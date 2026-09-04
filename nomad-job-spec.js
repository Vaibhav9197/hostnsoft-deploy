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
const DNS01_CERT_RESOLVER = 'cloudflare';
const HTTP01_CERT_RESOLVER = 'letsencrypt-http';

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

function buildNomadJobSpec({ appName, domain, imageName, appVersion, taskMemory, customDomains = [] }) {
  const tags = [
    'traefik.enable=true',
    ...defaultRouterTags(appName, domain),
    ...customDomainRouterTags(appName, customDomains),
  ];
  const tagLines = tags.map((tag) => `        "${tag}"`).join(',\n');

  return `
job "${appName}" {
  datacenters = ["dc1"]
  type        = "service"

  group "web" {
    network {
      port "http" {}
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
        ports      = ["http"]
        force_pull = false # Use the local image we just built
      }
      env {
        PORT        = "\${NOMAD_PORT_http}"
        APP_NAME    = "${appName}"
        APP_VERSION = "${appVersion}"
        DATA_DIR    = "/alloc/data"
      }
      resources {
        cpu    = 100
        memory = ${taskMemory}
      }
    }
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

// Exported so any part of this codebase that needs the app's own default
// domain shape has one place to derive it from.
function defaultDomainFor(appName) {
  return `${appName}.${APPS_DOMAIN_SUFFIX}`;
}
module.exports.defaultDomainFor = defaultDomainFor;
