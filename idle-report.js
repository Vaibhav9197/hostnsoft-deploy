/**
 * Reports which apps are idle and, with --apply, stops them. Steps 2, 3
 * and 6 of docs/scale-to-zero-gated-plan.md, which has the guards and the
 * reasoning behind each.
 *
 * Never gains: `-purge` (a purged job cannot be woken) or any delete of
 * app data (that is server.js's DELETE endpoint alone).
 *
 * Run as the deploy-service user, NOT root — it opens the analytics DB
 * read-write, and root leaves root-owned -wal/-shm files behind.
 *
 *   node idle-report.js            # report only
 *   node idle-report.js --apply    # stop, allowlisted apps only
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const fsp = require('fs/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const { getDb, isAnalyticsEnabled } = require('./analytics/db');
const { appDataPathFor, specPathFor } = require('./nomad-job-spec');
const { isBotRequest } = require('./analytics/bot-filter');
const { imagesFromSpec, missingImages } = require('./scale-to-zero-images');
const { SCALE_TO_ZERO_APPS, SCALE_TO_ZERO_MODE } = require('./scale-to-zero-apps');
const { allApps } = require('./scale-to-zero-registry');

const NOMAD_ADDR = process.env.NOMAD_ADDR || 'http://127.0.0.1:4646';

// How long without a request before an app counts as idle. Same
// soft-override-with-a-default convention as IMAGE_RETAIN_COUNT and
// ORPHAN_TTL_MS. 30 minutes is a starting point for observation, NOT a
// tuned value — Step 5 of the plan is where a real threshold gets chosen
// from actual traffic patterns.
const IDLE_THRESHOLD_MIN = Number(process.env.IDLE_THRESHOLD_MIN) || 30;

// THE SAFETY RAIL. The code seed in scale-to-zero-apps.js plus anything
// that opted in at deploy time (scale-to-zero-registry.js). Loaded once
// per run in main(), before anything can consult it.
//
// Being on this list only means "may be considered". Every stop still has
// to pass the spec, image and DATA_DIR checks below, none of which this
// list can waive.
let STOPPABLE_APPS = SCALE_TO_ZERO_APPS;

// A last-moment re-check window. The idle threshold is measured in tens
// of minutes; this catches a request that landed between the report and
// the stop, which the threshold's own resolution would miss.
const RECENT_TRAFFIC_GRACE_SEC = Number(process.env.RECENT_TRAFFIC_GRACE_SEC) || 60;

// Every stop copies the whole data directory, so unbounded this grows
// without limit: 20h of soak on one trivial app produced 36 snapshots and
// 127MB. 3 rather than 1, so there is somewhere to go back to when the
// newest copy is the damaged one.
const SNAPSHOT_RETAIN_COUNT = Number(process.env.SNAPSHOT_RETAIN_COUNT) || 3;

// Nomad jobs that are part of the platform itself, not a customer app.
// Traefik and the static-server (the shared Caddy behind static apps —
// docs/Static-apps-req.md) are the ones that run as Nomad jobs
// (deploy-service and api-service run under pm2, so they never appear in
// /v1/jobs at all). Both are `type = "system"` jobs, which is what
// runningAppNames actually filters on — customer apps are always
// `type = "service"` — but naming them here too means a future platform
// job can't silently become a scale-to-zero candidate just by existing.
// On a shared host the static-server's name carries the environment
// prefix (e.g. "test-static-server"), hence the type check doing the work.
const PLATFORM_JOBS = new Set(['traefik', 'static-server']);

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
    .filter((j) => j.Status === 'running' && j.Type !== 'system')
    .map((j) => j.ID)
    .filter((id) => !PLATFORM_JOBS.has(id))
    .sort();
}

// "Last REAL request". A new app attracts scanner traffic within seconds
// of its first certificate, and counting that would keep every app awake
// forever. See analytics/bot-filter.js.
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

// A rollback copy plus a manifest Step 4 asserts against before serving a
// woken app — an app that wakes to an empty DATA_DIR usually just creates
// a fresh database and reports itself healthy.
//
// Written AFTER the stop, when the files are quiescent: a copy of a live
// SQLite database can be torn.
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
  await pruneSnapshots(snapshotRoot);
  return { dest, manifest };
}

/**
 * Every `server` task's DATA_DIR. An app on /alloc/data writes into the
 * allocation directory, which Nomad collects with a stopped job. A missing
 * DATA_DIR is fine — nothing to lose.
 */
function dataDirsFromSpec(spec) {
  const dirs = [];
  for (const group of spec?.Job?.TaskGroups || []) {
    for (const task of group.Tasks || []) {
      if (task?.Name !== 'server') continue;
      if (task?.Env && 'DATA_DIR' in task.Env) dirs.push(task.Env.DATA_DIR);
    }
  }
  return dirs;
}

/**
 * Filenames under the running allocation's /alloc/data, or null if it
 * cannot be determined — which callers must treat as unsafe.
 *
 * Via Nomad's filesystem API, not the disk: allocation directories are
 * root-owned 0700 and this runs as the deploy-service user.
 */
async function allocDataDirContents(appName) {
  try {
    const allocs = await nomadGet(`/v1/job/${encodeURIComponent(appName)}/allocations`);
    const running = allocs
      .filter((a) => a.ClientStatus === 'running')
      .sort((a, b) => a.CreateIndex - b.CreateIndex)
      .pop();
    if (!running) return null;

    const res = await fetch(
      `${NOMAD_ADDR}/v1/client/fs/ls/${running.ID}?path=${encodeURIComponent('alloc/data')}`
    );
    if (res.status === 404) return [];
    if (!res.ok) return null;
    const entries = await res.json();
    if (!Array.isArray(entries)) return null;
    return entries.map((e) => e.Name).filter((n) => n && n !== '.' && n !== '..');
  } catch {
    return null;
  }
}

// Capture the job spec BEFORE stopping. deploy-service deletes the
// rendered spec after running it, so Nomad's own state is the only copy —
// and job_gc_threshold (4h) collects a STOPPED job out of it, at which
// point the app can never be woken. A capture failure ABORTS the stop.
async function captureJobSpec(appName) {
  const dest = specPathFor(appName);
  const { stdout } = await execFileAsync('nomad', ['job', 'inspect', appName]);

  // Guard against writing an empty or unparseable file over a good one:
  // a truncated spec would look like a successful capture and only fail
  // at wake time, which is the worst moment to discover it.
  const parsed = JSON.parse(stdout);
  if (!parsed.Job || parsed.Job.ID !== appName) {
    throw new Error(`inspect returned no Job for "${appName}"`);
  }

  // The spec is worthless without the images it references. App images
  // are built locally and pushed to no registry, and Nomad's own docker
  // GC used to delete them ~3m after the job's allocations were
  // collected (now disabled in nomad.hcl) — so an app stopped with its
  // image already gone could never be started again, and the failure
  // surfaced as "pull access denied", nowhere near the real cause.
  //
  // Checked here, before the stop, and fatal: exactly the same rule as
  // saving the spec. Do not stop what you cannot restart.
  const missing = await missingImages(imagesFromSpec(parsed));
  if (missing.length > 0) {
    throw new Error(`image(s) not present on this host: ${missing.join(', ')}`);
  }

// The last "do not stop what you cannot restart" check, and the only one
// whose failure costs DATA rather than uptime.
//
// An old DATA_DIR is not by itself a reason to refuse — 28 of 36 apps were
// on /alloc/data and only 4 had a file in it. The question is whether
// anything is actually there. Read over Nomad's filesystem API since this
// runs unprivileged; "cannot tell" is treated as unsafe.
  const badDataDirs = dataDirsFromSpec(parsed).filter((d) => d !== '/data');
  if (badDataDirs.length > 0) {
    const contents = await allocDataDirContents(appName);
    if (contents === null) {
      throw new Error(
        `DATA_DIR is ${badDataDirs.join(', ')} (not /data) and its allocation directory could not be ` +
          `read, so whether stopping this app would destroy data is unknown — refusing`
      );
    }
    if (contents.length > 0) {
      throw new Error(
        `DATA_DIR is ${badDataDirs.join(', ')}, not /data, and holds ${contents.length} file(s) ` +
          `(${contents.slice(0, 3).join(', ')}${contents.length > 3 ? ', ...' : ''}). Nomad garbage ` +
          `collects that directory with a stopped job. Fix with ` +
          `Server-setup/apply-app-config.sh, which regenerates the spec onto the bind mount ` +
          `using api-service's stored config — no rebuild, no downtime. If its data is not ` +
          `already at APP_DATA_ROOT, copy it first with migrate-app-data.sh`
      );
    }
    logger(`  note: ${appName} is on ${badDataDirs.join(', ')} but its data directory is empty — nothing to lose`);
  }

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, stdout);
  return dest;
}

/**
 * Prune old snapshots. This file's rule that nothing here deletes app data
 * still holds: these are OUR copies under .snapshots/, never the app's own
 * directory. Narrow on purpose — only timestamp-named directories, so
 * latest-manifest.json cannot be caught by it.
 */
const SNAPSHOT_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}T[\d-]+Z$/;

async function pruneSnapshots(snapshotRoot) {
  let entries;
  try {
    entries = await fsp.readdir(snapshotRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const snapshots = entries
    .filter((e) => e.isDirectory() && SNAPSHOT_DIR_PATTERN.test(e.name))
    .map((e) => e.name)
    // The timestamp format sorts lexicographically in chronological
    // order, so this is oldest-first without parsing any dates.
    .sort();

  const doomed = snapshots.slice(0, Math.max(0, snapshots.length - SNAPSHOT_RETAIN_COUNT));
  for (const name of doomed) {
    try {
      await fsp.rm(`${snapshotRoot}/${name}`, { recursive: true, force: true });
    } catch (e) {
      logger(`  ! could not prune old snapshot ${name}: ${e.message}`);
    }
  }
  if (doomed.length > 0) {
    logger(`  pruned ${doomed.length} old snapshot(s), keeping ${SNAPSHOT_RETAIN_COUNT}`);
  }
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

  // Registry first: an app that opted in at deploy time is not in the code
  // seed, and reading it after the report was built would silently exclude
  // exactly the apps Step 7 exists to include.
  STOPPABLE_APPS = await allApps();

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

// Refresh every eligible app's spec, not just the one about to stop.
// Stop-time capture alone leaves a real app with no spec between joining
// the allowlist and its first stop. One inspect per app per run.
  // Collected and summarised rather than logged per app per pass: the
  // DATA_DIR refusal is permanent until an app is migrated, so at one run
  // every 10 minutes it was ~576 identical lines a day.
  const blocked = [];
  for (const row of rows) {
    if (!STOPPABLE_APPS.includes(row.appName)) continue;
    await captureJobSpec(row.appName).catch((e) => blocked.push([row.appName, e.message]));
  }
  if (blocked.length > 0) {
    const unmigrated = blocked.filter(([, m]) => m.includes('DATA_DIR'));
    const other = blocked.filter(([, m]) => !m.includes('DATA_DIR'));
    if (unmigrated.length > 0) {
      logger(
        `  ! ${unmigrated.length} app(s) can never be stopped until migrated off /alloc/data: ` +
          `${unmigrated.map(([n]) => n).join(', ')} — see Server-setup/migrate-app-data.sh`
      );
    }
    // Anything else is unexpected and stays per-app: a missing image or an
    // unreachable Nomad is a new problem, not a known backlog.
    for (const [name, msg] of other) logger(`  ! could not refresh saved spec for ${name}: ${msg}`);
  }

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
    const eligible = rows.filter((r) => r.wouldStop && STOPPABLE_APPS.includes(r.appName)).length;
    console.log(
      `\n${rows.length} app(s) checked, ${stoppable} idle past the threshold, ` +
        `${eligible} of those eligible (mode: ${SCALE_TO_ZERO_MODE}), 0 actually touched.`
    );
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
      console.log(`  ABORT — ${e.message}; refusing to stop an app we may not be able to restart`);
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
