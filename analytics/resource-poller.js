/**
 * analytics/resource-poller.js
 *
 * Periodically samples every running app's CPU/memory usage and stores it
 * in resource_sample (see db.js) — the historical counterpart to
 * app-health.js's live-only status check.
 *
 * Job/allocation discovery still goes through Nomad's HTTP API (`/v1/jobs`,
 * `/v1/job/:id/allocations`) — confirmed working. The actual stats READ
 * does NOT: it used to call Nomad's own `/v1/client/allocation/:id/stats`,
 * but on production that endpoint came back with an empty `Tasks: {}` for
 * every allocation, while Docker's own stats API for the exact same
 * container returned complete, correct data in the same investigation
 * (2026-09-12) — this host's cgroup setup (a hybrid v1/v2 mount, confirmed
 * via `mount | grep cgroup`) appears to break Nomad's client-side stats
 * collector specifically, without affecting Docker's own accounting at
 * all. Rather than requiring a host reboot + kernel boot-parameter change
 * to fix Nomad's collector (its own separate, deliberately-deferred
 * decision — see docs/CLAUDE.md), this reads stats straight from Docker.
 *
 * Reads Docker's RAW (non-CLI-formatted) stats JSON — deliberately not
 * `docker stats`'s human-formatted output (e.g. "154.3MiB / 256MiB",
 * "0.42%"), which would need parsing size-unit strings back into numbers.
 * The raw JSON's byte/tick counts are both more precise and immune to any
 * future Docker CLI output-format change.
 *
 * Talks to the Docker daemon over its own Unix socket via Node's built-in
 * `http` (no new dependency — same "prefer what's already in Node" choice
 * as db.js's use of `node:sqlite` over a third-party package).
 *
 * Best-effort per app: one app's alloc/container being gone, or its stats
 * endpoint being briefly unavailable (e.g. mid-redeploy), must never stop
 * every other app from being sampled this tick.
 */
const http = require('http');
const logger = require('../logger');
const { getDb, isAnalyticsEnabled } = require('./db');

const POLL_INTERVAL_MS = Number(process.env.RESOURCE_POLL_INTERVAL_MS) || 60000;
const NOMAD_ADDR = process.env.NOMAD_ADDR || 'http://127.0.0.1:4646';
const DOCKER_SOCKET_PATH = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';

async function nomadGet(path) {
  const response = await fetch(`${NOMAD_ADDR}${path}`);
  if (!response.ok) {
    throw new Error(`Nomad API ${path} returned HTTP ${response.status}`);
  }
  return response.json();
}

function dockerGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: DOCKER_SOCKET_PATH, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Docker API ${path} returned HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`Docker API ${path} returned a non-JSON body`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// The most recently created allocation still actually running for this
// job — during a redeploy there can briefly be more than one.
async function findRunningAlloc(jobId) {
  const allocs = await nomadGet(`/v1/job/${encodeURIComponent(jobId)}/allocations`);
  const running = allocs.filter((a) => a.ClientStatus === 'running');
  if (running.length === 0) return null;
  running.sort((a, b) => (b.CreateIndex || 0) - (a.CreateIndex || 0));
  const alloc = running[0];

  // Task name comes from the allocation itself rather than an assumption.
  // TaskStates is keyed by task name; prefer "server" when present (every
  // customer app, and the app task in an orphan deploy that also runs an
  // orphan-proxy sidecar) so a sidecar can never be sampled in place of
  // the app it fronts.
  const taskNames = Object.keys(alloc.TaskStates || {});
  const taskName = taskNames.includes('server') ? 'server' : taskNames[0];
  if (!taskName) return null;

  return { allocId: alloc.ID, taskName };
}

// Nomad's own Docker task driver names every container "<task>-<allocID>"
// — its standard convention, confirmed against this host's real running
// containers (`docker ps`) while diagnosing the Nomad-stats gap above.
// Docker's stats endpoint accepts a container NAME here just as well as
// an ID, so no separate "look up the container ID" round trip is needed.
//
// The task name was previously hardcoded to "server". That is right for
// every customer app (nomad-job-spec.js always names the task "server"),
// but WRONG for any platform job whose task is called something else —
// notably traefik, which therefore 404'd on every single tick and filled
// the error log with "No such container" once a minute, forever. Noise
// that alarming is not harmless: it was read as a platform outage during
// a real incident on 2026-09-17 while nothing was actually wrong.
function containerNameFor(allocId, taskName) {
  return `${taskName}-${allocId}`;
}

// Platform jobs, not customer apps. Skipped outright rather than merely
// named correctly: their CPU/memory is not per-app analytics and nothing
// reads it, so sampling them is wasted work either way.
// Also skipped by type below: platform jobs are `type = "system"`,
// customer apps `type = "service"` — see idle-report.js's PLATFORM_JOBS.
const PLATFORM_JOBS = new Set(['traefik', 'static-server']);

// Same formula `docker stats` itself uses: percent of ONE core, so a
// container actively using 2 full cores reports ~200%, not capped at
// 100% — matches what Nomad's own (now-bypassed) CpuStats.Percent
// represented before, so existing thresholds/expectations still apply.
function cpuPercentFrom(stats) {
  const cpu = stats.cpu_stats;
  const precpu = stats.precpu_stats;
  if (!cpu || !precpu || !cpu.cpu_usage || !precpu.cpu_usage) return null;

  const cpuDelta = cpu.cpu_usage.total_usage - precpu.cpu_usage.total_usage;
  const systemDelta = (cpu.system_cpu_usage || 0) - (precpu.system_cpu_usage || 0);
  // precpu_stats can be all-zero on a container's very first-ever sample
  // (nothing to diff against yet) — skip rather than report a bogus spike.
  if (!(systemDelta > 0) || cpuDelta < 0) return null;

  const numCpus = cpu.online_cpus || (cpu.cpu_usage.percpu_usage || []).length || 1;
  return Math.round(cpuDelta / systemDelta * numCpus * 100 * 100) / 100;
}

// Subtracts reclaimable page cache from raw usage, same as `docker
// stats`'s own "MEM USAGE" column — otherwise usage looks inflated by
// cache the kernel would happily evict under memory pressure, and would
// no longer be comparable to the RSS-based figure this replaces. Field
// name differs cgroup v1 ("cache") vs v2 ("inactive_file"); try both so
// this keeps working if the host's cgroup mode ever changes.
function memoryMbFrom(stats) {
  const mem = stats.memory_stats;
  if (!mem || typeof mem.usage !== 'number') return null;

  const s = mem.stats || {};
  const cache = typeof s.cache === 'number' ? s.cache : typeof s.inactive_file === 'number' ? s.inactive_file : 0;
  return Math.round((mem.usage - cache) / (1024 * 1024) * 100) / 100;
}

async function sampleApp(jobId) {
  const alloc = await findRunningAlloc(jobId);
  if (!alloc) return null;

  const stats = await dockerGet(
    `/containers/${containerNameFor(alloc.allocId, alloc.taskName)}/stats?stream=false`
  );
  const cpuPercent = cpuPercentFrom(stats);
  const memoryMb = memoryMbFrom(stats);
  if (cpuPercent === null && memoryMb === null) return null;

  return { cpuPercent, memoryMb };
}

async function tick() {
  let jobs;
  try {
    jobs = await nomadGet('/v1/jobs');
  } catch (e) {
    logger.error(`[resource-poller] could not list jobs: ${e.message}`);
    return;
  }

  const runningJobs = jobs.filter((j) => j.Status === 'running' && j.Type !== 'system');
  const db = getDb();
  const insert = db.prepare(
    'INSERT INTO resource_sample (app_name, ts, cpu_percent, memory_mb) VALUES (?, ?, ?, ?)'
  );
  const now = Date.now();

  for (const job of runningJobs) {
    if (PLATFORM_JOBS.has(job.ID)) continue;
    try {
      const sample = await sampleApp(job.ID);
      if (sample) {
        insert.run(job.ID, now, sample.cpuPercent, sample.memoryMb);
      }
    } catch (e) {
      // A 404 means the container went away between Nomad listing the
      // allocation and Docker being asked about it — ordinary churn
      // during a redeploy or restart, which corrects itself on the next
      // tick. Deliberately info, not warn: warn goes to pm2's ERROR log,
      // where a once-a-minute "No such container" reads as a platform
      // outage. It was read exactly that way during a real incident on
      // 2026-09-17. Anything that is not a 404 still warns.
      if (/returned HTTP 404/.test(e.message)) {
        logger.info(`[resource-poller] "${job.ID}" container not present this tick (likely restarting)`);
      } else {
        logger.warn(`[resource-poller] could not sample "${job.ID}" this tick: ${e.message}`);
      }
    }
  }
}

function startResourcePoller() {
  if (!isAnalyticsEnabled()) {
    logger.warn('[resource-poller] ANALYTICS_DB_PATH not set — resource-usage analytics disabled');
    return;
  }
  logger.info(`[resource-poller] sampling every ${POLL_INTERVAL_MS}ms via Nomad (${NOMAD_ADDR}) + Docker (${DOCKER_SOCKET_PATH})`);
  // Sample once immediately, not just on the interval — otherwise every
  // deploy-service restart leaves a full POLL_INTERVAL_MS window with no
  // data at all (confirmed hard way: this exact gap is what first made
  // "current: null" look like a persistent bug rather than just-restarted).
  tick().catch((e) => logger.error(`[resource-poller] initial tick failed: ${e.message}`));
  setInterval(() => {
    tick().catch((e) => logger.error(`[resource-poller] tick failed: ${e.message}`));
  }, POLL_INTERVAL_MS).unref(); // .unref(): don't keep the process alive on shutdown
}

module.exports = { startResourcePoller };
