/**
 * feature-request.js
 *
 * Forwards an agent-submitted feature request/feedback to hostnsoft-api's
 * POST /internal/feature-requests — see docs/request-feature-req.md
 * (Path C). Same fire-and-report shape as record-deployment.js, but this
 * one's failure DOES matter to the caller (there's nothing else for it to
 * fall back to — unlike a deploy, which already succeeded or failed on
 * its own terms by the time recording happens), so this throws on
 * failure rather than swallowing it; the route handler turns that into a
 * 502.
 */
const logger = require("./logger");

const HOSTNSOFT_API_URL = process.env.HOSTNSOFT_API_URL; // already required/validated by validate-deploy-token.js at startup

async function submitFeatureRequest({ type, message, projectSlug, agentName, companyId }) {
  let response;
  try {
    response = await fetch(`${HOSTNSOFT_API_URL}/internal/feature-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, message, projectSlug, agentName, companyId }),
    });
  } catch (e) {
    logger.error(`[feature-request] could not reach hostnsoft-api for "${projectSlug}": ${e.message}`);
    throw new Error("Could not submit feature request");
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "<unreadable response body>");
    logger.error(`[feature-request] hostnsoft-api returned HTTP ${response.status} for "${projectSlug}": ${bodyText}`);
    throw new Error("Could not submit feature request");
  }

  return response.json();
}

module.exports = { submitFeatureRequest };
