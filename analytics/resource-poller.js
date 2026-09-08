/**
 * analytics/resource-poller.js
 *
 * Periodically samples every running app's CPU/memory usage straight
 * from Nomad's own HTTP API and stores it in resource_sample (see
 * db.js) — the historical counterpart to app-health.js's live-only
 * status check. Talks to Nomad's HTTP API directly (not the CLI): the
 * response is structured JSON with the exact fields needed
 * (ResourceUsage.CpuStats.Percent, .MemoryStats.RSS), confirmed against
 * Nomad's own API docs — no table-scraping/regex parsing needed here,
 * unlike app-health.js's use of `nomad job status` (which has no JSON
 * form that includes allocation-level state).
 *
 * Reads Nomad's per-TASK stats (not the whole allocation) specifically
 * for the "server" task — an orphan deploy also runs a small
 * "orphan-proxy" sidecar task (see nomad-job-spec.js) whose own
 * negligible CPU/memory would otherwise get mixed into the app's own
 * numbers if the whole-allocation total were used instead.
 *
 * Best-effort per app: one app's alloc being gone, or its stats
 * endpoint being briefly unavailable (e.g. mid-redeploy), must never
 * stop every other app from being sampled this tick.
 */
const logger = require('../logger');
const { getDb } = require('./db');

const POLL_INTERVAL_MS = Number(process.env.RESOURCE_POLL_INTERVAL_MS) || 60000;
const NOMAD_ADDR = process.env.NOMAD_ADDR || 'http://127.0.0.1:4646';

async function nomadGet(path) {
  const response = await fetch(`${NOMAD_ADDR}${path}`);
  if (!response.ok) {
    throw new Error(`Nomad API ${path} returned HTTP ${response.status}`);
  }
  return response.json();
}

// The most recently created allocation still actually running for this
// job — during a redeploy there can briefly be more than one.
async function findRunningAllocId(jobId) {
  const allocs = await nomadGet(`/v1/job/${encodeURIComponent(jobId)}/allocations`);
  const running = allocs.filter((a) => a.ClientStatus === 'running');
  if (running.length === 0) return null;
  running.sort((a, b) => (b.CreateIndex || 0) - (a.CreateIndex || 0));
  return running[0].ID;
}

async function sampleApp(jobId) {
  const allocId = await findRunningAllocId(jobId);
  if (!allocId) return null;

  const stats = await nomadGet(`/v1/client/allocation/${allocId}/stats`);
  const serverTask = stats.Tasks && stats.Tasks.server;
  if (!serverTask || !serverTask.ResourceUsage) return null;

  const cpuPercent = serverTask.ResourceUsage.CpuStats && serverTask.ResourceUsage.CpuStats.Percent;
  const rssBytes = serverTask.ResourceUsage.MemoryStats && serverTask.ResourceUsage.MemoryStats.RSS;
  if (typeof cpuPercent !== 'number' && typeof rssBytes !== 'number') return null;

  return {
    cpuPercent: typeof cpuPercent === 'number' ? cpuPercent : null,
    memoryMb: typeof rssBytes === 'number' ? rssBytes / (1024 * 1024) : null,
  };
}

async function tick() {
  let jobs;
  try {
    jobs = await nomadGet('/v1/jobs');
  } catch (e) {
    logger.error(`[resource-poller] could not list jobs: ${e.message}`);
    return;
  }

  const runningJobs = jobs.filter((j) => j.Status === 'running');
  const db = getDb();
  const insert = db.prepare(
    'INSERT INTO resource_sample (app_name, ts, cpu_percent, memory_mb) VALUES (?, ?, ?, ?)'
  );
  const now = Date.now();

  for (const job of runningJobs) {
    try {
      const sample = await sampleApp(job.ID);
      if (sample) {
        insert.run(job.ID, now, sample.cpuPercent, sample.memoryMb);
      }
    } catch (e) {
      logger.warn(`[resource-poller] could not sample "${job.ID}" this tick: ${e.message}`);
    }
  }
}

function startResourcePoller() {
  logger.info(`[resource-poller] sampling every ${POLL_INTERVAL_MS}ms via ${NOMAD_ADDR}`);
  setInterval(() => {
    tick().catch((e) => logger.error(`[resource-poller] tick failed: ${e.message}`));
  }, POLL_INTERVAL_MS);
}

module.exports = { startResourcePoller };
