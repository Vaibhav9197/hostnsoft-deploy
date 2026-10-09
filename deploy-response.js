/**
 * deploy-response.js
 *
 * One shape for every agent-facing reply of this service — POST /apps,
 * GET /apps/:appName/status, GET /apps/:appName/logs, and their errors:
 *
 *   { status, app, next, links }
 *
 *   status — where things stand, one word
 *   app    — only the facts the next step needs; never a URL
 *   next   — ONE short sentence: the thing to do now. Later steps (claim,
 *            showcase) appear in later replies, once they apply.
 *   links  — every URL in the reply, and only here. `next` names them
 *            (links.status) instead of repeating the URL in prose.
 *
 * `next` stays short on purpose. When a step needs more than a sentence —
 * how to claim, what the showcase needs, the runtime rules behind a crash,
 * how to send feedback — the detail lives in a capabilities topic
 * (capabilities.js) and the reply links it as links.help. The agent reads
 * it only if it needs to.
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
// rest of the body never repeat one.
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

// links.help: the capabilities topic that explains this reply's next step
// in full. One per reply at most, and only where a sentence isn't enough.
function helpUrl(host, topic) {
  return `https://${host}/capabilities/${topic}`;
}

// `links` with only the named entries, and feedback always.
function pick(all, ...names) {
  const out = {};
  for (const n of names) if (all[n]) out[n] = all[n];
  out.feedback = all.feedback;
  return out;
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
    ? `Static site, no build needed: check links.status in ${poll} seconds.`
    : `Building: poll links.status every ${poll} seconds until it says "live", "failed" or "crashed".`;
  if (claimedNow) next = `Claimed, so the app is permanent now. ${next}`;
  if (convertingFromService) {
    next = `This replaces the server app with a static site, which can't be undone; if that's wrong, redeploy the server version under a new name. ${next}`;
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
 * POST /apps for a static site that finished publishing while the request
 * waited (see STATIC_WAIT_MS in server.js): the real outcome, so the agent
 * goes straight to the next step (claim, or showcase) instead of polling.
 * Same body the status reply would give, minus its deprecated `deploy`
 * field, with the claim/convert notes the 202 would have carried.
 */
function publishedBody({ host, appName, url, claimed, claimedNow, expiresAt, convertingFromService, deployState, live }) {
  const { deploy, ...body } = statusBody({
    host, appName, kind: 'static', url, claimed, expiresAt, deployState, staticLive: live,
  });
  let next = body.next;
  if (claimedNow) next = `Claimed, so the app is permanent now. ${next}`;
  if (convertingFromService) {
    next = `This replaced the server app with a static site, which can't be undone; if that's wrong, redeploy the server version under a new name. ${next}`;
  }
  return live
    ? { success: true, ...body, next }
    : { success: false, code: 'publish_failed', ...body, next };
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

  // Live: give the user the URL, then the one next step for this app —
  // claim it while it's temporary, offer the showcase once it's kept.
  const live = claimed
    ? {
        status: 'live',
        next: 'Live: give the user links.app. If they want it listed publicly, follow links.help.',
        links: { ...pick(all, 'app'), help: helpUrl(host, 'showcase') },
      }
    : {
        status: 'live',
        next: `Live: give the user links.app and tell them it will be deleted at ${expiresAt} unless claimed. To claim it, follow links.help.`,
        links: { ...pick(all, 'app'), help: helpUrl(host, 'claim') },
      };
  const feedbackHelp = helpUrl(host, 'feedback');

  let body;
  if (attempt === 'in_progress') {
    body = {
      status: kind === 'static' ? 'publishing' : 'building',
      next: `Still ${kind === 'static' ? 'publishing' : 'building'}: check links.status again in ${poll} seconds.`,
      links: pick(all, 'status'),
    };
  } else if (attempt === 'failed') {
    body = kind === 'static'
      ? {
          status: 'failed',
          error: deployState.errorDetail || 'The deploy failed.',
          next: 'Publishing failed on our side: redeploy once, and if it fails again report it to links.feedback (see links.help).',
          links: { ...pick(all), help: feedbackHelp },
        }
      : {
          status: 'failed',
          error: deployState.errorDetail || 'The deploy failed.',
          next: 'Build failed: read links.logs, fix the cause, and redeploy with the same name. If it isn\'t clear, report it to links.feedback (see links.help).',
          links: { ...pick(all), logs: `${all.logs}?stream=stderr`, help: feedbackHelp },
        };
  } else if (kind === 'static') {
    // No job to ask: the site is live when its files and router exist.
    body = staticLive
      ? live
      : { status: 'not_deployed', next: 'Nothing is published under this name: deploy it with POST /apps.', links: pick(all) };
  } else if (health === 'running') {
    body = live;
  } else if (health === 'stopped') {
    // Parked by scale-to-zero: reachable, woken by the first request.
    body = { ...live, next: `${live.next} It's asleep now and wakes on the first request.` };
  } else if (health === 'starting') {
    body = {
      status: 'starting',
      next: `Built and starting: check links.status again in ${poll} seconds.`,
      links: pick(all, 'status'),
    };
  } else if (health === 'crashed') {
    body = {
      status: 'crashed',
      next: 'It builds but crashes on start: read links.logs, fix it, and redeploy. links.help lists the runtime rules (PORT, 0.0.0.0).',
      links: { ...pick(all), logs: `${all.logs}?stream=stderr`, help: helpUrl(host, 'deploy') },
    };
  } else if (health === 'not_deployed') {
    body = { status: 'not_deployed', next: 'Nothing is running under this name: deploy it with POST /apps.', links: pick(all) };
  } else {
    body = {
      status: 'unknown',
      next: 'No record of a recent deploy (the service may have restarted): if links.app responds, it\'s live; if not, redeploy.',
      links: pick(all, 'app'),
    };
  }

  return {
    status: body.status,
    app,
    ...(body.error ? { error: body.error } : {}),
    next: body.next,
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
    next: 'Static sites have no logs: if a page looks wrong, check the files and redeploy (see links.help).',
    links: { ...pick(linksFor(host, appName)), help: helpUrl(host, 'static-sites') },
  };
}

// The one-sentence fix for each error code. Anything not listed gets the
// generic line — every error still carries a next step and the feedback
// link.
const NEXT_FOR_CODE = {
  unauthorized: 'The token was rejected: deploy without it for a temporary app, or get a new one (see links.help).',
  invalid_app_name: 'Use 3-63 lowercase letters, digits and dashes, not starting or ending with a dash.',
  app_name_too_short: 'Use an app name of at least 3 characters.',
  app_name_too_long: 'Use an app name of at most 63 characters.',
  app_name_reserved: 'That name is reserved and never becomes free: pick a different one.',
  app_name_taken: 'That name belongs to someone else: pick a different one.',
  rename_in_progress: 'This app\'s address is being changed: wait a few minutes, then deploy under its new name.',
  app_name_check_failed: 'Temporary problem on our side: retry once, and report it to links.feedback if it keeps happening.',
  invalid_app_version: 'Use only letters, numbers, dots, dashes and underscores in X-App-Version.',
  invalid_app_type: 'Shorten X-App-Type to a plain label like "portfolio", or leave it out.',
  invalid_agent_name: 'Use a short plain name in X-Agent-Name like "claude-code", or leave it out.',
  missing_source_file: 'Attach the code: a tar.gz as the "source" field, or JSON with a non-empty "files" array.',
  invalid_json: 'Send valid JSON, or upload a tar.gz as the "source" field instead.',
  invalid_file_path: 'Use relative paths inside the app for every files[].path (no leading "/" or "..").',
  invalid_file_content: 'Make every files[].content a string; base64-encode binary files and set "encoding": "base64".',
  invalid_file_encoding: 'Set files[].encoding to "utf8" or "base64", or leave it out.',
  source_too_large: 'Too big for JSON: upload a tar.gz as the "source" field instead.',
  too_many_files: 'Leave out node_modules, build output and .git, or upload a tar.gz instead.',
  no_manifest_at_root: 'Repackage so package.json (or index.html) is at the top of the upload; foundNestedAt says where it is.',
  app_nested_in_subdirectory: 'Deploy the folder named in deployThisInstead, not the one above it.',
  unsupported_storage_pattern: 'Replace window.storage with SQLite under DATA_DIR (see links.help), then redeploy.',
  invalid_static_root: 'Point the Staticfile\'s root at a folder inside the upload, like "root: dist".',
  app_kind_changed: 'A static site can\'t become a server app: deploy this version under a new name (see links.help).',
  deploy_failed: 'Couldn\'t read the upload: check it\'s a valid tar.gz and redeploy, then report it to links.feedback if it keeps failing.',
  not_found: 'No app you can see has this name: check the name, and send the owning company\'s token if it\'s claimed.',
  lookup_failed: 'Temporary problem on our side: retry in a few seconds, and report it to links.feedback if it keeps happening.',
};

// The capabilities topic that explains the error in full, for the few codes
// where a sentence can't: how to get a token, where data lives, and what a
// static site can't do.
const HELP_FOR_CODE = {
  unauthorized: 'claim',
  unsupported_storage_pattern: 'files',
  invalid_static_root: 'static-sites',
  app_kind_changed: 'static-sites',
};

const GENERIC_NEXT = 'Fix the request as the error says and retry, or report it to links.feedback if it doesn\'t make sense.';

/**
 * Error body. `extra` carries a response's own fields (detail,
 * deployThisInstead, ...). `appExists` picks the feedback link: the
 * app-scoped route once the name is known to exist, the public one
 * (takes the user's email) before that.
 */
function errorBody({ host, appName, error, code, extra = {}, appExists = false, next }) {
  const links = {};
  const docsAnchored = ['no_manifest_at_root', 'app_nested_in_subdirectory', 'invalid_static_root'];
  if (docsAnchored.includes(code)) links.docs = DOCS_URL;
  const text = next || NEXT_FOR_CODE[code] || GENERIC_NEXT;
  // An error with no topic of its own that asks for a report points at the
  // feedback topic, which says what to send.
  const topic = HELP_FOR_CODE[code] || (text.includes('links.feedback') ? 'feedback' : null);
  if (topic) links.help = helpUrl(host, topic);
  const publicRoute = !(appExists && appName);
  links.feedback = publicRoute ? publicFeedbackUrl(host) : linksFor(host, appName).feedback;

  // `docs` used to sit at the top level of some errors; it lives in links now.
  const { docs, ...rest } = extra;
  return {
    error,
    code,
    ...rest,
    next: text,
    links,
  };
}

module.exports = {
  DOCS_URL,
  SHOWCASE_URL,
  linksFor,
  acceptedBody,
  publishedBody,
  statusBody,
  staticLogsBody,
  errorBody,
};
