/**
 * Is an app's image still on this host?
 *
 * App images are built locally and pushed to no registry, and job specs
 * use force_pull=false — so a missing image is unrecoverable, and Nomad
 * reports it as `pull access denied`, which looks like a credentials
 * problem and is not.
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// Every task's image, not just the app's own: an orphan deploy also runs
// the banner sidecar, and a missing sidecar image fails the alloc too.
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

/** Returns the images NOT present locally — empty means all present. */
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
