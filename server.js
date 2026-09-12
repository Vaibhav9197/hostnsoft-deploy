const path = require('path');

// Loads .env from this file's own directory, not process.cwd() — pm2 isn't
// guaranteed to launch this with its cwd set to here, so the default
// (cwd-relative) dotenv behavior would silently miss the file under pm2.
// Must run before validate-deploy-token.js (and anything else reading
// process.env) is required below.
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
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

// NEW: every deploy now authenticates as a specific company via a
// company-scoped token issued (and revocable/rotatable) by hostnsoft-api,
// replacing the old single shared PLATFORM_TOKEN everyone used.
const { validateDeployToken, validateDeployTokenWithCompany } = require('./validate-deploy-token');

// NEW: reports each deploy attempt's outcome back to hostnsoft-api so its
// dashboard deployment history is actually populated.
const { recordDeployment } = require('./record-deployment');

// NEW: confirms the app name is available to this company BEFORE any
// build/Nomad resources are spent — the app name is also the live
// subdomain, so it must be unique platform-wide.
const { claimProject } = require('./claim-project');

// NEW: shared Nomad job spec builder — see docs/Customdomain-req.md. Used
// here after a fresh build, and by the /internal/apps/:appName/config
// endpoint below when only custom-domain routing changed (no rebuild).
// APPS_DOMAIN_SUFFIX's fail-fast check now lives inside this module (see
// its defaultDomainFor) rather than here, since both this file and the
// config endpoint below need it.
const { buildNomadJobSpec, defaultDomainFor } = require('./nomad-job-spec');
const { requireInternalSecret } = require('./internal-auth');

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
const { setDeployState, getDeployState } = require('./deploy-status');
const { lookupProject } = require('./project-lookup');
const { verifyProxyAuthCompanyAccess } = require('./verify-proxy-auth');
const { getAppLogs } = require('./app-logs');

// NEW: lets an AI agent submit a feature request, piece of feedback, or
// other query in the context of the app it's deploying — see
// docs/request-feature-req.md (Path C). Forwards to hostnsoft-api, same
// shape as recordDeployment.
const { submitCustomerQuery } = require('./customer-query');

// NEW: keeps only the last N local images per app so one-click rollback
// always has a bounded, known-good window to roll back into (and disk
// usage stays bounded on a host that never pushes images to a registry).
const { pruneOldImages, IMAGE_RETAIN_COUNT } = require('./image-retention');

// NEW: reports an async config-push's real outcome (see the
// POST /internal/apps/:appName/config deploymentId branch below) back to
// hostnsoft-api once it's known.
const { reportConfigPushResult } = require('./report-config-push');

// Public docs site — one shared constant so every reference to it stays in
// sync. Canonical path is "/docs" (plural); "/doc" still works via a 308
// redirect on the frontend, but new references should use this directly
// rather than take the extra redirect hop.
const DOCS_URL = 'https://embarko.ai/docs';

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

// Configure Multer to save uploaded files to a temporary folder
const upload = multer({ dest: '/tmp/platform-uploads/' });

// Runs the actually-slow part of a deploy (railpack build + `nomad job
// run`) — split out of the request handler below so it can continue
// AFTER the response is already sent (see the handler's own comment for
// why). Never throws outward: this has no request/response to answer to
// by the time it runs, so every failure is caught, recorded, and logged
// here instead.
async function performBuildAndDeploy({
  appName, appVersion, imageName, domain, buildDir, filePath,
  claim, taskMemory, hasValidToken, token, deploymentId,
}) {
  try {
    logger.info(`[${appName}] Building image with Railpack (version: ${appVersion})...`);
    // Railpack's CLI takes the directory as a positional arg and the
    // image tag via --name.
    await execPromise(`cd ${buildDir} && railpack build . --name ${imageName}`);

    logger.info(`[${appName}] Generating Nomad file...`);
    const nomadJobSpec = buildNomadJobSpec({
      appName,
      domain,
      imageName,
      appVersion,
      taskMemory,
      customDomains: claim.customDomains || [],
      envVars: claim.envVars || [],
      isOrphan: claim.isOrphan,
      orphanExpiresAt: claim.orphanExpiresAt,
      orphanLoginUrl: claim.orphanLoginUrl,
    });
    const nomadFilePath = path.join(buildDir, `${appName}.nomad`);
    await fs.writeFile(nomadFilePath, nomadJobSpec);

    logger.info(`[${appName}] Deploying to Nomad...`);
    await execPromise(`nomad job run ${nomadFilePath}`);

    // Best-effort, after the deploy that matters has already succeeded —
    // never lets a retention hiccup affect the response/state below.
    await pruneOldImages(appName).catch((e) => {
      logger.warn(`[${appName}] Image retention pass failed (continuing): ${e.message}`);
    });

    await fs.remove(buildDir);
    await fs.remove(filePath);

    // Reports the outcome to hostnsoft-api so its dashboard deployment
    // history is actually populated. Skipped for anonymous deploys — see
    // docs/Anonymous-deploy-req.md's "out of scope": there's no company
    // to attribute history to until/unless the project is claimed.
    // deploymentId (from the in_progress call below) updates that same
    // row in place rather than creating a second one for this attempt.
    if (hasValidToken) {
      await recordDeployment({
        token,
        projectSlug: appName,
        appVersion,
        status: 'success',
        imageTag: imageName,
        memoryMb: taskMemory,
        deploymentId,
      });
    }
    setDeployState(appName, {
      status: 'success',
      finishedAt: new Date().toISOString(),
      errorDetail: null,
      imageTag: imageName,
    });
    logger.info(`[${appName}] Deployment complete.`);
  } catch (error) {
    logger.error(`[${appName}] Deployment failed:`, error);

    // Unlike before this became a background step, cleanup on failure
    // matters here too — a build that keeps failing (bad Dockerfile,
    // flaky dependency) would otherwise leave a build dir + upload behind
    // on every single retry, forever, with nothing to ever remove them.
    await fs.remove(buildDir).catch(() => {});
    await fs.remove(filePath).catch(() => {});

    if (hasValidToken) {
      await recordDeployment({
        token,
        projectSlug: appName,
        appVersion,
        status: 'failed',
        errorDetail: error.message,
        deploymentId,
      });
    }
    setDeployState(appName, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      errorDetail: error.message,
    });
  }
}

app.post('/apps', upload.single('source'), async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(' ')[1];
  const appName = req.headers['x-app-name'];

  // NEW: read version from header, fall back to a timestamp-based tag if not provided.
  // Never fall back to "latest" — Nomad's Docker driver always re-pulls :latest tags
  // and ignores the locally built image, even with force_pull = false.
  const rawVersion = req.headers['x-app-version'];
  const appVersion = (rawVersion && /^[a-zA-Z0-9._-]+$/.test(rawVersion))
    ? rawVersion
    : `${Date.now()}`;

  // 1. Validation
  // NEW: no X-Company-Id header — the deploy token is already company-
  // scoped at creation (hostnsoft-api mints one per company), so which
  // company this deploy belongs to is read off the token itself. One
  // fewer thing for a caller to get right or send inconsistently.
  //
  // NEW: a MISSING Authorization header opts into an anonymous ("orphan")
  // deploy — see docs/Anonymous-deploy-req.md — but a header that's
  // present and invalid is still a hard 401, never a silent fallback to
  // anonymous. Anonymous is opt-in by omission only, so a typo'd/expired
  // token surfaces as an auth error instead of masquerading as a feature.
  let hasValidToken = false;
  if (authHeader) {
    if (!token || !(await validateDeployToken(token))) {
      return res.status(401).json({ error: "Unauthorized", code: "unauthorized" });
    }
    hasValidToken = true;
  }

  if (!appName || !/^[a-z0-9-]+$/.test(appName)) {
    return res.status(400).json({ error: "Invalid or missing X-App-Name header. Use lowercase letters and dashes.", code: "invalid_app_name" });
  }

  // NEW: the app name is also the live subdomain and the Nomad job name —
  // confirm it's either already this token's company's or free to claim
  // BEFORE spending any build time on it. No project needs to exist via
  // the dashboard first; this auto-creates one on first sight. Passing
  // `undefined` (not the invalid/absent token itself) when there's no
  // valid token routes this to hostnsoft-api's anonymous/orphan path.
  const claim = await claimProject(hasValidToken ? token : undefined, appName);
  if (!claim.ok) {
    return res.status(claim.status).json({ error: claim.error, code: claim.code });
  }

  if (rawVersion && !/^[a-zA-Z0-9._-]+$/.test(rawVersion)) {
    return res.status(400).json({ error: "Invalid X-App-Version header. Use letters, numbers, dots, dashes, underscores only.", code: "invalid_app_version" });
  }

  if (!req.file) {
    return res.status(400).json({ error: "No source code uploaded", code: "missing_source_file" });
  }

  const buildDir = `/tmp/platform-builds/${appName}-${Date.now()}`;
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
  const selfHost = req.get('host');

  try {
    // 2. Extract the uploaded tar.gz file
    logger.info(`[${appName}] Extracting code...`);
    await fs.ensureDir(buildDir);
    await tar.x({
      file: req.file.path,
      cwd: buildDir
    });

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
        return res.status(422).json({
          error: "Unsupported storage pattern detected",
          code: "unsupported_storage_pattern",
          detail:
            "This app calls window.storage, an API specific to Claude Artifacts' sandbox. " +
            "It does not exist outside that environment and will fail at runtime if deployed " +
            "here as-is. Please update the app to persist data with a real database before " +
            "redeploying: SQLite for simple key-value/document-style data, or PGlite " +
            "(@electric-sql/pglite) for relational data needing joins or queries.",
          filesDetected: storageUsage.files,
          docs: DOCS_URL,
        });
      }
    }

    // 2c. Embedded DB (PGlite) needs more memory headroom than a plain
    // static/Express app. Uses the same `deps` read above — no second
    // package.json read.
    //
    // NEW: takes the project's configured memoryMb (hostnsoft-api's
    // PATCH .../memory — previously persisted but never actually reached
    // here) as a floor-adjustable override rather than either ignoring it
    // or letting it override outright: the auto-detected embedded-DB
    // requirement is a hard technical minimum (that app WILL OOM below
    // it), not something a lower configured value should be able to
    // undercut — hostnsoft-api's schema defaults every project to 256MB
    // whether or not memory was ever explicitly configured, so treating
    // the configured value as authoritative outright would silently
    // regress every embedded-DB app that never touched this setting.
    // Math.max lets an explicit HIGHER value win, while the auto-detected
    // minimum always still applies.
    const usesEmbeddedDb = Object.keys(deps).some(dep => dep.startsWith('@electric-sql/pglite'));
    const autoDetectedMemory = usesEmbeddedDb ? 512 : 256;
    const taskMemory = Math.max(autoDetectedMemory, claim.memoryMb || autoDetectedMemory);
    logger.info(`[${appName}] Embedded DB detected: ${usesEmbeddedDb} (min ${autoDetectedMemory}MB), configured: ${claim.memoryMb ?? 'none'}MB -> using ${taskMemory}MB`);

    // NEW: from here on, the actual build (railpack, which can easily
    // take minutes for a fresh install) and the Nomad deploy run in the
    // BACKGROUND, after the response below is already sent. A slow
    // build was hitting Cloudflare's own proxy timeout (524) well before
    // the deploy had a chance to finish — the client only needs to know
    // the upload was accepted, not wait out the whole build inline.
    // Progress is tracked via deploy-status.js (see GET
    // /apps/:appName/status, whose URL is included in the response
    // below) and, for token-authenticated deploys, mirrored into
    // hostnsoft-api's own deployment history too.
    let deploymentId = null;
    if (hasValidToken) {
      deploymentId = await recordDeployment({
        token,
        projectSlug: appName,
        appVersion,
        status: 'in_progress',
      });
    }
    setDeployState(appName, {
      status: 'in_progress',
      appVersion,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      errorDetail: null,
      deploymentId,
    });

    const statusUrl = `https://${selfHost}/apps/${appName}/status`;
    const logsUrl = `https://${selfHost}/apps/${appName}/logs`;
    const customerQueryUrl = `https://${selfHost}/apps/${appName}/customer-query`;
    const docsUrl = DOCS_URL;

    // 7. Send Accepted Response — the build/deploy hasn't run yet; see
    // performBuildAndDeploy above, kicked off (unawaited) below.
    const responseBody = {
      success: true,
      accepted: true,
      message:
        `Deployment accepted and is building in the background — this can take a few ` +
        `minutes for a fresh build. Check ${statusUrl} for progress (and ${logsUrl} for ` +
        `build/runtime logs) before assuming it's live at the URL below.`,
      version: appVersion,
      image: imageName,
      memory: `${taskMemory}MB`,
      url: `https://${domain}`,
      statusUrl,
      logsUrl,
      // 2026-09-13: surfaced on EVERY deploy response (orphan or claimed —
      // added above the isOrphan branch below, not inside it), not just
      // documented separately, so an AI agent doing the deploying learns
      // about this the moment it deploys, without needing to have already
      // read the docs. Written as a direct instruction TO the agent, not
      // a human-facing explanation of the feature — see
      // docs/request-feature-req.md (Path C) and customer-query.js.
      support: {
        message:
          `If deploying, building, or fixing this app ever fails or behaves ` +
          `unexpectedly, report it automatically — don't just work around it ` +
          `silently and say nothing. POST ${customerQueryUrl} with header ` +
          `"X-Agent-Name: <your agent's name>" and JSON body ` +
          `{"type": "feedback", "message": "<what went wrong, what you tried, ` +
          `and any error output>"} ("type" can also be "feature" for a missing ` +
          `capability, or "other"). Same access rules as ${statusUrl} and ` +
          `${logsUrl} above: no credential needed while this app is unclaimed, ` +
          `or the same deploy token / proxy_auth_token you're already using ` +
          `once it's claimed. Full docs: ${docsUrl}`,
        customerQueryUrl,
        docsUrl,
      },
    };
    // NEW: see docs/Anonymous-deploy-req.md #4 — orphanMessage is a
    // complete, self-contained instruction sequence, written so an AI
    // agent relaying this to a human can explain every step unaided.
    // statusUrl/logsUrl are repeated here (not just top-level) so that
    // same self-contained instruction sequence doesn't force the reader
    // to also go look at sibling fields to find them.
    if (claim.isOrphan) {
      responseBody.orphan = {
        expiresAt: claim.orphanExpiresAt,
        message: claim.orphanMessage,
        statusUrl,
        logsUrl,
      };
    }
    res.status(202).json(responseBody);

    // Deliberately not awaited — everything from here happens after the
    // response above. performBuildAndDeploy has its own try/catch that
    // records success/failure; .catch() here is only a backstop.
    performBuildAndDeploy({
      appName, appVersion, imageName, domain,
      buildDir, filePath: req.file.path,
      claim, taskMemory, hasValidToken, token, deploymentId,
    }).catch((err) => {
      logger.error(`[${appName}] unexpected error in background deploy: ${err.message}`);
    });

  } catch (error) {
    // Only the SYNCHRONOUS section above (extraction, package.json read,
    // storage scan, memory calc) can land here — the build/deploy itself
    // has its own error handling inside performBuildAndDeploy.
    logger.error(`[${appName}] Deploy request failed before accepting:`, error);

    if (hasValidToken) {
      await recordDeployment({
        token,
        projectSlug: appName,
        appVersion,
        status: 'failed',
        errorDetail: error.message,
      });
    }

    res.status(500).json({ error: "Deployment failed", code: "deploy_failed", details: error.message });
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
async function authorizeAppAccess(appName, authHeader, proxyAuthTokenHeader) {
  let callerCompanyId = null;
  let deployTokenPresented = false;
  if (authHeader) {
    deployTokenPresented = true;
    const token = authHeader.split(' ')[1];
    if (!token) return { ok: false, status: 401, error: "Unauthorized" };
    const validation = await validateDeployTokenWithCompany(token);
    if (!validation) return { ok: false, status: 401, error: "Unauthorized" };
    callerCompanyId = validation.companyId;
  }

  const lookup = await lookupProject(appName);
  if (!lookup.ok) {
    return { ok: false, status: lookup.status, error: lookup.error };
  }
  if (lookup.isOrphan) {
    // companyId returned here too (null for a still-orphan app) so
    // callers that need it (e.g. the customer-query route, to attribute
    // the row) don't have to look the project up a second time.
    return { ok: true, companyId: null, isOrphan: true };
  }

  // Only reached for a CLAIMED app, and only when no deploy token was
  // already presented above — a deploy token remains the primary/unchanged
  // path for every existing agent/CI caller.
  if (!deployTokenPresented && proxyAuthTokenHeader) {
    const membership = await verifyProxyAuthCompanyAccess(proxyAuthTokenHeader, lookup.companyId);
    if (!membership.valid) return { ok: false, status: 401, error: "Unauthorized" };
    if (!membership.isMember) return { ok: false, status: 404, error: "Not found" };
    callerCompanyId = lookup.companyId;
  }

  if (!callerCompanyId || lookup.companyId !== callerCompanyId) {
    return { ok: false, status: 404, error: "Not found" };
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
  if (!appName || !/^[a-z0-9-]+$/.test(appName)) {
    return res.status(400).json({ error: "Invalid app name" });
  }

  const auth = await authorizeAppAccess(appName, req.headers.authorization, req.headers['proxy_auth_token']);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  const deployState = getDeployState(appName) || {};
  const health = await getAppHealth(appName);

  res.json({
    appName,
    deploy: {
      status: deployState.status || 'unknown',
      appVersion: deployState.appVersion || null,
      startedAt: deployState.startedAt || null,
      finishedAt: deployState.finishedAt || null,
      errorDetail: deployState.errorDetail || null,
    },
    health,
  });
});

// Public — same auth as .../status above. Recent (tail, not streaming)
// stdout/stderr for the app's most recent allocation, regardless of
// whether that allocation is currently healthy — see app-logs.js: the
// most common reason to check logs is a build/runtime failure, so a
// dead allocation's logs matter here as much as a healthy one's.
// ?stream=stderr for the error stream; stdout is the default.
app.get('/apps/:appName/logs', async (req, res) => {
  const { appName } = req.params;
  if (!appName || !/^[a-z0-9-]+$/.test(appName)) {
    return res.status(400).json({ error: "Invalid app name" });
  }

  const auth = await authorizeAppAccess(appName, req.headers.authorization, req.headers['proxy_auth_token']);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  const stream = req.query.stream === 'stderr' ? 'stderr' : 'stdout';
  const result = await getAppLogs(appName, { stream });
  res.json(result);
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
  if (type !== 'feature' && type !== 'feedback' && type !== 'other') {
    return res.status(400).json({ error: 'type must be "feature", "feedback", or "other"' });
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
  const { imageTag, memoryMb, customDomains, envVars, deploymentId } = req.body || {};

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
  const taskMemory = typeof memoryMb === 'number' && memoryMb > 0 ? memoryMb : 256;
  const domain = defaultDomainFor(appName);

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
    customDomains,
    envVars: envVars || [],
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
        await fs.ensureDir(path.dirname(nomadFilePath));
        await fs.writeFile(nomadFilePath, nomadJobSpec);
        logger.info(`[${appName}] Applying config update (rollback, deploymentId=${deploymentId})...`);
        await execPromise(`nomad job run ${nomadFilePath}`);
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
    await fs.ensureDir(path.dirname(nomadFilePath));
    await fs.writeFile(nomadFilePath, nomadJobSpec);
    logger.info(`[${appName}] Applying config update (customDomains: ${customDomains.join(', ') || 'none'})...`);
    await execPromise(`nomad job run ${nomadFilePath}`);
    await fs.remove(nomadFilePath);
    res.json({ success: true });
  } catch (error) {
    logger.error(`[${appName}] Applying config update failed:`, error);
    res.status(500).json({ error: "Applying config update failed", details: error.message });
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

  try {
    await execPromise(`nomad job stop -purge ${appName}`).catch((e) => {
      // A job that was never successfully deployed (e.g. an orphan whose
      // build/deploy failed) has no Nomad job at all — treat "not found"
      // as already-torn-down rather than an error. Nomad's actual message
      // here is "No job(s) with prefix or id \"x\" found" (confirmed via
      // Nomad's own CLI source/issue tracker) — it does NOT contain the
      // substring "not found", so the previous check here never matched
      // and this path silently fell through to `throw e` instead (caught
      // by this function's own outer try/catch, surfaced as a 500 to
      // hostnsoft-api rather than the "already torn down" success this
      // comment always described). Found while adding the same
      // not-found detection to app-health.js's GET .../status endpoint.
      const output = `${e.stdout || ''}${e.stderr || ''}`;
      if (!/no job\(s\) with prefix or id/i.test(output)) throw e;
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
  res.json({ health });
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
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`🚀 Platform Deployment API running on port ${PORT}`);
});

// Started after listen() so a broken analytics subsystem can never
// prevent the actual deploy pipeline from coming up — each function
// warns and no-ops on its own if its required env var isn't set, rather
// than throwing, since analytics is additive, not load-bearing.
startAccessLogTailer();
startResourcePoller();
startRetentionLoop();
