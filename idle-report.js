/**
 * idle-report.js — Step 2 of docs/scale-to-zero-gated-plan.md.
 *
 * Reports which apps are idle and, with --apply, stops them — but ONLY an
 * app whose name appears in STOPPABLE_APPS below, which is a hardcoded
 * frozen list, not configuration and not an env var. That is the Step 3
 * safety rail: a bug anywhere else in this file still cannot reach an app
 * that is not literally named in the source.
 *
 * Two things this file must never gain, and does not have:
 *   - `-purge`. A purged job is GONE, spec and all, and cannot be woken.
 *     Plain `nomad job stop` keeps the job registered so Step 4 can
 *     restart it.
 *   - any delete/unlink/rm of app data. Stopping an app must never touch
 *     its data; removing an app's data directory belongs to exactly one
 *     place, server.js's DELETE /internal/apps/:appName.
 *
 * Still a standalone script rather than a loop inside server.js: a script
 * you run by hand cannot fire on a timer by accident. Step 5 is where it
 * earns a schedule.
 *
 *   node idle-report.js            # report only (default)
 *   node idle-report.js --apply    # actually stop, allowlisted apps only
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

const fsp = require('fs/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const { getDb, isAnalyticsEnabled } = require('./analytics/db');
const { appDataPathFor } = require('./nomad-job-spec');
const { isBotRequest } = require('./analytics/bot-filter');

const NOMAD_ADDR = process.env.NOMAD_ADDR || 'http://127.0.0.1:4646';

// How long without a request before an app counts as idle. Same
// soft-override-with-a-default convention as IMAGE_RETAIN_COUNT and
// ORPHAN_TTL_MS. 30 minutes is a starting point for observation, NOT a
// tuned value — Step 5 of the plan is where a real threshold gets chosen
// from actual traffic patterns.
const IDLE_THRESHOLD_MIN = Number(process.env.IDLE_THRESHOLD_MIN) || 30;

// THE SAFETY RAIL. Hardcoded and frozen deliberately: an allowlist read
// from the environment or a config file could be widened by accident, or
// by a deploy that ships the wrong file. Adding a real app here is a
// code change that has to be reviewed and deployed — which is exactly
// the friction Step 3 of the plan asks for. Step 6 is where this grows.
const STOPPABLE_APPS = Object.freeze(['scale-to-zero-test-1']);

// A last-moment re-check window. The idle threshold is measured in tens
// of minutes; this catches a request that landed between the report and
// the stop, which the threshold's own resolution would miss.
const RECENT_TRAFFIC_GRACE_SEC = Number(process.env.RECENT_TRAFFIC_GRACE_SEC) || 60;

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

// "Last REAL request", not "last request". A newly deployed app picks up
// credential-scanner traffic within seconds of its first TLS certificate
// (confirmed in production: ~2/min of /.env, /.git/config and friends),
// which would otherwise keep it permanently non-idle — and under
// scale-to-zero would wake it to serve those scans.
//
// Scans a bounded window of recent rows rather than MAX(ts): the answer
// is the newest NON-bot row, which SQL alone can't pick without pushing
// the whole classifier into a query. LOOKBACK_ROWS is generous enough
// that an app whose recent traffic is entirely bots still resolves
// correctly, and if every row in the window is a bot the app is
// genuinely idle by any definition.
const LOOKBACK_ROWS = 500;

function lastSeenMsFor(db, appName) {
  const rows = db
    .prepare(
      'SELECT ts, path, user_agent FROM request_log WHERE app_name = ? ORDER BY ts DESC LIMIT ?'
    )
    .all(appName, LOOKBACK_ROWS);

  for (const row of rows) {
    if (!isBotRequest({ userAgent: row.user_agent, path: row.path })) {
      return Number(row.ts);
    }
  }
  // Either no rows at all, or every row in the window was automated.
  // Both mean "no real visit we know of" — reported as never-requested
  // rather than silently treated as idle-since-forever.
  return null;
}

// Reported alongside, so the operator can see WHY an app looks idle —
// "no real traffic, but 340 bot hits" is a very different situation from
// "nothing has touched this at all", and the two would otherwise be
// indistinguishable in the output.
function botOnlyCountFor(db, appName) {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM request_log WHERE app_name = ? AND ts >= ?')
    .get(appName, Date.now() - 24 * 60 * 60 * 1000);
  return row ? row.n : 0;
}

// A deploy in flight must never be interrupted. deploy-status.js holds
// this state in-process inside deploy-service, which a standalone script
// cannot read, so ask Nomad instead: a job mid-deploy has a deployment
// whose status is still "running".
async function hasDeployInFlight(appName) {
  try {
    const deployments = await nomadGet(`/v1/job/${encodeURIComponent(appName)}/deployments`);
    return deployments.some((d) => d.Status === 'running');
  } catch (e) {
    // Unreachable/unknown means UNSAFE, not safe — refuse to stop.
    logger(`  ! could not check deployments for ${appName}: ${e.message}`);
    return true;
  }
}

// Same bot exclusion as the idle calculation itself — otherwise a single
// scanner hit inside the grace window would abort every stop, and the
// busiest-scanned apps (the newest ones) could never sleep at all.
function hadRecentTraffic(db, appName) {
  const rows = db
    .prepare('SELECT path, user_agent FROM request_log WHERE app_name = ? AND ts >= ?')
    .all(appName, Date.now() - RECENT_TRAFFIC_GRACE_SEC * 1000);
  return rows.some((r) => !isBotRequest({ userAgent: r.user_agent, path: r.path }));
}

// Snapshot of what the app's data looked like at the moment it was
// stopped. Two jobs: a rollback copy, and a manifest Step 4 can assert
// against before it declares a woken app healthy.
//
// That assertion is the point. An app that wakes to an empty DATA_DIR
// will usually just create a fresh database and report itself perfectly
// healthy — the user's data is gone and nothing alerts. Comparing file
// count and per-file sizes against this manifest catches exactly that.
//
// Written AFTER the job has stopped, when the files are quiescent: a
// plain copy of a live SQLite database can be torn, but a copy of a
// stopped one cannot.
//
// The snapshot root is a dot-prefixed sibling inside APP_DATA_ROOT. App
// names are /^[a-z0-9-]+$/, so a leading dot cannot ever collide with a
// real app's directory.
async function snapshotAppData(appName) {
  const dataDir = appDataPathFor(appName);
  const snapshotRoot = `${appDataPathFor('.snapshots')}/${appName}`;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${snapshotRoot}/${stamp}`;

  let entries;
  try {
    entries = await fsp.readdir(dataDir, { withFileTypes: true, recursive: true });
  } catch (e) {
    logger(`  ! no data directory for ${appName} (${e.code}) — nothing to snapshot`);
    return null;
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = `${entry.parentPath || entry.path}/${entry.name}`;
    const stat = await fsp.stat(full);
    files.push({ path: full.slice(dataDir.length + 1), bytes: stat.size });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  const manifest = {
    appName,
    stoppedAt: new Date().toISOString(),
    fileCount: files.length,
    totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
    files,
  };

  await fsp.mkdir(dest, { recursive: true });
  // cp -a, not a delete-then-copy: nothing in this file removes anything.
  await execFileAsync('cp', ['-a', `${dataDir}/.`, dest]);
  await fsp.writeFile(`${snapshotRoot}/latest-manifest.json`, JSON.stringify(manifest, null, 2));
  return { dest, manifest };
}

// Capture the app's Nomad job spec to disk BEFORE stopping it.
//
// This is a hard prerequisite for Step 4, not a nicety. deploy-service
// renders each job spec into a temp build directory, runs it, and
// deletes the file (server.js) — so after a deploy the ONLY copy of an
// app's spec lives inside Nomad's own state. `job_gc_threshold`
// (4h by default) garbage collects a STOPPED job out of that state, and
// at that moment the spec is gone for good: there is nothing left for an
// activator to `nomad job run`, and no way to recover the app short of a
// fresh deploy from source.
//
// So the window in which a stopped app can be woken is currently the GC
// threshold, and it closes silently. Writing the spec out here makes
// waking independent of Nomad's retention entirely.
//
// Before the stop, deliberately: `nomad job inspect` on an already-GC'd
// job returns nothing, and the whole point is to hold a copy that
// outlives GC. A capture failure ABORTS the stop — an app we cannot
// prove we can restart must not be stopped.
//
// `nomad job inspect` emits `{"Job": {...}}`, which is exactly what
// `nomad job run -json` accepts back, so no transformation is needed.
async function captureJobSpec(appName) {
  const specDir = appDataPathFor('.specs');
  const dest = `${specDir}/${appName}.json`;
  const { stdout } = await execFileAsync('nomad', ['job', 'inspect', appName]);

  // Guard against writing an empty or unparseable file over a good one:
  // a truncated spec would look like a successful capture and only fail
  // at wake time, which is the worst moment to discover it.
  const parsed = JSON.parse(stdout);
  if (!parsed.Job || parsed.Job.ID !== appName) {
    throw new Error(`inspect returned no Job for "${appName}"`);
  }

  await fsp.mkdir(specDir, { recursive: true });
  await fsp.writeFile(dest, stdout);
  return dest;
}

async function stopApp(appName) {
  // Belt and braces on top of the caller's own check: this function is
  // the one that shells out, so it re-asserts the rail itself rather
  // than trusting that every future caller remembered to.
  if (!STOPPABLE_APPS.includes(appName)) {
    throw new Error(`REFUSING to stop "${appName}" — not in STOPPABLE_APPS`);
  }
  // execFile with an argument array, never a shell string: no quoting or
  // interpolation, and no way for an app name to become extra flags.
  // Note there is no "-purge" here, and there must never be.
  await execFileAsync('nomad', ['job', 'stop', appName]);
}

function logger(line) {
  console.log(line);
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

  const apply = process.argv.includes('--apply');
  console.log(
    `Idle threshold: ${IDLE_THRESHOLD_MIN} min   ` +
      (apply
        ? `(APPLY — may stop: ${STOPPABLE_APPS.join(', ')})`
        : '(DRY RUN — nothing is stopped)') +
      '\n'
  );
  const width = Math.max(...rows.map((r) => r.appName.length), 12);
  for (const r of rows) {
    const name = r.appName.padEnd(width);
    if (r.idleMs === null) {
      const bots = botOnlyCountFor(db, r.appName);
      const suffix = bots > 0 ? `(${bots} automated hit(s) in 24h, no real traffic)` : '(no traffic at all)';
      console.log(`${name}  no real requests      ${suffix}`);
    } else if (r.wouldStop) {
      console.log(`${name}  idle for ${formatIdle(Math.floor(r.idleMs / 60000))}`.padEnd(width + 26) + '  WOULD STOP');
    } else {
      console.log(`${name}  active ${formatIdle(Math.floor(r.idleMs / 60000))} ago`.padEnd(width + 26) + '  would not stop');
    }
  }

  const stoppable = rows.filter((r) => r.wouldStop).length;

  if (!apply) {
    console.log(`\n${rows.length} app(s) checked, ${stoppable} would be stopped, 0 actually touched.`);
    return;
  }

  // Only rows that are BOTH idle and on the hardcoded rail get this far.
  const candidates = rows.filter((r) => r.wouldStop && STOPPABLE_APPS.includes(r.appName));
  const ignored = rows.filter((r) => r.wouldStop && !STOPPABLE_APPS.includes(r.appName));
  if (ignored.length > 0) {
    console.log(`\nIdle but NOT stoppable (not in STOPPABLE_APPS): ${ignored.map((r) => r.appName).join(', ')}`);
  }

  let stopped = 0;
  for (const row of candidates) {
    console.log(`\n--> ${row.appName}: idle, checking guards before stopping`);

    if (hadRecentTraffic(db, row.appName)) {
      console.log(`  ABORT — traffic within the last ${RECENT_TRAFFIC_GRACE_SEC}s`);
      continue;
    }
    if (await hasDeployInFlight(row.appName)) {
      console.log('  ABORT — a deploy is in flight');
      continue;
    }

    // Before the stop, and fatal to this app's stop if it fails: see
    // captureJobSpec. An app whose spec we could not save is an app we
    // could not wake once Nomad GCs the stopped job.
    try {
      const specPath = await captureJobSpec(row.appName);
      console.log(`  job spec saved -> ${specPath}`);
    } catch (e) {
      console.log(`  ABORT — could not save job spec (${e.message}); refusing to stop an app we may not be able to restart`);
      continue;
    }

    try {
      await stopApp(row.appName);
      console.log('  stopped');
    } catch (e) {
      console.log(`  STOP FAILED — ${e.message}`);
      continue;
    }

    // After the stop, so the files are quiescent. A snapshot failure is
    // reported loudly but does not undo the stop: the data is still
    // sitting in APP_DATA_ROOT either way, untouched by anything here.
    try {
      const snap = await snapshotAppData(row.appName);
      if (snap) {
        console.log(`  snapshot: ${snap.manifest.fileCount} file(s), ${snap.manifest.totalBytes} bytes -> ${snap.dest}`);
      }
    } catch (e) {
      console.log(`  WARNING — snapshot failed: ${e.message} (app is stopped; data is untouched)`);
    }
    stopped += 1;
  }

  console.log(`\n${rows.length} app(s) checked, ${candidates.length} eligible, ${stopped} stopped.`);
}

main().catch((e) => {
  console.error(`idle-report failed: ${e.message}`);
  process.exit(1);
});
