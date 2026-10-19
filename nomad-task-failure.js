/**
 * nomad-task-failure.js
 *
 * Explains WHY an app's container is not running, from Nomad's own
 * records: the latest allocation's task events (exit code, restart count,
 * "Not Restarting" verdict) plus the tail of the task's stderr/stdout.
 *
 * Two callers, with different audiences:
 *   - server.js, when `nomad job run` fails: the app OWNER gets the full
 *     picture, log lines included, as the deploy's errorDetail. Before
 *     this, the only message was "Command failed: nomad job run ...",
 *     which named the symptom and nothing else (groupcart, attendanceerp,
 *     danikjeevi, safeshare — four orphan deploys whose containers exited
 *     at startup, undiagnosable from the deploy response, 2026-10-19).
 *   - activator.js, when a wake times out: a PUBLIC visitor gets the
 *     exit code and a plain sentence, never the log tail — an app's
 *     output can carry secrets, and the visitor is not its owner.
 *
 * Read-only against Nomad's HTTP API. Every lookup is best-effort: a
 * failure to diagnose returns null and the caller falls back to the
 * message it would have shown anyway.
 */
'use strict';

const NOMAD_ADDR = process.env.NOMAD_ADDR || 'http://127.0.0.1:4646';

// Bounded: this runs inside a visitor's request in the activator and
// after an already-failed deploy in server.js — neither should wait on a
// slow Nomad for long.
const FETCH_TIMEOUT_MS = 4000;

async function nomadFetch(path, { text = false } = {}) {
    const res = await fetch(`${NOMAD_ADDR}${path}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Nomad ${path} -> ${res.status}`);
    return text ? res.text() : res.json();
}

/**
 * Which allocation tells the story. Not simply the newest: after a crash
 * Nomad reschedules (a fresh pending alloc with no exit yet), and
 * auto_revert places the PREVIOUS version, as a newer job version, right
 * as the deploy fails — either would hide the crash. And an old failed
 * alloc (a stale canary from weeks ago) must not be blamed for a wake
 * or deploy that failed before placing anything.
 *
 * So: only allocs created at or after `sinceMs` (the moment the caller
 * started its deploy / wake); among them, the newest whose task has
 * exited; else the newest. None in the window -> null, and the caller
 * keeps its generic message.
 */
function pickAllocation(allocs, task, sinceMs = 0) {
    if (!Array.isArray(allocs) || allocs.length === 0) return null;
    const sinceNs = sinceMs * 1e6;
    const recent = allocs.filter((a) => (a.CreateTime || 0) >= sinceNs);
    if (recent.length === 0) return null;
    recent.sort((a, b) => (b.CreateIndex || 0) - (a.CreateIndex || 0));
    const exited = recent.find((a) => {
        const ts = a.TaskStates && a.TaskStates[task];
        return ts && Array.isArray(ts.Events) && ts.Events.some((e) => e.Type === 'Terminated');
    });
    return exited || recent[0];
}

async function latestAllocation(jobId, task, sinceMs) {
    const allocs = await nomadFetch(`/v1/job/${encodeURIComponent(jobId)}/allocations`);
    return pickAllocation(allocs, task, sinceMs);
}

// Nomad's log endpoint 404s once the allocation is garbage-collected
// from the client, and returns a JSON error body (not plain text) for
// some failures; both read as "no log" here.
async function logTail(allocId, task, stream, tailBytes) {
    try {
        const out = await nomadFetch(
            `/v1/client/fs/logs/${allocId}?task=${encodeURIComponent(task)}&type=${stream}&origin=end&offset=${tailBytes}&plain=true`,
            { text: true },
        );
        const trimmed = String(out || '').trim();
        return trimmed.length > 0 ? trimmed : null;
    } catch {
        return null;
    }
}

/**
 * Describe the relevant allocation's `task` (see pickAllocation; `since`
 * is a ms epoch, allocations created before it are ignored). Resolves to
 * null when there is no such allocation, the task is not in it, or Nomad
 * cannot be reached.
 *
 *   {
 *     allocId, state ('pending'|'running'|'dead'), failed (bool),
 *     restarts, exitCode (number|null), oomKilled (bool),
 *     signal (string|null), lastEvent (Nomad's DisplayMessage|null),
 *     notRestarting (bool), stderr (string|null), stdout (string|null),
 *   }
 */
async function describeTaskFailure(jobId, { task = 'server', tailBytes = 4000, withLogs = true, since = 0 } = {}) {
    let alloc;
    try {
        alloc = await latestAllocation(jobId, task, since);
    } catch {
        return null;
    }
    const ts = alloc && alloc.TaskStates && alloc.TaskStates[task];
    if (!ts) return null;

    const events = Array.isArray(ts.Events) ? ts.Events : [];
    const terminated = events.filter((e) => e.Type === 'Terminated');
    const last = terminated.length > 0 ? terminated[terminated.length - 1] : null;
    const notRestarting = events.some((e) => e.Type === 'Not Restarting');
    const lastEvent = events.length > 0 ? events[events.length - 1].DisplayMessage || null : null;

    const out = {
        allocId: alloc.ID,
        state: ts.State,
        failed: Boolean(ts.Failed),
        restarts: ts.Restarts || 0,
        exitCode: last && typeof last.ExitCode === 'number' ? last.ExitCode : null,
        oomKilled: Boolean(last && last.OOMKilled),
        signal: last && last.Signal ? String(last.Signal) : null,
        lastEvent,
        notRestarting,
        stderr: null,
        stdout: null,
    };
    if (withLogs) {
        [out.stderr, out.stdout] = await Promise.all([
            logTail(alloc.ID, task, 'stderr', tailBytes),
            logTail(alloc.ID, task, 'stdout', tailBytes),
        ]);
    }
    return out;
}

// True only when Nomad itself marked the task failed AND its process
// exited. A clean stop (scale-to-zero) also leaves a dead task with an
// exit code, but Failed stays false there, so it is not a crash.
function isCrash(d) {
    if (!d) return false;
    const exited = d.exitCode !== null || d.oomKilled;
    return exited && d.failed;
}

// One sentence on what the exit means, for the cases that have a known
// reading. Null otherwise.
function exitHint(d) {
    if (d.oomKilled) {
        return 'The container was killed for exceeding its memory limit while starting.';
    }
    if (d.exitCode === 137) {
        return 'Exit code 137 usually means the container was killed, most often for exceeding its memory limit.';
    }
    if (d.exitCode === 0) {
        return 'Exit code 0 means the start command finished on its own without leaving a server running — ' +
            'typically a start command that runs a shell or a build step instead of launching the app.';
    }
    if (d.exitCode === 127 || d.exitCode === 126) {
        return `Exit code ${d.exitCode} means the start command itself was not found or not executable in the image.`;
    }
    return null;
}

/**
 * Owner-facing explanation for a failed deploy. Includes the log tail.
 */
function formatForOwner(appName, d) {
    if (!d) return null;
    // A healthy running alloc explains nothing about THIS failure (the run
    // failed for another reason: placement, bad spec, config push while
    // the previous version keeps serving). Let the caller's generic
    // message stand.
    if (!isCrash(d) && d.state === 'running') return null;
    const times = d.restarts > 0 ? ` ${d.restarts + 1} times in a row` : '';
    const code = d.exitCode !== null ? ` with exit code ${d.exitCode}` : d.signal ? ` on signal ${d.signal}` : '';
    const lines = [];
    lines.push(
        isCrash(d)
            ? `The build succeeded, but ${appName}'s container exited${code}${times} right after starting, so the deploy was stopped and the previous version (if any) was kept.`
            : `${appName}'s container did not become healthy before Nomad's deadline (task state: ${d.state}` +
            (d.exitCode !== null ? `, exited ${d.restarts + 1} time(s) so far, last exit code ${d.exitCode}` : '') + ').'
    );
    const hint = exitHint(d);
    if (hint) lines.push(hint);
    if (d.lastEvent) lines.push(`Nomad: ${d.lastEvent}`);
    const log = d.stderr || d.stdout;
    if (log) {
        lines.push('', `Last output from the app (${d.stderr ? 'stderr' : 'stdout'}):`, log);
    } else {
        lines.push('', `No output was captured from the app. GET /apps/${appName}/logs may still have it.`);
    }
    return lines.join('\n');
}

/**
 * Visitor-facing explanation for a wake that failed. No log lines.
 */
function formatForVisitor(d) {
    if (!isCrash(d)) return null;
    const code = d.exitCode !== null ? ` (exit code ${d.exitCode})` : '';
    return (
        `This app crashed while starting${code}, so it cannot be opened right now. ` +
        'Its owner needs to fix the app and deploy it again.\n'
    );
}

module.exports = { describeTaskFailure, pickAllocation, isCrash, formatForOwner, formatForVisitor };
