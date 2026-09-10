/**
 * report-config-push.js
 *
 * Reports the outcome of an ASYNC config-push (see POST
 * /internal/apps/:appName/config's deploymentId branch in server.js) back
 * to hostnsoft-api once it's actually known — that endpoint now responds
 * 202 the moment the target image is confirmed to exist, before the
 * Nomad job run that actually applies it has even started, so the
 * caller (currently only one-click rollback) needs a separate signal for
 * "it's done" the same way a fresh deploy gets one via
 * record-deployment.js.
 *
 * Authenticated with INTERNAL_API_SECRET rather than a deploy token —
 * this config-push was itself authenticated that same way (there's no
 * per-company deploy token in hand at all here, see internal-auth.js),
 * so hostnsoft-api's matching endpoint checks the same shared secret in
 * the reverse direction.
 *
 * Best-effort: logs and returns rather than throwing — there is no
 * request/response left to answer to by the time this runs, same
 * reasoning as every other fire-and-forget internal call in this
 * codebase.
 */
const logger = require("./logger");

const HOSTNSOFT_API_URL = process.env.HOSTNSOFT_API_URL; // already required/validated by validate-deploy-token.js at startup
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET; // already required/validated by internal-auth.js at startup

async function reportConfigPushResult(deploymentId, { success, errorDetail }) {
  try {
    const response = await fetch(`${HOSTNSOFT_API_URL}/internal/deployments/${deploymentId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': INTERNAL_API_SECRET },
      body: JSON.stringify({ success, errorDetail }),
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "<unreadable response body>");
      logger.error(`[report-config-push] hostnsoft-api returned HTTP ${response.status} for deployment ${deploymentId}: ${bodyText}`);
    }
  } catch (e) {
    logger.error(`[report-config-push] could not reach hostnsoft-api for deployment ${deploymentId}: ${e.message}`);
  }
}

module.exports = { reportConfigPushResult };
