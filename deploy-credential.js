/**
 * deploy-credential.js
 *
 * Reads whichever credential a POST /apps request presented, and packages
 * it for the two hostnsoft-api calls a deploy makes (claim-project.js and
 * record-deployment.js) so neither has to know which kind it's carrying.
 * Mirrors hostnsoft-api's own src/services/deployActor.ts — the two must
 * agree on the shape, so change them together.
 *
 * Three shapes, and they are NOT interchangeable:
 *
 *   deploy token (Authorization: Bearer <token>) — the original path
 *     (agents, CI, the CLI). Company-scoped at creation, so it alone says
 *     which company; validated here before any build resources are spent,
 *     exactly as before.
 *   proxy_auth_token (+ X-Company-Id) — added 2026-09-17 for the
 *     dashboard's upload button. The PAT is the dashboard's own login
 *     credential; it is NOT company-scoped (one person can belong to
 *     several companies), so the company comes from the header — and is
 *     VERIFIED by hostnsoft-api against proxy membership, never trusted
 *     from here. Not validated in this process at all: claim-project.js's
 *     call is the single verification point, so there's no second proxy
 *     round-trip per deploy and no way for the two checks to disagree.
 *   neither — the anonymous/orphan path (docs/Anonymous-deploy-req.md).
 *
 * Anonymous stays opt-in BY OMISSION ONLY. A credential that's present
 * and fails is an error, never a silent fallback to "deploy anonymously
 * instead" — that would hand someone a self-deleting app they believe is
 * permanent, and would mask a real auth bug (typo'd token, expired
 * session) as a feature.
 */
const { validateDeployToken } = require('./validate-deploy-token');

const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET; // validated at startup by internal-auth.js

// Returns { ok: true, credential } — credential is null for anonymous —
// or { ok: false, status, code, error } to return to the caller as-is.
async function readDeployCredential(req) {
  const authHeader = req.headers.authorization;
  const proxyAuthToken = req.headers['proxy_auth_token'];
  const companyId = req.headers['x-company-id'];

  // Deploy token wins when both are somehow presented — the same
  // precedence authorizeAppAccess already applies to status/logs, so no
  // existing agent/CI caller's behavior can shift no matter what the
  // dashboard starts sending alongside.
  if (authHeader) {
    const token = authHeader.split(' ')[1];
    if (!token || !(await validateDeployToken(token))) {
      return { ok: false, status: 401, code: 'unauthorized', error: "Unauthorized" };
    }
    return { ok: true, credential: { token } };
  }

  if (proxyAuthToken) {
    // Checked here rather than left to hostnsoft-api purely so the
    // message names the header the caller actually forgot to send.
    if (!companyId) {
      return {
        ok: false,
        status: 400,
        code: 'company_id_required',
        error: "Missing X-Company-Id header. A proxy_auth_token isn't scoped to one company, so the deploy has to say which company this app belongs to.",
      };
    }
    return { ok: true, credential: { proxyAuthToken, companyId } };
  }

  return { ok: true, credential: null };
}

// The credential fields to merge into an internal call's JSON body.
// Anonymous contributes nothing at all — hostnsoft-api routes on the
// ABSENCE of every credential field, so sending explicit nulls would not
// mean the same thing.
function credentialBody(credential) {
  return credential || {};
}

// hostnsoft-api demands the shared internal secret on the PAT branch
// only, and for the reason verify-proxy-auth.js already records: a PAT is
// the credential that drives the whole dashboard, far more powerful than
// a company-scoped deploy token, so relaying one additionally proves the
// call is coming from this service. A deploy token needs no such proof —
// knowing the raw token simply IS the credential.
function credentialHeaders(credential) {
  return credential && credential.proxyAuthToken
    ? { 'X-Internal-Secret': INTERNAL_API_SECRET }
    : {};
}

// True for anything that identifies a company — i.e. everything except
// anonymous. Gates deployment-history recording, which has no company to
// attribute an anonymous deploy to (docs/Anonymous-deploy-req.md).
function isIdentified(credential) {
  return credential !== null;
}

module.exports = { readDeployCredential, credentialBody, credentialHeaders, isIdentified };
