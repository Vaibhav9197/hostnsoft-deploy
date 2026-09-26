/**
 * app-kind.js
 *
 * Answers "what is deployed under this app name on THIS host right now":
 * a static site (static-site.js), a server app (a Nomad job), or nothing.
 *
 * Asked before every deploy, because the two kinds are not
 * interchangeable in both directions — see docs/Static-apps-req.md:
 *
 *   - service -> static is ALLOWED and handled as a migration. A static
 *     site needs nothing a server app has (no port, no DATA_DIR, no env
 *     vars), so going static only means removing a container nothing
 *     routes to any more once the files are live. This is also how every
 *     static app that predates the fast path — a Nomad job running
 *     Railpack's Caddy over the same files — moves off its container on
 *     its next deploy, with no special case for it.
 *   - static -> service is REFUSED (422 app_kind_changed in server.js).
 *     A server app needs routing, a data directory and settings the
 *     static app never had, and its rollback history would be a mix of
 *     directories and images. The caller is told to use a new app name.
 *
 * The answer comes from the host itself, never from hostnsoft-api: the
 * static manifest and the Nomad job ARE the deployment, the same way
 * `docker image inspect` is what the rollback path trusts.
 */
'use strict';

const { isStaticApp } = require('./static-site');

const NOMAD_ADDR = process.env.NOMAD_ADDR || 'http://127.0.0.1:4646';

// A stopped-but-not-purged (scale-to-zero) job still counts: it is still
// that app, just asleep.
async function nomadJobExists(appName) {
  const response = await fetch(`${NOMAD_ADDR}/v1/job/${encodeURIComponent(appName)}`);
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`Nomad API /v1/job/${appName} returned HTTP ${response.status}`);
  }
  return true;
}

// -> 'static' | 'service' | 'none'
async function resolveAppKind(appName) {
  if (await isStaticApp(appName)) return 'static';
  if (await nomadJobExists(appName)) return 'service';
  return 'none';
}

module.exports = { resolveAppKind };
