/**
 * scale-to-zero-registry.js — Step 7 of docs/scale-to-zero-gated-plan.md.
 *
 * Which apps have opted into scale-to-zero, and the Traefik routers that
 * make a stopped one reachable.
 *
 * Steps 3-6 used a frozen array in scale-to-zero-apps.js: widening it was a
 * reviewed code change plus a re-provision, which is exactly the friction
 * those steps wanted. Step 7 is where an app opts in at deploy time
 * instead, so the list has to become data. Three things keep that from
 * being a straight loss of safety:
 *
 *   - The seed list still exists and is still code. The registry can only
 *     ADD to it, never remove from it.
 *   - Opting in requires an authenticated deploy for that app. There is no
 *     endpoint that adds an arbitrary name.
 *   - Nothing here decides whether an app may be STOPPED. idle-report.js
 *     still re-checks, per stop, that the image exists, the spec saved, and
 *     DATA_DIR is not an allocation directory. Being in this file only
 *     means "allowed to be considered".
 *
 * The router file is regenerated wholesale from the registry rather than
 * appended to, so the file always matches the registry exactly and a
 * half-written previous state cannot survive.
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

const { appDataPathFor, specPathFor, defaultDomainFor, DNS01_CERT_RESOLVER, HTTP01_CERT_RESOLVER } =
  require('./nomad-job-spec');
const {
  SCALE_TO_ZERO_APPS, SCALE_TO_ZERO_MODE, EXCLUDED_APPS, WEBSOCKET_LOOKBACK_DAYS, isAlwaysFront,
} = require('./scale-to-zero-apps');

const NOMAD_ADDR = process.env.NOMAD_ADDR || 'http://127.0.0.1:4646';

const REGISTRY_PATH = `${appDataPathFor('.scale-to-zero')}/apps.json`;

// Traefik watches this directory (providers.file.directory). server-setup.sh
// writes platform.yml there and owns it; this file is ours alone, so the two
// can never overwrite each other.
const TRAEFIK_DYNAMIC_DIR = process.env.TRAEFIK_DYNAMIC_DIR || '/opt/traefik/dynamic';
const ROUTER_FILE = `${TRAEFIK_DYNAMIC_DIR}/scale-to-zero.yml`;

// Must match the service name server-setup.sh defines in platform.yml. The
// file provider merges every file in the directory into one configuration,
// so a router here can reference a service defined there.
const ACTIVATOR_SERVICE = process.env.ACTIVATOR_SERVICE_NAME || 'scale-to-zero-activator';

const APPS_DOMAIN_SUFFIX = process.env.APPS_DOMAIN_SUFFIX;

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
 * Apps that have served an HTTP 101 recently — WebSocket apps, which must
 * never be put to sleep automatically.
 *
 * This is the failure mode universal mode introduces that the allowlist
 * never exposed. Idle detection reads Traefik's access log, and Traefik
 * logs a WebSocket request only when the connection CLOSES. So an app with
 * a room full of users connected for six hours produces NO log line at all
 * and reads as completely idle. Stopping it drops every live connection.
 *
 * Returns null if analytics is unavailable — which callers must treat as
 * "cannot tell", not "none".
 */
function websocketApps() {
  try {
    // Required lazily: analytics is optional, and a box without it must
    // still be able to load this module.
    const { getDb, isAnalyticsEnabled } = require('./analytics/db');
    if (!isAnalyticsEnabled()) return null;
    const since = Date.now() - WEBSOCKET_LOOKBACK_DAYS * 86400000;
    const rows = getDb()
      .prepare('SELECT DISTINCT app_name FROM request_log WHERE status = 101 AND ts >= ?')
      .all(since);
    return new Set(rows.map((r) => r.app_name));
  } catch {
    return null;
  }
}

async function runningJobNames() {
  const res = await fetch(`${NOMAD_ADDR}/v1/jobs`);
  if (!res.ok) throw new Error(`Nomad /v1/jobs -> ${res.status}`);
  const jobs = await res.json();
  return jobs.filter((j) => j.Status === 'running' && j.Stop !== true).map((j) => j.ID);
}

/**
 * Every app allowed to scale to zero.
 *
 * allowlist mode: the code seed plus anything that opted in.
 * universal mode: every running app, minus the exclusions.
 *
 * The seed is always included and can never be excluded by data — it is
 * the floor, and the only part of this that a bad registry or an
 * unreachable Nomad cannot take away.
 */
async function allApps() {
  const reg = await readRegistry();
  const optedIn = Object.entries(reg.apps).filter(([, v]) => !v.optedOut).map(([k]) => k);
  const base = new Set([...SCALE_TO_ZERO_APPS, ...optedIn]);

  if (SCALE_TO_ZERO_MODE !== 'universal') return [...base].sort();

  const ws = websocketApps();
  if (ws === null) {
    // Cannot tell which apps hold WebSocket connections, so cannot safely
    // enrol anything new. Falls back to exactly what allowlist mode would
    // do rather than guessing — the alternative is dropping live
    // connections on an app nobody opted in.
    logger('universal mode: analytics unavailable, falling back to the allowlist');
    return [...base].sort();
  }

  let running;
  try {
    running = await runningJobNames();
  } catch (e) {
    logger(`universal mode: could not list jobs (${e.message}), falling back to the allowlist`);
    return [...base].sort();
  }

  const optedOut = new Set(Object.entries(reg.apps).filter(([, v]) => v.optedOut).map(([k]) => k));
  for (const name of running) {
    if (EXCLUDED_APPS.includes(name)) continue;
    if (optedOut.has(name)) continue;
    if (ws.has(name)) continue;
    base.add(name);
  }
  return [...base].sort();
}

function logger(line) {
  console.log(`${new Date().toISOString()} [scale-to-zero] ${line}`);
}

/**
 * Every hostname an app answers on, read from its saved Nomad job spec.
 *
 * From the spec rather than from the app name, because a custom domain is
 * exactly the case a name cannot tell you about — and a stopped app with a
 * custom domain and no router for it 404s on someone's real domain with no
 * wake and nothing in any log. That gap is why `focus` was kept out of the
 * Step 6 allowlist; generating per hostname is what closes it.
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

function routerBlock(name, host, service, alwaysFront) {
  // Custom domains are not in this platform's Cloudflare zone, so they can
  // only be issued over HTTP-01 — the same split the app's own router uses.
  const resolver =
    APPS_DOMAIN_SUFFIX && host.endsWith(`.${APPS_DOMAIN_SUFFIX}`)
      ? DNS01_CERT_RESOLVER
      : HTTP01_CERT_RESOLVER;
  return [
    `    ${name}:`,
    `      rule: "Host(${BT}${host}${BT})"`,
    '      entryPoints:',
    '        - websecure',
    `      service: ${service}`,
    // 500 keeps the activator PERMANENTLY in front, closing the post-stop
    // 502 window entirely — but it also puts the activator in the path of
    // that app's every request. Reserved for the seed apps, which have run
    // that way since 2026-09-21 and are proven.
    //
    // 1 is BELOW the ~25-44 Traefik derives from an app router's rule
    // length, so a running app is reached directly and the activator only
    // catches the hostname once the app is stopped. That reintroduces a
    // ~5s window after each stop where Traefik still points at a dead
    // allocation, and is the deliberate trade for not making the activator
    // the front door for the whole fleet.
    alwaysFront ? '      priority: 500' : '      priority: 1',
    '      tls:',
    `        certResolver: ${resolver}`,
    '',
  ].join('\n');
}

/**
 * Rewrite the router file from the registry. Idempotent, and safe to call
 * when nothing has changed.
 *
 * Traefik watches the directory, so this takes effect within seconds with
 * no restart and no server-setup.sh run — which is the whole reason Step 7
 * needed the directory provider rather than a single file.
 */
async function regenerateRouters() {
  const apps = await allApps();
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
    for (const host of await hostnamesFor(appName)) {
      // Router names must be unique across the whole file provider, and a
      // hostname can contain dots which read badly in Traefik's dashboard.
      lines.push(
        routerBlock(`wake-${host.replace(/[^a-z0-9-]/gi, '-')}`, host, ACTIVATOR_SERVICE, isAlwaysFront(appName))
      );
      count += 1;
    }
  }

  // No routers at all still writes a valid document: an empty `routers:`
  // key would be invalid YAML for Traefik to parse, and leaving a stale
  // file behind would keep routing removed apps at the activator.
  if (count === 0) lines.push('    {}');

  await fs.ensureDir(TRAEFIK_DYNAMIC_DIR);
  const tmp = `${ROUTER_FILE}.tmp`;
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
 * Mark an app as never eligible, for `X-Scale-To-Zero: false`.
 *
 * A RECORD, not a deletion. In universal mode an app is eligible by
 * default, so removing its entry would silently re-enrol it on the next
 * pass — the opposite of what its owner asked for. The entry has to
 * persist to say "no".
 */
async function setOptedOut(appName) {
  const reg = await readRegistry();
  reg.apps[appName] = { optedOut: true, optedOutAt: new Date().toISOString() };
  await writeRegistry(reg);
  return regenerateRouters();
}

/**
 * Forget an app entirely, for a DELETED app. Distinct from setOptedOut:
 * this one means "gone", and leaving an entry behind would keep a router
 * pointing at a hostname nothing serves.
 */
async function forget(appName) {
  const reg = await readRegistry();
  if (!(appName in reg.apps)) return null;
  delete reg.apps[appName];
  await writeRegistry(reg);
  return regenerateRouters();
}

function isSeedApp(appName) {
  return SCALE_TO_ZERO_APPS.includes(appName);
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
  isSeedApp,
};
