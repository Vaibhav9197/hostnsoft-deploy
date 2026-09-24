/**
 * static-site.js
 *
 * The static fast path's on-disk state — see docs/Static-apps-req.md.
 *
 * A plain static app (build-plan.js: Railpack's "staticfile" provider)
 * is not built into an image and does not run as a Nomad job. Its files
 * are copied under STATIC_SITES_ROOT and served by the ONE shared Caddy
 * (static-server/) that server-setup.sh runs next to Traefik; Traefik
 * reaches it through a per-app router file (traefik-router-file.js).
 *
 *   $STATIC_SITES_ROOT/<appName>/
 *     manifest.json              <- THE marker that this app is static
 *     versions/<appVersion>/     <- one directory per deployed version
 *     current -> versions/<v>    <- what Caddy serves; switched atomically
 *
 * manifest.json is how every later code path — health, logs, the
 * config/rollback push, deletion — tells a static app from a Nomad job
 * without asking anyone (see app-kind.js). hostnsoft-api never sends
 * the kind; it only ever names the app by slug, and this host is the
 * source of truth for what is actually deployed, the same way the
 * existing `docker image inspect` and `nomad job status` checks are.
 *
 * Versions are kept the way images are kept for a container app: the
 * imageTag hostnsoft-api records for a static deploy is still
 * "<appName>:<appVersion>", and a rollback to it means "point `current`
 * at versions/<appVersion>" — so hostnsoft-api's rollback and
 * custom-domain pushes needed no change in shape. The retention count is
 * shared with image-retention.js for the same reason: "how far back can
 * I roll back" should have one answer, not two.
 */
'use strict';

const path = require('path');
const fs = require('fs-extra');
const logger = require('./logger');
const { IMAGE_RETAIN_COUNT } = require('./image-retention');

// Fail-fast at require-time, same convention as APP_DATA_ROOT in
// nomad-job-spec.js — server-setup.sh creates and exports this per
// environment before starting this service.
if (!process.env.STATIC_SITES_ROOT) {
  throw new Error(
    'STATIC_SITES_ROOT environment variable is not set. This is the host directory ' +
      'the shared static server (static-server/) serves plain static apps from, one ' +
      'subdirectory per app — see server-setup.sh, which creates and exports it per ' +
      'environment, and .env.example.'
  );
}
const STATIC_SITES_ROOT = process.env.STATIC_SITES_ROOT;

const MANIFEST_NAME = 'manifest.json';

// appName is validated as /^[a-z0-9-]+$/ by every caller, so it cannot
// traverse out of STATIC_SITES_ROOT. appVersion is checked HERE instead:
// X-App-Version only has to be a valid image tag ([a-zA-Z0-9._-]+), and
// "." or ".." satisfy that while naming a directory ABOVE versions/.
const VERSION_PATTERN = /^[a-zA-Z0-9._-]+$/;
function assertSafeVersion(version) {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version) || /^\.+$/.test(version)) {
    throw new Error(`Refusing to use "${version}" as a static version directory name`);
  }
}

function staticAppDir(appName) {
  return path.join(STATIC_SITES_ROOT, appName);
}
function manifestPath(appName) {
  return path.join(staticAppDir(appName), MANIFEST_NAME);
}
function versionsDir(appName) {
  return path.join(staticAppDir(appName), 'versions');
}
function versionDir(appName, version) {
  assertSafeVersion(version);
  return path.join(versionsDir(appName), version);
}
function currentLinkPath(appName) {
  return path.join(staticAppDir(appName), 'current');
}

async function readManifest(appName) {
  try {
    return await fs.readJson(manifestPath(appName));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// Written to a sibling temp file and renamed into place: a reader in
// another request (app-kind.js) sees the old manifest or the new one,
// never a half-written one.
async function writeManifest(appName, manifest) {
  const target = manifestPath(appName);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.ensureDir(path.dirname(target));
  await fs.writeJson(tmp, { ...manifest, updatedAt: new Date().toISOString() }, { spaces: 2 });
  await fs.rename(tmp, target);
}

// The kind check every other module asks: is there a manifest?
async function isStaticApp(appName) {
  return fs.pathExists(manifestPath(appName));
}

async function hasStaticVersion(appName, version) {
  try {
    return await fs.pathExists(versionDir(appName, version));
  } catch {
    // An unsafe version string is simply "not a version we have".
    return false;
  }
}

// Railpack's Caddyfile hides .git and .env* from its file server; the
// copy simply leaves them out. Symlinks are left out too — a link inside
// an upload could point anywhere on this host, and Caddy would follow it.
async function copyFilter(src) {
  const name = path.basename(src);
  if (name === '.git' || name.startsWith('.env')) return false;
  const stat = await fs.lstat(src);
  return !stat.isSymbolicLink();
}

// The atomic switch. The new link is created beside the old one and
// renamed over it, so Caddy resolves either the previous version or the
// new one for any given request, never neither. Relative target, so it
// resolves identically inside the static server's read-only mount.
async function pointCurrentAt(appName, version) {
  const link = currentLinkPath(appName);
  const tmp = `${link}.tmp-${process.pid}-${Date.now()}`;
  await fs.symlink(path.join('versions', version), tmp);
  await fs.rename(tmp, link);
}

// Publishes one deployed version: copies the site files in, switches
// `current` to them, records the version in the manifest. Redeploying an
// existing version replaces its directory, exactly as `railpack build`
// re-tagging an existing image did on the container path.
//
// The copy goes to a staging directory first and is renamed into place
// once complete. If the version being redeployed is the one `current`
// points at, its files therefore stay served for the whole copy instead
// of disappearing while it runs; the only window left is the
// remove-plus-rename below. A failed copy leaves the old files untouched.
async function publishStaticVersion({ appName, version, sourceDir, provider, spa = false }) {
  const dest = versionDir(appName, version);
  const staging = `${dest}.tmp-${process.pid}-${Date.now()}`;
  await fs.ensureDir(versionsDir(appName));
  try {
    await fs.copy(sourceDir, staging, { filter: copyFilter });
  } catch (e) {
    await fs.remove(staging).catch(() => {});
    throw e;
  }
  await fs.remove(dest);
  await fs.rename(staging, dest);

  await pointCurrentAt(appName, version);

  const manifest = (await readManifest(appName)) || { kind: 'static', appName, versions: [] };
  manifest.versions = [
    ...(manifest.versions || []).filter((v) => v.version !== version),
    { version, deployedAt: new Date().toISOString() },
  ];
  manifest.current = version;
  manifest.provider = provider;
  manifest.spa = spa;
  await writeManifest(appName, manifest);
  return manifest;
}

// Rollback / config push: re-point `current` at an already-published
// version. Callers check hasStaticVersion first, the same way the
// container path checks `docker image inspect` before a rollback, so
// this throwing is a race or a bug, not a user-facing condition.
async function switchCurrentVersion(appName, version) {
  if (!(await hasStaticVersion(appName, version))) {
    throw new Error(`Static version "${version}" of ${appName} is not on this host`);
  }
  await pointCurrentAt(appName, version);
  const manifest = await readManifest(appName);
  if (manifest) {
    manifest.current = version;
    await writeManifest(appName, manifest);
  }
}

async function updateManifest(appName, patch) {
  const manifest = await readManifest(appName);
  if (!manifest) return null;
  const updated = { ...manifest, ...patch };
  await writeManifest(appName, updated);
  return updated;
}

// Keeps as many past versions as image-retention.js keeps images, so
// "how far back can one-click rollback reach" is one answer for both
// kinds of app. Never removes the version currently being served.
async function pruneOldStaticVersions(appName) {
  const manifest = await readManifest(appName);
  if (!manifest) return;
  const newestFirst = [...(manifest.versions || [])].sort((a, b) => (a.deployedAt < b.deployedAt ? 1 : -1));
  const keep = new Set(newestFirst.slice(0, IMAGE_RETAIN_COUNT).map((v) => v.version));
  keep.add(manifest.current);
  const toDelete = newestFirst.filter((v) => !keep.has(v.version));
  if (toDelete.length === 0) return;

  for (const { version } of toDelete) {
    try {
      await fs.remove(versionDir(appName, version));
      logger.info(`[${appName}] Pruned old static version ${version} (retention: keep last ${IMAGE_RETAIN_COUNT})`);
    } catch (e) {
      logger.warn(`[${appName}] Could not prune static version ${version}: ${e.message}`);
    }
  }
  manifest.versions = newestFirst.filter((v) => keep.has(v.version));
  await writeManifest(appName, manifest);
}

// Teardown. The caller removes the app's Traefik router file FIRST, so
// Traefik has stopped sending traffic here before the files go. Removing
// a directory that was never there is fine — the delete endpoint runs
// this for every app, whichever kind it turns out to be.
async function removeStaticApp(appName) {
  await fs.remove(staticAppDir(appName));
}

// Health for a static app is "does `current` resolve to a directory" —
// there is no process to be up or down.
async function staticAppIsServing(appName) {
  try {
    const stat = await fs.stat(currentLinkPath(appName)); // follows the symlink
    return stat.isDirectory();
  } catch {
    return false;
  }
}

module.exports = {
  STATIC_SITES_ROOT,
  assertSafeVersion,
  isStaticApp,
  readManifest,
  updateManifest,
  hasStaticVersion,
  publishStaticVersion,
  switchCurrentVersion,
  pruneOldStaticVersions,
  removeStaticApp,
  staticAppIsServing,
  staticAppDir,
};
