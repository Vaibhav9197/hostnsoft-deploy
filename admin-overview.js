// Everything the admin panel's Customer apps and Platform health pages need,
// in one call: GET /internal/admin/overview (hostnsoft-api's /admin/apps
// and /admin/platform read it).
//
// Per customer app: real runtime health (one bulk Nomad read for every app,
// instead of one `nomad job status` per app), whether it is asleep,
// restarts and out-of-memory kills in the last 24 hours, memory against its
// own limit, and failed wake-ups. Platform: the status file the platform
// monitor (Server-setup platform-monitor.js) rewrites every minute.

const fs = require('fs/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { readSleepState } = require('./scale-to-zero-registry');
const { readWakeFailures } = require('./wake-failures');
const { getDb, isAnalyticsEnabled } = require('./analytics/db');

const NOMAD_ADDR = process.env.NOMAD_ADDR || 'http://127.0.0.1:4646';
const DAY_MS = 24 * 3600_000;
// The monitor runs every minute; older than this means it has stopped.
const MONITOR_STALE_MS = 5 * 60_000;

// Platform jobs share the Nomad job list with customer apps. On a non-prod
// box the static server is "<env>-static-server".
function isPlatformJob(id) {
  return id === 'traefik' || id === 'static-server' || id.endsWith('-static-server');
}

async function nomad(path) {
  const res = await fetch(`${NOMAD_ADDR}${path}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Nomad ${path} -> HTTP ${res.status}`);
  return res.json();
}

// Same vocabulary as app-health.js simplifyHealth, plus "asleep".
function healthOf(job, alloc) {
  if (job.Status === 'dead') return 'stopped';
  if (!alloc) return 'unknown';
  switch (alloc.ClientStatus) {
    case 'running': return 'running';
    case 'failed':
    case 'lost': return 'crashed';
    case 'complete': return 'stopped';
    case 'pending': return 'starting';
    default: return 'unknown';
  }
}

// The app task's terminations in the last day, from the allocation's recent
// task events (Nomad keeps the last 10): {at (ms), oom}.
function terminations(alloc, since) {
  const states = (alloc && alloc.TaskStates) || {};
  const task = states.server || Object.values(states)[0];
  return ((task && task.Events) || [])
    .filter((e) => e.Type === 'Terminated' && e.Time / 1e6 >= since)
    .map((e) => ({ at: e.Time / 1e6, oom: !!(e.Details && e.Details.oom_killed === 'true') }));
}

// A restart that was the platform's doing, not the app's: Docker (re)started
// around then, or several apps went down together. The exit code can't tell
// them apart (a stopped Node app exits 1 just like a crashed one), the
// timing can. Exported for tests.
const PLATFORM_WINDOW_MS = 3 * 60_000;
const TOGETHER_APPS = 3;
function classifyTerminations(byApp, dockerStartedAt) {
  const all = Object.entries(byApp).flatMap(([app, list]) => list.filter((t) => !t.oom).map((t) => ({ app, at: t.at })));
  const out = {};
  for (const [app, list] of Object.entries(byApp)) {
    let crashes = 0;
    let platform = 0;
    let lastCrashAt = null;
    for (const t of list) {
      if (t.oom) continue;
      const nearDocker = dockerStartedAt !== null && Math.abs(t.at - dockerStartedAt) <= PLATFORM_WINDOW_MS;
      const together = new Set(all.filter((o) => Math.abs(o.at - t.at) <= PLATFORM_WINDOW_MS / 2).map((o) => o.app)).size >= TOGETHER_APPS;
      if (nearDocker || together) platform += 1;
      else {
        crashes += 1;
        lastCrashAt = Math.max(lastCrashAt || 0, t.at);
      }
    }
    out[app] = {
      crashes24h: crashes,
      lastCrashAt: lastCrashAt ? new Date(lastCrashAt).toISOString() : null,
      platformRestarts24h: platform,
      oomTerminations24h: list.filter((t) => t.oom).length,
    };
  }
  return out;
}

// When Docker last (re)started, or null if systemd can't say.
async function dockerStartedAt() {
  try {
    const { stdout } = await promisify(execFile)('systemctl', ['show', 'docker', '-p', 'ActiveEnterTimestamp', '--value'], { timeout: 5_000 });
    const t = Date.parse(stdout.trim().replace(/^[A-Za-z]{3} /, ''));
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

function memoryLimitMb(alloc) {
  const tasks = (alloc && alloc.AllocatedResources && alloc.AllocatedResources.Tasks) || {};
  const mem = (tasks.server || Object.values(tasks)[0] || {}).Memory || {};
  return mem.MemoryMaxMB || mem.MemoryMB || null;
}

// Latest sample (last 10 min) and the 24-hour peak, per app.
function memorySamples(since) {
  if (!isAnalyticsEnabled()) return {};
  const db = getDb();
  const out = {};
  const latest = db.prepare(`
    SELECT r.app_name AS app, r.memory_mb AS mb, r.cpu_percent AS cpu, r.ts AS ts
    FROM resource_sample r
    JOIN (SELECT app_name, MAX(ts) AS ts FROM resource_sample WHERE ts >= ? GROUP BY app_name) m
      ON m.app_name = r.app_name AND m.ts = r.ts
  `).all(Date.now() - 10 * 60_000);
  for (const r of latest) out[r.app] = { memoryMb: Math.round(r.mb), cpuPercent: Math.round(r.cpu * 10) / 10, sampledAt: new Date(r.ts).toISOString() };
  const peaks = db.prepare('SELECT app_name AS app, MAX(memory_mb) AS mb FROM resource_sample WHERE ts >= ? GROUP BY app_name').all(since);
  for (const r of peaks) out[r.app] = { ...(out[r.app] || {}), memoryPeak24hMb: Math.round(r.mb) };
  return out;
}

async function readMonitorStatus() {
  const file = process.env.MONITOR_STATUS_FILE;
  if (!file) return { monitor: null, monitorError: 'MONITOR_STATUS_FILE is not set' };
  try {
    const monitor = JSON.parse(await fs.readFile(file, 'utf8'));
    const age = Date.now() - Date.parse(monitor.generatedAt);
    return { monitor, monitorStale: !(age < MONITOR_STALE_MS) };
  } catch (e) {
    return { monitor: null, monitorError: e.code === 'ENOENT' ? 'the platform monitor has not written its status yet' : e.message };
  }
}

async function buildAdminOverview() {
  const now = Date.now();
  const since = now - DAY_MS;
  const [jobs, allocs, wakes, status, dockerAt] = await Promise.all([
    nomad('/v1/jobs'),
    nomad('/v1/allocations?resources=true'),
    readWakeFailures(since).catch(() => []),
    readMonitorStatus(),
    dockerStartedAt(),
  ]);

  const newestAlloc = {};
  for (const a of allocs) {
    const cur = newestAlloc[a.JobID];
    if (!cur || a.CreateIndex > cur.CreateIndex) newestAlloc[a.JobID] = a;
  }
  let samples = {};
  let samplesError = null;
  try {
    samples = memorySamples(since);
  } catch (e) {
    samplesError = e.message;
  }

  const customerJobs = jobs.filter((job) => job.Type !== 'system' && !isPlatformJob(job.ID));
  const restarts = classifyTerminations(
    Object.fromEntries(customerJobs.map((job) => [job.ID, terminations(newestAlloc[job.ID], since)])),
    dockerAt,
  );

  const appOoms = (status.monitor && status.monitor.history && status.monitor.history.appOoms) || [];
  const apps = {};
  for (const job of customerJobs) {
    const alloc = newestAlloc[job.ID];
    let health = healthOf(job, alloc);
    let asleepSince = null;
    if (health === 'stopped') {
      const sleep = await readSleepState(job.ID);
      if (sleep && (sleep.state === 'asleep' || sleep.state === 'stopping')) {
        health = 'asleep';
        asleepSince = sleep.since || null;
      }
    }
    const ooms = appOoms.filter((o) => o.job === job.ID && Date.parse(o.at) >= since);
    const myWakes = wakes.filter((w) => w.app === job.ID);
    apps[job.ID] = {
      health,
      asleepSince,
      ...restarts[job.ID],
      oomKills24h: ooms.length,
      lastOom: ooms.length ? ooms[ooms.length - 1] : null,
      memoryLimitMb: memoryLimitMb(alloc),
      ...(samples[job.ID] || {}),
      wakeFailures24h: myWakes.length,
      lastWakeFailure: myWakes.length ? myWakes[myWakes.length - 1] : null,
    };
  }

  return {
    generatedAt: new Date(now).toISOString(),
    monitor: status.monitor,
    monitorStale: status.monitorStale === true,
    monitorError: status.monitorError || null,
    samplesError,
    apps,
  };
}

module.exports = { buildAdminOverview, isPlatformJob, healthOf, classifyTerminations };
