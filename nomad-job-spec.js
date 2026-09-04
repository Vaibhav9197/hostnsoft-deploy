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
 * - DNS-01 ("cloudflare") for the platform's own *.app.<platform-domain>
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

function defaultRouterTags(appName, domain) {
  return [
    `traefik.http.routers.${appName}.rule=Host(\`${domain}\`)`,
    `traefik.http.routers.${appName}.entrypoints=websecure`,
    `traefik.http.routers.${appName}.tls.certresolver=${DNS01_CERT_RESOLVER}`,
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
    ];
  });
}

function buildNomadJobSpec({
  appName,
  domain,
  imageName,
  appVersion,
  taskMemory,
  customDomains = [],
  envVars = [],
  isOrphan = false,
  orphanExpiresAt,
  orphanLoginUrl,
}) {
  const projectEnvLines = projectEnvVarLines(envVars);
  const tags = [
    'traefik.enable=true',
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

    # Persists /alloc/data across redeploys by biasing the scheduler to reuse
    # the same client node, and migrating the data if it ever can't.
    # Apps that don't use DATA_DIR simply ignore this — it's opt-in.
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
      }
      env {
        PORT        = "\${NOMAD_PORT_${appPortLabel}}"
        APP_NAME    = "${appName}"
        APP_VERSION = "${appVersion}"
        DATA_DIR    = "/alloc/data"
${projectEnvLines}
      }
      resources {
        cpu    = 100
        memory = ${taskMemory}
      }
    }
${sidecarTask}
  }
}
    `;
}

module.exports = { buildNomadJobSpec, DNS01_CERT_RESOLVER, HTTP01_CERT_RESOLVER };

// Fail-fast at require-time, same convention as internal-auth.js and
// validate-deploy-token.js — server-setup.sh computes and exports this
// per environment (APPS_SUBDOMAIN_BASE + DOMAIN, offset by APP_ENV) before
// starting this service; see its APPS_DOMAIN_SUFFIX.
if (!process.env.APPS_DOMAIN_SUFFIX) {
  throw new Error(
    'APPS_DOMAIN_SUFFIX environment variable is not set. This is the ' +
      'domain suffix deployed apps live under (e.g. "app.embarko.ai") — ' +
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

// Exported so any part of this codebase that needs the app's own default
// domain shape has one place to derive it from.
function defaultDomainFor(appName) {
  return `${appName}.${APPS_DOMAIN_SUFFIX}`;
}
module.exports.defaultDomainFor = defaultDomainFor;
