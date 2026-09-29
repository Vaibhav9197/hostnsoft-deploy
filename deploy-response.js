/**
 * deploy-response.js
 *
 * One shape for every agent-facing reply of this service — POST /apps,
 * GET /apps/:appName/status, GET /apps/:appName/logs, and their errors:
 *
 *   { status, app, next, links }
 *
 *   status — where things stand, one word
 *   app    — only the facts the next step needs
 *   next   — ONE instruction: the thing to do now. Later steps (claim,
 *            showcase) appear in later replies, once they apply, rather
 *            than all being front-loaded into the first one.
 *   links  — only the URLs `next` refers to, plus feedback. `next` names
 *            them (links.status) instead of repeating the URL in prose.
 *
 * Errors keep their existing `error` and `code` (callers branch on code)
 * and gain `next` + `links` on top.
 *
 * The flow this steers an agent through: deploy -> confirm it is live ->
 * claim it (an anonymous deploy, the usual first-time case, is deleted
 * after 24h) -> offer the showcase. Feedback is always one link away.
 */

const DOCS_URL = 'https://embarko.ai/docs';
const SHOWCASE_URL = 'https://embarko.ai/showcase';

// Seconds between status polls. A static publish is done within a second
// or two; a container build takes minutes.
const POLL_SECONDS = { static: 2, service: 10 };

// Every URL a reply can carry lives here, and only here: `app` and the
// rest of the body never repeat one, and `next` refers to them by name
// (links.status) instead of spelling the URL out.
function linksFor(host, appName, appUrl) {
  const base = `https://${host}`;
  return {
    // The app's own public address — what the user is given once it's live.
    app: appUrl,
    status: `${base}/apps/${appName}/status`,
    logs: `${base}/apps/${appName}/logs`,
    // App-scoped feedback: needs no credential while the app is unclaimed,
    // the app's own token once it is.
    feedback: `${base}/apps/${appName}/customer-query`,
    claim: `${base}/api/public/deploy-tokens/request`,
    showcase: SHOWCASE_URL,
    docs: DOCS_URL,
  };
}

// For errors where the app may not exist at all (a rejected name, a bad
// token): the app-scoped feedback route would 404 there, so point at the
// public one, which takes an email instead of an app.
function publicFeedbackUrl(host) {
  return `https://${host}/api/public/customer-query`;
}

// How to call links.feedback — appended only when `next` actually tells
// the agent to report something, so it appears where it is needed and
// nowhere else. The public route has no app to attach to, so it asks for
// the user's email instead.
// `type` says what kind of problem it was, so reports can be triaged
// without reading each one. Same list as customer-query.js's FEEDBACK_TYPES,
// minus the two the dashboard uses.
const TYPE_HINT =
  `"type" is one of "platform_bug" (Embarko itself misbehaved), "missing_capability" (the app needs ` +
  `something Embarko lacks), "docs_issue" (the docs were wrong or unclear), "unexpected_behavior" ` +
  `(it worked, but not as documented) or "other".`;

function withFeedbackHow(next, { publicRoute = false } = {}) {
  if (!next.includes('links.feedback')) return next;
  return publicRoute
    ? `${next} To report: POST {"type": "<type>", "message": "<what happened>", "email": "<the user's email>"} to links.feedback. ${TYPE_HINT}`
    : `${next} To report: POST {"type": "<type>", "message": "<what happened>"} to links.feedback with the header "X-Agent-Name: <your name>". ${TYPE_HINT}`;
}

// `links` with only the named entries, and feedback always.
function pick(all, ...names) {
  const out = {};
  for (const n of names) if (all[n]) out[n] = all[n];
  out.feedback = all.feedback;
  return out;
}

// The claim instruction, written once. Shown only when an app is live and
// still anonymous — the moment it becomes the relevant next step.
function claimInstruction(expiresAt) {
  return (
    `Tell the user it is temporary and will be deleted at ${expiresAt} unless claimed. ` +
    `To claim it: ask the user for their email, POST {"email": "<their email>"} to links.claim ` +
    `(it always answers 202; the token is emailed), ask them to paste the token back, save it to ` +
    `~/.embarko/credentials, then redeploy with the same app name and the header ` +
    `"Authorization: Bearer <token>". That redeploy makes the app permanent at the same URL.`
  );
}

function appFacts({ appName, kind, claimed, expiresAt }) {
  const app = { name: appName, kind, claimed };
  if (!claimed && expiresAt) app.expiresAt = expiresAt;
  return app;
}

/**
 * POST /apps 202. `claimedNow` — this deploy just adopted a previously
 * anonymous app. `convertingFromService` — a server app is being replaced
 * by a static site.
 */
function acceptedBody({ host, appName, kind, url, claimed, claimedNow, expiresAt, convertingFromService }) {
  const all = linksFor(host, appName, url);
  const poll = POLL_SECONDS[kind];

  let next = kind === 'static'
    ? `Static site: nothing to build, so it is being published directly. Check links.status in ${poll} seconds; it should already be live.`
    : `Accepted, not live yet. The build can take a few minutes. Poll links.status every ${poll} seconds until status is "live" or "failed", and don't give the user the URL as working before that.`;

  if (claimedNow) {
    next = `Claimed: this app is now permanent and will not be deleted. Tell the user. ${next}`;
  }
  if (convertingFromService) {
    next =
      `Heads up: "${appName}" was a server app and is now being replaced by a static site; its server ` +
      `is being removed and it cannot be turned back into a server app. If that was not intended, ` +
      `deploy the server version under a new app name. ${next}`;
  }

  return {
    success: true,
    status: kind === 'static' ? 'publishing' : 'building',
    app: appFacts({ appName, kind, claimed, expiresAt }),
    next,
    links: pick(all, 'status'),
  };
}

/**
 * GET /apps/:appName/status. `deployState` is this process's record of
 * the last attempt (deploy-status.js), null after a restart. `health` is
 * Nomad's view (app-health.js) — meaningless for a static site, which has
 * no job; `staticLive` says whether its files are being served instead.
 */
function statusBody({ host, appName, kind, url, claimed, expiresAt, deployState, health, staticLive }) {
  const all = linksFor(host, appName, url);
  const app = appFacts({ appName, kind, claimed, expiresAt });
  const attempt = deployState ? deployState.status : null;
  const poll = POLL_SECONDS[kind];

  const liveNext = claimed
    ? `Live. Give the user links.app. If they would like it listed publicly, point them to links.showcase.`
    : `Live. Give the user links.app. ${claimInstruction(expiresAt)}`;
  const liveLinks = claimed ? pick(all, 'app', 'showcase') : pick(all, 'app', 'claim');

  let body;
  if (attempt === 'in_progress') {
    body = {
      status: kind === 'static' ? 'publishing' : 'building',
      next: `Still ${kind === 'static' ? 'publishing' : 'building'}. Check links.status again in ${poll} seconds.`,
      links: pick(all, 'status'),
    };
  } else if (attempt === 'failed') {
    body = {
      status: 'failed',
      error: deployState.errorDetail || 'The deploy failed.',
      next: kind === 'static'
        ? `Publishing the files failed, which is on our side. Redeploy once; if it fails again, report it to links.feedback.`
        : `Read links.logs to find the cause, fix it, and redeploy under the same app name. If the cause isn't clear, report it to links.feedback.`,
      links: kind === 'static' ? pick(all) : { ...pick(all), logs: `${all.logs}?stream=stderr` },
    };
  } else if (kind === 'static') {
    // No job to ask: the site is live when its files and router exist.
    body = staticLive
      ? { status: 'live', next: liveNext, links: liveLinks }
      : {
          status: 'not_deployed',
          next: `Nothing is published under this name. Deploy it with POST /apps.`,
          links: pick(all),
        };
  } else if (health === 'running') {
    body = { status: 'live', next: liveNext, links: liveLinks };
  } else if (health === 'stopped') {
    // Parked by scale-to-zero: reachable, woken by the first request.
    body = {
      status: 'live',
      next: `${liveNext} It is asleep right now and wakes on the first request, which can take a few seconds.`,
      links: liveLinks,
    };
  } else if (health === 'starting') {
    body = {
      status: 'starting',
      next: `Built, and the app is starting. Check links.status again in ${poll} seconds.`,
      links: pick(all, 'status'),
    };
  } else if (health === 'crashed') {
    body = {
      status: 'crashed',
      next:
        `The build worked but the app stops right after starting. Read links.logs (stderr has the crash), ` +
        `fix it, and redeploy. Common causes: not listening on the PORT environment variable, or binding to ` +
        `localhost instead of 0.0.0.0.`,
      links: { ...pick(all), logs: `${all.logs}?stream=stderr` },
    };
  } else if (health === 'not_deployed') {
    body = {
      status: 'not_deployed',
      next: `Nothing is running under this name. Deploy it with POST /apps.`,
      links: pick(all),
    };
  } else {
    body = {
      status: 'unknown',
      next: `There's no record of a recent deploy (the deploy service may have restarted). If links.app responds, the app is live; if not, redeploy.`,
      links: pick(all, 'app'),
    };
  }

  return {
    status: body.status,
    app,
    ...(body.error ? { error: body.error } : {}),
    next: withFeedbackHow(body.next),
    links: body.links,
    // DEPRECATED — the old field installed deploy scripts poll on
    // (in_progress | success | failed | unknown). Remove once those
    // copies have been updated.
    deploy: { status: attempt || (body.status === 'live' ? 'success' : 'unknown') },
  };
}

// GET /apps/:appName/logs for a static site: there is no process, so
// there is nothing to log.
function staticLogsBody({ host, appName }) {
  return {
    status: 'not_available',
    // Same pair every other "no logs" reply carries, which the dashboard's
    // log panel reads.
    available: false,
    reason: 'This is a static site, so there are no app logs: nothing runs on the server.',
    app: { name: appName, kind: 'static' },
    next: withFeedbackHow(
      `This is a static site, so there are no app logs: nothing runs on the server. If a page looks wrong, ` +
      `check the uploaded files and redeploy. If it still looks broken, report it to links.feedback.`
    ),
    links: pick(linksFor(host, appName)),
  };
}

// What to do about each error code. Anything not listed gets the generic
// line — every error still carries a next step and the feedback link.
const NEXT_FOR_CODE = {
  unauthorized:
    `The deploy token was rejected (unknown or revoked). Deploy without the Authorization header to get a ` +
    `temporary app, or get a new token: POST {"email": "<the user's email>"} to links.claim and ask the user ` +
    `to paste the emailed token. Never send an empty or made-up token.`,
  invalid_app_name:
    `Fix the app name: 3-63 characters, lowercase letters, digits and dashes, not starting or ending with a dash.`,
  app_name_too_short: `Use an app name of at least 3 characters.`,
  app_name_too_long: `Use an app name of at most 63 characters.`,
  app_name_reserved: `That name is reserved and will never be available. Pick a different app name.`,
  app_name_taken: `That name belongs to someone else. Pick a different app name (X-App-Name) and deploy again.`,
  rename_in_progress:
    `This app's web address is being changed. Wait a few minutes, then deploy again using its new name.`,
  app_name_check_failed: `A temporary problem on our side. Retry once; if it keeps failing, report it to links.feedback.`,
  invalid_app_version: `Use only letters, numbers, dots, dashes and underscores in X-App-Version.`,
  invalid_app_type: `Shorten X-App-Type to a plain label such as "portfolio", or leave it out; it is optional.`,
  invalid_agent_name: `Use a short plain name in X-Agent-Name such as "claude-code", or leave it out; it is optional.`,
  missing_source_file: `Attach the app's code: a tar.gz as the "source" form field, or a JSON body with a non-empty "files" array.`,
  invalid_json: `Send a valid JSON body, or upload a tar.gz as the "source" form field instead.`,
  invalid_file_path: `Use relative paths inside the app for every files[].path (no leading "/" and no "..").`,
  invalid_file_content: `Every files[].content must be a string. Base64-encode binary files and set "encoding": "base64".`,
  invalid_file_encoding: `Set files[].encoding to "utf8" or "base64", or leave it out.`,
  source_too_large: `Too big for a JSON upload. Upload a tar.gz as the "source" form field instead.`,
  too_many_files: `Leave out node_modules, build output and .git, or upload a tar.gz instead.`,
  no_manifest_at_root:
    `Repackage so the app's package.json (or index.html for a static site) is at the top of the upload, not inside a folder. foundNestedAt says where it was found.`,
  app_nested_in_subdirectory:
    `Deploy the folder named in deployThisInstead, not the folder above it. A separate backend is a separate app with its own name.`,
  unsupported_storage_pattern:
    `Replace window.storage with SQLite (better-sqlite3) writing under the DATA_DIR environment variable, then redeploy. filesDetected lists where it is used.`,
  invalid_static_root: `Point the Staticfile's root at a folder inside the upload, such as "root: dist", then redeploy.`,
  app_kind_changed:
    `This app is a static site and can't become a server app. Deploy this version under a new app name.`,
  deploy_failed: `Something went wrong reading the upload. Check the archive is a valid tar.gz and redeploy; if it keeps failing, report it to links.feedback.`,
  not_found:
    `No app you can see has this name. Check the name. If the app is claimed, send the deploy token of the company that owns it.`,
  lookup_failed: `A temporary problem on our side. Retry in a few seconds; if it keeps failing, report it to links.feedback.`,
};

const GENERIC_NEXT = `Fix the request as the error describes and try again. If it doesn't make sense, report it to links.feedback.`;

/**
 * Error body. `extra` carries a response's own fields (detail,
 * deployThisInstead, ...). `appExists` picks the feedback link: the
 * app-scoped route once the name is known to exist, the public one
 * (takes the user's email) before that.
 */
function errorBody({ host, appName, error, code, extra = {}, appExists = false, next }) {
  const links = {};
  if (code === 'unauthorized') links.claim = `https://${host}/api/public/deploy-tokens/request`;
  const docsAnchored = ['no_manifest_at_root', 'app_nested_in_subdirectory', 'unsupported_storage_pattern', 'invalid_static_root', 'app_kind_changed'];
  if (docsAnchored.includes(code)) links.docs = DOCS_URL;
  const publicRoute = !(appExists && appName);
  links.feedback = publicRoute ? publicFeedbackUrl(host) : linksFor(host, appName).feedback;

  // `docs` used to sit at the top level of some errors; it lives in links now.
  const { docs, ...rest } = extra;
  return {
    error,
    code,
    ...rest,
    next: withFeedbackHow(next || NEXT_FOR_CODE[code] || GENERIC_NEXT, { publicRoute }),
    links,
  };
}

module.exports = {
  DOCS_URL,
  SHOWCASE_URL,
  linksFor,
  acceptedBody,
  statusBody,
  staticLogsBody,
  errorBody,
};
