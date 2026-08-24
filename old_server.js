const express = require('express');
const multer = require('multer');
const tar = require('tar');
const fs = require('fs-extra');
const { exec } = require('child_process');
const path = require('path');
const util = require('util');

const execPromise = util.promisify(exec);
const app = express();

// Configure Multer to save uploaded files to a temporary folder
const upload = multer({ dest: '/tmp/platform-uploads/' });

// Basic security token (In production, use database validation)
const PLATFORM_TOKEN = "secret_agent_token_123";

app.post('/v1/deploy', upload.single('source'), async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const appName = req.headers['x-app-name'];
  
  // read version from header, fall back to a timestamp-based tag if not provided.
  // Never fall back to "latest"
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
  const imageName = `${appName}:${appVersion}`; // Local Docker tag
  const domain = `${appName}.app.103.27.235.146.sslip.io`; // Your dynamic domain

  try {
    // 2. Extract the uploaded tar.gz file
    console.log(`[${appName}] Extracting code...`);
    await fs.ensureDir(buildDir);
    await tar.x({
      file: req.file.path,
      cwd: buildDir
    });

    // 3. Build the container image using Railpack (or Docker)
    console.log(`[${appName}] Building image with Railpack with version: ${appVersion}`);
    // Assuming 'railpack' is installed globally on the server. 
    // If not, you can replace this with a standard 'docker build' command if needed.
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
    service {
      name     = "${appName}"
      provider = "nomad"
      port     = "http"
      tags = [
        "traefik.enable=true",
        "traefik.http.routers.${appName}.rule=Host(\`${domain}\`)",
        "traefik.http.routers.${appName}.entrypoints=web"
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
        PORT = "\${NOMAD_PORT_http}"
	APP_NAME = "${appName}"
	APP_VERSION = "${appVersion}"
      }
      resources {
        cpu    = 100
        memory = 128
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
      url: `http://${domain}`
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
