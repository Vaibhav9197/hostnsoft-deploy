/**
 * analytics/query.js
 *
 * Reads back what access-log-tailer.js and resource-poller.js have
 * written — backs GET /internal/apps/:appName/analytics. Percentiles are
 * computed with a plain ORDER BY + LIMIT/OFFSET (the exact rank, not an
 * approximation) rather than a percentile() SQL function — the SQLite
 * build embedded in Node's own node:sqlite doesn't include that
 * extension function, and re-deriving it from window functions isn't
 * worth it for the row counts this platform runs at.
 */
const { getDb } = require('./db');

const RANGE_MS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
};

// "all" isn't literally unbounded — see retention.js, which prunes rows
// past RETENTION_DAYS. This cutoff just needs to predate any row that
// could still exist; it does not need to be "the beginning of time".
const ALL_RANGE_MS = 400 * 24 * 60 * 60 * 1000;

// Bucket width for the time-series points returned alongside the
// summary numbers — coarser for wider ranges so a chart doesn't end up
// with (for "all") potentially thousands of points.
const BUCKET_MS = {
  '24h': 60 * 60 * 1000, // hourly, 24 points
  '7d': 6 * 60 * 60 * 1000, // 4/day, 28 points
  '30d': 24 * 60 * 60 * 1000, // daily, 30 points
  '90d': 24 * 60 * 60 * 1000, // daily, 90 points
  all: 24 * 60 * 60 * 1000, // daily
};

function sinceFor(range) {
  const spanMs = RANGE_MS[range] ?? ALL_RANGE_MS;
  return Date.now() - spanMs;
}

function isValidRange(range) {
  return range === 'all' || Object.prototype.hasOwnProperty.call(RANGE_MS, range);
}

function percentile(db, appName, since, p) {
  const { c: count } = db
    .prepare('SELECT COUNT(*) as c FROM request_log WHERE app_name = ? AND ts >= ?')
    .get(appName, since);
  if (count === 0) return null;
  const offset = Math.min(count - 1, Math.max(0, Math.floor(count * p)));
  const row = db
    .prepare('SELECT duration_ms FROM request_log WHERE app_name = ? AND ts >= ? ORDER BY duration_ms LIMIT 1 OFFSET ?')
    .get(appName, since, offset);
  return row ? Math.round(row.duration_ms * 100) / 100 : null;
}

function queryTraffic(appName, range) {
  const db = getDb();
  const since = sinceFor(range);
  const bucketMs = BUCKET_MS[range] ?? BUCKET_MS.all;

  const totals = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status BETWEEN 200 AND 299 THEN 1 ELSE 0 END) as count2xx,
         SUM(CASE WHEN status BETWEEN 300 AND 399 THEN 1 ELSE 0 END) as count3xx,
         SUM(CASE WHEN status BETWEEN 400 AND 499 THEN 1 ELSE 0 END) as count4xx,
         SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) as count5xx
       FROM request_log WHERE app_name = ? AND ts >= ?`
    )
    .get(appName, since);

  const topPaths = db
    .prepare(
      `SELECT path, COUNT(*) as count FROM request_log
       WHERE app_name = ? AND ts >= ? AND path != ''
       GROUP BY path ORDER BY count DESC LIMIT 10`
    )
    .all(appName, since);

  // CAST(... AS INTEGER) on both the column and the bound `?` params is
  // required, not decorative — confirmed in practice: node:sqlite binds
  // a JS number parameter with REAL affinity even when it's a whole
  // number, so a bare `(ts / ?) * ?` does floating-point division and
  // never actually truncates, silently returning the original ts back
  // (i.e. every row lands in its own "bucket"). A literal divisor typed
  // directly into the SQL text doesn't have this problem — only bound
  // parameters do — which is exactly why this was easy to miss.
  const series = db
    .prepare(
      `SELECT
         (CAST(ts AS INTEGER) / CAST(? AS INTEGER)) * CAST(? AS INTEGER) as bucketStart,
         COUNT(*) as requests,
         SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) as errors
       FROM request_log
       WHERE app_name = ? AND ts >= ?
       GROUP BY bucketStart ORDER BY bucketStart ASC`
    )
    .all(bucketMs, bucketMs, appName, since);

  return {
    range,
    totalRequests: totals.total || 0,
    statusBreakdown: {
      '2xx': totals.count2xx || 0,
      '3xx': totals.count3xx || 0,
      '4xx': totals.count4xx || 0,
      '5xx': totals.count5xx || 0,
    },
    latencyMs: {
      p50: percentile(db, appName, since, 0.5),
      p95: percentile(db, appName, since, 0.95),
    },
    topPaths: topPaths.map((r) => ({ path: r.path, requests: r.count })),
    series: series.map((r) => ({
      bucketStart: new Date(r.bucketStart).toISOString(),
      requests: r.requests,
      errors: r.errors,
    })),
  };
}

function queryResourceUsage(appName, range) {
  const db = getDb();
  const since = sinceFor(range);
  const bucketMs = BUCKET_MS[range] ?? BUCKET_MS.all;

  // See the identical CAST note in queryTraffic above — bound `?`
  // parameters get REAL affinity in node:sqlite, so this division must
  // be forced to INTEGER explicitly or it silently never buckets at all.
  const series = db
    .prepare(
      `SELECT
         (CAST(ts AS INTEGER) / CAST(? AS INTEGER)) * CAST(? AS INTEGER) as bucketStart,
         AVG(cpu_percent) as avgCpuPercent,
         MAX(cpu_percent) as maxCpuPercent,
         AVG(memory_mb) as avgMemoryMb,
         MAX(memory_mb) as maxMemoryMb
       FROM resource_sample
       WHERE app_name = ? AND ts >= ?
       GROUP BY bucketStart ORDER BY bucketStart ASC`
    )
    .all(bucketMs, bucketMs, appName, since);

  const latest = db
    .prepare('SELECT cpu_percent, memory_mb, ts FROM resource_sample WHERE app_name = ? ORDER BY ts DESC LIMIT 1')
    .get(appName);

  const round2 = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : null);

  return {
    range,
    current: latest
      ? { cpuPercent: round2(latest.cpu_percent), memoryMb: round2(latest.memory_mb), sampledAt: new Date(latest.ts).toISOString() }
      : null,
    series: series.map((r) => ({
      bucketStart: new Date(r.bucketStart).toISOString(),
      avgCpuPercent: round2(r.avgCpuPercent),
      maxCpuPercent: round2(r.maxCpuPercent),
      avgMemoryMb: round2(r.avgMemoryMb),
      maxMemoryMb: round2(r.maxMemoryMb),
    })),
  };
}

module.exports = { isValidRange, queryTraffic, queryResourceUsage };
