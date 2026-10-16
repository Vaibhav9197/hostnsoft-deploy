/**
 * analytics/access-log-tailer.js
 *
 * Follows Traefik's JSON access log (TRAEFIK_ACCESS_LOG_PATH — see
 * server-setup.sh's Traefik section, which enables --accesslog with
 * format=json) and turns each request into one row in request_log (see
 * db.js). Poll-based rather than fs.watch/inotify: simpler, and matches
 * every other background loop in this codebase (orphanCleanup,
 * domainReverification) being a plain setInterval rather than a
 * reactive/event-driven design.
 *
 * Attribution: Traefik names each request's matched router
 * "<name>@<provider>" (confirmed against Traefik's own docs — every
 * provider suffixes its resource names this way, e.g. "@docker",
 * "@file"; this platform's Nomad-provider services get "@nomad"). The
 * platform's own default router is literally named after the app slug
 * (see nomad-job-spec.js's defaultRouterTags: `routers.${appName}...`),
 * and each custom-domain router is "<appName>-customN" (customDomainRouterTags).
 * Stripping the "@provider" suffix and then any trailing "-customN"
 * recovers the app slug either way. A request that matched no router at
 * all (Traefik omits RouterName entirely for those — e.g. a 404 for an
 * unknown Host header) has nothing to attribute to and is skipped.
 *
 * Best-effort by design: a malformed line, a missing log file, or any
 * other tailer failure is logged and skipped/retried on the next poll —
 * this must never affect the actual deploy pipeline.
 */
const fs = require('fs');
const logger = require('../logger');
const { getDb, isAnalyticsEnabled } = require('./db');

const POLL_INTERVAL_MS = Number(process.env.ACCESS_LOG_POLL_INTERVAL_MS) || 5000;

// Traefik router names look like "myapp@nomad" (default router) or
// "myapp-custom0@nomad" (a custom domain's router, see
// nomad-job-spec.js's customDomainRouterTags). Strips the provider
// suffix first, then the "-customN" suffix if present, recovering the
// app slug either way.
function appNameFromRouterName(routerName) {
  const withoutProvider = routerName.replace(/@[^@]+$/, '');
  return withoutProvider.replace(/-custom\d+$/, '');
}

function readNewBytes(logPath, fromOffset) {
  const fd = fs.openSync(logPath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size <= fromOffset) {
      return { text: '', newOffset: fromOffset, size: stat.size };
    }
    const length = stat.size - fromOffset;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, fromOffset);
    return { text: buffer.toString('utf8'), newOffset: stat.size, size: stat.size };
  } finally {
    fs.closeSync(fd);
  }
}

// Only complete (newline-terminated) lines are consumed — a line still
// being written by Traefik at the moment we poll is left for the next
// poll rather than parsed as (invalid) partial JSON. Returns the
// complete lines plus how many bytes of `text` they actually consumed,
// so the caller only advances the persisted offset past whole lines.
function splitCompleteLines(text) {
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline === -1) return { lines: [], consumedBytes: 0 };
  const complete = text.slice(0, lastNewline);
  return {
    lines: complete.split('\n').filter((l) => l.length > 0),
    consumedBytes: Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8'),
  };
}

function parseLine(line) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!entry.RouterName) return null; // unrouted (e.g. unknown Host) — nothing to attribute to

  const appName = appNameFromRouterName(entry.RouterName);
  const status = Number(entry.DownstreamStatus);
  const durationNs = Number(entry.Duration);
  if (!appName || !Number.isFinite(status) || !Number.isFinite(durationNs)) return null;

  const tsSource = entry.time || entry.StartUTC;
  const ts = tsSource ? Date.parse(tsSource) : NaN;

  return {
    appName,
    ts: Number.isFinite(ts) ? ts : Date.now(),
    status,
    durationMs: durationNs / 1e6,
    path: typeof entry.RequestPath === 'string' ? entry.RequestPath : '',
    // Traefik emits kept request headers as "request_<Header-Name>" (see
    // server-setup.sh's --accesslog.fields.headers.names.User-Agent).
    // Absent entirely on a Traefik that predates that flag, and '-' when
    // Traefik saw no header at all — both are preserved as-is here so
    // bot-filter.js can tell "unknown" (null) from "genuinely empty".
    userAgent:
      typeof entry['request_User-Agent'] === 'string' ? entry['request_User-Agent'] : null,
  };
}

function tick(logPath) {
  let stat;
  try {
    stat = fs.statSync(logPath);
  } catch (e) {
    logger.warn(`[access-log-tailer] cannot stat ${logPath} (yet?): ${e.message}`);
    return;
  }

  const db = getDb();
  const state = db.prepare('SELECT inode, byte_offset FROM tail_state WHERE log_path = ?').get(logPath);

  // A changed inode (rotation via rename) or a file now smaller than our
  // last offset (rotation via copytruncate) both mean "start over from 0
  // on the new file" — there is no way to recover exactly-once delivery
  // across a rotation we didn't see happen, so this accepts a small
  // window of possible duplicate/missed lines around a rotation instead.
  const rotated = !state || state.inode !== stat.ino || stat.size < state.byte_offset;
  const fromOffset = rotated ? 0 : state.byte_offset;

  const { text, newOffset } = readNewBytes(logPath, fromOffset);
  if (!text) {
    if (rotated) {
      db.prepare(
        'INSERT INTO tail_state (log_path, inode, byte_offset) VALUES (?, ?, ?) ' +
        'ON CONFLICT(log_path) DO UPDATE SET inode = excluded.inode, byte_offset = excluded.byte_offset'
      ).run(logPath, stat.ino, newOffset);
    }
    return;
  }

  const { lines, consumedBytes } = splitCompleteLines(text);
  const parsed = lines.map(parseLine).filter(Boolean);

  const insert = db.prepare(
    'INSERT INTO request_log (app_name, ts, status, duration_ms, path, user_agent) VALUES (?, ?, ?, ?, ?, ?)'
  );
  db.exec('BEGIN');
  try {
    for (const row of parsed) {
      insert.run(row.appName, row.ts, row.status, row.durationMs, row.path, row.userAgent);
    }
    db.prepare(
      'INSERT INTO tail_state (log_path, inode, byte_offset) VALUES (?, ?, ?) ' +
      'ON CONFLICT(log_path) DO UPDATE SET inode = excluded.inode, byte_offset = excluded.byte_offset'
    ).run(logPath, stat.ino, fromOffset + consumedBytes);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    logger.error(`[access-log-tailer] failed to ingest batch: ${e.message}`);
  }
}

function startAccessLogTailer() {
  const logPath = process.env.TRAEFIK_ACCESS_LOG_PATH;
  if (!logPath) {
    logger.warn('[access-log-tailer] TRAEFIK_ACCESS_LOG_PATH not set — traffic analytics disabled');
    return;
  }
  if (!isAnalyticsEnabled()) {
    logger.warn('[access-log-tailer] ANALYTICS_DB_PATH not set — traffic analytics disabled');
    return;
  }
  logger.info(`[access-log-tailer] following ${logPath} every ${POLL_INTERVAL_MS}ms`);
  setInterval(() => {
    try {
      tick(logPath);
    } catch (e) {
      logger.error(`[access-log-tailer] tick failed: ${e.message}`);
    }
  }, POLL_INTERVAL_MS).unref(); // .unref(): don't keep the process alive on shutdown
}

module.exports = { startAccessLogTailer, appNameFromRouterName };
