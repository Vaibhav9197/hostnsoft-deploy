/**
 * app-logs.js
 *
 * Fetches recent stdout/stderr for an app's most recent allocation
 * straight from Nomad's HTTP API — backs GET /apps/:appName/logs. Uses
 * the MOST RECENT allocation regardless of its status (unlike
 * analytics/resource-poller.js's findRunningAllocId, which deliberately
 * only considers a currently-running one) — the single most common
 * reason to check logs is to see why an allocation just failed, so a
 * dead/failed allocation's logs matter here at least as much as a
 * healthy one's.
 */
const logger = require('./logger');

const NOMAD_ADDR = process.env.NOMAD_ADDR || 'http://127.0.0.1:4646';

async function nomadGet(path) {
  const response = await fetch(`${NOMAD_ADDR}${path}`);
  if (!response.ok) {
    throw new Error(`Nomad API ${path} returned HTTP ${response.status}`);
  }
  return response.json();
}

async function findLatestAllocId(jobId) {
  const allocs = await nomadGet(`/v1/job/${encodeURIComponent(jobId)}/allocations`);
  if (allocs.length === 0) return null;
  allocs.sort((a, b) => (b.CreateIndex || 0) - (a.CreateIndex || 0));
  return allocs[0].ID;
}

// stream: 'stdout' | 'stderr'. tailBytes: how much of the log's tail to
// fetch (Nomad's `origin=end&offset=N` — a single non-streaming fetch,
// not a live tail; `follow` is deliberately omitted/false).
async function getAppLogs(appName, { stream = 'stdout', tailBytes = 8000 } = {}) {
  let allocId;
  try {
    allocId = await findLatestAllocId(appName);
  } catch (e) {
    logger.error(`[${appName}] could not list allocations for logs: ${e.message}`);
    return { available: false, reason: "Could not reach the deploy backend to list allocations" };
  }
  if (!allocId) {
    return { available: false, reason: "No allocation has ever been created for this app yet" };
  }

  const url = `${NOMAD_ADDR}/v1/client/fs/logs/${allocId}?task=server&type=${stream}&origin=end&offset=${tailBytes}&plain=true`;
  let response;
  try {
    response = await fetch(url);
  } catch (e) {
    logger.error(`[${appName}] could not fetch logs for alloc ${allocId}: ${e.message}`);
    return { available: false, reason: "Could not reach the deploy backend to fetch logs" };
  }
  if (!response.ok) {
    const bodyText = await response.text().catch(() => "<unreadable response body>");
    logger.warn(`[${appName}] Nomad logs API returned HTTP ${response.status} for alloc ${allocId}: ${bodyText}`);
    return { available: false, reason: `Logs not available yet (HTTP ${response.status})` };
  }

  const logs = await response.text();
  return { available: true, allocId, stream, logs };
}

module.exports = { getAppLogs };
