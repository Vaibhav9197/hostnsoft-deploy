/**
 * customer-query.js (renamed from feature-request.js, 2026-09-09 —
 * hostnsoft-api's endpoint moved from /internal/feature-requests to
 * /internal/customer-query, same underlying table/type)
 *
 * Forwards an agent-submitted feature request/feedback/other query to
 * hostnsoft-api's POST /internal/customer-query — see
 * docs/request-feature-req.md (Path C). Same fire-and-report shape as
 * record-deployment.js, but this one's failure DOES matter to the caller
 * (there's nothing else for it to fall back to — unlike a deploy, which
 * already succeeded or failed on its own terms by the time recording
 * happens), so this throws on failure rather than swallowing it; the
 * route handler turns that into a 502.
 */
const logger = require("./logger");

const HOSTNSOFT_API_URL = process.env.HOSTNSOFT_API_URL; // already required/validated by validate-deploy-token.js at startup

async function submitCustomerQuery({ type, message, projectSlug, agentName, companyId }) {
  let response;
  try {
    response = await fetch(`${HOSTNSOFT_API_URL}/internal/customer-query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, message, projectSlug, agentName, companyId }),
    });
  } catch (e) {
    logger.error(`[customer-query] could not reach hostnsoft-api for "${projectSlug}": ${e.message}`);
    throw new Error("Could not submit customer query");
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "<unreadable response body>");
    logger.error(`[customer-query] hostnsoft-api returned HTTP ${response.status} for "${projectSlug}": ${bodyText}`);
    throw new Error("Could not submit customer query");
  }

  return response.json();
}

// Mirrors FEATURE_REQUEST_TYPES in hostnsoft-api's
// src/services/featureRequests.ts — hostnsoft-api validates again, so the
// two lists must change together. The last five let an agent say what kind
// of problem it hit; the first three are what people send from the dashboard.
const FEEDBACK_TYPES = [
  'platform_bug',
  'missing_capability',
  'docs_issue',
  'unexpected_behavior',
  'other',
  'feature',
  'feedback',
];

module.exports = { submitCustomerQuery, FEEDBACK_TYPES };
