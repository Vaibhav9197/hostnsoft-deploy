/**
 * image-registry.js
 *
 * Copies every freshly built image into the host's local registry
 * (server-setup.md#image-registry). This service deletes an app's source
 * after each build, so the image is the only copy of the app there is —
 * the registry is where that copy stops depending on one Docker daemon.
 *
 * Write-only for now: nothing pulls from the registry, job specs still
 * reference the local tag. So a push must never cost a deploy anything —
 * it runs after the deploy has succeeded, is not awaited by it, and every
 * failure is logged and swallowed. Unset REGISTRY_ADDR skips it entirely.
 */
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const logger = require('./logger');

const REGISTRY_ADDR = process.env.REGISTRY_ADDR || '';

// A push over loopback is seconds; this only bounds a wedged registry.
const PUSH_TIMEOUT_MS = process.env.REGISTRY_PUSH_TIMEOUT_MS
  ? parseInt(process.env.REGISTRY_PUSH_TIMEOUT_MS, 10)
  : 10 * 60 * 1000;

// Never rejects. `imageName` is the local `<app>:<version>` tag.
async function pushToRegistry(appName, imageName) {
  if (!REGISTRY_ADDR) return;
  const remoteTag = `${REGISTRY_ADDR}/${imageName}`;
  try {
    await execPromise(`docker tag ${imageName} ${remoteTag}`);
    await execPromise(`docker push ${remoteTag}`, { timeout: PUSH_TIMEOUT_MS });
    logger.info(`[${appName}] Pushed ${imageName} to registry ${REGISTRY_ADDR}`);
  } catch (e) {
    logger.warn(`[${appName}] Registry push of ${imageName} failed (deploy unaffected): ${e.message}`);
  } finally {
    // Only the extra tag, never the image: the local <app>:<version> tag
    // still holds it. Left in place, these tags would escape
    // image-retention.js (it matches `<app>:*`) and pin every build's
    // layers on disk forever.
    await execPromise(`docker rmi ${remoteTag}`).catch(() => {});
  }
}

module.exports = { pushToRegistry, REGISTRY_ADDR };
