/**
 * traefik-router-file.js
 *
 * Traefik routing for a static app — the counterpart of the Traefik tags
 * nomad-job-spec.js puts on a container app's Nomad service. A static app
 * has no Nomad job for Traefik's Nomad provider to read, so its routers
 * are declared through Traefik's FILE provider instead: one YAML file per
 * app in TRAEFIK_DYNAMIC_DIR, a directory Traefik watches
 * (server-setup.sh configures `--providers.file.directory` on it).
 * Writing the file is the deploy; deleting it is the teardown.
 *
 * Kept deliberately parallel to nomad-job-spec.js:
 *   - Router names are the app slug (default domain) and
 *     "<slug>-custom<N>" (one per custom domain). analytics/access-log-
 *     tailer.js recovers the app name from a router name by stripping
 *     "@<provider>" and then "-customN", so a static app's traffic is
 *     attributed exactly like a container app's ("myapp@file" instead of
 *     "myapp@nomad") with no change there.
 *   - Same two cert resolvers, and the same per-app security-headers
 *     middleware carrying DEFAULT_CSP (the WASM-safe policy — see
 *     nomad-job-spec.js for why the platform owns that header).
 *
 * What is new is how the shared static server (static-server/Caddyfile)
 * learns WHICH app a request is for: a per-app request-header middleware
 * sets X-Embarko-App to the slug. Traefik's customRequestHeaders REPLACES
 * any value a client sent, and the static server is bound to 127.0.0.1
 * behind Traefik only, so the header can only ever carry what this file
 * put in it. The Caddyfile still refuses anything not matching the app
 * name pattern before using it as a path.
 *
 * An orphan (anonymous, unclaimed) app is routed through the shared
 * orphan-banner proxy that runs beside the static server, not straight
 * to it. It injects the same expiry banner the per-app sidecar does for
 * a container app, reading the expiry and login URL from two more
 * request headers set here (see orphan-proxy/proxy.js) — one shared
 * process for every orphan static app rather than one sidecar each.
 *
 * Files are written atomically (temp file + rename). Traefik's watcher
 * only loads .yml/.yaml/.toml, so the temp name is never picked up.
 */
'use strict';

const path = require('path');
const fs = require('fs-extra');
const logger = require('./logger');
const {
  DEFAULT_CSP, DNS01_CERT_RESOLVER, HTTP01_CERT_RESOLVER, wildcardDomainsFor,
} = require('./nomad-job-spec');

// Fail-fast at require-time, same convention as every other required
// config in this codebase — server-setup.sh exports all three.
for (const name of ['TRAEFIK_DYNAMIC_DIR', 'STATIC_SERVER_PORT', 'STATIC_ORPHAN_PROXY_PORT']) {
  if (!process.env[name]) {
    throw new Error(
      `${name} environment variable is not set. Static apps are routed through Traefik's ` +
        'file provider to the shared static server — see server-setup.sh, which configures ' +
        'and exports these per environment, and .env.example.'
    );
  }
}
const TRAEFIK_DYNAMIC_DIR = process.env.TRAEFIK_DYNAMIC_DIR;
const STATIC_SERVER_PORT = Number(process.env.STATIC_SERVER_PORT);
const STATIC_ORPHAN_PROXY_PORT = Number(process.env.STATIC_ORPHAN_PROXY_PORT);

// Same "skip and warn, never break the deploy" posture as
// nomad-job-spec.js's projectEnvVarLines. hostnsoft-api validates a
// domain before it gets here, but it is interpolated into a Host() rule,
// so it is checked again at this boundary.
const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

// Every scalar is written as a JSON string: a JSON string is a valid
// YAML double-quoted scalar, which spares hand-escaping the CSP's quotes
// and semicolons or a URL's colons.
const q = (value) => JSON.stringify(String(value));

function staticRouterFilePath(appName) {
  return path.join(TRAEFIK_DYNAMIC_DIR, `static-${appName}.yml`);
}

// certDomains: the wildcard this router's certificate should cover, or null
// for a per-host certificate. Supplied only for platform hostnames — see
// wildcardDomainsFor in nomad-job-spec.js for why (Let's Encrypt's 50
// certs/week per registered domain, which a cert-per-app model hits at the
// fiftieth app). Custom domains pass null: HTTP-01 cannot issue wildcards,
// and we do not control those zones anyway.
function routerLines(name, host, certResolver, serviceName, middlewares, certDomains = null) {
  return [
    `    ${q(name)}:`,
    `      rule: ${q(`Host(\`${host}\`)`)}`,
    '      entryPoints:',
    '        - websecure',
    `      service: ${q(serviceName)}`,
    '      middlewares:',
    ...middlewares.map((m) => `        - ${q(m)}`),
    '      tls:',
    `        certResolver: ${q(certResolver)}`,
    ...(certDomains
      ? [
          '        domains:',
          `          - main: ${q(certDomains.main)}`,
          '            sans:',
          ...certDomains.sans.map((s) => `              - ${q(s)}`),
        ]
      : []),
  ];
}

function buildStaticRouterConfig({
  appName,
  domain,
  customDomains = [],
  isOrphan = false,
  orphanExpiresAt,
  orphanLoginUrl,
  isFreePlan = false,
  spa = false,
}) {
  const showBanner = isOrphan || isFreePlan;
  const serviceName = `${appName}-static`;
  const headersMiddleware = `${appName}-security-headers`;
  const appMiddleware = `${appName}-static-app`;
  const middlewares = [headersMiddleware, appMiddleware];

  const validCustomDomains = customDomains.filter((d) => {
    if (typeof d === 'string' && HOSTNAME_PATTERN.test(d)) return true;
    logger.warn(`[traefik-router-file] skipping custom domain with invalid hostname "${d}" for ${appName}`);
    return false;
  });

  const requestHeaders = [
    `          X-Embarko-App: ${q(appName)}`,
    // Always set, so a client-supplied value is overwritten either way.
    // "1" is reserved for build-time SPAs, not produced yet — see
    // docs/Static-apps-req.md "Next" and static-server/Caddyfile.
    `          X-Embarko-Spa: ${q(spa ? '1' : '0')}`,
  ];
  if (showBanner) requestHeaders.push(`          X-Embarko-Footer: ${q('1')}`);
  if (isOrphan) {
    requestHeaders.push(`          X-Orphan-Expires-At: ${q(orphanExpiresAt || '')}`);
    requestHeaders.push(`          X-Orphan-Login-Url: ${q(orphanLoginUrl || '')}`);
  }
  const upstreamPort = showBanner ? STATIC_ORPHAN_PROXY_PORT : STATIC_SERVER_PORT;

  return [
    '# Generated by deploy-service (traefik-router-file.js) — do not edit. The',
    '# next deploy or config push of this app overwrites it; deletion removes it.',
    'http:',
    '  routers:',
    ...routerLines(appName, domain, DNS01_CERT_RESOLVER, serviceName, middlewares,
      wildcardDomainsFor(domain)),
    ...validCustomDomains.flatMap((d, i) =>
      routerLines(`${appName}-custom${i}`, d, HTTP01_CERT_RESOLVER, serviceName, middlewares)
    ),
    '  middlewares:',
    `    ${q(headersMiddleware)}:`,
    '      headers:',
    '        customResponseHeaders:',
    `          Content-Security-Policy: ${q(DEFAULT_CSP)}`,
    `    ${q(appMiddleware)}:`,
    '      headers:',
    '        customRequestHeaders:',
    ...requestHeaders,
    '  services:',
    `    ${q(serviceName)}:`,
    '      loadBalancer:',
    '        servers:',
    `          - url: ${q(`http://127.0.0.1:${upstreamPort}`)}`,
    '',
  ].join('\n');
}

async function writeStaticRouterFile(config) {
  const target = staticRouterFilePath(config.appName);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.ensureDir(TRAEFIK_DYNAMIC_DIR);
  await fs.writeFile(tmp, buildStaticRouterConfig(config));
  await fs.rename(tmp, target);
  return target;
}

async function removeStaticRouterFile(appName) {
  await fs.remove(staticRouterFilePath(appName));
}

module.exports = {
  buildStaticRouterConfig,
  writeStaticRouterFile,
  removeStaticRouterFile,
  staticRouterFilePath,
};
