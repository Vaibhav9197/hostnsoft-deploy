/**
 * validate-deploy-token.js
 *
 * Confirms a deploy request's (companyId, token) pair against
 * hostnsoft-api before this service spends any build/deploy resources on
 * it. Replaces the old single shared PLATFORM_TOKEN model — every deploy
 * now authenticates as a specific company via a token hostnsoft-api
 * issued (and can revoke/rotate), not one secret shared by everyone.
 */

if (!process.env.HOSTNSOFT_API_URL) {
  console.error("FATAL: HOSTNSOFT_API_URL environment variable is not set.");
  console.error("Point it at the hostnsoft-api instance this service validates deploy tokens against.");
  process.exit(1);
}
const HOSTNSOFT_API_URL = process.env.HOSTNSOFT_API_URL;

async function validateDeployToken(companyId, token) {
  let response;
  try {
    response = await fetch(`${HOSTNSOFT_API_URL}/internal/deploy-tokens/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId, token }),
    });
  } catch (e) {
    // Fail closed — an unreachable hostnsoft-api must never be treated as
    // "any token is fine". Logged distinctly from a bad-token rejection so
    // ops can tell "hostnsoft-api is down" apart from "wrong token".
    console.error(`[validate-deploy-token] could not reach hostnsoft-api: ${e.message}`);
    return false;
  }

  if (!response.ok) {
    console.error(`[validate-deploy-token] hostnsoft-api returned HTTP ${response.status}`);
    return false;
  }

  const body = await response.json();
  return body.valid === true;
}

module.exports = { validateDeployToken };
