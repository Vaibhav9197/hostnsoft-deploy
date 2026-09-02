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
const logger = require('./logger');

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

const app = express();

// Configure Multer to save uploaded files to a temporary folder
const upload = multer({ dest: '/tmp/platform-uploads/' });

app.post('/apps', upload.single('source'), async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
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
  if (!token || !(await validateDeployToken(token))) {
    return res.status(401).json({ error: "Unauthorized", code: "unauthorized" });
  }

  if (!appName || !/^[a-z0-9-]+$/.test(appName)) {
    return res.status(400).json({ error: "Invalid or missing X-App-Name header. Use lowercase letters and dashes.", code: "invalid_app_name" });
  }

  // NEW: the app name is also the live subdomain and the Nomad job name —
  // confirm it's either already this token's company's or free to claim
  // BEFORE spending any build time on it. No project needs to exist via
  // the dashboard first; this auto-creates one on first sight.
  const claim = await claimProject(token, appName);
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
  // TODO(embarko rebrand, 2026-09-02): switch to embarko.ai once its DNS,
  // Cloudflare zone, and wildcard cert resolver are confirmed live — not
  // yet ready, so this intentionally still points at hostnsoft.com. Do
  // not change this without confirming the new domain actually resolves
  // and can issue certs first, or every deploy after the switch breaks.
  const domain = `${appName}.app.hostnsoft.com`;

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
    const nomadJobSpec = `
job "${appName}" {
  datacenters = ["dc1"]
  type        = "service"

  group "web" {
    network {
      port "http" {}
    }

    # Persists /alloc/data across redeploys by biasing the scheduler to reuse
    # the same client node, and migrating the data if it ever can't.
    # Apps that don't use DATA_DIR simply ignore this — it's opt-in.
    ephemeral_disk {
      size    = 500
      sticky  = true
      migrate = true
    }

    service {
      name     = "${appName}"
      provider = "nomad"
      port     = "http"

      tags = [
        "traefik.enable=true",
        "traefik.http.routers.${appName}.rule=Host(\`${domain}\`)",
        "traefik.http.routers.${appName}.entrypoints=websecure",
        "traefik.http.routers.${appName}.tls.certresolver=cloudflare"
      ]
    }
    task "server" {
      driver = "docker"
      config {
        image      = "${imageName}"
        ports      = ["http"]
        force_pull = false # Use the local image we just built
      }
      env {
        PORT        = "\${NOMAD_PORT_http}"
        APP_NAME    = "${appName}"
        APP_VERSION = "${appVersion}"
        DATA_DIR    = "/alloc/data"
      }
      resources {
        cpu    = 100
        memory = ${taskMemory}
      }
    }
  }
}
    `;

    const nomadFilePath = path.join(buildDir, `${appName}.nomad`);
    await fs.writeFile(nomadFilePath, nomadJobSpec);

    // 5. Deploy to Nomad
    logger.info(`[${appName}] Deploying to Nomad...`);
    await execPromise(`nomad job run ${nomadFilePath}`);

    // 6. Cleanup temp files
    await fs.remove(buildDir);
    await fs.remove(req.file.path);

    // NEW: report this deploy's outcome to hostnsoft-api so its dashboard
    // deployment history is actually populated.
    await recordDeployment({
      token,
      projectSlug: appName,
      appVersion,
      status: 'success',
      imageTag: imageName,
      memoryMb: taskMemory,
    });

    // 7. Send Success Response
    res.status(200).json({
      success: true,
      message: "Deployment successful!",
      version: appVersion,
      image: imageName,
      memory: `${taskMemory}MB`,
      url: `https://${domain}`
    });

  } catch (error) {
    logger.error(`[${appName}] Deployment failed:`, error);

    // NEW: report the failure too — token/appName/appVersion are all
    // validated before this try block starts, so they're safe here even
    // if the failure happened early in the pipeline (taskMemory isn't,
    // hence its absence below).
    await recordDeployment({
      token,
      projectSlug: appName,
      appVersion,
      status: 'failed',
      errorDetail: error.message,
    });

    res.status(500).json({ error: "Deployment failed", code: "deploy_failed", details: error.message });
  }
});

// Start the API Server on port 4000
app.listen(4000, '0.0.0.0', () => {
  logger.info("🚀 Platform Deployment API running on port 4000");
});
