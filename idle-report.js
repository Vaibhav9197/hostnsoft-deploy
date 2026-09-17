/**
 * idle-report.js — Step 2 of docs/scale-to-zero-gated-plan.md.
 *
 * DRY RUN ONLY. This file has no "apply" mode, no `nomad job stop` call,
 * and no write path of any kind — it opens the analytics DB read-only and
 * prints what a future idle-watcher WOULD do. Deliberately a standalone
 * script rather than a loop inside server.js: Step 2 of the plan is about
 * proving the detection logic is right before anything can act on it, and
 * a script you run by hand cannot fire on a timer by accident.
 *
 *   node idle-report.js
 *
 * Run as the SAME user deploy-service runs as (ubuntu), not root:
 * analytics/db.js's getDb() opens the database read-write (it sets WAL
 * mode and runs CREATE TABLE IF NOT EXISTS), so running it as root can
 * leave root-owned -wal/-shm files beside a ubuntu-owned database and
 * break the running service's ability to write to it.
 *
 * Step 1 of the plan ("record when each app was last requested") needed no
 * new code — analytics/access-log-tailer.js already writes one row per
 * request into request_log(app_name, ts), indexed on exactly (app_name,
 * ts). Last-seen is a MAX(ts) over that.
 */
// Same absolute-path dotenv load as server.js — this script is run by
// hand from wherever the operator happens to be standing, so the default
// cwd-relative lookup would silently find nothing and the script would
// (correctly, but unhelpfully) report that analytics is disabled.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { getDb, isAnalyticsEnabled } = require('./analytics/db');

const NOMAD_ADDR = process.env.NOMAD_ADDR || 'http://127.0.0.1:4646';

// How long without a request before an app counts as idle. Same
// soft-override-with-a-default convention as IMAGE_RETAIN_COUNT and
// ORPHAN_TTL_MS. 30 minutes is a starting point for observation, NOT a
// tuned value — Step 5 of the plan is where a real threshold gets chosen
// from actual traffic patterns.
const IDLE_THRESHOLD_MIN = Number(process.env.IDLE_THRESHOLD_MIN) || 30;

// Nomad jobs that are part of the platform itself, not a customer app.
// Traefik is the only one that runs as a Nomad job (deploy-service and
// api-service run under pm2, so they never appear in /v1/jobs at all) —
// but listing it explicitly means a future platform job can't silently
// become a scale-to-zero candidate just by existing.
const PLATFORM_JOBS = new Set(['traefik']);

async function nomadGet(path) {
  const response = await fetch(`${NOMAD_ADDR}${path}`);
  if (!response.ok) {
    throw new Error(`Nomad API ${path} returned HTTP ${response.status}`);
  }
  return response.json();
}

// Sourced from Nomad rather than from request_log's own app_name column:
// an app that has NEVER been requested has no rows in request_log at all,
// and that is exactly the app most likely to be idle. Driving the list
// off request_log would make those apps invisible to this report.
async function runningAppNames() {
  const jobs = await nomadGet('/v1/jobs');
  return jobs
    .filter((j) => j.Status === 'running')
    .map((j) => j.ID)
    .filter((id) => !PLATFORM_JOBS.has(id))
    .sort();
}

function lastSeenMsFor(db, appName) {
  const row = db
    .prepare('SELECT MAX(ts) AS lastSeen FROM request_log WHERE app_name = ?')
    .get(appName);
  return row && row.lastSeen ? Number(row.lastSeen) : null;
}

function formatIdle(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

async function main() {
  // Matches the guard the tailer/poller use. Without this the report would
  // print "every app is idle" purely because there is no traffic data —
  // which in apply mode would be the worst possible failure, so it is a
  // hard exit rather than a warning even though this script cannot act.
  if (!isAnalyticsEnabled()) {
    console.error(
      'ANALYTICS_DB_PATH is not set, so there is no request history to read.\n' +
        'Without it every app looks idle. Refusing to report.'
    );
    process.exit(1);
  }

  const db = getDb();
  const apps = await runningAppNames();
  if (apps.length === 0) {
    console.log('No running customer apps found.');
    return;
  }

  const now = Date.now();
  const thresholdMs = IDLE_THRESHOLD_MIN * 60 * 1000;
  const rows = apps.map((appName) => {
    const lastSeen = lastSeenMsFor(db, appName);
    // No rows at all means no request has EVER been recorded for this app.
    // Reported separately from a large idle time rather than folded into
    // it: "never requested" usually means the app was only just deployed,
    // or that its traffic is not being attributed correctly — both worth
    // seeing as themselves before anything acts on this data.
    const idleMs = lastSeen === null ? null : now - lastSeen;
    return {
      appName,
      lastSeen,
      idleMs,
      wouldStop: idleMs !== null && idleMs >= thresholdMs,
    };
  });

  console.log(`Idle threshold: ${IDLE_THRESHOLD_MIN} min   (DRY RUN — nothing is stopped)\n`);
  const width = Math.max(...rows.map((r) => r.appName.length), 12);
  for (const r of rows) {
    const name = r.appName.padEnd(width);
    if (r.idleMs === null) {
      console.log(`${name}  never requested        (no action — needs investigation)`);
    } else if (r.wouldStop) {
      console.log(`${name}  idle for ${formatIdle(Math.floor(r.idleMs / 60000))}`.padEnd(width + 26) + '  WOULD STOP');
    } else {
      console.log(`${name}  active ${formatIdle(Math.floor(r.idleMs / 60000))} ago`.padEnd(width + 26) + '  would not stop');
    }
  }

  const stoppable = rows.filter((r) => r.wouldStop).length;
  console.log(`\n${rows.length} app(s) checked, ${stoppable} would be stopped, 0 actually touched.`);
}

main().catch((e) => {
  console.error(`idle-report failed: ${e.message}`);
  process.exit(1);
});
