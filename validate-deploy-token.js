/**
 * validate-deploy-token.js
 *
 * Confirms a deploy request's token is real and live against
 * hostnsoft-api before this service spends any build/deploy resources on
 * it. The token itself is company-scoped (issued per-company by
 * hostnsoft-api) — there's no separate X-Company-Id for the caller to
 * send or get wrong; hostnsoft-api reads the owning company directly off
 * the token.
 */

const logger = require("./logger");

if (!process.env.HOSTNSOFT_API_URL) {
  logger.error("FATAL: HOSTNSOFT_API_URL environment variable is not set.");
  logger.error("Point it at the hostnsoft-api instance this service validates deploy tokens against.");
  process.exit(1);
}
const HOSTNSOFT_API_URL = process.env.HOSTNSOFT_API_URL;

async function validateDeployToken(token) {
  let response;
  try {
    response = await fetch(`${HOSTNSOFT_API_URL}/internal/deploy-tokens/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch (e) {
    // Fail closed — an unreachable hostnsoft-api must never be treated as
    // "any token is fine". Logged distinctly from a bad-token rejection so
    // ops can tell "hostnsoft-api is down" apart from "wrong token".
    logger.error(`[validate-deploy-token] could not reach hostnsoft-api: ${e.message}`);
    return false;
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "<unreadable response body>");
    logger.error(`[validate-deploy-token] hostnsoft-api returned HTTP ${response.status}: ${bodyText}`);
    return false;
  }

  const body = await response.json();
  return body.valid === true;
}

module.exports = { validateDeployToken };
