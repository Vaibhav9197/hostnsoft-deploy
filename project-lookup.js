/**
 * project-lookup.js
 *
 * Read-only counterpart to claim-project.js — calls hostnsoft-api's
 * POST /internal/projects/lookup to find out whether an app name exists,
 * whether it's an unclaimed orphan, and which company owns it, WITHOUT
 * claim-project.js's side effects (auto-creating a project on first
 * sight, or adopting an orphan into a company). Backs GET
 * /apps/:appName/status and .../logs, which must never mutate anything
 * just from being checked.
 *
 * Fails closed, same convention as validate-deploy-token.js: an
 * unreachable hostnsoft-api must never be treated as "this app doesn't
 * exist" or "anyone may view it".
 */
const logger = require("./logger");

const HOSTNSOFT_API_URL = process.env.HOSTNSOFT_API_URL;

async function lookupProject(slug) {
  let response;
  try {
    response = await fetch(`${HOSTNSOFT_API_URL}/internal/projects/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug }),
    });
  } catch (e) {
    logger.error(`[project-lookup] could not reach hostnsoft-api looking up "${slug}": ${e.message}`);
    return { ok: false, status: 502, code: 'lookup_failed', error: "Could not verify app ownership" };
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "<unreadable response body>");
    logger.error(`[project-lookup] hostnsoft-api returned HTTP ${response.status} looking up "${slug}": ${bodyText}`);
    return { ok: false, status: 502, code: 'lookup_failed', error: "Could not verify app ownership" };
  }

  const body = await response.json();
  if (!body.exists) {
    return { ok: false, status: 404, code: 'not_found', error: "Not found" };
  }
  return {
    ok: true,
    companyId: body.companyId,
    isOrphan: !!body.isOrphan,
    orphanExpiresAt: body.orphanExpiresAt || null,
  };
}

module.exports = { lookupProject };
