/**
 * Which apps opted into scale-to-zero, and the Traefik routers that make a
 * stopped one reachable. Step 7 of docs/scale-to-zero-gated-plan.md.
 *
 * Opting in requires an authenticated deploy for that app, and being
 * listed only means "may be considered" — idle-report still re-checks image, spec and DATA_DIR
 * before every stop.
 *
 * The router file is rewritten wholesale, never appended to.
 */
const fs = require('fs-extra');
const path = require('path');

// BEFORE requiring nomad-job-spec, which fail-fasts at REQUIRE time on
// APPS_DOMAIN_SUFFIX/APP_DATA_ROOT. Loading dotenv further down — inside
// the require.main block at the bottom — is too late: the throw happens
// while this file's own requires are still being evaluated. Only when run
// directly; every caller loads its own .env first, and dotenv never
// overrides an already-set variable.
if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
}

const { appDataPathFor, specPathFor, defaultDomainFor, isPlatformHost, DNS01_CERT_RESOLVER, HTTP01_CERT_RESOLVER } =
  require('./nomad-job-spec');
const { SCALE_TO_ZERO_MODE, EXCLUDED_APPS } = require('./scale-to-zero-apps');

const NOMAD_ADDR = process.env.NOMAD_ADDR || 'http://127.0.0.1:4646';

const REGISTRY_PATH = `${appDataPathFor('.scale-to-zero')}/apps.json`;

// Traefik watches this directory (providers.file.directory). server-setup.sh
// writes platform.yml there and owns it; this file is ours alone, so the two
// can never overwrite each other.
const TRAEFIK_DYNAMIC_DIR = process.env.TRAEFIK_DYNAMIC_DIR || '/opt/traefik/dynamic';
const ROUTER_FILE = `${TRAEFIK_DYNAMIC_DIR}/scale-to-zero.yml`;

// MUST match staticRouterFilePath() in traefik-router-file.js. Duplicated
// rather than imported because that module fail-fasts at require time on
// STATIC_SERVER_PORT/STATIC_ORPHAN_PROXY_PORT, which a host without static
// sites configured does not set — importing it would take scale-to-zero
// down on exactly the hosts that have nothing to do with static sites.
// If the filename convention changes there, change it here too.
function staticRouterFilePathFor(appName) {
  return `${TRAEFIK_DYNAMIC_DIR}/static-${appName}.yml`;
}

// Must match the service name server-setup.sh defines in platform.yml. The
// file provider merges every file in the directory into one configuration,
// so a router here can reference a service defined there.
const ACTIVATOR_SERVICE = process.env.ACTIVATOR_SERVICE_NAME || 'scale-to-zero-activator';

const APPS_DOMAIN_SUFFIX = process.env.APPS_DOMAIN_SUFFIX;

// A wake router's priority. FALLBACK sits below the ~25-44 Traefik derives
// for the app's own router from its rule length, so a running app is
// reached directly. HOLD sits above it (and far below the platform's own
// 10000/10100), so the activator is in front: used from just before a stop
// until the app is awake again. server-setup.md#s2z-routers
const FALLBACK_PRIORITY = 1;
const HOLD_PRIORITY = 500;

// Which apps are stopping or asleep, one file per app rather than a field
// in apps.json: idle-report, the activator and deploy-service all write it,
// and a whole-file read-modify-write between three processes loses
// updates. Writing or removing one file is atomic on its own.
const SLEEP_STATE_DIR = `${appDataPathFor('.scale-to-zero')}/sleep`;

// A 'stopping' record this old was left by an idle-report run that died
// mid-stop, and nothing else will ever clear it. Read as 'asleep' from then
// on. Generous because the snapshot copies the whole data directory.
const STOPPING_STALE_MS = Number(process.env.STOPPING_STALE_MS) || 10 * 60 * 1000;

// How long Traefik takes to apply a rewrite of the router file. Its file
// watcher fires at once, but providersThrottleDuration (2s by default)
// holds each provider's update back. Traefik's API is not enabled on these
// hosts, so this is a wait rather than a check.
const WAKE_ROUTER_SETTLE_MS = Number(process.env.WAKE_ROUTER_SETTLE_MS) || 3000;

async function readRegistry() {
  try {
    const raw = await fs.readFile(REGISTRY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.apps === 'object' ? parsed : { apps: {} };
  } catch (e) {
    // A missing registry is the normal state on a box where nobody has
    // opted in. A CORRUPT one is not, and must not silently read as empty —
    // that would drop every opted-in app's routers on the next regenerate,
    // making live apps unreachable the moment one of them is stopped.
    if (e.code === 'ENOENT') return { apps: {} };
    throw new Error(`scale-to-zero registry at ${REGISTRY_PATH} is unreadable: ${e.message}`);
  }
}

async function writeRegistry(reg) {
  await fs.ensureDir(path.dirname(REGISTRY_PATH));
  // Write-then-rename: a crash mid-write leaves the old registry intact
  // rather than a truncated file that readRegistry would refuse.
  const tmp = `${REGISTRY_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(reg, null, 2));
  await fs.rename(tmp, REGISTRY_PATH);
}

/**
 * Apps with a saved job spec — every app scale-to-zero has ever stopped.
 *
 * Essential in universal mode: a SLEEPING app is not a running Nomad job,
 * so enumerating running jobs alone drops it from the wakeable set the
 * moment it sleeps, and the activator then 404s its hostname. A saved spec
 * is the durable record that we stopped this app and must be able to wake
 * it.
 */
async function appsWithSavedSpec() {
  try {
    const dir = appDataPathFor('.specs');
    const files = await fs.readdir(dir);
    return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

// Type !== 'system' drops the platform's OWN jobs — Traefik and the shared
// static-server — the same test idle-report.js applies. Without it universal
// mode enrols them as if they were customer apps: a wake router gets written
// for a hostname no app owns, and the activator believes it can start a
// platform job.
//
// The type check, not a name in EXCLUDED_APPS, because the static-server's
// job name carries the environment prefix (prod-static-server,
// test-static-server) while EXCLUDED_APPS holds bare names — a name-based
// exclusion silently misses it on every environment. These two functions
// must keep answering "is this a customer app?" the same way; they disagreed
// once and that is what this comment exists to prevent.
async function runningJobNames() {
  const res = await fetch(`${NOMAD_ADDR}/v1/jobs`);
  if (!res.ok) throw new Error(`Nomad /v1/jobs -> ${res.status}`);
  const jobs = await res.json();
  return jobs
    .filter((j) => j.Status === 'running' && j.Stop !== true && j.Type !== 'system')
    .map((j) => j.ID);
}

/**
 * allowlist: the opt-ins. universal: every running app minus the
 * exclusions and opt-outs, plus the opt-ins.
 */
async function allApps() {
  const reg = await readRegistry();
  const optedIn = Object.entries(reg.apps).filter(([, v]) => !v.optedOut).map(([k]) => k);
  const base = new Set(optedIn);

  if (SCALE_TO_ZERO_MODE !== 'universal') return [...base].sort();

  let running;
  try {
    running = await runningJobNames();
  } catch (e) {
    logger(`universal mode: could not list jobs (${e.message}), falling back to the allowlist`);
    return [...base].sort();
  }

  const optedOut = new Set(Object.entries(reg.apps).filter(([, v]) => v.optedOut).map(([k]) => k));
  // Running jobs AND anything we have a saved spec for. A sleeping app is
  // in the second set only, and omitting it is what made 35 apps
  // unreachable on 2026-09-24.
  for (const name of [...running, ...(await appsWithSavedSpec())]) {
    if (EXCLUDED_APPS.includes(name)) continue;
    if (optedOut.has(name)) continue;
    base.add(name);
  }
  return [...base].sort();
}

function logger(line) {
  console.log(`${new Date().toISOString()} [scale-to-zero] ${line}`);
}

// A tmp name no other write can share, in this process or another: the
// pid alone collides between two writes in flight in the same process.
// Ends in .tmp, so Traefik never loads one as config.
let tmpSeq = 0;
function uniqueTmpPath(file) {
  tmpSeq += 1;
  return `${file}.${process.pid}-${tmpSeq}.tmp`;
}

function sleepStatePath(appName) {
  return `${SLEEP_STATE_DIR}/${appName}.json`;
}

function normalizeSleepState(record) {
  if (record.state === 'stopping' && !(Date.now() - Date.parse(record.since) < STOPPING_STALE_MS)) {
    return { ...record, state: 'asleep', stale: true };
  }
  return record;
}

/**
 * { state: 'stopping' | 'asleep', since }, or null for an app that is
 * neither. An unreadable record reads as 'asleep': that keeps the
 * activator in front, which costs a hop, where dropping it would cost the
 * 502 this exists to prevent.
 */
async function readSleepState(appName) {
  try {
    return normalizeSleepState(JSON.parse(await fs.readFile(sleepStatePath(appName), 'utf8')));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    return { state: 'asleep', since: null, unreadable: true };
  }
}

async function writeSleepState(appName, state) {
  await fs.ensureDir(SLEEP_STATE_DIR);
  const file = sleepStatePath(appName);
  const tmp = uniqueTmpPath(file);
  await fs.writeFile(tmp, JSON.stringify({ state, since: new Date().toISOString() }));
  await fs.rename(tmp, file);
}

async function clearSleepState(appName) {
  await fs.remove(sleepStatePath(appName));
}

async function sleepStates() {
  let files;
  try {
    files = await fs.readdir(SLEEP_STATE_DIR);
  } catch {
    return new Map();
  }
  const states = new Map();
  for (const f of files.filter((name) => name.endsWith('.json'))) {
    const appName = f.slice(0, -5);
    const record = await readSleepState(appName);
    if (record) states.set(appName, record);
  }
  return states;
}

// Host -> priority, as scale-to-zero.yml has it NOW. Read back rather than
// taken from what regenerateRouters wrote: another process may have
// rewritten the file since.
async function wakeRouterPriorities() {
  let text;
  try {
    text = await fs.readFile(ROUTER_FILE, 'utf8');
  } catch {
    return new Map();
  }
  const priorities = new Map();
  let host = null;
  for (const line of text.split(/\r?\n/)) {
    const rule = line.match(/rule: "Host\(`([^`]+)`\)"/);
    if (rule) host = rule[1];
    const priority = line.match(/^\s+priority: (\d+)\s*$/);
    if (priority && host) {
      priorities.set(host, Number(priority[1]));
      host = null;
    }
  }
  return priorities;
}

/**
 * Every hostname an app answers on, from its saved job spec — a custom
 * domain is exactly what a name cannot tell you, and a stopped app with no
 * router for it 404s on someone's real domain.
 */
async function hostnamesFor(appName) {
  const fallback = APPS_DOMAIN_SUFFIX ? [defaultDomainFor(appName)] : [];
  let spec;
  try {
    spec = await fs.readFile(specPathFor(appName), 'utf8');
  } catch {
    return fallback;
  }
  const hosts = new Set(fallback);
  for (const m of spec.matchAll(/Host\(`([^`]+)`\)/g)) hosts.add(m[1]);
  return [...hosts].sort();
}

// A backtick as a plain constant rather than an escape inside a template
// literal. Traefik's Host() rule requires backticks, and escaping one
// inside a template literal is exactly the mistake that has now broken
// this codebase twice — once in an HCL comment that silently terminated a
// template literal and took deploy-service down, and once here.
const BT = String.fromCharCode(96);

function routerBlock(name, host, service, priority) {
  // Custom domains are not in this platform's Cloudflare zone, so they can
  // only be issued over HTTP-01 — the same split the app's own router uses.
  const resolver =
    APPS_DOMAIN_SUFFIX && isPlatformHost(host) ? DNS01_CERT_RESOLVER : HTTP01_CERT_RESOLVER;
  return [
    `    ${name}:`,
    `      rule: "Host(${BT}${host}${BT})"`,
    '      entryPoints:',
    '        - websecure',
    `      service: ${service}`,
    // FALLBACK_PRIORITY or HOLD_PRIORITY — see where they are defined.
    `      priority: ${priority}`,
    '      tls:',
    `        certResolver: ${resolver}`,
    '',
  ].join('\n');
}

/**
 * Rewrite the router file. Traefik watches the directory, so this applies
 * within seconds with no restart — which is why Step 7 needed the
 * directory provider.
 */
async function regenerateRouters() {
  const apps = await allApps();

  // An 'asleep' record for a job that is running again (redeployed, or
  // started by hand) would keep it behind the activator for good, and one
  // for an app no longer listed is litter. Never a 'stopping' one:
  // idle-report sets it while the job is still running, on purpose. If
  // Nomad cannot be asked, every record stays — a stale hold costs a hop
  // through the activator, a missing one costs the 502.
  const states = await sleepStates();
  const running = await runningJobNames().catch(() => null);
  if (running) {
    for (const [appName, record] of states) {
      if (record.state === 'stopping') continue;
      if (running.includes(appName) || !apps.includes(appName)) {
        await clearSleepState(appName);
        states.delete(appName);
      }
    }
  }

  const lines = [
    '# GENERATED by deploy-service (scale-to-zero-registry.js). Do not edit.',
    '# One router per HOSTNAME for every app opted into scale-to-zero, so a',
    '# stopped app reaches the activator instead of returning 404.',
    '# Rewritten in full on every change; server-setup.sh owns platform.yml',
    '# in this directory and never touches this file.',
    'http:',
    '  routers:',
  ];

  let count = 0;
  for (const appName of apps) {
    // A static app has no Nomad job to wake, so a wake router for it can
    // only do harm. This matters most for an app that MIGRATED from a
    // service: the old job was purged, and a purged job can never be
    // woken, so the activator would hold real traffic waiting on
    // something that cannot start.
    //
    // The test is the presence of the static router file rather than a
    // call into static-site.js: that module fail-fasts at require time
    // when STATIC_SITES_ROOT is unset, which would break scale-to-zero
    // entirely on a host where static sites are not configured. The file
    // is also the more direct question — "does something else already
    // route this hostname".
    if (await fs.pathExists(staticRouterFilePathFor(appName))) {
      logger(`skipping ${appName}: served statically, no job to wake`);
      continue;
    }
    const priority = states.has(appName) ? HOLD_PRIORITY : FALLBACK_PRIORITY;
    for (const host of await hostnamesFor(appName)) {
      // Router names must be unique across the whole file provider, and a
      // hostname can contain dots which read badly in Traefik's dashboard.
      lines.push(
        routerBlock(`wake-${host.replace(/[^a-z0-9-]/gi, '-')}`, host, ACTIVATOR_SERVICE, priority)
      );
      count += 1;
    }
  }

  // No routers at all still writes a file, so a stale one never lingers
  // and keeps routing removed apps at the activator — but it must NOT
  // contain an `http:` block. Traefik rejects `routers: {}` ("routers
  // cannot be a standalone element"), and one bad file in the dynamic
  // directory drops EVERY file in it, platform.yml included: shipyard and
  // api-service become 404 until the file is fixed. Seen 2026-09-30 on
  // the local VM. A comment-only file parses cleanly.
  if (count === 0) {
    lines.splice(-2, 2,
      '# No app is opted into scale-to-zero right now, so there is nothing',
      '# to route. Deliberately no `http:` block: Traefik rejects an empty',
      '# routers map and takes every other file in this directory with it.');
  }

  await fs.ensureDir(TRAEFIK_DYNAMIC_DIR);
  // idle-report and the activator rewrite this file too now, alongside
  // deploy-service's concurrent deploys, and two writers sharing one tmp
  // can rename a half-written file into place — which Traefik rejects,
  // taking platform.yml with it. See uniqueTmpPath.
  const tmp = uniqueTmpPath(ROUTER_FILE);
  await fs.writeFile(tmp, `${lines.join('\n')}\n`);
  await fs.rename(tmp, ROUTER_FILE);
  return { apps: apps.length, routers: count };
}

async function optIn(appName) {
  const reg = await readRegistry();
  reg.apps[appName] = {
    optedInAt: new Date().toISOString(),
    // Recorded for auditing only. hostnamesFor() re-reads the spec every
    // time routers are generated, so a custom domain added later is picked
    // up without the app having to opt in again.
    hostnames: await hostnamesFor(appName),
  };
  await writeRegistry(reg);
  return regenerateRouters();
}

/**
 * X-Scale-To-Zero: false. A RECORD, not a deletion — in universal mode a
 * missing entry means eligible, so removing it would re-enrol the app.
 */
async function setOptedOut(appName) {
  const reg = await readRegistry();
  reg.apps[appName] = { optedOut: true, optedOutAt: new Date().toISOString() };
  await writeRegistry(reg);
  return regenerateRouters();
}

/**
 * Forget an app entirely, for a DELETED app. Distinct from setOptedOut:
 * this one means "gone", and leaving anything behind would keep a router
 * pointing at a hostname nothing serves.
 *
 * Removes everything the wake path reads — registry entry, sleep record,
 * saved spec — and always regenerates the router file. In universal mode
 * most apps have no registry entry (allApps() lists them from the saved
 * spec), so the regenerate must not depend on an entry being present.
 */
async function forget(appName) {
  const reg = await readRegistry();
  const hadEntry = appName in reg.apps;
  if (hadEntry) {
    delete reg.apps[appName];
    await writeRegistry(reg);
  }
  // Spec and sleep record go before the regenerate, so the rewrite no
  // longer sees the app.
  await clearSleepState(appName);
  await fs.remove(specPathFor(appName));
  const result = await regenerateRouters();
  return { ...result, hadEntry };
}

/**
 * Carry an app's registry entry across a rename.
 *
 * Distinct from optIn + forget, and the difference is the whole point: an
 * entry may be an opt-OUT record, and `optIn` would rewrite it into an
 * opt-in. In universal mode a missing entry reads as eligible, so losing
 * an opt-out to a rename silently re-enrols an app whose owner asked to be
 * left alone — the same reasoning setOptedOut is built on.
 *
 * The entry is copied verbatim apart from `hostnames`, which is re-derived
 * because every hostname changed. An app with no entry is not an error:
 * in universal mode most eligible apps have never been recorded at all.
 */
async function rekey(oldName, newName) {
  const reg = await readRegistry();
  if (!(oldName in reg.apps)) return null;
  const entry = reg.apps[oldName];
  delete reg.apps[oldName];
  reg.apps[newName] = {
    ...entry,
    ...(entry.hostnames ? { hostnames: await hostnamesFor(newName) } : {}),
    renamedFrom: oldName,
    renamedAt: new Date().toISOString(),
  };
  await writeRegistry(reg);
  return regenerateRouters();
}

/**
 * Put the activator in front of an app that is about to be stopped, and
 * confirm it. Returns what is wrong; empty means the stop may go ahead.
 *
 * Must happen BEFORE the stop. Traefik's Nomad provider only polls, so the
 * app's own router outlives the job by up to one refresh interval, and
 * while it does it outranks a priority-1 wake router and points at a dead
 * allocation: an instant 502 that never reaches the activator (EAI-61).
 * Raised first, the wake router wins while the app is still up — the
 * activator proxies to it until the stop, then holds requests until it can
 * be woken — so there is no moment Traefik routes to a dead allocation.
 *
 * The file is read back rather than trusted, and every hostname must be at
 * HOLD_PRIORITY. That also covers "no wake router at all": stopped, such
 * an app 404s instead (daily-mandala, 2026-10-11).
 */
async function holdForStop(appName) {
  await writeSleepState(appName, 'stopping');
  await regenerateRouters();
  const hosts = await hostnamesFor(appName);
  if (hosts.length === 0) return [`no hostnames known for ${appName}`];

  const priorities = await wakeRouterPriorities();
  const problems = [];
  for (const host of hosts) {
    if (!priorities.has(host)) problems.push(`no wake router for ${host}`);
    else if (priorities.get(host) !== HOLD_PRIORITY) {
      problems.push(`wake router for ${host} is at priority ${priorities.get(host)}, not ${HOLD_PRIORITY}`);
    }
  }
  if (problems.length === 0) await new Promise((r) => setTimeout(r, WAKE_ROUTER_SETTLE_MS));
  return problems;
}

/**
 * The stop is done and the snapshot written. The router stays where
 * holdForStop put it; what changes is that the activator stops holding
 * requests and may wake the app.
 */
async function markAsleep(appName) {
  await writeSleepState(appName, 'asleep');
}

/** The stop did not happen after all: back to reaching the app directly. */
async function releaseHold(appName) {
  await clearSleepState(appName);
  return regenerateRouters();
}

/**
 * The app is running again: drop its wake router back below the app's own
 * router, so its traffic goes direct. Safe however long Traefik takes to
 * notice either change — until it sees the app's own router, requests fall
 * through to the activator, which proxies to the running app.
 *
 * Only an 'asleep' record. A 'stopping' one belongs to an idle-report run
 * that is about to stop this app, and needs the hold it set.
 */
async function markAwake(appName) {
  const record = await readSleepState(appName);
  if (!record || record.state !== 'asleep') return false;
  await clearSleepState(appName);
  await regenerateRouters();
  return true;
}

// Run directly to rewrite the router file: `node scale-to-zero-registry.js`.
// Called by both server-setup.sh and redeploy.sh after .env exists, so the
// routers are regenerated on every deploy rather than only on a
// re-provision. dotenv is loaded at the TOP of this file — see the note
// there for why it cannot live in this block.
if (require.main === module) {
  regenerateRouters()
    .then((r) => console.log(`scale-to-zero: ${r.routers} router(s) for ${r.apps} app(s) -> ${ROUTER_FILE}`))
    .catch((e) => {
      console.error(`scale-to-zero: could not write routers: ${e.message}`);
      process.exit(1);
    });
}

module.exports = {
  REGISTRY_PATH,
  ROUTER_FILE,
  readRegistry,
  allApps,
  hostnamesFor,
  regenerateRouters,
  optIn,
  setOptedOut,
  forget,
  rekey,
  readSleepState,
  holdForStop,
  markAsleep,
  releaseHold,
  markAwake,
};
