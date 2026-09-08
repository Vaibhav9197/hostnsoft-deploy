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

// Same call as validateDeployToken above, but also returns the token's
// own companyId — needed by GET /apps/:appName/status and .../logs to
// decide whether the caller's token actually owns the app being
// inspected (see project-lookup.js), not just whether the token itself
// is live. Kept as a separate function rather than changing
// validateDeployToken's own boolean return shape: an object is always
// truthy, so every existing `if (!(await validateDeployToken(token)))`
// call site would have silently stopped rejecting invalid tokens if this
// had been done in place instead.
async function validateDeployTokenWithCompany(token) {
  let response;
  try {
    response = await fetch(`${HOSTNSOFT_API_URL}/internal/deploy-tokens/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch (e) {
    logger.error(`[validate-deploy-token] could not reach hostnsoft-api: ${e.message}`);
    return null;
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "<unreadable response body>");
    logger.error(`[validate-deploy-token] hostnsoft-api returned HTTP ${response.status}: ${bodyText}`);
    return null;
  }

  const body = await response.json();
  if (body.valid !== true || typeof body.companyId !== 'string') return null;
  return { companyId: body.companyId };
}

module.exports = { validateDeployToken, validateDeployTokenWithCompany };
