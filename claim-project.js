/**
 * claim-project.js
 *
 * Confirms (and, on first sight, auto-creates) that an app name is
 * actually available to the deploying company BEFORE any build/Nomad
 * resources are spent on it — see hostnsoft-api's
 * src/routes/internalProjects.routes.ts.
 *
 * `credential` comes from deploy-credential.js and says who's deploying:
 * a deploy token (hostnsoft-api reads the owning company off the token
 * itself), or a proxy_auth_token + companyId for a dashboard upload
 * (2026-09-17 — hostnsoft-api verifies that pairing against proxy
 * membership), or `null` for an anonymous deploy, which creates/reuses an
 * ("orphan") project instead of requiring a company at all — see
 * docs/Anonymous-deploy-req.md.
 *
 * This call is the single verification point for a proxy_auth_token:
 * nothing upstream has checked it, so its rejections (401/403) are real
 * auth answers to relay, not "couldn't verify" — which is why they're
 * passed through below instead of being flattened into a 502.
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
const { credentialBody, credentialHeaders } = require("./deploy-credential");

const HOSTNSOFT_API_URL = process.env.HOSTNSOFT_API_URL; // already required/validated by validate-deploy-token.js at startup

// Statuses that are hostnsoft-api's own considered answer about the
// CALLER rather than a sign something went wrong between the services —
// relayed with their own status and code so the person sees "your
// session expired" or "you're not in that company", not a blanket "could
// not verify app name availability". Everything else still becomes a 502
// (fail closed), same as before.
const RELAYED_STATUSES = new Set([400, 401, 403, 409]);

async function claimProject(credential, slug, appType, schedules) {
  let response;
  try {
    response = await fetch(`${HOSTNSOFT_API_URL}/internal/projects/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...credentialHeaders(credential) },
      body: JSON.stringify({
        ...credentialBody(credential),
        slug,
        ...(appType ? { appType } : {}),
        ...(schedules !== undefined ? { schedules } : {}),
      }),
    });
  } catch (e) {
    logger.error(`[claim-project] could not reach hostnsoft-api to claim "${slug}": ${e.message}`);
    return { ok: false, status: 502, code: 'app_name_check_failed', error: "Could not verify app name availability" };
  }

  if (RELAYED_STATUSES.has(response.status)) {
    const body = await response.json().catch(() => ({}));
    // Pass hostnsoft-api's own code through rather than assuming
    // "taken": a 409 here is also how a RESERVED name is refused
    // (app_name_reserved, app_name_too_short/_too_long), and those mean
    // something different to the caller. "Taken" invites retrying the
    // same name later; "reserved" never becomes available, so an agent
    // told the wrong one retries forever. Falls back to app_name_taken
    // so an older hostnsoft-api that sends no code still behaves as it did
    // — which is also why that fallback is scoped to 409 specifically.
    return {
      ok: false,
      status: response.status,
      code: body.code || (response.status === 409 ? 'app_name_taken' : 'unauthorized'),
      error:
        body.error ||
        (response.status === 409
          ? `App name "${slug}" is already in use`
          : "Not authorized to deploy this app"),
    };
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
    // True only on the deploy that adopted a previously anonymous app —
    // the reply tells the agent the app is now permanent.
    claimedNow: !!body.claimedNow,
    orphanExpiresAt: body.orphanExpiresAt || null,
    orphanMessage: body.orphanMessage || null,
    orphanLoginUrl: body.orphanLoginUrl || null,
    // The keep-this-app link, present only on the deploy that CREATED an
    // orphan: it carries a one-time code hostnsoft-api minted with the
    // project (its lib/orphanClaim.ts), so an anonymous redeploy of the
    // same name gets none. server.js relays it as links.claim in the
    // deploy reply, and nowhere else — status and logs need no
    // credential, so a link there would hand the app to anyone.
    claimUrl: body.claimUrl || null,
    isFreePlan: !!body.isFreePlan,
    // {declared, accepted, reason?} when embarko.json listed schedules —
    // hostnsoft-api's docs/schedules.md. Relayed in the deploy reply.
    schedules: body.schedules || null,
    // How many schedules the app has right now, so a deploy without them
    // can say they were kept (server.js deployWarnings).
    scheduleCount: typeof body.scheduleCount === 'number' ? body.scheduleCount : 0,
  };
}

module.exports = { claimProject };
