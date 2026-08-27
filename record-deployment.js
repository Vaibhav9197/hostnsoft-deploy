/**
 * record-deployment.js
 *
 * Reports a deploy attempt's outcome to hostnsoft-api after it concludes
 * (success or failure), so the dashboard's deployment history is
 * actually populated — see hostnsoft-api's
 * src/routes/internalDeployments.routes.ts.
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
 * succeeded or failed on its own terms by the time this runs.
 */
const HOSTNSOFT_API_URL = process.env.HOSTNSOFT_API_URL; // already required/validated by validate-deploy-token.js at startup

async function recordDeployment({
  companyId,
  token,
  projectSlug,
  appVersion,
  status,
  imageTag,
  memoryMb,
  errorDetail,
}) {
  try {
    const response = await fetch(`${HOSTNSOFT_API_URL}/internal/deployments/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        companyId,
        token,
        projectSlug,
        appVersion,
        status,
        imageTag,
        memoryMb,
        errorDetail,
      }),
    });

    if (!response.ok) {
      console.error(
        `[record-deployment] hostnsoft-api returned HTTP ${response.status} recording ${projectSlug}@${appVersion}`
      );
    }
  } catch (e) {
    console.error(
      `[record-deployment] could not reach hostnsoft-api to record ${projectSlug}@${appVersion}: ${e.message}`
    );
  }
}

module.exports = { recordDeployment };
