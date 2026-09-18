/**
 * scale-to-zero-images.js — is an app's image still on this host?
 *
 * Shared by idle-report.js (don't stop what you can't restart) and
 * activator.js (fail clearly instead of letting Nomad fail obscurely).
 *
 * Why this check has to exist at all: app images are built locally by
 * railpack and pushed to NO registry, and job specs set
 * force_pull = false. So "the image is missing" is unrecoverable, and
 * Nomad reports it as `pull access denied for <app>, repository does not
 * exist or may require 'docker login'` — which reads like a registry
 * credentials problem and sends you looking in entirely the wrong place.
 * server.js already learned this on the rollback path; same lesson here.
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

/**
 * Pull every task image out of a `nomad job inspect` payload
 * ({ Job: { TaskGroups: [ { Tasks: [ { Config: { image } } ] } ] } }).
 * All of them, not just the app's own: an orphan deploy also runs the
 * orphan-banner-proxy sidecar, and a missing sidecar image fails the
 * allocation just as completely as a missing app image.
 */
function imagesFromSpec(spec) {
  const images = [];
  for (const group of spec?.Job?.TaskGroups || []) {
    for (const task of group.Tasks || []) {
      const image = task?.Config?.image;
      if (image) images.push(image);
    }
  }
  return images;
}

/** Returns the images that are NOT present locally — empty means all present. */
async function missingImages(images) {
  const missing = [];
  for (const image of images) {
    try {
      await execFileAsync('docker', ['image', 'inspect', image]);
    } catch {
      missing.push(image);
    }
  }
  return missing;
}

module.exports = { imagesFromSpec, missingImages };
