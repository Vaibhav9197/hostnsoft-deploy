/**
 * claim-project.js
 *
 * Confirms (and, on first sight, auto-creates) that an app name is
 * actually available to this token's company BEFORE any build/Nomad
 * resources are spent on it — see hostnsoft-api's
 * src/routes/internalProjects.routes.ts. hostnsoft-api reads the owning
 * company directly off the token; no X-Company-Id involved.
 *
 * `token` may be omitted entirely (pass `undefined`, not `null`) — see
 * docs/Anonymous-deploy-req.md. That creates/reuses an anonymous
 * ("orphan") project instead of requiring a company.
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
const logger = require("./logger");

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
    logger.error(`[claim-project] could not reach hostnsoft-api to claim "${slug}": ${e.message}`);
    return { ok: false, status: 502, code: 'app_name_check_failed', error: "Could not verify app name availability" };
  }

  if (response.status === 409) {
    const body = await response.json().catch(() => ({}));
    return { ok: false, status: 409, code: 'app_name_taken', error: body.error || `App name "${slug}" is already in use` };
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "<unreadable response body>");
    logger.error(`[claim-project] hostnsoft-api returned HTTP ${response.status} claiming "${slug}": ${bodyText}`);
    return { ok: false, status: 502, code: 'app_name_check_failed', error: "Could not verify app name availability" };
  }

  const body = await response.json();
  // customDomains: this project's already-active custom domains (see
  // docs/Customdomain-req.md) — passed through so server.js can include
  // their routers in the regenerated job spec on every deploy, not just
  // when a domain is first activated.
  //
  // isOrphan/orphanExpiresAt/orphanMessage/orphanLoginUrl: see
  // docs/Anonymous-deploy-req.md — present when this deploy has no (or
  // an as-yet-unclaimed) token, so server.js knows to inject the expiry
  // banner and include the orphan notice in its own response.
  // envVars: this project's configured env vars (set via hostnsoft-api's
  // /companies/:companyId/projects/:projectId/env-vars) — passed through
  // so server.js can bake them into the container's env block. Previously
  // these were persisted in hostnsoft-api's DB but never actually reached
  // a running app; this is that missing integration point.
  //
  // memoryMb: this project's configured memory override (set via
  // hostnsoft-api's PATCH .../memory) — same gap as envVars had: this
  // was already returned by hostnsoft-api but never actually read here,
  // so server.js's auto-detected 256/512 always won regardless of what
  // was configured.
  return {
    ok: true,
    projectId: body.projectId,
    customDomains: body.customDomains || [],
    envVars: body.envVars || [],
    memoryMb: typeof body.memoryMb === 'number' ? body.memoryMb : null,
    isOrphan: !!body.isOrphan,
    orphanExpiresAt: body.orphanExpiresAt || null,
    orphanMessage: body.orphanMessage || null,
    orphanLoginUrl: body.orphanLoginUrl || null,
  };
}

module.exports = { claimProject };
