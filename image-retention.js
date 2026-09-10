/**
 * image-retention.js
 *
 * Keeps only the N most recently built local images for an app, deleting
 * older ones — bounds disk usage on a host that never pushes images to a
 * registry (every build lives here forever otherwise), while guaranteeing
 * one-click rollback (POST /internal/apps/:appName/config, see server.js)
 * always has up to N past versions to roll back to.
 *
 * Deliberately separate from the wildcard `docker rmi` in
 * DELETE /internal/apps/:appName (orphan expiry / project deletion) —
 * that one deletes EVERYTHING because the whole app is being torn down,
 * not retained. This one runs after every successful deploy, for every
 * app, orphan or not.
 */
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const logger = require('./logger');

// Same soft-override pattern as every other tunable-with-a-default in
// this codebase (see e.g. ORPHAN_TTL_MS in hostnsoft-api).
const IMAGE_RETAIN_COUNT = process.env.IMAGE_RETAIN_COUNT
  ? parseInt(process.env.IMAGE_RETAIN_COUNT, 10)
  : 5;

// docker images' own --format CreatedAt string ("2026-09-10 10:15:22
// +0000 UTC") doesn't parse reliably with JS Date() across Node/OS
// versions — docker inspect's `.Created` is full RFC3339Nano
// ("2026-09-10T10:15:22.123456789Z"), which Date() always parses
// correctly. Worth the extra exec per image; the list being pruned is
// always small (bounded by how many versions of one app exist).
async function getImageCreatedAt(tag) {
  const { stdout } = await execPromise(`docker inspect -f "{{.Created}}" ${tag}`);
  return new Date(stdout.trim());
}

async function pruneOldImages(appName) {
  let stdout;
  try {
    ({ stdout } = await execPromise(
      `docker images --filter=reference=${appName}:* --format "{{.Repository}}:{{.Tag}}"`
    ));
  } catch (e) {
    logger.warn(`[${appName}] Could not list images for retention check (skipping): ${e.message}`);
    return;
  }

  const tags = stdout.split('\n').map((t) => t.trim()).filter(Boolean);
  if (tags.length <= IMAGE_RETAIN_COUNT) return;

  const withDates = [];
  for (const tag of tags) {
    try {
      withDates.push({ tag, createdAt: await getImageCreatedAt(tag) });
    } catch (e) {
      // Couldn't inspect this one specific tag — skip it rather than
      // fail the whole retention pass over one bad entry.
      logger.warn(`[${appName}] Could not inspect image "${tag}" for retention (skipping it): ${e.message}`);
    }
  }
  withDates.sort((a, b) => b.createdAt - a.createdAt);

  const toDelete = withDates.slice(IMAGE_RETAIN_COUNT);
  for (const { tag } of toDelete) {
    try {
      await execPromise(`docker rmi -f ${tag}`);
      logger.info(`[${appName}] Pruned old image ${tag} (retention: keep last ${IMAGE_RETAIN_COUNT})`);
    } catch (e) {
      // Best-effort — a stuck/in-use old image is a disk-usage annoyance,
      // never a reason to fail the deploy that triggered this.
      logger.warn(`[${appName}] Could not prune old image ${tag}: ${e.message}`);
    }
  }
}

module.exports = { pruneOldImages, IMAGE_RETAIN_COUNT };
