/**
 * deploy-status.js
 *
 * In-process, in-memory record of each app's most recent deploy attempt
 * — backs GET /apps/:appName/status. Deliberately NOT persisted to
 * hostnsoft-api's database as the source of truth for this endpoint:
 * unlike record-deployment.js's calls (which populate the dashboard's
 * deployment history and only fire for token-authenticated deploys), an
 * orphan (anonymous) deploy has no company to attribute a database row
 * to at all — see docs/Anonymous-deploy-req.md. Tracking state locally
 * instead means the status endpoint works identically for both, with no
 * special-casing.
 *
 * Deliberately ephemeral: if this process restarts mid-build, the build
 * itself is already interrupted (nothing about a build survives a
 * restart today), so losing its in-memory status entry at the same time
 * isn't a new failure mode — the next deploy attempt simply starts a
 * fresh entry.
 */
const state = new Map(); // appName -> { status, appVersion, startedAt, finishedAt, errorDetail, imageTag, deploymentId }

function setDeployState(appName, patch) {
  state.set(appName, { ...state.get(appName), ...patch });
}

function getDeployState(appName) {
  return state.get(appName) || null;
}

module.exports = { setDeployState, getDeployState };
