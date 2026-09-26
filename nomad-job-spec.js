/**
 * nomad-job-spec.js
 *
 * Builds an app's Nomad job spec (Traefik tags included) — shared between
 * the initial deploy path (server.js's POST /apps, after a fresh build)
 * and the custom-domain config-update path (POST
 * /internal/apps/:appName/config, no build involved), so both stay in
 * sync instead of duplicating router-generation logic. See
 * docs/Customdomain-req.md.
 *
 * Two cert resolvers, deliberately kept separate (constraint #1):
 * - DNS-01 ("cloudflare") for the platform's own *.<APPS_DOMAIN_SUFFIX> (e.g. *.embarko.app)
 *   router — DNS-01 needs write access to the DNS zone, which the
 *   platform only has for its own domain.
 * - HTTP-01 ("letsencrypt-http") for every client custom domain — works
 *   for any domain pointed at this server regardless of who controls its
 *   DNS zone, at the cost of needing port 80 reachable for the ACME
 *   challenge path. The Traefik STATIC config defining this resolver
 *   must already exist on the server — this file only emits tags that
 *   reference it by name; it does not (and cannot, from application
 *   code) create the resolver itself. See the custom-domains rollout
 *   notes for that manual infra step.
 */
const logger = require('./logger');

const DNS01_CERT_RESOLVER = 'cloudflare';
const HTTP01_CERT_RESOLVER = 'letsencrypt-http';

// Applied to every app's router(s) below via a Traefik headers
// middleware — see securityHeadersMiddlewareTags(). This platform sets
// NO response headers of its own otherwise; what a browser actually sees
// today is whatever the app's own container happens to set (for a
// static build, that's Railpack's built-in Caddy default — confirmed by
// diffing a live response against Railpack's own Caddyfile.template on
// GitHub). That upstream default is missing 'wasm-unsafe-eval' from
// script-src, which breaks any WASM app (Godot/Unity/Emscripten/
// Rust-wasm exports are static builds, so they hit exactly this path)
// with a CompileError and a blank page — WebAssembly.compile requires
// this directive, it isn't covered by 'unsafe-inline' or 'unsafe-eval'.
// Otherwise byte-identical to Railpack's default, so this is a strict
// superset: nothing that worked before stops working.
//
// Confirmed Traefik's headers middleware REPLACES a same-name header
// already set by the backend rather than adding a second one — if it
// instead produced two Content-Security-Policy headers, browsers
// enforce the INTERSECTION of both policies, which would silently drop
// 'wasm-unsafe-eval' again and defeat this fix without looking broken
// under a plain `curl -I` check.
//
// Trade-off worth knowing: this now takes precedence over any CSP an
// app might try to set for itself (e.g. via its own Caddyfile) — not a
// concern today since nothing at this layer previously supported a
// per-app override anyway, but worth remembering if that's ever wanted.
const DEFAULT_CSP =
  "default-src 'self'; img-src 'self' data: https: *; style-src 'self' 'unsafe-inline' https: *; " +
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https: *; font-src 'self' data: https: *; " +
  "connect-src 'self' https: *; media-src 'self' https: *; object-src 'none'; frame-src 'self' https: *;";

function securityHeadersMiddlewareName(appName) {
  return `${appName}-security-headers`;
}

function securityHeadersMiddlewareTags(appName) {
  const name = securityHeadersMiddlewareName(appName);
  return [`traefik.http.middlewares.${name}.headers.customResponseHeaders.Content-Security-Policy=${DEFAULT_CSP}`];
}

// PORT/APP_NAME/APP_VERSION/DATA_DIR are set by this platform itself and
// must never be overridable by a project's own configured env vars — an
// override could break how the app is actually reached (wrong port) or
// how its data persists (wrong directory). Silently dropped (with a
// warning) rather than erroring, so one stray reserved-name env var
// doesn't block every future deploy of that project.
const RESERVED_ENV_KEYS = new Set(['PORT', 'APP_NAME', 'APP_VERSION', 'DATA_DIR']);

// Nomad job specs interpolate ${...} sequences at parse/apply time (see
// e.g. ${NOMAD_PORT_http} below) — a user-supplied env var value that
// happens to literally contain "${" would otherwise either break job
// submission (unknown interpolation variable) or resolve to something
// never intended. "$${" is Nomad's own escape for a literal "${" in the
// output, so this neutralizes it rather than passing it through raw.
// hostnsoft-api's envVars.routes.ts is the actual enforcement point for
// `key` (restricted to safe identifier syntax there, since it's embedded
// as a bare unquoted attribute name here, not a quoted string) — this
// only needs to handle `value`.
function escapeHclStringValue(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    // A function replacer, not a '$${' string replacer — String.replace
    // treats "$$" in a replacement STRING as its own escape for a single
    // literal "$", which would silently collapse '$${' back down to a
    // single "$" and defeat this entirely. A function's return value has
    // no such special-casing.
    .replace(/\$\{/g, () => '$${');
}

// `key` is embedded below as a bare, unquoted HCL attribute name — an
// unrestricted key could break out of the env block and inject arbitrary
// job-spec content. hostnsoft-api's envVars.routes.ts already restricts
// this at set-time, but this is the actual template-injection boundary,
// so it's enforced again here rather than trusting the caller.
const ENV_VAR_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// One line per project-configured env var (see docs/CLAUDE.md's env-vars
// feature) — appended into the "server" task's env block below so they
// actually reach the running container, not just hostnsoft-api's DB.
function projectEnvVarLines(envVars) {
  return envVars
    .filter(({ key }) => {
      if (RESERVED_ENV_KEYS.has(key)) {
        logger.warn(`[nomad-job-spec] skipping project env var "${key}" — reserved, set by the platform itself`);
        return false;
      }
      if (!ENV_VAR_KEY_PATTERN.test(key)) {
        logger.warn(`[nomad-job-spec] skipping project env var with invalid key "${key}"`);
        return false;
      }
      return true;
    })
    .map(({ key, value }) => `        ${key} = "${escapeHclStringValue(value)}"`)
    .join('\n');
}

// Deliberately NOT ":latest" — confirmed in practice (and documented:
// https://github.com/hashicorp/nomad/issues/20548) that Nomad's docker
// driver always attempts a real registry pull when an image reference's
// tag is "latest" or omitted, REGARDLESS of force_pull, and treats that
// pull's failure as fatal rather than falling back to an already-present
// local image. This image is only ever built locally (server-setup.sh /
// redeploy.sh), never pushed anywhere — any other fixed tag makes
// force_pull=false actually work as intended. Must match exactly what
// those scripts pass to `docker build -t`.
const ORPHAN_PROXY_IMAGE = 'orphan-banner-proxy:local';

// ONE wildcard certificate for the whole apps zone, instead of one per app.
//
// Let's Encrypt allows 50 new certificates per REGISTERED DOMAIN per week.
// Asking for a separate cert per app hostname means app number fifty-one
// fails, and so does every deploy after it, with a 429 that does not clear
// for up to seven days. That is not hypothetical: it happened on
// 2026-09-25, hours after apps moved to embarko.app — new deploys and
// existing apps alike stopped being able to get certificates, service and
// static apps together.
//
// A wildcard is one certificate that covers every app forever, so the
// weekly ceiling stops scaling with the number of apps. It is only
// obtainable over DNS-01; HTTP-01 cannot issue wildcards at all, which is
// why custom domains are deliberately NOT given one below — we do not
// control those zones, and each keeps its own per-domain certificate.
function wildcardDomainsFor(host) {
  // Never introduce a new crash path here. A caller that somehow reaches
  // this without a host already had a broken router; it should stay broken
  // in the same way it was before, not fail differently inside certificate
  // logic that has nothing to do with the real mistake.
  if (!host) return null;
  if (host === APPS_DOMAIN_SUFFIX || host.endsWith(`.${APPS_DOMAIN_SUFFIX}`)) {
    return { main: APPS_DOMAIN_SUFFIX, sans: [`*.${APPS_DOMAIN_SUFFIX}`] };
  }
  // Not a platform hostname. Emit nothing and let the caller fall back to a
  // per-host certificate — correct for a custom domain.
  return null;
}

function defaultRouterTags(appName, domain) {
  const wildcard = wildcardDomainsFor(domain);
  return [
    `traefik.http.routers.${appName}.rule=Host(\`${domain}\`)`,
    `traefik.http.routers.${appName}.entrypoints=websecure`,
    `traefik.http.routers.${appName}.tls.certresolver=${DNS01_CERT_RESOLVER}`,
    ...(wildcard
      ? [
          `traefik.http.routers.${appName}.tls.domains[0].main=${wildcard.main}`,
          `traefik.http.routers.${appName}.tls.domains[0].sans=${wildcard.sans.join(',')}`,
        ]
      : []),
    `traefik.http.routers.${appName}.middlewares=${securityHeadersMiddlewareName(appName)}`,
  ];
}

// One separate router per custom domain, each with its own Host() rule
// and its own cert-resolver tag — not one router with an OR'd Host()
// rule — since the default router and every custom-domain router need
// different cert resolvers, and Traefik only exposes that per-router,
// not per-Host()-clause. See docs/Customdomain-req.md constraint #4.
//
// Router names use an index suffix rather than the domain itself:
// Traefik's tag-based config parses `traefik.http.routers.<NAME>.<prop>`
// by splitting on ".", so a router name containing a literal "." (every
// real domain has one) would corrupt that parse.
function customDomainRouterTags(appName, customDomains) {
  return customDomains.flatMap((customDomain, index) => {
    const routerName = `${appName}-custom${index}`;
    return [
      `traefik.http.routers.${routerName}.rule=Host(\`${customDomain}\`)`,
      `traefik.http.routers.${routerName}.entrypoints=websecure`,
      `traefik.http.routers.${routerName}.tls.certresolver=${HTTP01_CERT_RESOLVER}`,
      // Same security-headers middleware as the default router — a
      // custom domain is still the same app, and shouldn't get a
      // different (missing) CSP just because of which hostname reached it.
      `traefik.http.routers.${routerName}.middlewares=${securityHeadersMiddlewareName(appName)}`,
    ];
  });
}

// Emits the `memory` / `memory_max` pair for a task's resources block.
//
// Clamped rather than trusted: Nomad rejects a job whose memory_max is
// below its memory, and the ceiling can legitimately come out lower than
// the floor (a project whose owner configured an unusually small
// memoryMb through hostnsoft-api, which only validates it as a positive
// integer). In that case the floor is dropped and a single flat `memory`
// is emitted, exactly as before this feature existed — an app asking for
// less than the floor is already small enough that there's nothing to
// oversubscribe. memory_max is likewise omitted when the two are equal,
// since declaring a ceiling identical to the reservation buys nothing.
function memoryResourceLines(taskMemory, schedulingFloorMb) {
  const floor =
    typeof schedulingFloorMb === 'number' && schedulingFloorMb > 0
      ? Math.min(schedulingFloorMb, taskMemory)
      : taskMemory;

  if (floor >= taskMemory) {
    return `        cpu    = 100\n        memory = ${taskMemory}`;
  }
  return `        cpu        = 100\n        memory     = ${floor}\n        memory_max = ${taskMemory}`;
}

function buildNomadJobSpec({
  appName,
  domain,
  imageName,
  appVersion,
  taskMemory,
  schedulingFloorMb,
  customDomains = [],
  // Defaults to this app's own host data directory; callers never need
  // to pass it, but it stays injectable for tests.
  appDataPath = undefined,
  envVars = [],
  isOrphan = false,
  orphanExpiresAt,
  orphanLoginUrl,
}) {
  const projectEnvLines = projectEnvVarLines(envVars);
  const resolvedAppDataPath = appDataPath || appDataPathFor(appName);
  const tags = [
    'traefik.enable=true',
    ...securityHeadersMiddlewareTags(appName),
    ...defaultRouterTags(appName, domain),
    ...customDomainRouterTags(appName, customDomains),
  ];
  const tagLines = tags.map((tag) => `        "${tag}"`).join(',\n');

  // While a project is orphaned, public traffic is routed through a
  // small language/framework-agnostic sidecar (orphan-proxy/) that
  // injects the expiry banner into any text/html response, instead of
  // reaching the app container directly — see
  // docs/Anonymous-deploy-req.md #5. Traefik's service always points at
  // the "http" port label; which task actually owns that label shifts
  // depending on isOrphan, so the app itself is untouched either way.
  //
  // Since every deploy rebuilds this entire job spec from scratch, this
  // — and the sidecar task itself — is automatically gone the moment a
  // project is claimed and redeployed (isOrphan false): see #6. No
  // separate removal step exists or is needed.
  const appPortLabel = isOrphan ? 'app' : 'http';

  const sidecarNetworkPort = isOrphan ? '\n      port "app"  {}' : '';

  // Memory oversubscription (see docs/Memory-oversubscription-req.md).
  // `memory` is what Nomad's scheduler PACKS against; `memory_max` is the
  // ceiling a task may burst to when the host has spare capacity at that
  // moment. Real `docker stats` data showed most apps sitting at 20-150MB
  // against a flat 256MB reservation, so scheduling against the flat
  // number caused "resources exhausted" placement failures long before
  // the box was actually full. The ceiling here is the SAME
  // embedded-DB-aware number that used to be the flat reservation — an
  // app's real limit is unchanged, only what it's scheduled against is
  // lower.
  //
  // Requires memory oversubscription to be enabled cluster-wide
  // (`nomad operator scheduler set-config -memory-oversubscription=true`,
  // done by Server-setup/server-setup.sh) — without it Nomad accepts the
  // job but ignores memory_max, which silently means every task gets the
  // low floor as a hard cap. If apps start OOMing right after a host
  // rebuild, check that setting first.
  const memoryLines = memoryResourceLines(taskMemory, schedulingFloorMb);

  const sidecarTask = isOrphan ? `
    # Only present for orphan (anonymous, unclaimed) deploys — see above.
    task "orphan-proxy" {
      driver = "docker"
      config {
        image        = "${ORPHAN_PROXY_IMAGE}"
        network_mode = "host" # shares the host's network stack, needed to reach the app task's published port at all
        force_pull   = false  # built once by server-setup.sh, not per-deploy
      }
      env {
        LISTEN_PORT       = "\${NOMAD_PORT_http}"
        # NOT 127.0.0.1 — confirmed in practice that Docker publishes
        # this platform's app ports bound to the box's own advertised/
        # public IP specifically, not to loopback or 0.0.0.0. ORIGIN_IP
        # is that same address (see this module's fail-fast check below).
        TARGET_HOST       = "${ORIGIN_IP}"
        TARGET_PORT       = "\${NOMAD_PORT_app}"
        BANNER_EXPIRES_AT = "${orphanExpiresAt}"
        BANNER_LOGIN_URL  = "${orphanLoginUrl}"
      }
      resources {
        cpu    = 50
        memory = 64
      }
    }` : '';

  return `
job "${appName}" {
  datacenters = ["dc1"]
  type        = "service"

  group "web" {
    network {
      port "http" {}${sidecarNetworkPort}
    }

    # NOTE: this no longer backs DATA_DIR — that moved to a host bind mount
    # (see appDataPathFor above and the volumes line below) so it survives
    # the job being STOPPED, not just redeployed. Kept because it still
    # sizes and node-biases the allocation's own scratch space, which
    # Nomad uses regardless.
    ephemeral_disk {
      size    = 500
      sticky  = true
      migrate = true
    }

    service {
      name     = "${appName}"
      provider = "nomad"
      port     = "http"

      tags = [
${tagLines}
      ]
    }
    task "server" {
      driver = "docker"
      config {
        image      = "${imageName}"
        ports      = ["${appPortLabel}"]
        force_pull = false # Use the local image we just built
        # Host bind mount, NOT a Nomad volume — needs no host_volume
        # declaration in nomad.hcl (the docker plugin there already
        # enables volumes), and gives each app its own directory rather
        # than one shared mount every app can read.
        # Deliberately mounted at /data rather than over /alloc/data:
        # bind-mounting on top of Nomad's own allocation directory fights
        # with how Nomad manages it.
        volumes = ["${resolvedAppDataPath}:/data"]
      }
      env {
        PORT        = "\${NOMAD_PORT_${appPortLabel}}"
        APP_NAME    = "${appName}"
        APP_VERSION = "${appVersion}"
        # Moved off /alloc/data — see appDataPathFor's comment. Apps read
        # this variable rather than hardcoding a path (it is reserved, so
        # a project cannot override it), so they follow automatically.
        DATA_DIR    = "/data"
${projectEnvLines}
      }
      resources {
${memoryLines}
      }
    }
${sidecarTask}
  }
}
    `;
}

// DEFAULT_CSP is exported so traefik-router-file.js (static apps) emits the
// exact same policy through Traefik's file provider — one CSP, two providers.
module.exports = { buildNomadJobSpec, DNS01_CERT_RESOLVER, HTTP01_CERT_RESOLVER, DEFAULT_CSP, wildcardDomainsFor };

// Fail-fast at require-time, same convention as internal-auth.js and
// validate-deploy-token.js — server-setup.sh computes and exports this
// per environment (APPS_SUBDOMAIN_BASE + DOMAIN, offset by APP_ENV) before
// starting this service; see its APPS_DOMAIN_SUFFIX.
if (!process.env.APPS_DOMAIN_SUFFIX) {
  throw new Error(
    'APPS_DOMAIN_SUFFIX environment variable is not set. This is the ' +
      'domain suffix deployed apps live under (e.g. "embarko.app") — ' +
      'see server-setup.sh, which computes and exports it per environment.'
  );
}
const APPS_DOMAIN_SUFFIX = process.env.APPS_DOMAIN_SUFFIX;

// Same convention — the address Docker actually publishes app container
// ports to on this box (confirmed in practice: NOT 0.0.0.0/127.0.0.1,
// specifically the box's own advertised/public IP — see nomad.hcl's
// `advertise` block in server-setup.sh). Only used for the orphan-proxy
// sidecar (see buildNomadJobSpec's TARGET_HOST above) to reach the app
// task it fronts, but required unconditionally at require-time same as
// every other fail-fast config in this codebase, rather than only when
// an orphan deploy actually happens.
if (!process.env.ORIGIN_IP) {
  throw new Error(
    'ORIGIN_IP environment variable is not set. This must be the same address ' +
      "Docker actually publishes app container ports to on this box (this platform's " +
      "Nomad setup binds published ports to the box's own advertised/public IP, not " +
      '0.0.0.0 or 127.0.0.1 — confirmed in practice, not an assumption) — ' +
      'see server-setup.sh, which computes and exports it per environment.'
  );
}
const ORIGIN_IP = process.env.ORIGIN_IP;

// Where each app's DATA_DIR lives ON THE HOST, one directory per app.
//
// Before this existed, DATA_DIR pointed at /alloc/data — Nomad's own
// ephemeral allocation directory, kept across redeploys only by
// `ephemeral_disk { sticky = true }` biasing the scheduler back to the
// same node. That is fine for a redeploy (the job stays alive, so the
// new allocation can inherit the old one's disk) but NOT for stopping a
// job: Nomad garbage-collects stopped jobs after job_gc_threshold (4h by
// default), and the allocation directory goes with them. Any app with a
// SQLite database under DATA_DIR would wake up empty — and, worse,
// silently, since an app that finds no database usually just creates a
// fresh one and looks perfectly healthy.
//
// A host path outside the allocation removes that entire class of
// failure: the data is simply not owned by the thing being stopped. This
// is the prerequisite for scale-to-zero (see
// docs/scale-to-zero-gated-plan.md Step 0) — nothing may stop an app
// until its data lives here.
//
// One directory per app, never a single shared Nomad host_volume: a
// shared volume would let every app read every other app's database.
if (!process.env.APP_DATA_ROOT) {
  throw new Error(
    'APP_DATA_ROOT environment variable is not set. This is the host directory ' +
      "under which each app's DATA_DIR is stored (one subdirectory per app) — " +
      'see server-setup.sh, which creates and exports it per environment.'
  );
}
const APP_DATA_ROOT = process.env.APP_DATA_ROOT;

// Exported so both the deploy path and the config-update path create the
// directory before `nomad job run`, and so the delete path knows what to
// remove. appName is already validated as /^[a-z0-9-]+$/ by every caller,
// so it cannot traverse out of APP_DATA_ROOT.
function appDataPathFor(appName) {
  return `${APP_DATA_ROOT}/${appName}`;
}
module.exports.appDataPathFor = appDataPathFor;

// Exported so any part of this codebase that needs the app's own default
// domain shape has one place to derive it from.
function defaultDomainFor(appName) {
  return `${appName}.${APPS_DOMAIN_SUFFIX}`;
}
module.exports.defaultDomainFor = defaultDomainFor;

// True for hostnames in the zone this platform controls in Cloudflare,
// i.e. issuable over DNS-01. Everything else is a client custom domain
// (HTTP-01).
function isPlatformHost(host) {
  return host.endsWith(`.${APPS_DOMAIN_SUFFIX}`);
}
module.exports.isPlatformHost = isPlatformHost;

// Where an app's saved Nomad job spec lives. One definition, because
// three files write or read it — server.js saves it at deploy time,
// idle-report.js refreshes it before a stop, activator.js runs it to wake
// the app — and a disagreement about the path would not fail loudly. It
// would look like "no saved spec", i.e. an app that cannot be woken, and
// only at the moment someone is waiting for it.
function specPathFor(appName) {
  return `${appDataPathFor('.specs')}/${appName}.json`;
}
module.exports.specPathFor = specPathFor;
