/**
 * claim-project.js
 *
 * Confirms (and, on first sight, auto-creates) that an app name is
 * actually available to this token's company BEFORE any build/Nomad
 * resources are spent on it — see hostnsoft-api's
 * src/routes/internalProjects.routes.ts. hostnsoft-api reads the owning
 * company directly off the token; no X-Company-Id involved.
 *
 * The app name doubles as the live subdomain (<appName>.app.hostnsoft.com)
 * and the Nomad job name, so it must be unique platform-wide. Previously
 * the only uniqueness check happened in record-deployment.js, AFTER the
 * Nomad job already existed — too late to actually prevent a collision.
 * This runs first instead.
 *
 * Fails closed, same as validate-deploy-token.js: an unreachable
 * hostnsoft-api must never be treated as "any app name is fine".
 */
const HOSTNSOFT_API_URL = process.env.HOSTNSOFT_API_URL; // already required/validated by validate-deploy-token.js at startup

async function claimProject(token, slug) {
  let response;
  try {
    response = await fetch(`${HOSTNSOFT_API_URL}/internal/projects/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, slug }),
    });
  } catch (e) {
    console.error(`[claim-project] could not reach hostnsoft-api to claim "${slug}": ${e.message}`);
    return { ok: false, status: 502, code: 'app_name_check_failed', error: "Could not verify app name availability" };
  }

  if (response.status === 409) {
    const body = await response.json().catch(() => ({}));
    return { ok: false, status: 409, code: 'app_name_taken', error: body.error || `App name "${slug}" is already in use` };
  }

  if (!response.ok) {
    console.error(`[claim-project] hostnsoft-api returned HTTP ${response.status} claiming "${slug}"`);
    return { ok: false, status: 502, code: 'app_name_check_failed', error: "Could not verify app name availability" };
  }

  const body = await response.json();
  return { ok: true, projectId: body.projectId };
}

module.exports = { claimProject };
