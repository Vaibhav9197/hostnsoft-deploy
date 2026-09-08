/**
 * record-deployment.js
 *
 * Reports a deploy attempt's state to hostnsoft-api so the dashboard's
 * deployment history is actually populated — see hostnsoft-api's
 * src/routes/internalDeployments.routes.ts. Called twice per deploy
 * attempt now that builds run in the background (see server.js): once
 * with status "in_progress" right as the attempt starts (no
 * deploymentId — creates a new row), and again with "success"/"failed"
 * once it concludes (passing the first call's returned id back as
 * deploymentId, so the SAME row is updated in place rather than a
 * second one being created).
 *
 * hostnsoft-api assigns the deployment's actual sequence number (v1, v2,
 * ...) itself — this only reports appVersion, whatever X-App-Version (or
 * this service's own Date.now() fallback) was used for the image tag.
 * That's informational, not an identity: nothing stops a user from
 * redeploying without bumping it at all.
 *
 * Best-effort: never throws. A hostnsoft-api outage or a bug in this
 * reporting step must never change the response already being sent back
 * to the client that triggered the deploy — the deploy itself already
 * succeeded or failed on its own terms by the time this runs. Returns
 * the deployment's id on success, or null if the call failed — a null
 * here just means the later success/failed call falls back to creating
 * its own new row instead of updating one, same as before this feature.
 */
const logger = require("./logger");

const HOSTNSOFT_API_URL = process.env.HOSTNSOFT_API_URL; // already required/validated by validate-deploy-token.js at startup

async function recordDeployment({
  token,
  projectSlug,
  appVersion,
  status,
  imageTag,
  memoryMb,
  errorDetail,
  deploymentId,
}) {
  try {
    const response = await fetch(`${HOSTNSOFT_API_URL}/internal/deployments/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        projectSlug,
        appVersion,
        status,
        imageTag,
        memoryMb,
        errorDetail,
        deploymentId,
      }),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "<unreadable response body>");
      logger.error(
        `[record-deployment] hostnsoft-api returned HTTP ${response.status} recording ${projectSlug}@${appVersion}: ${bodyText}`
      );
      return null;
    }

    const body = await response.json().catch(() => null);
    return body && typeof body.id === 'string' ? body.id : null;
  } catch (e) {
    logger.error(
      `[record-deployment] could not reach hostnsoft-api to record ${projectSlug}@${appVersion}: ${e.message}`
    );
    return null;
  }
}

module.exports = { recordDeployment };
