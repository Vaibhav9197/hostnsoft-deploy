/**
 * rename-app.js — move a deployed app from one name to another.
 *
 * The app name is this service's only identifier; there is no project id
 * anywhere on this side. It is simultaneously the Nomad job name, the
 * Traefik router/service/middleware names, the hostname, the Docker image
 * repository, the host data directory bind-mounted at /data, the
 * APP_NAME in the container's env, and the app_name column in the
 * analytics tables. So a rename is a migration, not an update, and every
 * one of those has to move together or the app comes back wrong.
 *
 * Why this couldn't reuse anything that already exists:
 *   - POST /internal/apps/:appName/config under a new name would register
 *     a SECOND Nomad job, bind-mounted at a brand-new EMPTY data
 *     directory (buildNomadJobSpec defaults appDataPath from appName),
 *     while the old job kept running and serving. For any app with an
 *     embedded database that is silent data loss, which is the single
 *     worst outcome available here.
 *   - DELETE /internal/apps/:appName removes the data directory and every
 *     image, so it cannot be used to clear the old name afterwards.
 *
 * ORDERING. Two rules drive the sequence below, and both are the
 * expensive-to-learn kind:
 *
 *   1. The data directory moves while NOTHING is running. Moving a bind
 *      mount out from under a live container is how you corrupt a
 *      database rather than move one — the same reason
 *      DELETE /internal/apps/:appName removes it only after the job stop.
 *   2. The old job is purged only once the NEW hostname actually serves a
 *      real certificate. The platform zone has no wildcard cert: verified
 *      2026-09-18 against Certificate Transparency and a live handshake,
 *      every app holds its own single-name Let's Encrypt cert. So the new
 *      hostname needs a fresh ACME order, and until it completes Traefik
 *      answers with its self-signed default — a hard browser warning. If
 *      we purged first and issuance then failed or hit a rate limit, the
 *      old address would already be gone and the new one unusable,
 *      possibly for days. Purging last means the worst case is a failed
 *      rename we can roll back, not a dead app.
 *
 * Everything before the job stop is a check. Everything after it is
 * undoable, and `rollback` below undoes it in reverse.
 *
 * NOT HANDLED HERE: a deploy landing on either name while a rename is in
 * flight. There is no cross-process lock in this service — deploys have
 * never had one either — and the window is minutes, so the case is real
 * rather than theoretical. It is left to the caller: hostnsoft-api
 * refuses a rename while that project has a deployment in progress, and
 * it is the only thing that issues renames. Worth revisiting if renames
 * ever become self-service for agents, because a deploy arriving between
 * the stop and the new job's run would find the old job stopped and
 * `purgeIfNotRunning` (server.js) would purge it out from under the
 * rollback path.
 */
const fs = require('fs-extra');
const path = require('path');
const tls = require('tls');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const logger = require('./logger');
const { buildNomadJobSpec, defaultDomainFor, appDataPathFor, specPathFor } = require('./nomad-job-spec');
const { imagesFromSpec, missingImages } = require('./scale-to-zero-images');
const scaleToZero = require('./scale-to-zero-registry');
const { getDb, isAnalyticsEnabled } = require('./analytics/db');

const APP_NAME_PATTERN = /^[a-z0-9-]+$/;

// How long to wait for the new hostname to answer with a real
// certificate before giving up and rolling back. A DNS-01 order against
// Cloudflare is the slow part (propagation, then issuance), so this is
// minutes rather than seconds.
const CERT_WAIT_MS = Number(process.env.RENAME_CERT_WAIT_MS) || 60000;
const CERT_POLL_MS = Number(process.env.RENAME_CERT_POLL_MS) || 5000;

// Traefik's placeholder, served for any hostname it has no certificate
// for. Matching on it is how we tell "ACME finished" from "ACME hasn't
// finished yet" without needing access to Traefik's own ACME store,
// which is root-owned and outside this repo.
const TRAEFIK_DEFAULT_CERT_CN = 'TRAEFIK DEFAULT CERT';

class RenameError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Is this a hardcoded seed app?
 *
 * Seed apps are frozen in source code in scale-to-zero-apps.js with
 * priority 500 routers and cannot be renamed dynamically without
 * code changes. Normal customer apps under universal mode CAN be renamed.
 */
function isScaleToZeroApp(appName) {
  return scaleToZero.isSeedApp(appName);
}

/**
 * Returns { spec, raw } or null when the job isn't registered. `raw` is
 * kept verbatim because it is what rollback re-runs: `nomad job inspect`
 * emits `{"Job": {...}}`, which is exactly the API-format document
 * `nomad job run -json` reads back. Re-running the job's own spec is the
 * only way to restart a stopped job — there is no `nomad job start`.
 */
async function jobInspect(appName) {
  try {
    const { stdout } = await execPromise(`nomad job inspect ${appName}`);
    return { spec: JSON.parse(stdout), raw: stdout };
  } catch {
    return null; // not registered
  }
}

/**
 * Every local image tagged for this app, as "<repo>:<tag>". The rename
 * has to carry all of them, not just the running one: rollback on the
 * hostnsoft-api side can ask for any past imageTag, and image retention
 * and teardown both look images up by the app's CURRENT name. An image
 * left behind under the old name is unreachable by both — it can never
 * be rolled back to and never be cleaned up.
 */
async function imageTagsFor(appName) {
  const { stdout } = await execPromise(
    `docker images --filter=reference=${appName}:* --format "{{.Repository}}:{{.Tag}}"`
  );
  return stdout.split('\n').map((t) => t.trim()).filter(Boolean);
}

/**
 * Does `host` answer TLS with a real certificate yet?
 *
 * Connects to the local edge with SNI rather than resolving the hostname:
 * the answer we want is "has Traefik got a cert for this name", and going
 * out through public DNS to come back to the same box only adds ways to
 * get a misleading answer.
 */
function servesRealCertificate(host, port, connectHost = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = tls.connect(
      {
        host: connectHost,
        port,
        servername: host,
        // The cert is very likely untrusted at this instant (that is what
        // we are testing), so validation must not abort the handshake —
        // we inspect the presented cert ourselves below.
        rejectUnauthorized: false,
        timeout: 10000,
      },
      () => {
        const cert = socket.getPeerCertificate();
        const cn = cert?.subject?.CN || '';
        const isDefault = cn.toUpperCase().includes(TRAEFIK_DEFAULT_CERT_CN);
        // tls.checkServerIdentity returns undefined if the host matches the cert (including wildcards)
        const covers = !tls.checkServerIdentity(host, cert);
        socket.end();
        resolve(!isDefault && covers);
      }
    );
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

async function waitForCertificate(host, { edgePort, deadlineMs, onProgress }) {
  const until = Date.now() + deadlineMs;
  let attempt = 0;
  while (Date.now() < until) {
    attempt += 1;
    if (await servesRealCertificate(host, edgePort)) return true;
    if (onProgress) onProgress(attempt, Math.max(0, until - Date.now()));
    await new Promise((r) => setTimeout(r, CERT_POLL_MS));
  }
  return false;
}

/**
 * Save the NEW job's spec where the activator looks for it.
 *
 * Deploys do this via server.js's saveJobSpec after every `nomad job run`;
 * the rename path runs its own and so has to do the same. Without it the
 * new name has no spec, and two things quietly degrade: hostnamesFor()
 * falls back to the default domain alone, dropping the wake router for any
 * custom domain, and activator.js cannot wake the app at all once Nomad
 * has garbage-collected the stopped job.
 *
 * Best-effort with a loud warning, matching saveJobSpec: the app is live
 * either way, and the cost is a cold start that fails rather than an
 * outage now.
 */
async function carrySavedJobSpec(oldName, newName) {
  try {
    const { stdout } = await execPromise(`nomad job inspect ${newName}`);
    const parsed = JSON.parse(stdout);
    if (!parsed.Job || parsed.Job.ID !== newName) throw new Error('inspect returned no matching Job');
    const dest = specPathFor(newName);
    await fs.ensureDir(path.dirname(dest));
    await fs.writeFile(dest, stdout);
  } catch (e) {
    logger.warn(`[${newName}] Could not save Nomad job spec (scale-to-zero wake would fail): ${e.message}`);
  }
  // The old one describes a job that no longer exists, at exactly the path
  // the activator reads — the same reason DELETE removes it.
  await fs.remove(specPathFor(oldName)).catch((e) =>
    logger.warn(`[${oldName}] Could not remove the old saved job spec: ${e.message}`)
  );
}

/**
 * Move scale-to-zero's snapshots of the app's data directory onto the new
 * name.
 *
 * These are full copies of the app's own data, and the freed name can be
 * claimed by anyone — the same exposure carryAnalyticsHistory closes for
 * traffic metrics, except these are the files themselves. Moved rather
 * than deleted: they are the only copy of pre-stop state.
 */
async function carrySnapshots(oldName, newName) {
  const from = `${appDataPathFor('.snapshots')}/${oldName}`;
  const to = `${appDataPathFor('.snapshots')}/${newName}`;
  try {
    if (await fs.pathExists(from)) {
      await fs.move(from, to, { overwrite: false });
      logger.info(`[${newName}] Moved scale-to-zero snapshots over from "${oldName}"`);
    }
  } catch (e) {
    logger.warn(
      `[${newName}] Could not move snapshots from ${from} to ${to} (continuing; they stay under the old name): ${e.message}`
    );
  }
}

/**
 * Carry the scale-to-zero registry entry onto the new name.
 *
 * renameApp refuses eligible apps outright, so in allowlist mode there is
 * usually nothing here. In universal mode there can be: an opt-OUT is a
 * recorded entry, not an absence, and an app that opted out is not
 * eligible and so is not refused above. Losing that entry to a rename
 * would read as "never asked", and universal mode would put the app to
 * sleep against its owner's explicit request.
 */
async function carryScaleToZeroEntry(oldName, newName) {
  try {
    const result = await scaleToZero.rekey(oldName, newName);
    if (result) {
      logger.info(`[${newName}] Carried the scale-to-zero registry entry over from "${oldName}"`);
    } else {
      // In universal mode, app had no explicit apps.json entry,
      // but Traefik fallback routers still need to be updated.
      await scaleToZero.regenerateRouters();
      logger.info(`[${newName}] Regenerated scale-to-zero fallback routers`);
    }
  } catch (e) {
    logger.warn(`[${newName}] Could not update scale-to-zero routers: ${e.message}`);
  }
}

/**
 * Move this app's analytics history onto the new name.
 *
 * Both tables key rows by a bare `app_name` string with no company
 * scoping, and retention keeps them for ANALYTICS_RETENTION_DAYS (100 by
 * default). So this is not only about the owner keeping their graphs. If
 * the rows stayed under the old name, whoever claims that freed name
 * next — any company, since app names are first-come platform-wide —
 * would inherit the previous owner's traffic volumes, latency
 * percentiles and top request paths. Rewriting is what closes that, and
 * it is the same reason `docker rmi` of the old tags happens above.
 *
 * Best-effort and last: analytics is additive, and the app is already
 * live under the new name by the time this runs. Losing a graph is not a
 * reason to fail a rename that has otherwise completed.
 */
function carryAnalyticsHistory(oldName, newName) {
  if (!isAnalyticsEnabled()) return;
  try {
    const db = getDb();
    for (const table of ['request_log', 'resource_sample']) {
      const result = db.prepare(`UPDATE ${table} SET app_name = ? WHERE app_name = ?`).run(newName, oldName);
      logger.info(`[${newName}] Carried ${result.changes ?? 0} ${table} row(s) over from "${oldName}"`);
    }
  } catch (e) {
    logger.warn(
      `[${newName}] Could not move analytics history from "${oldName}" (continuing; old rows stay under the old name): ${e.message}`
    );
  }
}

/**
 * Move an app to a new name.
 *
 * `config` carries what the job spec needs and this side does not store:
 * hostnsoft-api owns the app's memory, custom domains and env vars, and
 * passes them exactly as it already does for the config-push endpoint.
 * Re-deriving them from the old job spec instead would quietly resurrect
 * whatever was live at the last deploy, which is not the same thing.
 */
async function renameApp(oldName, newName, config = {}) {
  if (!APP_NAME_PATTERN.test(oldName) || !APP_NAME_PATTERN.test(newName)) {
    throw new RenameError('invalid_app_name', 'App names may contain only lowercase letters, digits and hyphens.');
  }
  if (oldName === newName) {
    throw new RenameError('invalid_app_name', 'The new name is the same as the current one.');
  }
  if (await isScaleToZeroApp(oldName)) {
    throw new RenameError(
      'app_not_renameable',
      'This app takes part in scale-to-zero. Its fallback router and allowlist entries are fixed infrastructure and must be moved by hand first.'
    );
  }

  // --- Checks. Nothing below this block has changed anything yet. ---

  if (await jobInspect(newName)) {
    throw new RenameError('app_name_taken', `A Nomad job named "${newName}" already exists on this host.`);
  }

  const oldDataDir = appDataPathFor(oldName);
  const newDataDir = appDataPathFor(newName);
  if (await fs.pathExists(newDataDir)) {
    throw new RenameError(
      'app_name_taken',
      `A data directory for "${newName}" already exists on this host. Refusing to deploy over someone else's data.`
    );
  }

  const existing = await jobInspect(oldName);
  if (!existing) {
    throw new RenameError('app_not_found', `No Nomad job named "${oldName}" on this host.`);
  }

  // If the images backing this app are already gone, the new job could
  // never start (built locally, pushed to no registry, force_pull=false)
  // and we would have stopped a working app to find out. Same lesson as
  // the rollback path's up-front `docker image inspect`.
  const missing = await missingImages(imagesFromSpec(existing.spec));
  if (missing.length) {
    throw new RenameError(
      'image_unavailable',
      `Image(s) no longer on this host: ${missing.join(', ')}. This app cannot be moved.`
    );
  }

  const imageTag = config.imageTag;
  if (!imageTag || !imageTag.includes(':')) {
    throw new RenameError('invalid_config', 'imageTag is required and must be a full "name:version" reference.');
  }
  const appVersion = imageTag.slice(imageTag.indexOf(':') + 1);
  const renamedImageTag = `${newName}:${appVersion}`;

  const steps = { retagged: [], stopped: false, moved: false, newJobRan: false };

  async function rollback(reason) {
    logger.error(`[${oldName}] Rename to "${newName}" failed (${reason}) — rolling back`);
    if (steps.newJobRan) {
      await execPromise(`nomad job stop -purge ${newName}`).catch((e) =>
        logger.error(`[${newName}] Rollback: could not purge the new job: ${e.message}`)
      );
    }
    if (steps.moved) {
      await fs.move(newDataDir, oldDataDir, { overwrite: false }).catch((e) =>
        // The one failure worth shouting about: the app's data is now
        // under a name nothing points at. Nothing has DELETED it, so it
        // is recoverable by hand, and saying exactly where it is matters
        // more than any other line this module logs.
        logger.error(
          `[${oldName}] ROLLBACK INCOMPLETE — app data is still at ${newDataDir} and must be moved back to ${oldDataDir} by hand: ${e.message}`
        )
      );
    }
    if (steps.stopped) {
      // There is no `nomad job start`. The old job was stopped rather
      // than purged precisely so its own spec — captured before any of
      // this began — can simply be re-run, which clears the stop and
      // brings the app back exactly as it was.
      const restorePath = `/tmp/platform-builds/${oldName}-rollback-${Date.now()}.json`;
      try {
        await fs.ensureDir(path.dirname(restorePath));
        await fs.writeFile(restorePath, existing.raw);
        await execPromise(`nomad job run -json ${restorePath}`);
        await fs.remove(restorePath).catch(() => { });
        logger.info(`[${oldName}] Rollback: restarted under its original name`);
      } catch (e) {
        logger.error(
          `[${oldName}] ROLLBACK INCOMPLETE — the app is STOPPED and could not be restarted automatically. ` +
          `Its spec is saved at ${restorePath}; run \`nomad job run -json ${restorePath}\` to bring it back: ${e.message}`
        );
      }
    }
    for (const tag of steps.retagged) {
      await execPromise(`docker rmi -f ${tag}`).catch(() => { });
    }
  }

  try {
    // --- 1. Retag images FIRST. Cheap, additive, and reversible: the
    // old tags stay, so nothing is at risk yet, and doing it before the
    // stop keeps the window where the app is down as short as possible.
    for (const tag of await imageTagsFor(oldName)) {
      const version = tag.slice(tag.indexOf(':') + 1);
      const target = `${newName}:${version}`;
      await execPromise(`docker tag ${tag} ${target}`);
      steps.retagged.push(target);
    }
    logger.info(`[${oldName}] Retagged ${steps.retagged.length} image(s) as "${newName}:*"`);

    // --- 2. Stop the old job. Not purged: its spec stays registered so
    // rollback can bring it straight back.
    await execPromise(`nomad job stop ${oldName}`);
    steps.stopped = true;
    logger.info(`[${oldName}] Stopped, ready to move data`);

    // --- 3. Move the data directory, with nothing running against it.
    if (await fs.pathExists(oldDataDir)) {
      await fs.move(oldDataDir, newDataDir, { overwrite: false });
      steps.moved = true;
      logger.info(`[${oldName}] Moved data directory to ${newDataDir}`);
    } else {
      // Nothing to move — an app that has never written anything. Create
      // it so the new job's bind mount has a directory to point at, with
      // the same permissions ensureAppDataDir would give it.
      await fs.ensureDir(newDataDir);
      await fs.chmod(newDataDir, 0o777);
    }

    // --- 4. Run the app under its new name.
    const domain = defaultDomainFor(newName);
    const nomadJobSpec = buildNomadJobSpec({
      appName: newName,
      domain,
      imageName: renamedImageTag,
      appVersion,
      taskMemory: config.taskMemory,
      schedulingFloorMb: config.schedulingFloorMb,
      customDomains: config.customDomains || [],
      envVars: config.envVars || [],
    });
    const nomadFilePath = `/tmp/platform-builds/${newName}-rename-${Date.now()}.nomad`;
    await fs.ensureDir(path.dirname(nomadFilePath));
    await fs.writeFile(nomadFilePath, nomadJobSpec);
    await execPromise(`nomad job run ${nomadFilePath}`);
    steps.newJobRan = true;
    await fs.remove(nomadFilePath).catch(() => { });
    logger.info(`[${newName}] Running under the new name`);

    // --- 5. Wait for a real certificate before destroying the old name.
    const edgePort = Number(process.env.EDGE_HTTPS_PORT) || 443;
    const gotCert = await waitForCertificate(domain, {
      edgePort,
      deadlineMs: CERT_WAIT_MS,
      onProgress: (attempt, remaining) => {
        if (attempt % 6 === 0) {
          logger.info(`[${newName}] Still waiting for a certificate for ${domain} (${Math.round(remaining / 1000)}s left)`);
        }
      },
    });
    if (!gotCert) {
      throw new RenameError(
        'certificate_timeout',
        `${domain} did not get a certificate within ${Math.round(CERT_WAIT_MS / 1000)}s. The app has been put back under its old name.`
      );
    }
    logger.info(`[${newName}] Certificate issued for ${domain}`);

    // --- 6. Point of no return. The old name goes away here.
    await execPromise(`nomad job stop -purge ${oldName}`).catch((e) =>
      // Not fatal: the app is already live and certificated under the new
      // name, so failing the whole rename now would be worse than a
      // leftover stopped job. Loud, because it does need cleaning up.
      logger.error(`[${oldName}] Could not purge the old job after a successful rename — clean up by hand: ${e.message}`)
    );

    // Old image tags, now that nothing refers to them. The renamed copies
    // share the same layers, so this frees no space by itself; it stops
    // the old names lingering where retention will never look again.
    for (const tag of await imageTagsFor(oldName)) {
      await execPromise(`docker rmi -f ${tag}`).catch((e) =>
        logger.warn(`[${oldName}] Could not remove old image tag ${tag}: ${e.message}`)
      );
    }

    // The remaining per-app state that is keyed by name. All best-effort
    // and all after the point of no return: the app is live and
    // certificated under the new name, and none of these is worth failing
    // a completed rename over. Each logs loudly enough to be fixed by hand.
    await carrySavedJobSpec(oldName, newName);
    await carrySnapshots(oldName, newName);
    await carryScaleToZeroEntry(oldName, newName);
    carryAnalyticsHistory(oldName, newName);

    return { renamed: true, from: oldName, to: newName, imageTag: renamedImageTag, domain };
  } catch (error) {
    await rollback(error.message);
    throw error;
  }
}

// servesRealCertificate is exported for the certificate check to be
// exercised on its own: it is the one thing here that decides when the
// OLD name may be destroyed, and it is not otherwise reachable without a
// full rename against live Nomad.
module.exports = { renameApp, RenameError, isScaleToZeroApp, servesRealCertificate };
