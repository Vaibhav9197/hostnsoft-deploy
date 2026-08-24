const express = require('express');
const multer = require('multer');
const tar = require('tar');
const fs = require('fs-extra');
const { exec } = require('child_process');
const path = require('path');
const util = require('util');
const execPromise = util.promisify(exec);

// NEW: detects apps built assuming Claude Artifacts' window.storage API,
// which does not exist outside that sandbox and will fail if deployed
// here unmodified. Blocks the deploy with a clear message rather than
// building/shipping an app that will break at runtime. Skipped entirely
// for apps that already declare a real database dependency.
const { detectWindowStorageUsage, hasRealDatabaseDependency } = require('./detect-storage-usage');

const app = express();

// Configure Multer to save uploaded files to a temporary folder
const upload = multer({ dest: '/tmp/platform-uploads/' });

// Security token — must come from the environment, never hardcoded.
// Generate a real one with: openssl rand -hex 32
if (!process.env.PLATFORM_TOKEN) {
  console.error("FATAL: PLATFORM_TOKEN environment variable is not set.");
  console.error("Generate one with: openssl rand -hex 32");
  process.exit(1);
}
const PLATFORM_TOKEN = process.env.PLATFORM_TOKEN;

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
  if (token !== PLATFORM_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!appName || !/^[a-z0-9-]+$/.test(appName)) {
    return res.status(400).json({ error: "Invalid or missing X-App-Name header. Use lowercase letters and dashes." });
  }

  if (rawVersion && !/^[a-zA-Z0-9._-]+$/.test(rawVersion)) {
    return res.status(400).json({ error: "Invalid X-App-Version header. Use letters, numbers, dots, dashes, underscores only." });
  }

  if (!req.file) {
    return res.status(400).json({ error: "No source code uploaded" });
  }

  const buildDir = `/tmp/platform-builds/${appName}-${Date.now()}`;
  const imageName = `${appName}:${appVersion}`; // CHANGED: versioned tag instead of :latest
  // Real domain via Cloudflare DNS, routed through Traefik with Let's Encrypt TLS.
  const domain = `${appName}.app.hostnsoft.com`;

  try {
    // 2. Extract the uploaded tar.gz file
    console.log(`[${appName}] Extracting code...`);
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
      console.warn(`[${appName}] Could not read package.json, defaulting to standard memory and running storage scan: ${e.message}`);
    }

    const hasRealDb = hasRealDatabaseDependency(deps);

    // NEW 2b. Reject apps that rely on window.storage BEFORE spending any
    // build time/resources on them — but only bother checking if the app
    // doesn't already have real persistence, since that's the one case
    // this check exists for. This is a hard stop, not a warning — the app
    // would break at runtime on hostnsoft otherwise, and a compatibility
    // shim was considered and rejected (it would require exposing an
    // unauthenticated public endpoint to every app's visitor traffic —
    // see project notes for that discussion).
    if (!hasRealDb) {
      const storageUsage = await detectWindowStorageUsage(buildDir);
      if (storageUsage.detected) {
        console.log(`[${appName}] Rejected: window.storage usage detected in: ${storageUsage.files.join(', ')}`);
        await fs.remove(buildDir);
        await fs.remove(req.file.path);
        return res.status(422).json({
          error: "Unsupported storage pattern detected",
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
    console.log(`[${appName}] Embedded DB detected: ${usesEmbeddedDb} -> memory = ${taskMemory}MB`);

    // 3. Build the container image using Railpack
    console.log(`[${appName}] Building image with Railpack (version: ${appVersion})...`);
    // FIXED: Railpack's CLI takes the directory as a positional arg and the
    // image tag via --name. The original `railpack build ${imageName}` treated
    // the tag itself as a directory path and always failed.
    await execPromise(`cd ${buildDir} && railpack build . --name ${imageName}`);

    // 4. Generate the Nomad Job Specification
    console.log(`[${appName}] Generating Nomad file...`);
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
    console.log(`[${appName}] Deploying to Nomad...`);
    await execPromise(`nomad job run ${nomadFilePath}`);

    // 6. Cleanup temp files
    await fs.remove(buildDir);
    await fs.remove(req.file.path);

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
    console.error(`[${appName}] Deployment failed:`, error);
    res.status(500).json({ error: "Deployment failed", details: error.message });
  }
});

// Start the API Server on port 4000
app.listen(4000, '0.0.0.0', () => {
  console.log("🚀 Platform Deployment API running on port 4000");
});
