/**
 * deploy-in-flight.js
 *
 * Which apps have a deploy running in this process right now — from the
 * moment hostnsoft-api has claimed the name for it until the build and
 * Nomad deploy have finished, success or failure. Backs DELETE
 * /internal/apps/:appName?ifIdle=1, which hostnsoft-api's orphan cleanup
 * sends so it never tears an expired orphan down under a deploy that
 * started before the 24 hours ran out: the teardown would land first,
 * then the build would bring the app back up with no project behind it.
 *
 * Separate from deploy-status.js on purpose. That one holds the LAST
 * deploy's outcome for GET /apps/:appName/status and only says
 * "in_progress" once the upload has been unpacked and checked; a request
 * rejected before then never touches it. This starts at the claim, and
 * every registration is released exactly once, so a rejected or failed
 * deploy can't leave an app looking busy forever.
 *
 * A count, not a flag: an app can have two deploys going at once (the
 * same name deployed twice in a row), and the first one finishing must
 * not make the app look idle while the second is still building.
 *
 * In-memory, same as deploy-status.js: a restart interrupts every build
 * anyway, so there is nothing left in flight to remember.
 */
const counts = new Map(); // appName -> number of deploys in flight

// Returns the release function. Calling it more than once is harmless.
function beginDeploy(appName) {
  counts.set(appName, (counts.get(appName) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (counts.get(appName) || 1) - 1;
    if (left > 0) counts.set(appName, left);
    else counts.delete(appName);
  };
}

function isDeployInFlight(appName) {
  return counts.has(appName);
}

module.exports = { beginDeploy, isDeployInFlight };
