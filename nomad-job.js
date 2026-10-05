/**
 * Exact-ID Nomad job lookups.
 *
 * The `nomad job` CLI resolves its argument by PREFIX whenever no job has
 * exactly that ID. `nomad job inspect pushpendra` with no job "pushpendra"
 * returns pushpendra-agrawal, so a free name looked taken. `nomad job stop
 * -purge demo` with only "demo111" registered stops at a "[y/N]" prompt
 * that nothing answers — the request hangs forever — and with several
 * candidates it fails outright ("Prefix matched multiple jobs"). Both
 * seen in production on 2026-09-29.
 *
 * The HTTP API's GET /v1/job/:id never prefix-matches, so every "does this
 * job exist / what is it" question goes through here. The CLI is still
 * used to stop jobs (it waits for the stop to be evaluated, which teardown
 * relies on before removing data), but only after an exact lookup has
 * confirmed the job exists — when an exact ID exists the CLI picks it
 * over any longer prefix match and never prompts.
 */

const { exec } = require('child_process');
const util = require('util');

const execPromise = util.promisify(exec);
const NOMAD_ADDR = process.env.NOMAD_ADDR || 'http://127.0.0.1:4646';

// The job with exactly this ID, or null when there is none.
async function getNomadJob(jobId) {
    const headers = process.env.NOMAD_TOKEN ? { 'X-Nomad-Token': process.env.NOMAD_TOKEN } : {};
    const res = await fetch(`${NOMAD_ADDR}/v1/job/${encodeURIComponent(jobId)}`, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Nomad GET /v1/job/${jobId} returned ${res.status}: ${await res.text()}`);
    return res.json();
}

// Stops (and optionally purges) exactly this job. Returns false, without
// running anything, when no job has this exact ID.
async function stopNomadJob(jobId, { purge = false } = {}) {
    if (!(await getNomadJob(jobId))) return false;
    await execPromise(`nomad job stop ${purge ? '-purge ' : ''}${jobId}`);
    return true;
}

module.exports = { getNomadJob, stopNomadJob };
