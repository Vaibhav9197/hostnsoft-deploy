/**
 * footer-flag.js — the per-app switch for the "hosted on Embarko" footer.
 *
 * A container app on the free plan (or orphaned) runs behind the
 * orphan-proxy sidecar, which injects the footer. The sidecar re-reads
 * $APP_DATA_ROOT/.footer/<app>/show ("1" or "0") every few seconds, so a
 * plan change only has to rewrite that file: no job change, no restart.
 *
 * The flag can only do that for a job whose sidecar was started with the
 * mount (footerSwitchState below). A job without a sidecar — deployed
 * while the company was paying — has nothing to read it, and neither does
 * a sidecar from before this file existed. Those need one config push,
 * which hostnsoft-api falls back to when told so.
 *
 * Static apps have no sidecar of their own; their footer is the
 * X-Embarko-Footer header in their router file (traefik-router-file.js).
 */
const fs = require('fs-extra');
const path = require('path');

const { footerFlagDirFor, specPathFor } = require('./nomad-job-spec');
const { getNomadJob } = require('./nomad-job');

const SIDECAR_TASK = 'orphan-proxy';

function footerFlagPath(appName) {
  return path.join(footerFlagDirFor(appName), 'show');
}

// Written to a temp file and renamed, so the sidecar never reads a
// half-written value. Safe to call on every deploy and config push.
async function writeFooterFlag(appName, show) {
  const target = footerFlagPath(appName);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.ensureDir(path.dirname(target));
  await fs.writeFile(tmp, show ? '1' : '0');
  await fs.rename(tmp, target);
}

async function removeFooterFlag(appName) {
  await fs.remove(footerFlagDirFor(appName));
}

// The job spec the app runs (or will run, once woken): the live one from
// Nomad, else the copy saved for scale-to-zero, which is what the
// activator runs to wake a stopped app. Exact-ID lookup (nomad-job.js):
// the CLI's prefix matching would answer for "demo111" when asked about
// "demo".
async function currentJobSpec(appName) {
  const live = await getNomadJob(appName);
  if (live) return live;
  try {
    return (await fs.readJson(specPathFor(appName))).Job;
  } catch {
    return null;
  }
}

/**
 * Whether rewriting the flag alone changes what visitors see.
 *   "switchable" — the sidecar is running with the flag mounted
 *   "no_sidecar" — no footer at all; turning it ON needs a config push
 *   "unmounted"  — a sidecar from before the flag existed; needs a push
 *   "no_job"     — nothing on this host to switch
 */
async function footerSwitchState(appName) {
  const job = await currentJobSpec(appName);
  if (!job) return 'no_job';
  const tasks = (job.TaskGroups || []).flatMap((g) => g.Tasks || []);
  const sidecar = tasks.find((t) => t.Name === SIDECAR_TASK);
  if (!sidecar) return 'no_sidecar';
  return sidecar.Env && sidecar.Env.FOOTER_FLAG_FILE ? 'switchable' : 'unmounted';
}

module.exports = { writeFooterFlag, removeFooterFlag, footerSwitchState };
