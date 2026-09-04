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
const { validateDeployToken } = require('./validate-deploy-token');

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
          docs: "https://ship.hostnsoft.com/docs/storage-requirements",
        });
      }
    }

    // 2c. Embedded DB (PGlite) needs more memory headroom than a plain
    // static/Express app. Uses the same `deps` read above — no second
    // package.json read.
    const usesEmbeddedDb = Object.keys(deps).some(dep => dep.startsWith('@electric-sql/pglite'));
    const taskMemory = usesEmbeddedDb ? 512 : 256;
    logger.info(`[${appName}] Embedded DB detected: ${usesEmbeddedDb} -> memory = ${taskMemory}MB`);

    // 3. Build the container image using Railpack
    logger.info(`[${appName}] Building image with Railpack (version: ${appVersion})...`);
    // FIXED: Railpack's CLI takes the directory as a positional arg and the
    // image tag via --name. The original `railpack build ${imageName}` treated
    // the tag itself as a directory path and always failed.
    await execPromise(`cd ${buildDir} && railpack build . --name ${imageName}`);

    // 4. Generate the Nomad Job Specification
    logger.info(`[${appName}] Generating Nomad file...`);
    // NEW: includes one HTTP-01 router per already-active custom domain
    // for this project (claim.customDomains, from
    // /internal/projects/claim) — without this, redeploying an app that
    // already has a custom domain attached would silently drop its
    // router. See docs/Customdomain-req.md.
    //
    // NEW: isOrphan/orphanExpiresAt/orphanLoginUrl route traffic through
    // the language-agnostic orphan-proxy sidecar instead of the app
    // directly — see docs/Anonymous-deploy-req.md #5 and
    // nomad-job-spec.js. Replaces the old build-time source-injection
    // approach (orphan-banner.js, removed), which only ever covered a
    // static index.html or a narrow Node-specific case.
    //
    // NEW: claim.envVars — this project's configured env vars (see
    // hostnsoft-api's env-vars.routes.ts), baked into the container's
    // env block on every deploy. Previously persisted in hostnsoft-api's
    // DB but never actually reached a running app.
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

    // 5. Deploy to Nomad
    logger.info(`[${appName}] Deploying to Nomad...`);
    await execPromise(`nomad job run ${nomadFilePath}`);

    // 6. Cleanup temp files
    await fs.remove(buildDir);
    await fs.remove(req.file.path);

    // NEW: report this deploy's outcome to hostnsoft-api so its dashboard
    // deployment history is actually populated. Skipped for anonymous
    // deploys — see docs/Anonymous-deploy-req.md's "out of scope": there's
    // no company to attribute history to until/unless the project is
    // claimed, and nothing is retroactively backfilled once it is.
    if (hasValidToken) {
      await recordDeployment({
        token,
        projectSlug: appName,
        appVersion,
        status: 'success',
        imageTag: imageName,
        memoryMb: taskMemory,
      });
    }

    // 7. Send Success Response
    const responseBody = {
      success: true,
      message: "Deployment successful!",
      version: appVersion,
      image: imageName,
      memory: `${taskMemory}MB`,
      url: `https://${domain}`
    };
    // NEW: see docs/Anonymous-deploy-req.md #4 — orphanMessage is a
    // complete, self-contained instruction sequence, written so an AI
    // agent relaying this to a human can explain every step unaided.
    if (claim.isOrphan) {
      responseBody.orphan = {
        expiresAt: claim.orphanExpiresAt,
        message: claim.orphanMessage,
      };
    }
    res.status(200).json(responseBody);

  } catch (error) {
    logger.error(`[${appName}] Deployment failed:`, error);

    // NEW: report the failure too — token/appName/appVersion are all
    // validated before this try block starts, so they're safe here even
    // if the failure happened early in the pipeline (taskMemory isn't,
    // hence its absence below). Skipped for anonymous deploys, same
    // reasoning as the success path above.
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

// NEW: pushes updated custom-domain routing to a project's already-
// running app WITHOUT a rebuild — see docs/Customdomain-req.md
// "Activating the router". Called by hostnsoft-api once a custom
// domain's DNS is verified (or once one is removed/deactivated), with
// its full current list of active domains for the project each time
// (a resync, not a diff). Reuses the exact same buildNomadJobSpec +
// `nomad job run` as a fresh deploy — Nomad applies job spec changes
// in-place when the job name already exists, so the running container
// image is never touched.
app.post('/internal/apps/:appName/config', express.json(), requireInternalSecret, async (req, res) => {
  const { appName } = req.params;
  const { imageTag, memoryMb, customDomains, envVars } = req.body || {};

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
      // as already-torn-down rather than an error.
      const output = `${e.stdout || ''}${e.stderr || ''}`;
      if (!/not found/i.test(output)) throw e;
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

// Start the API Server — PORT is env-driven so multiple environments
// (see server-setup.sh's per-APP_ENV port offset) can coexist on one host
// without colliding; defaults to 4000 to match prior fixed behavior.
const PORT = Number(process.env.PORT) || 4000;
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`🚀 Platform Deployment API running on port ${PORT}`);
});
