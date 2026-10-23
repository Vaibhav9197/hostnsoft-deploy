const path = require('path');

// Loads .env from this file's own directory, not process.cwd() — pm2 isn't
// guaranteed to launch this with its cwd set to here, so the default
// (cwd-relative) dotenv behavior would silently miss the file under pm2.
// Must run before validate-deploy-token.js (and anything else reading
// process.env) is required below.
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const tar = require('tar');
const fs = require('fs-extra');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const { randomUUID } = require('crypto');
const logger = require('./logger');
const { runWithRequestId } = require('./request-context');

// NEW: detects apps built assuming Claude Artifacts' window.storage API,
// which does not exist outside that sandbox and will fail if deployed
// here unmodified. Blocks the deploy with a clear message rather than
// building/shipping an app that will break at runtime. Skipped entirely
// for apps that already declare a real database dependency.
const { detectWindowStorageUsage, hasRealDatabaseDependency } = require('./detect-storage-usage');
const { detectTimers } = require('./detect-timers');
const { readEmbarkoConfig } = require('./embarko-config');
const { BUILD_INFO } = require('./build-info');

// NEW: confirms the extracted upload actually has a manifest (or
// index.html) at buildDir's own root — Railpack only looks there. Catches
// the "app files nested in an extra wrapping folder" upload before any
// build time is spent on it, instead of letting Railpack fail deep inside
// the build with a cryptic error that never names the real cause.
const { resolveBuildRoot, detectDelegatingRoot } = require('./detect-manifest-root');

// NEW: keeps a failed build's actual output (which used to be discarded
// entirely) and turns the exit codes with an unambiguous meaning into a
// stated cause. See build-diagnostics.js.
const {
  setBuildLog, getBuildLog, describeBuildFailure, BUILD_OUTPUT_MAX_BUFFER,
} = require('./build-diagnostics');

// NEW: every deploy now authenticates as a specific company via a
// company-scoped token issued (and revocable/rotatable) by hostnsoft-api,
// replacing the old single shared PLATFORM_TOKEN everyone used.
// (POST /apps validates its own token through deploy-credential.js below,
// which has to handle the proxy_auth_token alternative too; this import is
// only the status/logs path's company-resolving variant.)
const { validateDeployTokenWithCompany } = require('./validate-deploy-token');

// NEW: reports each deploy attempt's outcome back to hostnsoft-api so its
// dashboard deployment history is actually populated.
const { recordDeployment } = require('./record-deployment');

// NEW: confirms the app name is available to this company BEFORE any
// build/Nomad resources are spent — the app name is also the live
// subdomain, so it must be unique platform-wide.
const { claimProject } = require('./claim-project');

// NEW (2026-09-17): POST /apps also accepts the dashboard's own
// proxy_auth_token (+ X-Company-Id), so the upload button in the UI can
// deploy as the logged-in person instead of making them mint a
// company-wide deploy token first. One module reads whichever credential
// came in and packages it for the hostnsoft-api calls below.
const { readDeployCredential } = require('./deploy-credential');

// NEW: shared Nomad job spec builder — see docs/Customdomain-req.md. Used
// here after a fresh build, and by the /internal/apps/:appName/config
// endpoint below when only custom-domain routing changed (no rebuild).
// APPS_DOMAIN_SUFFIX's fail-fast check now lives inside this module (see
// its defaultDomainFor) rather than here, since both this file and the
// config endpoint below need it.
const { buildNomadJobSpec, defaultDomainFor, appDataPathFor, specPathFor } = require('./nomad-job-spec');
const scaleToZero = require('./scale-to-zero-registry');
const { requireInternalSecret } = require('./internal-auth');
const { getNomadJob, stopNomadJob } = require('./nomad-job');
const { describeTaskFailure, formatForOwner } = require('./nomad-task-failure');
const { renameApp, renameStaticApp } = require('./rename-app');

// NEW: the static fast path — see docs/Static-apps-req.md. build-plan.js
// asks Railpack whether an upload is a plain static site; if so it is
// published as files (static-site.js) behind a Traefik file-provider
// router (traefik-router-file.js) instead of being built into an image
// and run as a Nomad job. app-kind.js says which of the two an existing
// app already is, since an app name keeps its kind for life.
const { inspectBuildPlan } = require('./build-plan');
const {
  isStaticApp, hasStaticVersion, publishStaticVersion, switchCurrentVersion,
  updateManifest, pruneOldStaticVersions, removeStaticApp,
} = require('./static-site');
const { writeStaticRouterFile, removeStaticRouterFile } = require('./traefik-router-file');
const { resolveAppKind } = require('./app-kind');

// ---------------------------------------------------------------------------
// Memory policy — see docs/Memory-oversubscription-req.md.
//
// Every app now gets TWO numbers in its Nomad job spec instead of one: a
// low `memory` the scheduler packs against, and the `memory_max` ceiling
// it may actually burst up to. The CEILING values below are exactly the
// numbers that used to be the single flat reservation (and are still what
// the docs publish and what hostnsoft-api persists as
// Project.memoryMb) — no app's real limit changed. Only the number Nomad
// bin-packs against got lower.
//
// The floor comes from real `docker stats` data off the live server:
// typical apps sit at 20-150MB against a 256MB reservation, so packing
// against 256 was causing "resources exhausted" placement failures on a
// box with plenty of free RAM. 32 deliberately sits at the LOW end of
// that observed range rather than at its middle — the floor only has to
// be enough to schedule against, since everything above it is available
// as burst. A task that needs more still gets it, up to its ceiling.
//
// Both numbers are universal: there is no second, higher tier for
// embedded-database apps any more. That tier existed solely for PGlite,
// which is no longer supported (SQLite only — see detect-storage-usage.js).
// SQLite is an in-process library rather than a separate database engine,
// so a SQLite-backed app needs no more headroom than any other app.
//
// Applies to new deploys only. Already-running apps keep whatever job
// spec they were last deployed with until their next deploy — nothing
// needs to be restarted for this to take effect.
const MEMORY_CEILING_MB = 256;
const SCHEDULING_FLOOR_MB = 32;

// NEW: GET /internal/apps/:appName/status — real Nomad allocation status,
// backing hostnsoft-api's project-health field (previously hardcoded to
// "unknown"). See app-health.js.
const { getAppHealth } = require('./app-health');

// NEW: GET /internal/apps/:appName/analytics — per-app traffic (from
// Traefik's access log) and CPU/memory (from Nomad's stats API) history,
// backing hostnsoft-api's analytics endpoints. See analytics/*.js.
const { startAccessLogTailer } = require('./analytics/access-log-tailer');
const { startResourcePoller } = require('./analytics/resource-poller');
const { startRetentionLoop } = require('./analytics/retention');
const { isValidRange, queryTraffic, queryResourceUsage } = require('./analytics/query');

// NEW: POST /apps now responds as soon as the upload is validated and
// accepted, before the (potentially multi-minute) build/deploy actually
// runs — a slow build was causing Cloudflare's own proxy timeout (524)
// well before the deploy itself had a chance to finish. The build now
// continues in the background; deploy-status.js tracks its progress
// in-process (see GET /apps/:appName/status) and app-logs.js/
// project-lookup.js back that endpoint and GET /apps/:appName/logs.
const { setDeployState, getDeployState, clearDeployState } = require('./deploy-status');
const { beginDeploy, isDeployInFlight } = require('./deploy-in-flight');
const { lookupProject } = require('./project-lookup');
const { verifyProxyAuthCompanyAccess } = require('./verify-proxy-auth');
const { getAppLogs } = require('./app-logs');

// NEW: lets an AI agent submit a feature request, piece of feedback, or
// other query in the context of the app it's deploying — see
// docs/request-feature-req.md (Path C). Forwards to hostnsoft-api, same
// shape as recordDeployment.
const { submitCustomerQuery, FEEDBACK_TYPES } = require('./customer-query');

// NEW: keeps only the last N local images per app so one-click rollback
// always has a bounded, known-good window to roll back into (and disk
// usage stays bounded on a host that never pushes images to a registry).
const { pruneOldImages, IMAGE_RETAIN_COUNT } = require('./image-retention');
const { pushToRegistry } = require('./image-registry');

// NEW: reports an async config-push's real outcome (see the
// POST /internal/apps/:appName/config deploymentId branch below) back to
// hostnsoft-api once it's known.
const { reportConfigPushResult } = require('./report-config-push');
// JSON { files: [...] } source for POST /apps — what an MCP tool call can
// carry, since it can't attach a file. See json-source.js.
const { jsonSource } = require('./json-source');
// The { status, app, next, links } shape every agent-facing reply uses.
// The docs URL lives there too, so every reply links the same one.
const { acceptedBody, publishedBody, statusBody, staticLogsBody, errorBody, linksFor, timersWarning } = require('./deploy-response');

// How long POST /apps waits for a static site to publish before answering
// "check back" instead. Almost every static site is done in about a second,
// so the agent gets the live result in one reply; a very large one falls
// back to polling, well inside Cloudflare's ~100s and the dashboard
// proxy's 120s request timeouts.
const STATIC_WAIT_MS = Number(process.env.STATIC_WAIT_MS) || 5000;

// Origins allowed to call this service from a BROWSER. Until the
// dashboard's upload button (2026-09-17) every caller here was an agent,
// a CI job or the CLI — none of which is subject to CORS at all, which is
// why this service had none. Now the dashboard uploads a tarball to
// POST /apps directly from the page, so without this the browser refuses
// the preflight and the upload never reaches the auth check.
//
// Comma-separated allowlist rather than a wildcard. Not because a
// wildcard would leak a credential — nothing here is cookie- or
// ambient-authenticated, every credential is an explicit header a
// cross-origin page would have to already possess — but because an
// allowlist keeps the blast radius of a future cookie/session change
// small, and makes "who is allowed to drive deploys from a browser" a
// deployment decision rather than an implicit one.
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const app = express();

// First, ahead of every route — assigns a unique id to each request so
// every log line made while handling it (anywhere, including inside
// claim-project.js/record-deployment.js) can be correlated back to this
// one invocation, plus logs the request's start and its final status.
app.use((req, res, next) => {
  const requestId = randomUUID();
  res.setHeader('X-Request-Id', requestId);

  runWithRequestId(requestId, () => {
    logger.info(`--> ${req.method} ${req.originalUrl}`);
    res.on('finish', () => {
      logger.info(`<-- ${req.method} ${req.originalUrl} ${res.statusCode}`);
    });
    next();
  });
});

// Ahead of every route (but after the request-id middleware, so a
// preflight is logged and carries X-Request-Id like anything else), so
// preflights are answered for all of them.
//
// No `credentials: true` — this service reads credentials from explicit
// headers only and never from a cookie, so allowing credentialed
// cross-origin requests would grant nothing but would rule out ever
// widening the allowlist.
//
// Requests with no Origin header at all (curl, the CLI, agents,
// server-to-server) are unaffected: cors() passes them straight through,
// which is what keeps every existing non-browser caller working exactly
// as before.
app.use(
  cors({
    origin: FRONTEND_ORIGINS,
    // proxy_auth_token and x-company-id are the dashboard's upload
    // credential; the rest are what POST /apps and the agent-facing
    // endpoints already read. A header missing here is silently dropped
    // by the browser, so the request arrives looking unauthenticated.
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'proxy_auth_token',
      'X-Company-Id',
      'X-App-Name',
      'X-App-Id',
      'X-App-Version',
      'X-Agent-Name',
    ],
    methods: ['GET', 'POST', 'OPTIONS'],
    // So the dashboard can correlate a failed upload with this service's
    // own logs without the user having to paste anything.
    exposedHeaders: ['X-Request-Id'],
  })
);

// Configure Multer to save uploaded files to a temporary folder
const upload = multer({ dest: '/tmp/platform-uploads/' });
/**
 * Save the app's Nomad job spec so it can be woken after a stop.
 *
 * Nomad's own copy is not enough: `job_gc_threshold` (4h) collects a
 * STOPPED job out of Nomad's state entirely, taking the spec with it, and
 * the spec rendered here is written to a temp build directory that is
 * deleted moments later.
 *
 * idle-report.js already captures this immediately before it stops an
 * app, which covers the apps scale-to-zero itself stops. That is not
 * sufficient for a real app: it means the ONLY thing that ever creates
 * the spec is the first stop, so between an app joining the allowlist and
 * its first stop there is no saved spec at all — and any failure in that
 * first capture leaves an app that cannot be woken. Writing it at deploy
 * time means the spec exists from the moment the app does.
 *
 * Best-effort, and deliberately after the deploy has already succeeded: a
 * failure here costs the ability to scale that app to zero, which is an
 * opt-in feature. Failing the deploy over it would trade a working
 * deployment for a missing optional file.
 *
 * The wake routers are rewritten here too, from the spec just saved. In
 * universal mode every running app is eligible to be stopped, but the
 * router file was only rewritten on opt-in/out, rename, delete and a
 * platform redeploy — so an app first deployed after the last redeploy
 * was stopped with no wake router and 404'd until the next one
 * (daily-mandala, 2026-10-11). Same for a custom domain added here.
 */
async function saveJobSpec(appName) {
  try {
    const { stdout } = await execPromise(`nomad job inspect ${appName}`);
    // Parsed before writing so a truncated or error response cannot
    // overwrite a good spec with something that only fails at wake time.
    const parsed = JSON.parse(stdout);
    if (!parsed.Job || parsed.Job.ID !== appName) throw new Error('inspect returned no matching Job');
    const dest = specPathFor(appName);
    await fs.ensureDir(path.dirname(dest));
    await fs.writeFile(dest, stdout);
  } catch (e) {
    logger.warn(`[${appName}] Could not save Nomad job spec (scale-to-zero wake would fail): ${e.message}`);
  }
  await scaleToZero.regenerateRouters().catch((e) => {
    logger.warn(`[${appName}] Could not rewrite scale-to-zero wake routers (continuing): ${e.message}`);
  });
}

/**
 * A job that is registered but DEAD must be purged before it can be
 * deployed over.
 *
 * Nomad versions a job by the content of its spec. Redeploying the same
 * app version produces a byte-identical spec (only the image tag and
 * APP_VERSION vary per deploy), so Nomad creates no new version and
 * starts no new deployment — and `nomad job run` then monitors the
 * PREVIOUS deployment. If that one failed, the CLI exits non-zero and
 * the deploy is reported as a failure although nothing was even
 * attempted. The job's Submit Date gives it away: unchanged.
 *
 * That makes the most natural recovery action — retry the failed deploy
 * with the same version number — permanently impossible, with an error
 * ("Command failed: nomad job run ...") that says nothing about the
 * actual cause. Hit for real on 2026-09-18.
 *
 * Only a job with no running allocations is purged, so this cannot
 * disturb a live app: a running job takes the normal update path, where
 * an identical spec correctly means "nothing to do". A stopped job is
 * also purged — that includes one parked by scale-to-zero, where a
 * deploy should plainly bring the app back rather than silently no-op.
 */
async function purgeIfNotRunning(appName) {
  // Exact lookup: `nomad job inspect` would return a DIFFERENT dead job
  // whose name merely starts with this one, and the purge below would
  // then target it (see nomad-job.js).
  let status;
  try {
    status = await getNomadJob(appName);
  } catch (e) {
    logger.warn(`[${appName}] Could not look up existing job (continuing): ${e.message}`);
    return;
  }
  if (!status || (status.Status === 'running' && status.Stop !== true)) return;

  logger.info(`[${appName}] Existing job is ${status.Stop ? 'stopped' : status.Status} — purging before deploy`);
  await stopNomadJob(appName, { purge: true }).catch((e) => {
    // Not fatal: the run below may still succeed (it will, whenever the
    // new spec actually differs). Failing the deploy here would turn a
    // recoverable case into an outage.
    logger.warn(`[${appName}] Purge of dead job failed (continuing): ${e.message}`);
  });
}

/**
 * Runs `nomad job run` (no -detach, so it returns only once the deployment
 * succeeds or fails). On failure, replaces the CLI's unhelpful error with
 * the app's own crash details (exit code, restarts, last log lines) from
 * nomad-task-failure.js. The thrown error carries no stdout/stderr so
 * setBuildLog does not overwrite the railpack build log.
 */
async function runNomadJob(appName, nomadFilePath) {
  // Allocations older than this belong to earlier deploys/wakes and must
  // not be blamed for this one (see pickAllocation in nomad-task-failure).
  const since = Date.now() - 5000; // clock skew between us and Nomad
  try {
    await execPromise(`nomad job run ${nomadFilePath}`);
  } catch (e) {
    logger.error(`[${appName}] nomad job run failed: ${(e.stderr || e.stdout || e.message || '').trim().slice(-2000)}`);
    const diagnosis = await describeTaskFailure(appName, { since }).catch(() => null);
    const explained = formatForOwner(appName, diagnosis);
    if (explained) {
      logger.warn(`[${appName}] Deploy failed at startup: exit code ${diagnosis.exitCode}, ${diagnosis.restarts} restart(s), alloc ${diagnosis.allocId}`);
      throw new Error(explained);
    }
    throw new Error(
      `Nomad could not bring the app up and the deploy was stopped (${e.message.split('\n')[0]}). ` +
      `GET /apps/${appName}/logs has the container's output, if any was produced.`
    );
  }
}

// `railpack build` can exit 0 without leaving a tagged image behind — a
// production incident did exactly that (docs/CLAUDE.md, "The still-open
// production mystery"), and trusting the exit code alone let the deploy
// carry on to `nomad job run`, where the allocation died pulling an
// image that was never there. That failure surfaced far from the build
// log that could have explained it. So the image is asked for directly,
// here, and a miss is a build failure like any other: the thrown error
// lands in finishDeployFailure, and the railpack output captured just
// before this runs stays retrievable via GET /apps/:appName/logs (a
// plain Error carries no stdout/stderr, so setBuildLog there is a no-op
// and does not overwrite it).
async function assertImageExists(appName, imageName) {
  try {
    // --format keeps the output to the image ID; the default is the full
    // inspect JSON, which is large and not needed here.
    await execPromise(`docker image inspect --format '{{.Id}}' ${imageName}`);
  } catch (e) {
    const detail = (e.stderr || e.message || '').trim();
    throw new Error(
      `Railpack reported success but no Docker image named "${imageName}" exists, so there is nothing to deploy. ` +
      `The build did not produce an image; check the build log (GET /apps/${appName}/logs) for what railpack actually did.` +
      (detail ? `\n\ndocker image inspect: ${detail}` : '')
    );
  }
  logger.info(`[${appName}] Verified image ${imageName} exists.`);
}

// Creates this app's host data directory before Nomad is asked to bind
// mount it. Docker would otherwise create a missing bind-mount source
// itself, but as root and mode 0755 — and Railpack images do not
// necessarily run as root, so the app would get a directory it cannot
// write to and fail at runtime rather than at deploy time. Creating it
// here with an explicit permissive mode avoids depending on whatever
// user a given app's image happens to run as.
//
// Idempotent, and deliberately never removes anything: this runs on
// every deploy of an existing app too, where the directory already
// exists and holds the app's live database. Deleting an app's data is
// the delete endpoint's job alone (see DELETE /internal/apps/:appName).
async function ensureAppDataDir(appName) {
  const dir = appDataPathFor(appName);
  await fs.ensureDir(dir);
  // ensureDir's own mode argument only applies to directories it
  // actually creates, so chmod separately to also correct a directory
  // that already exists from an earlier, stricter default.
  await fs.chmod(dir, 0o777);
  return dir;
}

// Shared tail of every background deploy, container or static: reports
// the outcome to hostnsoft-api so its dashboard deployment history is
// actually populated, and to this process's own deploy-status.js.
// Anonymous deploys are reported too (since 2026-10-08): the recorded
// image tag is what lets the claim link keep the app without a rebuild
// — see record-deployment.js. deploymentId (from the in_progress call
// in the request handler) updates that same row in place rather than
// creating a second one for this attempt. `kind`
// ("static" | "service") is what hostnsoft-api persists as
// Project.kind — reported only here, on success, because that is
// the first moment the app's kind on this host is actually settled
// (a failed static publish is undone, see performStaticDeploy).
async function finishDeploySuccess({ appName, appVersion, imageName, taskMemory, credential, deploymentId, kind, schedules }) {
  await recordDeployment({
    schedules,
    credential,
    projectSlug: appName,
    appVersion,
    status: 'success',
    imageTag: imageName,
    memoryMb: taskMemory,
    deploymentId,
    kind,
  });
  setDeployState(appName, {
    status: 'success',
    finishedAt: new Date().toISOString(),
    errorDetail: null,
    imageTag: imageName,
  });
  logger.info(`[${appName}] Deployment complete.`);
}

async function finishDeployFailure({ appName, appVersion, credential, deploymentId, buildDir, filePath, error }) {
  logger.error(`[${appName}] Deployment failed:`, error);

  // Keep whatever the failed command managed to write BEFORE the build
  // directory is removed below — on an exec rejection these two fields
  // carry railpack's own output, which is the only place the actual
  // failing command is ever named. Retrievable afterwards via
  // GET /apps/:appName/logs, which now falls back to it.
  setBuildLog(appName, error);

  // A stated cause for the exit codes that have one, appended to the
  // raw error rather than replacing it — nothing that was reported
  // before stops being reported.
  const failure = describeBuildFailure(error);
  const errorDetail = failure.hint ? `${error.message}\n\n${failure.hint}` : error.message;

  // Unlike before this became a background step, cleanup on failure
  // matters here too — a build that keeps failing (bad Dockerfile,
  // flaky dependency) would otherwise leave a build dir + upload behind
  // on every single retry, forever, with nothing to ever remove them.

  await fs.remove(buildDir).catch(() => { });
  await fs.remove(filePath).catch(() => { });

  await recordDeployment({
    credential,
    projectSlug: appName,
    appVersion,
    status: 'failed',
    errorDetail,
    deploymentId,
  });
  setDeployState(appName, {
    status: 'failed',
    finishedAt: new Date().toISOString(),
    errorDetail,
  });


}

// Runs the actually-slow part of a deploy (railpack build + `nomad job
// run`) — split out of the request handler below so it can continue
// AFTER the response is already sent (see the handler's own comment for
// why). Never throws outward: this has no request/response to answer to
// by the time it runs, so every failure is caught, recorded, and logged
// here instead.
async function performBuildAndDeploy({
  appName, appVersion, imageName, domain, buildDir, filePath,
  claim, taskMemory, schedulingFloorMb, credential, deploymentId,
  scaleToZeroOptIn, scaleToZeroOptOut, schedules,
}) {
  try {
    logger.info(`[${appName}] Building image with Railpack (version: ${appVersion})...`);
    // Railpack's CLI takes the directory as a positional arg and the
    // image tag via --name.
    //
    // The output is CAPTURED, not discarded: railpack names the actual
    // failing command in it, and that was previously thrown away — a
    // failed build produces no Nomad allocation, so GET .../logs had
    // nothing to serve either and the failure was undiagnosable. The
    // raised maxBuffer matters for the same reason (exec's 1MB default
    // truncates a cold-cache build). See build-diagnostics.js.
    const buildResult = await execPromise(
      `cd ${buildDir} && railpack build . --name ${imageName}`,
      { maxBuffer: BUILD_OUTPUT_MAX_BUFFER },
    );
    setBuildLog(appName, buildResult);

    // Exit code 0 above is not proof an image exists — see
    // assertImageExists. Checked BEFORE anything downstream is touched
    // (data dir, purgeIfNotRunning, Nomad), so a build that produced
    // nothing leaves the currently running version of the app alone.
    await assertImageExists(appName, imageName);

    // Before the job spec is applied, not after — Nomad's bind mount
    // needs this to exist and be writable at container start.
    const appDataDir = await ensureAppDataDir(appName);
    logger.info(`[${appName}] Data directory ready at ${appDataDir}`);

    logger.info(`[${appName}] Generating Nomad file...`);
    const nomadJobSpec = buildNomadJobSpec({
      appName,
      domain,
      imageName,
      appVersion,
      taskMemory,
      schedulingFloorMb,
      customDomains: claim.customDomains || [],
      envVars: claim.envVars || [],
      isOrphan: claim.isOrphan,
      orphanExpiresAt: claim.orphanExpiresAt,
      orphanLoginUrl: claim.orphanLoginUrl,
      isFreePlan: claim.isFreePlan,
    });
    const nomadFilePath = path.join(buildDir, `${appName}.nomad`);
    await fs.writeFile(nomadFilePath, nomadJobSpec);

    logger.info(`[${appName}] Deploying to Nomad...`);
    // See purgeIfNotRunning: without this, redeploying the same app
    // version over a dead job is a silent no-op reported as a failure.
    await purgeIfNotRunning(appName);
    await runNomadJob(appName, nomadFilePath);
    await saveJobSpec(appName);

    // AFTER saveJobSpec, which is what the router generation reads
    // hostnames from — including any custom domain, which is the case a
    // name alone cannot tell you about.
    //
    // Best-effort, like saveJobSpec: scale-to-zero is opt-in, and failing
    // a working deployment because an optional registration did not stick
    // would be the worse trade. The app simply stays always-on, which is
    // the behaviour its owner had before asking.
    if (scaleToZeroOptIn || scaleToZeroOptOut) {
      try {
        const result = scaleToZeroOptIn
          ? await scaleToZero.optIn(appName)
          : await scaleToZero.setOptedOut(appName);
        logger.info(
          `[${appName}] scale-to-zero ${scaleToZeroOptIn ? 'opt-IN' : 'opt-OUT'} recorded ` +
          `(${result.routers} router(s) across ${result.apps} app(s))`
        );
      } catch (e) {
        // An opt-IN failure leaves the app always-on, which is safe. An
        // opt-OUT failure is NOT: in universal mode the app stays
        // eligible, so its owner's "leave mine alone" did not take. Said
        // plainly rather than folded into a generic warning.
        logger.warn(
          `[${appName}] Could not record scale-to-zero ${scaleToZeroOptIn ? 'opt-in' : 'OPT-OUT'}: ${e.message}` +
          (scaleToZeroOptOut ? ' — THIS APP MAY STILL BE PUT TO SLEEP' : ' (app stays always-on)')
        );
      }
    }

    // Best-effort, after the deploy that matters has already succeeded —
    // never lets a retention hiccup affect the response/state below.
    await pruneOldImages(appName).catch((e) => {
      logger.warn(`[${appName}] Image retention pass failed (continuing): ${e.message}`);
    });

    // Not awaited: the deploy never waits on, or fails over, the registry.
    pushToRegistry(appName, imageName);

    await fs.remove(buildDir);
    await fs.remove(filePath);

    await finishDeploySuccess({ appName, appVersion, imageName, taskMemory, credential, deploymentId, kind: 'service', schedules });
  } catch (error) {
    await finishDeployFailure({ appName, appVersion, credential, deploymentId, buildDir, filePath, error });
  }
}

// The static fast path — see docs/Static-apps-req.md. Everything a
// container deploy does after the upload is skipped: no railpack build,
// no image, no data directory, no Nomad job. The files are copied under
// STATIC_SITES_ROOT (static-site.js) and a Traefik router file points the
// app's hostnames at the shared static server (traefik-router-file.js).
// Still runs in the background after the 202, purely so the response
// contract (accepted -> poll statusUrl) is the same for both kinds of
// app; in practice it is finished within a second.
// `onOutcome` is told 'live' or 'failed' the moment that is known, so
// POST /apps can wait (briefly) for a static publish and answer with the
// real result instead of "check back". Anything slow that follows — retiring
// a converted server app's job, pruning old versions — runs after that and
// can't change the outcome, which is why it happens outside the try below.
async function performStaticDeploy({
  appName, appVersion, imageName, domain, buildDir, filePath,
  claim, credential, deploymentId, plan, existingKind, onOutcome = () => { }, schedules,
}) {
  const convertingFromService = existingKind === 'service';
  try {
    // plan.ok is false when railpack could not inspect the upload and the
    // app kept its existing static kind (see the deploy handler); there is
    // then no detected root or provider, so the upload root is the site.
    const rootDir = (plan.ok && plan.rootDir) || '.';
    const provider = (plan.ok && plan.providers) || 'staticfile';
    logger.info(`[${appName}] Static site (railpack provider: ${provider}, root: ${rootDir}) — publishing files directly, no image build and no Nomad job.`);
    await publishStaticVersion({
      appName,
      version: appVersion,
      sourceDir: path.join(buildDir, rootDir),
      provider,
    });
    // publishStaticVersion above wrote the manifest, which is what
    // app-kind.js reads: from this point the host calls the app static.
    // The version is not reachable until the router file exists, though,
    // so if that write fails an app that was NOT static before must not
    // stay marked static — otherwise the old Nomad job (or nothing at
    // all) keeps answering the hostnames while every later server-app
    // upload is refused with app_kind_changed. Undo the publish so the
    // host is back to exactly what it was before this deploy. An app
    // that was already static keeps its previous router file (the write
    // is an atomic rename), so its files stay served and there is
    // nothing to roll back.
    try {
      await writeStaticRouterFile({
        appName,
        domain,
        customDomains: claim.customDomains || [],
        isOrphan: claim.isOrphan,
        orphanExpiresAt: claim.orphanExpiresAt,
        orphanLoginUrl: claim.orphanLoginUrl,
        isFreePlan: claim.isFreePlan,
      });
    } catch (routerError) {
      if (existingKind !== 'static') {
        logger.warn(`[${appName}] Router file write failed; undoing the static publish so the app stays a ${existingKind === 'service' ? 'server app' : 'new name'}: ${routerError.message}`);
        await removeStaticRouterFile(appName).catch(() => { });
        await removeStaticApp(appName).catch((e) => {
          logger.error(`[${appName}] Could not undo the static publish after the router failure — the app may now be wrongly marked static: ${e.message}`);
        });
      }
      throw routerError;
    }
    logger.info(`[${appName}] Static version ${appVersion} is live.`);

    // Live from here: the files are published and routed. Record it now,
    // before the best-effort cleanup below, so the status reply and
    // deployment history say "live" as soon as it's true.
    // No memoryMb: a static app runs no process, so there is nothing
    // hostnsoft-api's Project.memoryMb could describe for it.
    await finishDeploySuccess({ appName, appVersion, imageName, taskMemory: undefined, credential, deploymentId, kind: 'static', schedules });
    onOutcome('live');
  } catch (error) {
    await finishDeployFailure({ appName, appVersion, credential, deploymentId, buildDir, filePath, error });
    onOutcome('failed');
    return;
  }

  // Cleanup after the site is already live. Every step is best-effort and
  // logged; none of them can turn a live deploy into a failed one.
  try {
    // Server app -> static site (see app-kind.js for why this direction
    // is allowed). The router file above already sends the hostnames to
    // the static server, so purging the job — and with it the
    // Nomad-provider router that was matching the same Host — only
    // removes a container nothing routes to any more. Its images go too:
    // a rollback to one of them is not something the static config push
    // can do, so keeping them would only take up disk. The app's DATA_DIR
    // is deliberately left alone — only the delete endpoint removes data.
    // This is also how every static app that predates the fast path (a
    // job running Railpack's Caddy over the same files) moves off its
    // container on its next deploy.
    if (convertingFromService) {
      logger.info(`[${appName}] Retiring the server job now that the files are served directly.`);
      await stopNomadJob(appName, { purge: true }).catch((e) => {
        logger.warn(`[${appName}] Could not purge the old Nomad job (continuing): ${e.message}`);
      });
      await execPromise(`docker images --filter=reference=${appName}:* -q | xargs -r docker rmi -f`).catch((e) => {
        logger.warn(`[${appName}] Could not remove the old images (continuing): ${e.message}`);
      });
      // Retire the scale-to-zero enrolment along with the job, or its wake
      // router outlives the thing it wakes. The job above was purged, and a
      // purged job CANNOT be woken — so a surviving router sends real
      // traffic to the activator to wait on something that can never start.
      //
      // That router sits at priority 1 and loses to the static router's
      // rule-length ~44, so the static site stays reachable either way —
      // but the activator would still list the purged app as wakeable.
      await scaleToZero.forget(appName).catch((e) => {
        logger.warn(`[${appName}] Could not clear the scale-to-zero entry (continuing): ${e.message}`);
      });
      // The saved spec names an image just removed above. Left behind, it
      // lists a static app as a server app to everything that reads
      // .specs (scale-to-zero's router generation, the registry backfill).
      await fs.remove(specPathFor(appName)).catch((e) => {
        logger.warn(`[${appName}] Could not remove the old job spec (continuing): ${e.message}`);
      });
    }

    // Best-effort, same as pruneOldImages on the container path.
    await pruneOldStaticVersions(appName).catch((e) => {
      logger.warn(`[${appName}] Static version retention pass failed (continuing): ${e.message}`);
    });

    await fs.remove(buildDir);
    await fs.remove(filePath);
  } catch (error) {
    logger.warn(`[${appName}] Cleanup after the static publish failed (the site is live): ${error.message}`);
  }
}

// The agent guide lives on the website, one topic per page, and is the only
// copy: https://embarko.ai/docs (Markdown for agents, HTML for people, .json
// on request). /capabilities used to be a second copy served from here, and
// two copies drift. Its URLs are in older replies, skills and prompts, so
// they redirect to the matching guide topic. The Accept header carries over,
// so an agent that asked for JSON still gets JSON there.
//
// Express puts the address in the body too, so a client that doesn't follow
// redirects (curl without -L) still learns where to go.
const GUIDE = 'https://embarko.ai/docs';
// Topics that were renamed in the guide. Anything else keeps its name; the
// guide resolves aliases itself and answers an unknown name with its contents.
const GUIDE_TOPIC = { files: 'data', 'not-supported': 'prerequisites', 'scale-to-zero': 'status', all: '' };

function toGuide(res, topic, ext = '') {
  const name = topic == null ? '' : (Object.hasOwn(GUIDE_TOPIC, topic) ? GUIDE_TOPIC[topic] : topic);
  const url = name ? `${GUIDE}/${encodeURIComponent(name)}${ext}` : (ext ? `${GUIDE}/index${ext}` : GUIDE);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.redirect(301, url);
}

// Which code is serving and since when — see build-info.js. The deploy
// workflow polls this after a redeploy and fails unless `commit` is the
// one it just pushed.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', commit: BUILD_INFO.commit, startedAt: BUILD_INFO.startedAt });
});

app.get('/capabilities', (req, res) => toGuide(res, req.query.feature ? String(req.query.feature).toLowerCase() : null));
app.get('/capabilities/:topic', (req, res) => {
  const [, topic, ext = ''] = /^(.*?)(\.md|\.json)?$/i.exec(req.params.topic.toLowerCase());
  toGuide(res, topic, ext);
});

// The deploy reply's warnings — see the call site in POST /apps.
function deployWarnings({ config, timers, claim, isStaticDeploy, schedules }) {
  const out = [...config.warnings];
  const timer = timersWarning(timers);
  if (timer) out.push(timer);
  // No embarko.json schedules this time, but the app has some: say they
  // were kept, so a deleted file isn't mistaken for "removed".
  if (schedules === undefined && claim.scheduleCount > 0 && !isStaticDeploy) {
    out.push({
      code: 'schedules_unchanged',
      detail:
        `This app has ${claim.scheduleCount} schedule(s), and this upload has no "schedules" in embarko.json, so they were kept as they are. ` +
        'To remove them, deploy with {"schedules": []} in embarko.json.',
    });
  }
  if (isStaticDeploy && Array.isArray(schedules) && schedules.length > 0) {
    out.push({
      code: 'schedules_on_static_site',
      detail: 'This is a static site, so nothing runs on a server and its schedules were not applied. Deploy the app as a server app to use schedules.',
    });
  }
  return out;
}

// How long a paused deploy is told to wait (Retry-After).
const BUILDS_PAUSED_RETRY_SEC = 600;

app.post('/apps', upload.single('source'), jsonSource, async (req, res) => {
  // `let`: replaced by the app's current name once the claim has resolved
  // it (see below) — everything after the claim builds and routes under that.
  let appName = req.headers['x-app-name'];

  // Optional: the app's stable id from an earlier deploy reply (app.id),
  // which the deployer keeps in embarko.json. It finds the app even after
  // its name was changed in the dashboard — see hostnsoft-api's
  // services/projectClaim.ts resolveDeployTarget.
  const rawAppId = req.headers['x-app-id'];
  const appId = typeof rawAppId === 'string' ? rawAppId.trim() : '';

  // Multer has already written the upload to disk by the time this runs,
  // so every rejection below must remove it — nothing else ever will.
  // Once the 202 is sent, the background deploy owns the file instead.
  const discardUpload = () => (req.file ? fs.remove(req.file.path).catch(() => { }) : Promise.resolve());
  // Same for a THROW before the 202 (e.g. hostnsoft-api answering 2xx with
  // a non-JSON proxy error page, so response.json() blows up): drop the
  // upload, then let it fail as before.
  const orDiscard = (p) => p.catch(async (e) => { await discardUpload(); throw e; });

  // Every rejection below: the upload is dropped and the reply carries a
  // next step plus the feedback link (deploy-response.js). `appExists`
  // once the claim has succeeded, so feedback can point at this app.
  const host = req.get('host');
  const reject = async (status, code, error, extra = {}, appExists = false) => {
    await discardUpload();
    return res.status(status).json(errorBody({ host, appName, error, code, extra, appExists }));
  };

  // NEW: read version from header, fall back to a timestamp-based tag if not provided.
  // Never fall back to "latest" — Nomad's Docker driver always re-pulls :latest tags
  // and ignores the locally built image, even with force_pull = false.
  // Step 7 opt-in. Absent — the default for every existing and future
  // deploy — behaves exactly as before. Only an explicit "true" counts:
  // anything else is treated as not opting in rather than guessed at,
  // since the failure mode of a wrong guess is an app that sleeps when
  // its owner never asked it to.
  const scaleToZeroHeader = String(req.headers['x-scale-to-zero'] || '').toLowerCase();
  const scaleToZeroOptIn = scaleToZeroHeader === 'true';
  // An explicit "false" is a real instruction, not just the absence of
  // one. In universal mode an app is eligible by default, so "leave mine
  // alone" has to be RECORDED — otherwise the next pass re-enrols it.
  const scaleToZeroOptOut = scaleToZeroHeader === 'false';

  // Optional: what the app is for ("portfolio", "task management",
  // "feedback system"...), in the deployer's own words — stored on the
  // project by hostnsoft-api (Project.appType). Free text, but kept short
  // and printable so it stays a label rather than a payload.
  const rawAppType = req.headers['x-app-type'];
  const appType = typeof rawAppType === 'string' ? rawAppType.trim() : '';

  // Optional: which agent is deploying, in its own words ("claude-code",
  // "chatgpt", "cursor"...). Recorded on the deployment by hostnsoft-api
  // (Deployment.agentName) — self-reported attribution, never used for
  // access. Same shape rules as X-App-Type.
  const rawAgentName = req.headers['x-agent-name'];
  const agentName = typeof rawAgentName === 'string' ? rawAgentName.trim() : '';

  const rawVersion = req.headers['x-app-version'];
  const appVersion = (rawVersion && /^[a-zA-Z0-9._-]+$/.test(rawVersion))
    ? rawVersion
    : `${Date.now()}`;

  // The platform monitor pauses new builds while the server is short of
  // memory (Server-setup server-setup.md#platform-monitor), by creating
  // this file. Refused before anything is claimed or built.
  if (process.env.BUILDS_PAUSED_FILE && fs.existsSync(process.env.BUILDS_PAUSED_FILE)) {
    res.set('Retry-After', String(BUILDS_PAUSED_RETRY_SEC));
    return reject(503, 'builds_paused', 'Embarko is short of memory right now, so new deploys are paused for a few minutes. Nothing was changed.', { retryAfterSeconds: BUILDS_PAUSED_RETRY_SEC });
  }

  // 1. Validation
  // Which credential this deploy carries, if any — a deploy token, a
  // dashboard proxy_auth_token + X-Company-Id, or nothing at all. See
  // deploy-credential.js for the full reasoning, including why a deploy
  // token still wins when both are somehow presented and why anonymous
  // stays opt-in BY OMISSION ONLY: a MISSING credential opts into an
  // anonymous ("orphan") deploy (docs/Anonymous-deploy-req.md), but one
  // that's present and invalid is a hard error, never a silent fallback,
  // so a typo'd/expired credential surfaces as an auth failure instead of
  // masquerading as a feature.
  //
  // A deploy token is still company-scoped at creation (hostnsoft-api
  // mints one per company), so it needs no X-Company-Id and ignores one
  // if sent — a stale header can never re-point a token-authenticated
  // deploy at a different company. Only a proxy_auth_token needs the
  // header, because a PAT isn't scoped to one company.
  const credentialResult = await orDiscard(readDeployCredential(req));
  if (!credentialResult.ok) {
    return reject(credentialResult.status, credentialResult.code, credentialResult.error);
  }
  const credential = credentialResult.credential;

  if (!appName || !/^[a-z0-9-]+$/.test(appName)) {
    return reject(400, 'invalid_app_name', "Invalid or missing X-App-Name header. Use lowercase letters, digits and dashes.");
  }

  // NEW: the app name is also the live subdomain and the Nomad job name —
  // confirm it's either already the deploying company's or free to claim
  // BEFORE spending any build time on it. No project needs to exist via
  // the dashboard first; this auto-creates one on first sight. A null
  // credential routes this to hostnsoft-api's anonymous/orphan path.
  //
  // For a proxy_auth_token this call is ALSO where that credential is
  // actually verified (validity + membership in X-Company-Id) — it still
  // runs before any build resource is spent, so a rejected PAT costs
  // nothing, and keeping it to one call means the two services can't
  // reach different conclusions about the same deploy.
  if (appType && (appType.length > 60 || !/^[\x20-\x7E]+$/.test(appType))) {
    return reject(400, 'invalid_app_type', "Invalid X-App-Type header. Use a short plain-text label of at most 60 characters, e.g. \"portfolio\" or \"task management\".");
  }

  if (agentName && (agentName.length > 60 || !/^[\x20-\x7E]+$/.test(agentName))) {
    return reject(400, 'invalid_agent_name', "Invalid X-Agent-Name header. Use a short plain-text name of at most 60 characters, e.g. \"claude-code\" or \"chatgpt\".");
  }

  if (appId && (appId.length > 64 || !/^[a-z0-9]+$/.test(appId))) {
    return reject(400, 'invalid_app_id', "Invalid X-App-Id header. Send the app.id from an earlier deploy reply exactly as given, or leave it out.");
  }

  // The app's optional embarko.json, read from the archive before the
  // claim so a file that can't be trusted refuses the deploy before any
  // work, and the claim can check its schedules and create CRON_SECRET in
  // the same call. See embarko-config.js and docs/embarko-json.md.
  // `schedules` undefined = no file or no key = leave schedules as they are.
  const config = req.file
    ? await orDiscard(readEmbarkoConfig(req.file.path))
    : { ok: true, present: false, schedules: undefined, warnings: [] };
  if (!config.ok) {
    return reject(400, config.code, config.error, { file: 'embarko.json', help: 'https://embarko.ai/docs/embarko-json' });
  }
  const schedules = config.schedules;

  // The header wins over embarko.json's appId: it is what this deployer
  // means right now. The file covers token deployers (agents, CI) that
  // don't send one. Not a dashboard upload: there the person picked the
  // app, and a stale file in their zip must not send it somewhere else.
  const isDashboardUpload = !!(credential && credential.proxyAuthToken);
  const targetAppId = appId || (isDashboardUpload ? undefined : config.appId) || undefined;
  const claim = await orDiscard(claimProject(credential, appName, appType || undefined, schedules, targetAppId));
  if (!claim.ok) {
    return reject(claim.status, claim.code, claim.error);
  }
  // The app may have been renamed since the deployer last looked: build,
  // route and report under its current name. claim.notices says so.
  if (claim.slug && claim.slug !== appName) {
    logger.info(`[${appName}] Resolved to the app's current name "${claim.slug}"`);
    appName = claim.slug;
  }

  // In flight from the claim on, for orphan cleanup's teardown (see
  // deploy-in-flight.js). This registration covers the request itself and
  // ends with its response, whichever way that goes; a build that carries
  // on in the background takes its own registration below, before the
  // response goes out, so there's no gap between the two.
  const endRequestInFlight = beginDeploy(appName);
  res.once('finish', endRequestInFlight);
  res.once('close', endRequestInFlight);

  if (rawVersion && !/^[a-zA-Z0-9._-]+$/.test(rawVersion)) {
    return reject(400, 'invalid_app_version', "Invalid X-App-Version header. Use letters, numbers, dots, dashes, underscores only.", {}, true);
  }

  if (!req.file) {
    return reject(400, 'missing_source_file', "No source code uploaded", {}, true);
  }

  const buildDir = `/tmp/platform-builds/${appName}-${Date.now()}`;
  // Set once a publish or build starts: from then on it owns buildDir and
  // the upload, and the error handler below must not delete them.
  let backgroundOwnsFiles = false;
  const imageName = `${appName}:${appVersion}`; // CHANGED: versioned tag instead of :latest
  // Real domain via Cloudflare DNS, routed through Traefik with Let's Encrypt TLS.
  // Domain suffix comes from APPS_DOMAIN_SUFFIX (see nomad-job-spec.js's
  // defaultDomainFor) — not hardcoded, so it tracks whatever
  // server-setup.sh configured.
  const domain = defaultDomainFor(appName);
  // The status/log check-back URLs below always answer as this same
  // service, so they're built off the incoming request's own host rather
  // than a separate env var — same https-hardcoding the response already
  // relied on (this platform is always served through Traefik's TLS
  // termination in practice).

  try {
    // 2. Extract the uploaded tar.gz file
    logger.info(`[${appName}] Extracting code...`);
    await fs.ensureDir(buildDir);
    await tar.x({
      file: req.file.path,
      cwd: buildDir
    });

    // NEW 2a-pre. Confirm there's actually something buildable at
    // buildDir's own root before spending any build time — see
    // detect-manifest-root.js. Auto-flattens the common single-wrapping-
    // folder case (matching what the dashboard's own upload flow already
    // does client-side in pack.ts's stripCommonRoot, so both paths behave
    // identically) and only hard-fails when flattening wouldn't help.
    const rootCheck = await resolveBuildRoot(buildDir);
    if (rootCheck.flattened) {
      logger.info(`[${appName}] Auto-flattened a wrapping folder ('${rootCheck.flattened}') to reach the app root`);
    }
    if (!rootCheck.ok) {
      logger.info(`[${appName}] Rejected: no buildable manifest at the archive root${rootCheck.hint ? ` (found one nested at ${rootCheck.hint})` : ''}`);
      await fs.remove(buildDir);
      await fs.remove(req.file.path);
      return res.status(422).json(errorBody({
        host, appName, appExists: true,
        error: "No buildable app found at the archive root",
        code: "no_manifest_at_root",
        extra: {
          detail:
            "No package.json, requirements.txt, pyproject.toml, go.mod, Gemfile, composer.json, " +
            "Cargo.toml, or index.html was found at the top level of the uploaded archive" +
            (rootCheck.hint ? `, but one was found nested at '${rootCheck.hint}'` : "") +
            ". Railpack only looks at the archive root — re-package so the app's manifest (or " +
            "index.html for a static site) sits at the top level, not inside an extra wrapping " +
            "folder, then redeploy.",
          foundNestedAt: rootCheck.hint || null,
        },
      }));
    }

    // NEW 2a-pre2. The root looks buildable, but only because a wrapper
    // package.json sits on top of the real app — see
    // detect-manifest-root.js's detectDelegatingRoot. railpack installs at
    // the archive root only, so the delegated build dies on a missing
    // binary (exit 127) minutes from now. Reject it in seconds, naming the
    // subdirectory to deploy instead.
    const delegating = await detectDelegatingRoot(buildDir);
    if (delegating) {
      logger.info(`[${appName}] Rejected: root package.json delegates its build to '${delegating.subdir}/'`);
      await fs.remove(buildDir);
      await fs.remove(req.file.path);
      return res.status(422).json(errorBody({
        host, appName, appExists: true,
        error: "The app to deploy is in a subdirectory, not at the archive root",
        code: "app_nested_in_subdirectory",
        extra: {
          detail:
            `The package.json at the archive root declares no dependencies of its own and hands its ` +
            `build to '${delegating.subdir}/'` +
            (delegating.script ? ` (${delegating.script})` : '') +
            `. Only the archive root is installed, so '${delegating.subdir}/node_modules' would never ` +
            `be created and the build would fail on a missing command (exit code 127). Deploy the ` +
            `'${delegating.subdir}' directory directly — upload that folder, or point the deploy ` +
            `script at it — instead of the folder above it.`,
          deployThisInstead: delegating.subdir,
        },
      }));
    }

    // NEW 2a. Read package.json once, up front — shared by the embedded-DB
    // memory check below AND to decide whether the window.storage scan is
    // even worth running (skipped entirely if a real DB dependency already
    // exists, since that's the exact case that doesn't need this check).
    let deps = {};
    try {
      const pkgPath = path.join(buildDir, 'package.json');
      if (await fs.pathExists(pkgPath)) {
        const pkg = await fs.readJson(pkgPath);
        deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      }
    } catch (e) {
      logger.warn(`[${appName}] Could not read package.json, defaulting to standard memory and running storage scan: ${e.message}`);
    }

    const hasRealDb = hasRealDatabaseDependency(deps);

    // NEW 2b. Reject apps that rely on window.storage BEFORE spending any
    // build time/resources on them — but only bother checking if the app
    // doesn't already have real persistence, since that's the one case
    // this check exists for. This is a hard stop, not a warning — the app
    // would break at runtime on Embarko otherwise, and a compatibility
    // shim was considered and rejected (it would require exposing an
    // unauthenticated public endpoint to every app's visitor traffic —
    // see project notes for that discussion).
    if (!hasRealDb) {
      const storageUsage = await detectWindowStorageUsage(buildDir);
      if (storageUsage.detected) {
        logger.info(`[${appName}] Rejected: window.storage usage detected in: ${storageUsage.files.join(', ')}`);
        await fs.remove(buildDir);
        await fs.remove(req.file.path);
        return res.status(422).json(errorBody({
          host, appName, appExists: true,
          error: "Unsupported storage pattern detected",
          code: "unsupported_storage_pattern",
          extra: {
            detail:
              "This app calls window.storage, an API specific to Claude Artifacts' sandbox. " +
              "It does not exist outside that environment and will fail at runtime if deployed " +
              "here as-is. Please update the app to persist data with a real database before " +
              "redeploying: use SQLite (better-sqlite3), writing under DATA_DIR.",
            filesDetected: storageUsage.files,
          },
        }));
      }
    }

    // NEW 2b'. Which KIND of app this is — a plain static site, or one that
    // needs a build and a server. Railpack decides (build-plan.js), and
    // this host's own record of what is already deployed under this name
    // says what it was before (app-kind.js). A server app may become a
    // static site (performStaticDeploy retires its job once the files are
    // live); a static site may NOT become a server app — see
    // docs/Static-apps-req.md for why only that direction is refused.
    // Checked BEFORE the 202, so a refusal is a real response, not a
    // background failure to poll for.
    const plan = await inspectBuildPlan(buildDir);
    const existingKind = await resolveAppKind(appName);
    if (plan.invalidStaticRoot !== undefined) {
      // build-plan.js: the Staticfile names a root outside the upload.
      // Not a transient railpack failure, so it does NOT fall through to
      // "keep the existing kind" — that path publishes from the upload
      // root and would hide the misconfiguration.
      logger.info(`[${appName}] Rejected: ${plan.error}`);
      await fs.remove(buildDir);
      await fs.remove(req.file.path);
      return res.status(422).json(errorBody({
        host, appName, appExists: true,
        error: "Invalid static root",
        code: "invalid_static_root",
        extra: {
          detail:
            `The Staticfile sets root: ${plan.invalidStaticRoot}, which points outside the uploaded files. ` +
            `The root must be a directory inside the upload (for example "root: dist" or "root: public").`,
        },
      }));
    }
    if (!plan.ok) {
      logger.info(`[${appName}] railpack could not inspect this upload (${plan.error}) — keeping the app's existing kind (${existingKind === 'none' ? 'new app, so server' : existingKind})`);
    } else if (plan.isSpa) {
      logger.info(`[${appName}] Single-page app build detected (${plan.providers}) — built and served in a container for now`);
    }
    // Only a SUCCESSFUL inspection says anything about the upload's kind.
    // When railpack cannot inspect it at all, the upload is not evidence
    // of a change, so the app keeps whatever kind it already is: a static
    // site publishes its files from the upload root, a server app (or a
    // brand new name) goes to the build, which reports the real problem.
    // Refusing here instead used to send a static app's owner off to a
    // second app name over a transient railpack failure.
    const isStaticDeploy = plan.ok ? plan.isPlainStatic : existingKind === 'static';

    // In-process timers (node-cron, APScheduler...) stop when an idle app is
    // put to sleep. Warn, never refuse: the reply tells the agent to move the
    // jobs to schedules — see detect-timers.js. Skipped when embarko.json
    // already declares schedules, and for a static site, which runs no code.
    const timers = !isStaticDeploy && schedules === undefined ? await detectTimers(buildDir, deps) : null;
    if (timers) logger.info(`[${appName}] In-process timer library detected: ${timers.libraries.join(', ')}`);
    if (plan.ok && !isStaticDeploy && existingKind === 'static') {
      const now = `a server app (railpack detected: ${plan.providers || 'unknown'})`;
      logger.info(`[${appName}] Rejected: app is a static site, this upload is ${now}`);
      await fs.remove(buildDir);
      await fs.remove(req.file.path);
      return res.status(422).json(errorBody({
        host, appName, appExists: true,
        error: "App kind changed",
        code: "app_kind_changed",
        extra: {
          detail:
            `"${appName}" is deployed as a static site, but this upload is ${now}. A static site is ` +
            `served directly from its files with no server process; a server app runs as its own job ` +
            `with routing, a data directory and settings this app never had, so a static app cannot ` +
            `be turned into one. To ship this version, deploy it under a NEW app name (X-App-Name). ` +
            `If the change is a mistake, restore the static files (e.g. an index.html at the upload ` +
            `root) and redeploy under this name.`,
          previousKind: 'static',
          uploadedKind: 'service',
        },
      }));
    }
    const convertingFromService = isStaticDeploy && existingKind === 'service';
    if (convertingFromService) {
      logger.info(`[${appName}] Currently a server app (Nomad job) — this static upload will replace it and retire the job`);
    }

    // 2c. Memory sizing. There is no auto-detected tier any more: PGlite
    // is no longer supported, and SQLite — the only remaining embedded
    // option — is an in-process library that needs no extra headroom, so
    // every app starts from the same 256MB ceiling.
    //
    // The project's configured memoryMb (hostnsoft-api's PATCH
    // .../memory) can RAISE that ceiling but never lower it below the
    // platform default: hostnsoft-api's schema defaults every project to
    // 256MB whether or not memory was ever explicitly configured, so
    // treating a configured value as authoritative outright would let an
    // untouched default silently undercut the baseline. Math.max lets an
    // explicit higher value win while the default always still applies.
    //
    // schedulingFloorMb is deliberately NOT derived from the configured
    // value — raising a project's memory is a request for more headroom,
    // not a promise to use it, so it lifts the ceiling without making the
    // app harder to place.
    const taskMemory = Math.max(MEMORY_CEILING_MB, claim.memoryMb || MEMORY_CEILING_MB);
    const schedulingFloorMb = SCHEDULING_FLOOR_MB;
    logger.info(`[${appName}] Memory: configured ${claim.memoryMb ?? 'none'}MB -> scheduling floor ${schedulingFloorMb}MB, burst ceiling ${taskMemory}MB`);

    // NEW: from here on, the actual build (railpack, which can easily
    // take minutes for a fresh install) and the Nomad deploy run in the
    // BACKGROUND, after the response below is already sent. A slow
    // build was hitting Cloudflare's own proxy timeout (524) well before
    // the deploy had a chance to finish — the client only needs to know
    // the upload was accepted, not wait out the whole build inline.
    // Progress is tracked via deploy-status.js (see GET
    // /apps/:appName/status, whose URL is included in the response
    // below) and mirrored into hostnsoft-api's own deployment history —
    // for anonymous deploys too, since that record is what the claim
    // link's no-rebuild re-push runs from (see record-deployment.js).
    const deploymentId = await recordDeployment({
      credential,
      projectSlug: appName,
      appVersion,
      status: 'in_progress',
      agentName: agentName || undefined,
    });
    setDeployState(appName, {
      status: 'in_progress',
      appVersion,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      errorDetail: null,
      deploymentId,
    });

    const replyFacts = {
      host,
      appName,
      appId: claim.projectId,
      action: claim.action,
      notices: claim.notices,
      url: `https://${domain}`,
      claimed: !claim.isOrphan,
      claimedNow: !!claim.claimedNow,
      expiresAt: claim.orphanExpiresAt,
      // Only on the deploy that created a temporary app — see
      // claim-project.js. This reply is the one place the link appears.
      claimUrl: claim.claimUrl,
      // hostnsoft-api's id for this attempt (null if recording failed),
      // for support and the dashboard's history; not needed to proceed.
      deploymentId,
      convertingFromService,
      // What hostnsoft-api said about embarko.json's schedules, if any.
      schedules: claim.schedules,
      // Everything worth fixing that didn't stop the deploy, as
      // {code, detail}: embarko.json problems, in-process timers, schedules
      // left as they were, schedules on a static site. deploy-response.js.
      warnings: deployWarnings({ config, timers, claim, isStaticDeploy, schedules }),
    };

    // A static site publishes in about a second, so wait for it (up to
    // STATIC_WAIT_MS) and answer with the real outcome: live, with the
    // claim or showcase step next, or failed. A site that takes longer gets
    // the same "check links.status" reply as before and finishes in the
    // background. Nothing here can outlast the proxy timeouts.
    if (isStaticDeploy) {
      backgroundOwnsFiles = true;
      let settle;
      const outcome = new Promise((resolve) => { settle = resolve; });
      const endStaticInFlight = beginDeploy(appName);
      performStaticDeploy({
        appName, appVersion, imageName, domain,
        buildDir, filePath: req.file.path,
        claim, credential, deploymentId, plan, existingKind,
        onOutcome: settle, schedules,
      }).catch((err) => {
        logger.error(`[${appName}] unexpected error in static deploy: ${err.message}`);
        settle('failed');
      }).finally(endStaticInFlight);

      let timer;
      const result = await Promise.race([
        outcome,
        new Promise((resolve) => { timer = setTimeout(() => resolve('pending'), STATIC_WAIT_MS); }),
      ]);
      clearTimeout(timer);

      if (result === 'pending') {
        return res.status(202).json(acceptedBody({ ...replyFacts, kind: 'static' }));
      }
      const live = result === 'live';
      return res.status(live ? 200 : 500).json(publishedBody({
        ...replyFacts, deployState: getDeployState(appName), live,
      }));
    }

    backgroundOwnsFiles = true;
    const endBuildInFlight = beginDeploy(appName);
    // A server app's build takes minutes: answer at once and let the agent
    // poll. The claim and showcase steps come later, in the status reply,
    // once the app is actually live — see deploy-response.js.
    res.status(202).json(acceptedBody({ ...replyFacts, kind: 'service' }));

    // Deliberately not awaited — everything from here happens after the
    // response above. performBuildAndDeploy has its own try/catch that
    // records success/failure; .catch() here is only a backstop.
    performBuildAndDeploy({
      appName, appVersion, imageName, domain,
      buildDir, filePath: req.file.path,
      claim, taskMemory, schedulingFloorMb, credential, deploymentId,
      scaleToZeroOptIn, scaleToZeroOptOut, schedules,
    }).catch((err) => {
      logger.error(`[${appName}] unexpected error in background deploy: ${err.message}`);
    }).finally(endBuildInFlight);

  } catch (error) {
    // Only the SYNCHRONOUS section above (extraction, package.json read,
    // storage scan, memory calc) can land here — the build/deploy itself
    // has its own error handling inside performBuildAndDeploy.
    logger.error(`[${appName}] Deploy request failed before accepting:`, error);

    // Once a publish or build has started it owns buildDir and the upload
    // (and removes them itself); deleting them here would pull the files
    // out from under it. If no reply went out yet, still answer.
    if (backgroundOwnsFiles) {
      if (!res.headersSent) {
        res.status(500).json(errorBody({
          host, appName, appExists: true,
          error: "Deployment failed", code: "deploy_failed", extra: { details: error.message },
        }));
      }
      return;
    }
    if (res.headersSent) return;

    await fs.remove(buildDir).catch(() => { });
    await discardUpload();

    await recordDeployment({
      credential,
      projectSlug: appName,
      appVersion,
      status: 'failed',
      errorDetail: error.message,
      agentName: agentName || undefined,
    });

    res.status(500).json(errorBody({
      host, appName, appExists: true,
      error: "Deployment failed", code: "deploy_failed", extra: { details: error.message },
    }));
  }
});

// Shared by GET /apps/:appName/status, .../logs, and .../customer-query
// below. Same auth shape as POST /apps itself (Authorization: Bearer
// <deploy token>, optional — its absence means "only allowed if this app
// is still an unclaimed orphan"), but deliberately does NOT reuse
// claim-project.js: that endpoint's job is to CLAIM (auto-creating a
// project on first sight, or adopting an orphan into the caller's
// company as a side effect) — exactly the wrong tool for a read-only
// status/log check, which must never mutate anything just from being
// looked at. Uses project-lookup.js's read-only counterpart instead.
//
// ALSO accepts a proxy_auth_token header (2026-09-13) — the dashboard's
// own login credential (see hostnsoft-api's docs/CLAUDE.md "Auth flow"
// #1) — as an alternative to a deploy token for a CLAIMED app, so someone
// already logged into the dashboard can hit these same endpoints
// directly rather than needing to separately mint a deploy token just to
// check their own app. Deliberately the SAME three endpoints, not new
// ones — only checked when no deploy token was presented, and only once
// the app is confirmed claimed (an orphan app needs no credential at all,
// same as before, so this never even looks at proxy_auth_token for one).
// Unlike a deploy token, a PAT isn't itself scoped to one company, so
// verifyProxyAuthCompanyAccess is asked about THIS app's specific company.
//
// A claimed app's status/logs are only visible to a token (of either
// kind) tied to the SAME company; anyone else (including no credential at
// all) gets 404 — never 403 — so a wrong/foreign credential can't even
// confirm the app exists, same convention hostnsoft-api's own
// loadCompanyContext uses. A credential that's PRESENT but itself invalid
// (a bad deploy token, or a rejected/expired PAT) is 401 instead — "your
// credential is wrong" reads differently from "this isn't your app".
//
// A personal ("user") deploy token (2026-10-21) reaches apps outside its own
// workspace, so for a token the access decision is hostnsoft-api's
// (validation.appAccess, see validate-deploy-token.js), with the companyId
// comparison below kept only for an older hostnsoft-api that doesn't answer
// it. `permission` names what the route does — app.view or app.logs.
async function authorizeAppAccess(appName, authHeader, proxyAuthTokenHeader, permission = 'app.view') {
  let callerCompanyId = null;
  let deployTokenPresented = false;
  let tokenAppAccess = null;
  if (authHeader) {
    deployTokenPresented = true;
    const token = authHeader.split(' ')[1];
    if (!token) return { ok: false, status: 401, code: 'unauthorized', error: "Unauthorized" };
    const validation = await validateDeployTokenWithCompany(token, appName, permission);
    if (!validation) return { ok: false, status: 401, code: 'unauthorized', error: "Unauthorized" };
    callerCompanyId = validation.companyId;
    tokenAppAccess = validation.appAccess;
    // A caller the app moved away from, or a person who lost access: told
    // why, rather than a 404 that reads as "the app is gone".
    if (validation.appRefusal) {
      const r = validation.appRefusal;
      return { ok: false, status: r.status || 403, code: r.code, error: r.error };
    }
  }

  const lookup = await lookupProject(appName);
  if (!lookup.ok) {
    return { ok: false, status: lookup.status, code: lookup.code, error: lookup.error };
  }
  if (lookup.isOrphan) {
    // companyId returned here too (null for a still-orphan app) so
    // callers that need it (e.g. the customer-query route, to attribute
    // the row) don't have to look the project up a second time.
    // orphanExpiresAt: the status reply tells the agent the deadline.
    return { ok: true, companyId: null, isOrphan: true, orphanExpiresAt: lookup.orphanExpiresAt };
  }

  // Only reached for a CLAIMED app, and only when no deploy token was
  // already presented above — a deploy token remains the primary/unchanged
  // path for every existing agent/CI caller.
  if (!deployTokenPresented && proxyAuthTokenHeader) {
    const membership = await verifyProxyAuthCompanyAccess(proxyAuthTokenHeader, lookup.companyId, appName, permission);
    if (!membership.valid) return { ok: false, status: 401, code: 'unauthorized', error: "Unauthorized" };
    if (!membership.isMember) return { ok: false, status: 404, code: 'not_found', error: "Not found" };
    // A member whose access to this app doesn't cover this read (logs need
    // more than "Can view") gets the same 404 as a stranger.
    if (membership.appAccess === false) return { ok: false, status: 404, code: 'not_found', error: "Not found" };
    callerCompanyId = lookup.companyId;
  }

  if (deployTokenPresented && tokenAppAccess !== null) {
    if (!tokenAppAccess) return { ok: false, status: 404, code: 'not_found', error: "Not found" };
    // The APP's workspace, not the token's: customer-query attributes the
    // row with it, and for a personal token the two can differ.
    return { ok: true, companyId: lookup.companyId, isOrphan: false };
  }
  if (!callerCompanyId || lookup.companyId !== callerCompanyId) {
    return { ok: false, status: 404, code: 'not_found', error: "Not found" };
  }
  return { ok: true, companyId: callerCompanyId, isOrphan: false };
}

// Public — the URL returned in POST /apps's own response. Reports the
// in-flight/last-completed deploy attempt (from deploy-status.js, this
// process's own in-memory state — see that module for why it isn't
// sourced from hostnsoft-api's DB instead) alongside the app's real live
// health (app-health.js), so "still building" and "built but crashed"
// read differently instead of both just looking like silence.
app.get('/apps/:appName/status', async (req, res) => {
  const { appName } = req.params;
  const host = req.get('host');
  if (!appName || !/^[a-z0-9-]+$/.test(appName)) {
    return res.status(400).json(errorBody({ host, error: "Invalid app name", code: 'invalid_app_name' }));
  }

  const auth = await authorizeAppAccess(appName, req.headers.authorization, req.headers['proxy_auth_token']);
  if (!auth.ok) {
    return res.status(auth.status).json(errorBody({ host, appName, error: auth.error, code: auth.code }));
  }

  // A static site has no Nomad job, so Nomad's health says nothing about
  // it (it would read "not_deployed" for a live site). Its manifest only
  // exists once a publish has succeeded — a failed one is undone — so
  // that is what "live" means for it.
  const isStatic = await isStaticApp(appName);
  const kind = isStatic ? 'static' : 'service';

  res.json(statusBody({
    host,
    appName,
    kind,
    url: `https://${defaultDomainFor(appName)}`,
    claimed: !auth.isOrphan,
    expiresAt: auth.orphanExpiresAt || null,
    deployState: getDeployState(appName),
    health: isStatic ? null : await getAppHealth(appName),
    staticLive: isStatic,
  }));
});

// Public — same auth as .../status above. Recent (tail, not streaming)
// stdout/stderr for the app's most recent allocation, regardless of
// whether that allocation is currently healthy — see app-logs.js: the
// most common reason to check logs is a build/runtime failure, so a
// dead allocation's logs matter here as much as a healthy one's.
// ?stream=stderr for the error stream; stdout is the default.
app.get('/apps/:appName/logs', async (req, res) => {
  const { appName } = req.params;
  const host = req.get('host');
  if (!appName || !/^[a-z0-9-]+$/.test(appName)) {
    return res.status(400).json(errorBody({ host, error: "Invalid app name", code: 'invalid_app_name' }));
  }

  const auth = await authorizeAppAccess(appName, req.headers.authorization, req.headers['proxy_auth_token'], 'app.logs');
  if (!auth.ok) {
    return res.status(auth.status).json(errorBody({ host, appName, error: auth.error, code: auth.code }));
  }

  // Nothing runs for a static site, so there is nothing to log — say so
  // plainly rather than "no allocation", which reads as a failed deploy.
  if (await isStaticApp(appName)) {
    return res.json(staticLogsBody({ host, appName }));
  }

  const feedbackLink = { feedback: linksFor(host, appName).feedback };
  const buildLogBody = (buildLog) => ({
    available: true,
    source: 'build',
    stream: 'combined',
    logs: buildLog.output,
    capturedAt: buildLog.capturedAt,
    next: 'These are the latest build logs: fix what they name and redeploy with the same name.',
    links: feedbackLink,
  });

  // A failed REdeploy leaves the previous version's allocation behind, so
  // runtime logs exist — but they belong to the old version and say
  // nothing about why this build failed. When the latest attempt failed
  // and its build log is from that attempt, that log is the answer.
  const deployState = getDeployState(appName);
  const buildLog = getBuildLog(appName);
  if (
    deployState && deployState.status === 'failed' && buildLog &&
    deployState.startedAt && buildLog.capturedAt >= deployState.startedAt
  ) {
    return res.json(buildLogBody(buildLog));
  }

  const stream = req.query.stream === 'stderr' ? 'stderr' : 'stdout';
  const result = await getAppLogs(appName, { stream });

  // Nomad allocation logs only exist once something has actually been
  // scheduled, so a first build that FAILED has none. Fall back to the
  // most recent build's own output (build-diagnostics.js), which is where
  // the real failure is named.
  if (!result.available && buildLog) {
    return res.json(buildLogBody(buildLog));
  }

  if (!result.available) {
    return res.json({
      ...result,
      next: 'No logs yet because the app hasn\'t started: check links.status.',
      links: { status: linksFor(host, appName).status, ...feedbackLink },
    });
  }

  res.json({ ...result, links: feedbackLink });
});

// Path C of docs/request-feature-req.md — an AI agent (Claude Code,
// Claude in a chat client, ChatGPT, whatever) submitting a feature
// request, feedback, or other query about the app it's deploying. Same
// auth shape as .../status and .../logs above (reuses
// authorizeAppAccess): token optional, required to belong to the app's
// own company once claimed, no token needed while it's still an
// unclaimed orphan. X-Agent-Name is required and free text on purpose —
// see the doc for why this must never need a code change to recognize a
// new agent.
//
// Renamed from /feature-requests to /customer-query (2026-09-09) — see
// customer-query.js.
app.post('/apps/:appName/customer-query', express.json(), async (req, res) => {
  const { appName } = req.params;
  if (!appName || !/^[a-z0-9-]+$/.test(appName)) {
    return res.status(400).json({ error: "Invalid app name" });
  }

  const auth = await authorizeAppAccess(appName, req.headers.authorization, req.headers['proxy_auth_token']);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  const agentName = (req.headers['x-agent-name'] || '').toString().trim();
  if (!agentName) {
    return res.status(400).json({ error: "X-Agent-Name header is required" });
  }

  const { type, message } = req.body || {};
  if (!FEEDBACK_TYPES.includes(type)) {
    return res.status(400).json({
      error: `type must be one of: ${FEEDBACK_TYPES.map((t) => `"${t}"`).join(', ')}`,
      code: 'invalid_feedback_type',
    });
  }
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: "message is required" });
  }

  try {
    const result = await submitCustomerQuery({
      type,
      message: message.trim(),
      projectSlug: appName,
      agentName,
      companyId: auth.companyId,
    });
    res.status(201).json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// NEW: pushes an app's config (image, memory, custom domains, env vars)
// WITHOUT a rebuild — see docs/Customdomain-req.md "Activating the
// router". Called by hostnsoft-api for two things: (1) a custom domain
// being verified/removed, with the project's current imageTag unchanged
// and its full current active-domain list (a resync, not a diff), and
// (2) one-click rollback, with a PAST imageTag and everything else left
// at its current value — a rollback only changes what code is running,
// never a project's current domains/env vars/memory floor. Reuses the
// exact same buildNomadJobSpec + `nomad job run` as a fresh deploy —
// Nomad applies job spec changes in-place when the job name already
// exists, so this never touches anything except the one field that
// actually changed.
app.post('/internal/apps/:appName/config', express.json(), requireInternalSecret, async (req, res) => {
  const { appName } = req.params;
  const { imageTag, memoryMb, customDomains, envVars, deploymentId, isFreePlan = false } = req.body || {};

  if (!appName || !/^[a-z0-9-]+$/.test(appName)) {
    return res.status(400).json({ error: "Invalid app name" });
  }
  if (typeof imageTag !== 'string' || !imageTag.includes(':')) {
    return res.status(400).json({ error: 'imageTag is required and must be a full "name:version" image reference' });
  }
  if (!Array.isArray(customDomains) || !customDomains.every((d) => typeof d === 'string')) {
    return res.status(400).json({ error: "customDomains must be an array of strings" });
  }
  // Optional (defaults to []) — hostnsoft-api sends this on every push
  // (see customDomainActivation.ts) so a custom-domain activation never
  // silently strips a project's env vars, but tolerate it being absent
  // rather than failing a request that has nothing to do with env vars.
  if (envVars !== undefined && (!Array.isArray(envVars) || !envVars.every((v) => v && typeof v.key === 'string' && typeof v.value === 'string'))) {
    return res.status(400).json({ error: "envVars must be an array of {key, value} strings" });
  }

  // imageTag is always "<appName>:<appVersion>" (see how it's built in
  // POST /apps above and stored as Deployment.imageTag in hostnsoft-api)
  // — the version is whatever follows the first colon.
  const appVersion = imageTag.slice(imageTag.indexOf(':') + 1);
  const taskMemory = typeof memoryMb === 'number' && memoryMb > 0 ? memoryMb : MEMORY_CEILING_MB;
  // One universal floor, so unlike the ceiling there is nothing to infer
  // here. This endpoint has no build dir and therefore no dependency
  // scan, which used to matter when the floor had an embedded-DB tier.
  const schedulingFloorMb = SCHEDULING_FLOOR_MB;
  const domain = defaultDomainFor(appName);

  // A static app (static-site.js) has no image and no job: the same push
  // means "serve this already-published version" (rollback) and/or
  // "route these hostnames to it" (custom domains). memoryMb and envVars
  // have nothing to apply to — a static site runs no process — and are
  // ignored; hostnsoft-api sends them on every push whatever the reason
  // for it, so their presence is not an error. imageTag keeps its
  // "<appName>:<appVersion>" shape and the version names the directory,
  // so hostnsoft-api's rollback and custom-domain flows needed no change.
  if (await isStaticApp(appName)) {
    if (!(await hasStaticVersion(appName, appVersion))) {
      logger.warn(`[${appName}] Requested static version "${appVersion}" not found on this host, refusing config update`);
      return res.status(404).json({
        error: `Version "${imageTag}" is no longer available on this host`,
        code: 'image_unavailable',
        retainCount: IMAGE_RETAIN_COUNT,
      });
    }
    if ((envVars || []).length > 0 || typeof memoryMb === 'number') {
      logger.info(`[${appName}] Static app: env vars and memory in this config push have no effect (no server process)`);
    }

    const applyStatic = async () => {
      await switchCurrentVersion(appName, appVersion);
      // A config push only ever comes from hostnsoft-api on behalf of a
      // company, so the app is claimed: the orphan-banner routing goes,
      // exactly as the sidecar does when a container app's spec is
      // rebuilt by this same endpoint without isOrphan.
      const manifest = await updateManifest(appName, { customDomains, isOrphan: false });
      await writeStaticRouterFile({
        appName, domain, customDomains, isOrphan: false, isFreePlan: !!isFreePlan, spa: !!(manifest && manifest.spa),
      });
    };

    if (deploymentId) {
      res.status(202).json({ accepted: true, kind: 'static' });
      applyStatic()
        .then(() => {
          logger.info(`[${appName}] Static config update applied (version ${appVersion}, deploymentId=${deploymentId}).`);
          return reportConfigPushResult(deploymentId, { success: true });
        })
        .catch(async (error) => {
          logger.error(`[${appName}] Applying static config update failed:`, error);
          await reportConfigPushResult(deploymentId, { success: false, errorDetail: error.message });
        });
      return;
    }

    try {
      await applyStatic();
      logger.info(`[${appName}] Static config update applied (version ${appVersion}, customDomains: ${customDomains.join(', ') || 'none'}).`);
      return res.json({ success: true, kind: 'static' });
    } catch (error) {
      logger.error(`[${appName}] Applying static config update failed:`, error);
      return res.status(500).json({ error: "Applying config update failed", details: error.message });
    }
  }

  // NEW: this endpoint now also backs one-click rollback (see
  // hostnsoft-api's src/routes/deployments.routes.ts), which can request
  // ANY past imageTag, not just the currently-running one. These images
  // are railpack-built locally and never pushed to a registry, so if
  // this one isn't on disk (e.g. the host was rebuilt, or it was pruned)
  // there's nowhere for Nomad to pull it from — confirmed via
  // `docker image inspect` up front instead of letting `nomad job run`
  // fail deep in its own retry/placement logic with a confusing
  // "pull access denied" error unrelated to the actual cause.
  try {
    await execPromise(`docker image inspect ${imageTag}`);
  } catch (e) {
    logger.warn(`[${appName}] Requested image "${imageTag}" not found locally, refusing config update`);
    // code + retainCount let the caller (hostnsoft-api's rollback route)
    // build a proper client-facing message instead of a generic 502 —
    // see docs/request-feature-req.md's sibling note on this exact case.
    // retainCount travels with the response rather than being hardcoded
    // on hostnsoft-api's side, so the two services can't drift apart if
    // this ever changes.
    return res.status(404).json({
      error: `Image "${imageTag}" is no longer available on this host`,
      code: 'image_unavailable',
      retainCount: IMAGE_RETAIN_COUNT,
    });
  }

  const nomadJobSpec = buildNomadJobSpec({
    appName,
    domain,
    imageName: imageTag,
    appVersion,
    taskMemory,
    schedulingFloorMb,
    customDomains,
    envVars: envVars || [],
    isFreePlan: !!isFreePlan,
  });

  const nomadFilePath = `/tmp/platform-builds/${appName}-config-${Date.now()}.nomad`;

  // NEW: a deploymentId (currently only set by one-click rollback — see
  // hostnsoft-api's deployments.routes.ts) means the caller wants the
  // ASYNC shape: respond as soon as the image check above has passed
  // (the one thing worth failing fast on), apply the actual Nomad job
  // run in the background, and report the real outcome back once it's
  // known — same "accept fast, report later" split as POST /apps itself,
  // since applying a job spec change can take a real, user-visible
  // amount of time. pushCustomDomainConfig (no deploymentId) deliberately
  // keeps the ORIGINAL synchronous behavior: it marks a Domain "active"
  // the instant this call returns success, which must still mean "fully
  // applied" for that caller, not "accepted."
  if (deploymentId) {
    res.status(202).json({ accepted: true });

    (async () => {
      try {
        await ensureAppDataDir(appName);
        await fs.ensureDir(path.dirname(nomadFilePath));
        await fs.writeFile(nomadFilePath, nomadJobSpec);
        logger.info(`[${appName}] Applying config update (rollback, deploymentId=${deploymentId})...`);
        await runNomadJob(appName, nomadFilePath);
        await saveJobSpec(appName);
        await fs.remove(nomadFilePath);
        logger.info(`[${appName}] Config update applied.`);
        await reportConfigPushResult(deploymentId, { success: true });
      } catch (error) {
        logger.error(`[${appName}] Applying config update failed:`, error);
        await reportConfigPushResult(deploymentId, { success: false, errorDetail: error.message });
      }
    })();
    return;
  }

  try {
    await ensureAppDataDir(appName);
    await fs.ensureDir(path.dirname(nomadFilePath));
    await fs.writeFile(nomadFilePath, nomadJobSpec);
    logger.info(`[${appName}] Applying config update (customDomains: ${customDomains.join(', ') || 'none'})...`);
    await runNomadJob(appName, nomadFilePath);
    await saveJobSpec(appName);
    await fs.remove(nomadFilePath);
    res.json({ success: true });
  } catch (error) {
    logger.error(`[${appName}] Applying config update failed:`, error);
    res.status(500).json({ error: "Applying config update failed", details: error.message });
  }
});

/**
 * Moves an app to a new name — see rename-app.js for the sequence and
 * why it has to be that sequence.
 *
 * Synchronous, and deliberately slow: it does not answer until the app
 * is live and holding a real certificate under the new name, or until
 * everything has been put back. There is no wildcard certificate for the
 * platform zone, so the new hostname needs its own ACME order and that
 * is minutes, not milliseconds. Callers must allow for it. Answering
 * early would mean reporting a rename that can still roll back, and
 * hostnsoft-api would have already renamed its own record by then.
 *
 * Takes the same {imageTag, memoryMb, customDomains, envVars} the config
 * endpoint above does — hostnsoft-api owns all four, and the job spec
 * has to be rebuilt from scratch under the new name anyway.
 *
 * NOT RATE LIMITED HERE. The docs advertise one change per week
 * per app; that quota lives in hostnsoft-api, which owns the project
 * record the count hangs off and is the only caller of this route. This
 * side would have nowhere durable to keep it — see deploy-status.js on why
 * in-memory state here is deliberately ephemeral. Worth revisiting
 * alongside the deploy-lock note in rename-app.js if renames ever become
 * self-service for agents.
 */
app.post('/internal/apps/:appName/rename', express.json(), requireInternalSecret, async (req, res) => {
  const { appName } = req.params;
  const { newName, imageTag, memoryMb, customDomains, envVars, isFreePlan = false } = req.body || {};

  if (!appName || !/^[a-z0-9-]+$/.test(appName)) {
    return res.status(400).json({ error: "Invalid app name", code: 'invalid_app_name' });
  }
  if (typeof newName !== 'string' || !/^[a-z0-9-]+$/.test(newName)) {
    return res.status(400).json({ error: "newName must be lowercase letters, digits and hyphens", code: 'invalid_app_name' });
  }
  if (customDomains !== undefined && (!Array.isArray(customDomains) || !customDomains.every((d) => typeof d === 'string'))) {
    return res.status(400).json({ error: "customDomains must be an array of strings", code: 'invalid_config' });
  }
  if (envVars !== undefined && (!Array.isArray(envVars) || !envVars.every((v) => v && typeof v.key === 'string' && typeof v.value === 'string'))) {
    return res.status(400).json({ error: "envVars must be an array of {key, value} strings", code: 'invalid_config' });
  }

  const taskMemory = typeof memoryMb === 'number' && memoryMb > 0 ? memoryMb : MEMORY_CEILING_MB;

  try {
    // Kind decides the migration: a static app has no Nomad job, image or
    // data dir to move (see renameStaticApp). imageTag/memory/envVars are
    // container concerns and are ignored on that path.
    const result = (await isStaticApp(appName))
      ? await renameStaticApp(appName, newName, { customDomains: customDomains || [], isFreePlan: !!isFreePlan })
      : await renameApp(appName, newName, {
        imageTag,
        taskMemory,
        // Same universal floor the config endpoint applies: no build dir
        // here either, so there is no dependency scan to infer one from.
        schedulingFloorMb: SCHEDULING_FLOOR_MB,
        customDomains: customDomains || [],
        envVars: envVars || [],
        isFreePlan: !!isFreePlan,
      });

    // The in-memory deploy state is keyed by app name, so carry it over
    // or GET /apps/<newName>/status reports "unknown" for an app that
    // just deployed successfully. Cleared under the old name in the same
    // breath: left behind, it keeps reporting a successful deploy for an
    // app that no longer exists, and the old name is now free for someone
    // else to claim.
    const previous = getDeployState(appName);
    if (previous) setDeployState(newName, { ...previous, imageTag: result.imageTag });
    clearDeployState(appName);

    logger.info(`[${appName}] Renamed to "${newName}"`);
    res.json({ success: true, ...result });
  } catch (error) {
    // renameApp rolls back before it throws, so by here the app is
    // either still under its old name or the log says exactly what was
    // left behind.
    const status = error.code === 'app_not_found' ? 404
      : error.code === 'app_name_taken' ? 409
        : error.code === 'image_unavailable' ? 404
          : error.code === 'certificate_timeout' ? 504
            : error.code === 'invalid_app_name' || error.code === 'invalid_config' ? 400
              : 500;
    logger.error(`[${appName}] Rename to "${newName}" failed: ${error.message}`);
    res.status(status).json({ error: error.message, code: error.code || 'rename_failed' });
  }
});

// NEW: fully tears down an app — see docs/Anonymous-deploy-req.md #7.
// Called by hostnsoft-api's hourly orphan-cleanup job. `nomad job stop
// -purge` removes both the Nomad job AND its Traefik routing (Traefik's
// Nomad provider derives config from the running job, so purging it is
// sufficient — no separate Traefik cleanup step exists or is needed).
// Uploaded tarballs/build directories are already removed immediately
// after every deploy attempt (success or failure) today, so there's
// nothing left over for this endpoint to clean up there.
app.delete('/internal/apps/:appName', requireInternalSecret, async (req, res) => {
  const { appName } = req.params;
  if (!appName || !/^[a-z0-9-]+$/.test(appName)) {
    return res.status(400).json({ error: "Invalid app name" });
  }

  // ?ifIdle=1 (orphan cleanup only): leave an app with a deploy in flight
  // alone and say so, rather than tearing it down under a build that would
  // bring it back up afterwards — see deploy-in-flight.js. hostnsoft-api
  // retries on its next cleanup run. Without the flag a deploy in flight
  // doesn't stop a teardown, as before.
  if (req.query.ifIdle === '1' && isDeployInFlight(appName)) {
    logger.info(`[${appName}] Teardown skipped: a deploy is in progress`);
    return res.status(409).json({ error: "A deploy of this app is in progress", code: "deploy_in_progress" });
  }

  try {
    // A job that was never successfully deployed (e.g. an orphan whose
    // build/deploy failed) has no Nomad job at all, and a static app never
    // has one — stopNomadJob treats that as already torn down. It looks
    // the job up by exact ID first: a bare `nomad job stop -purge demo`
    // with no job "demo" resolves by prefix to someone else's job (see
    // nomad-job.js).
    await stopNomadJob(appName, { purge: true });

    // A static app (static-site.js) has no job to purge; it has a Traefik
    // router file and a directory of files instead. Router first, so
    // Traefik has stopped sending traffic before the files go. Both are
    // no-ops for a container app — teardown does not need to know which
    // kind it is dealing with, it removes whatever either kind leaves.
    await removeStaticRouterFile(appName).catch((e) => {
      logger.warn(`[${appName}] Could not remove static router file: ${e.message}`);
    });
    await removeStaticApp(appName).catch((e) => {
      logger.warn(`[${appName}] Could not remove static files: ${e.message}`);
    });

    // Now that DATA_DIR is a host directory rather than the allocation's
    // own ephemeral disk, purging the Nomad job no longer takes the app's
    // data with it — so deleting it is an explicit step, and this is the
    // ONLY place in the codebase that does it. Nothing on the
    // scale-to-zero path (which stops jobs but keeps them) may ever touch
    // this: see docs/scale-to-zero-gated-plan.md Step 0.
    //
    // After the job stop, not before: removing a running container's bind
    // mount source out from under it is how you corrupt a database rather
    // than delete one.
    // Before the data and spec are removed: the router file is generated
    // from those, and a deleted app left in the registry would keep a
    // router pointing at the activator for a hostname nothing serves.
    await scaleToZero.forget(appName).catch((e) => {
      logger.warn(`[${appName}] Could not remove from the scale-to-zero registry: ${e.message}`);
    });

    const appDataDir = appDataPathFor(appName);
    await fs.remove(appDataDir).catch((e) => {
      // Best-effort, same posture as the not-found handling above — an
      // app whose deploy never succeeded may have no data directory, and
      // a leftover directory is a disk-usage problem, not a reason to
      // fail a teardown that has otherwise completed.
      logger.warn(`[${appName}] Could not remove data directory ${appDataDir}: ${e.message}`);
    });

    // idle-report.js saves a stopped app's Nomad job spec under
    // $APP_DATA_ROOT/.specs so a scale-to-zero app stays wakeable after
    // Nomad garbage collects the stopped job. A spec left behind for a
    // DELETED app is worse than clutter: it is a complete, runnable
    // description of an app the user asked us to remove, sitting exactly
    // where the activator looks. Removed here so deletion stays final.
    const appSpecFile = specPathFor(appName);
    await fs.remove(appSpecFile).catch((e) => {
      logger.warn(`[${appName}] Could not remove saved job spec ${appSpecFile}: ${e.message}`);
    });

    // Snapshots are full copies of the app's data directory, written by
    // idle-report.js every time scale-to-zero stops it. Left behind, they
    // are the app's own data surviving an explicit deletion — which is the
    // one thing a delete has to get right.
    const appSnapshotDir = `${appDataPathFor('.snapshots')}/${appName}`;
    await fs.remove(appSnapshotDir).catch((e) => {
      logger.warn(`[${appName}] Could not remove snapshots ${appSnapshotDir}: ${e.message}`);
    });
    await execPromise(`docker images --filter=reference=${appName}:* -q | xargs -r docker rmi -f`).catch((e) => {
      logger.warn(`[${appName}] Removing docker image(s) during teardown failed (continuing): ${e.message}`);
    });
    logger.info(`[${appName}] Orphan teardown complete`);
    res.json({ success: true });
  } catch (error) {
    logger.error(`[${appName}] Orphan teardown failed:`, error);
    res.status(500).json({ error: "Teardown failed", details: error.message });
  }
});

// NEW: read-only Nomad allocation status for a project — see
// hostnsoft-api's src/services/appHealth.ts (its GET
// /companies/:companyId/projects/:projectId consumes this, replacing the
// previously-hardcoded health: "unknown"). See app-health.js for how
// Nomad's own status vocabulary is simplified.
app.get('/internal/apps/:appName/status', requireInternalSecret, async (req, res) => {
  const { appName } = req.params;
  if (!appName || !/^[a-z0-9-]+$/.test(appName)) {
    return res.status(400).json({ error: "Invalid app name" });
  }

  const health = await getAppHealth(appName);
  const kind = (await isStaticApp(appName)) ? 'static' : 'service';
  res.json({ health, kind });
});

// NEW: per-app traffic (Traefik access log) and CPU/memory (Nomad stats)
// history — see hostnsoft-api's src/services/appAnalytics.ts, which this
// backs. `range` matches the values documented in the API reference:
// 24h/7d/30d/90d/all.
app.get('/internal/apps/:appName/analytics', requireInternalSecret, async (req, res) => {
  const { appName } = req.params;
  if (!appName || !/^[a-z0-9-]+$/.test(appName)) {
    return res.status(400).json({ error: "Invalid app name" });
  }
  const range = typeof req.query.range === 'string' ? req.query.range : '24h';
  if (!isValidRange(range)) {
    return res.status(400).json({ error: 'range must be one of: 24h, 7d, 30d, 90d, all' });
  }

  try {
    res.json({
      traffic: queryTraffic(appName, range),
      resourceUsage: queryResourceUsage(appName, range),
    });
  } catch (error) {
    logger.error(`[${appName}] Analytics query failed:`, error);
    res.status(500).json({ error: "Analytics query failed", details: error.message });
  }
});

// Start the API Server — PORT is env-driven so multiple environments
// (see server-setup.sh's per-APP_ENV port offset) can coexist on one host
// without colliding; defaults to 4000 to match prior fixed behavior.
const PORT = Number(process.env.PORT) || 4000;
const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`🚀 Platform Deployment API running on port ${PORT}`);
  // Tell pm2 we can serve (wait_ready). No-op outside pm2.
  if (process.send) process.send('ready');
});

// Graceful shutdown, same shape as api-service. pm2 sends SIGINT on
// reload/stop (SIGTERM from docker/systemd); without a handler Node would
// exit at once, cutting in-flight requests and background builds. Close
// the server, give in-flight requests and background builds the grace
// period, then exit. pm2 kill_timeout must be longer than this.
// server-setup.md#zero-downtime
const SHUTDOWN_GRACE_MS = 120000;
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[server] ${signal} received: closing HTTP server, finishing in-flight work`);
  server.close(() => logger.info('[server] HTTP server closed'));
  setTimeout(() => {
    logger.info(`[server] grace period of ${SHUTDOWN_GRACE_MS / 1000}s over, exiting`);
    process.exit(0);
  }, SHUTDOWN_GRACE_MS).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Started after listen() so a broken analytics subsystem can never
// prevent the actual deploy pipeline from coming up — each function
// warns and no-ops on its own if its required env var isn't set, rather
// than throwing, since analytics is additive, not load-bearing.
startAccessLogTailer();
startResourcePoller();
startRetentionLoop();
