/**
 * verify-proxy-auth.js
 *
 * Lets GET /apps/:appName/status, .../logs, and .../customer-query (all
 * sharing one authorizeAppAccess helper in server.js) also accept a
 * dashboard proxy_auth_token for a CLAIMED app, not just a deploy token —
 * so someone who's already logged into the dashboard can hit these same
 * endpoints directly, without needing to separately mint/hold a deploy
 * token just to check their own app's status/logs.
 *
 * Calls hostnsoft-api's internal-only POST /internal/proxy-auth/verify-membership,
 * which verifies the PAT against MSG91 and checks membership in the
 * SPECIFIC company the app belongs to — a proxy_auth_token isn't itself
 * company-scoped the way a deploy token is (one person can belong to
 * several companies), so the target company has to be supplied.
 *
 * Sends INTERNAL_API_SECRET (same shared secret already used for the
 * config-push completion callback, see report-config-push.js) — a PAT is
 * a far more powerful credential than a company-scoped deploy token, so
 * this call additionally proves it's coming from hostnsoft-deploy itself.
 */
const logger = require("./logger");

const HOSTNSOFT_API_URL = process.env.HOSTNSOFT_API_URL;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

// Fails closed on any problem (unreachable, non-2xx, malformed body) —
// same convention as validate-deploy-token.js: never treat "couldn't
// verify" as "let them in". Callers should treat a false `valid` the
// same whether it means "the PAT itself was rejected" or "hostnsoft-api
// couldn't be asked" — both are "this credential doesn't check out".
// appName (optional, added with roles): also ask whether this person may
// read that app — appAccess in the reply — for `permission`: app.view for
// status, app.logs for logs (only some access levels include logs). Absent
// from an older API's reply.
async function verifyProxyAuthCompanyAccess(proxyAuthToken, companyId, appName, permission) {
  let response;
  try {
    response = await fetch(`${HOSTNSOFT_API_URL}/internal/proxy-auth/verify-membership`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': INTERNAL_API_SECRET },
      body: JSON.stringify({ proxyAuthToken, companyId, ...(appName ? { appName, ...(permission ? { permission } : {}) } : {}) }),
    });
  } catch (e) {
    logger.error(`[verify-proxy-auth] could not reach hostnsoft-api: ${e.message}`);
    return { valid: false, isMember: false };
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "<unreadable response body>");
    logger.error(`[verify-proxy-auth] hostnsoft-api returned HTTP ${response.status}: ${bodyText}`);
    return { valid: false, isMember: false };
  }

  const body = await response.json();
  return {
    valid: body.valid === true,
    isMember: body.isMember === true,
    appAccess: typeof body.appAccess === 'boolean' ? body.appAccess : null,
  };
}

module.exports = { verifyProxyAuthCompanyAccess };
