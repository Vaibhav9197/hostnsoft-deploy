/**
 * platform-health.js
 *
 * Backs the public GET /health that an external uptime monitor polls.
 * hostnsoft-api is never exposed through Traefik and the activator listens
 * on loopback only, so this is the one public URL that can vouch for all
 * three: this service answering at all, plus hostnsoft-api's own /health
 * (which checks its database and Redis) and the activator's
 * /__activator/health.
 *
 * Only the names of what failed reach the response, never the reason —
 * the route is unauthenticated. Failures are logged; successes are not.
 */
const logger = require('./logger');

// Already required/validated by validate-deploy-token.js at startup.
const HOSTNSOFT_API_URL = process.env.HOSTNSOFT_API_URL;
// The activator's own setting and default (activator.js). It is a separate
// pm2 process, so an environment whose activator is not on 4200 must set
// ACTIVATOR_PORT for this service too.
const ACTIVATOR_URL = `http://127.0.0.1:${Number(process.env.ACTIVATOR_PORT) || 4200}/__activator/health`;

// Per dependency. Both are loopback calls that answer in milliseconds when
// healthy; a monitor waits longer than this for the whole response.
const CHECK_TIMEOUT_MS = 2000;

async function check(name, url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (response.ok) return 'ok';
    logger.error(`[health] ${name} answered ${response.status}`);
  } catch (e) {
    logger.error(`[health] ${name} unreachable: ${e.message}`);
  }
  return 'down';
}

async function getPlatformHealth() {
  const [api, activator] = await Promise.all([
    check('hostnsoft-api', `${HOSTNSOFT_API_URL}/health`),
    check('activator', ACTIVATOR_URL),
  ]);
  const ok = api === 'ok' && activator === 'ok';
  return { ok, body: { status: ok ? 'ok' : 'down', api, activator } };
}

module.exports = { getPlatformHealth };
