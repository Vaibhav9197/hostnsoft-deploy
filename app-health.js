/**
 * app-health.js
 *
 * Backs GET /internal/apps/:appName/status — see hostnsoft-api's
 * src/services/appHealth.ts, which is the only caller (dashboard's
 * project-detail view, replacing the previously-hardcoded
 * health: "unknown"). Read-only; never touches the job.
 *
 * `nomad job status <job>` is parsed instead of `-json` because the JSON
 * form returns the raw Job spec (no allocation/runtime state at all) —
 * getting allocation status would mean a second call + a different
 * endpoint shape. The human-readable table already carries everything
 * needed (job-level Status plus each allocation's Status), same
 * information an operator reads by eye, so it's parsed directly. Nomad's
 * own tabwriter pads columns with 2+ spaces, which is what makes
 * splitting on /\s{2,}/ a reliable tokenizer here (a single space never
 * appears as a column separator).
 */
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const logger = require('./logger');
const { isStaticApp, staticAppIsServing } = require('./static-site');

function parseJobStatus(stdout) {
  const match = stdout.match(/^Status\s*=\s*(\S+)/m);
  return match ? match[1] : null;
}

// Most recent allocation is listed first under the "Allocations" table —
// that's the one whose Status reflects the app's current runtime state.
function parseLatestAllocStatus(stdout) {
  const lines = stdout.split('\n');
  const headerIdx = lines.findIndex((l) => l.trim() === 'Allocations');
  if (headerIdx === -1 || !lines[headerIdx + 1]) return null;

  const header = lines[headerIdx + 1].trim().split(/\s{2,}/);
  const statusCol = header.indexOf('Status');
  const dataRow = lines[headerIdx + 2];
  if (statusCol === -1 || !dataRow || !dataRow.trim()) return null;

  const cols = dataRow.trim().split(/\s{2,}/);
  return cols[statusCol] || null;
}

// Collapses Nomad's own job/alloc status vocabulary into the small set
// the dashboard actually needs to render. "crashed" covers both a failed
// and a lost allocation — from a dashboard's perspective, both mean "the
// app isn't up and something needs attention," the distinction between
// them is an infra-debugging detail.
function simplifyHealth(jobStatus, allocStatus) {
  if (jobStatus === 'dead') return 'stopped';
  if (allocStatus === 'running') return 'running';
  if (allocStatus === 'failed' || allocStatus === 'lost') return 'crashed';
  if (allocStatus === 'complete') return 'stopped';
  if (allocStatus === 'pending' || jobStatus === 'pending') return 'starting';
  return 'unknown';
}

async function getAppHealth(appName) {
  // A static app (static-site.js) has no Nomad job and no process: it is
  // "running" for as long as its `current` version resolves to files the
  // static server can serve — from the moment it is published until it
  // is deleted. Anything else would be a bug in this codebase, not an
  // app state, hence "unknown" rather than "crashed".
  if (await isStaticApp(appName)) {
    return (await staticAppIsServing(appName)) ? 'running' : 'unknown';
  }

  let stdout;
  try {
    ({ stdout } = await execPromise(`nomad job status ${appName}`));
  } catch (e) {
    const output = `${e.stdout || ''}${e.stderr || ''}`;
    // Nomad's actual message for a job that doesn't exist is "No job(s)
    // with prefix or id \"x\" found" — no "not found" substring, so that
    // naive check (as originally copied from the DELETE teardown
    // endpoint below) never actually matched. Confirmed via Nomad's own
    // CLI source/issue tracker.
    if (/no job\(s\) with prefix or id/i.test(output)) {
      return 'not_deployed';
    }
    logger.error(`[${appName}] nomad job status failed: ${e.message}`);
    return 'unknown';
  }

  const jobStatus = parseJobStatus(stdout);
  const allocStatus = parseLatestAllocStatus(stdout);
  return simplifyHealth(jobStatus, allocStatus);
}

module.exports = { getAppHealth };
