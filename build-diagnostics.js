/**
 * build-diagnostics.js
 *
 * Makes a failed build readable. Two halves of the same problem:
 *
 * 1. THE BUILD LOG. `railpack build` writes the one thing that explains a
 *    failure — the actual failing command — to its own stdout/stderr, and
 *    until now all of that was discarded: exec's error carried only a
 *    `Command failed: <cmd>` line plus whatever stderr tail fit. Worse,
 *    GET /apps/:appName/logs reads NOMAD ALLOCATION logs (app-logs.js), and
 *    a build that fails never produces an allocation — so a failed build
 *    had no retrievable output anywhere, for anyone. The tail is kept here,
 *    in memory, and served as a fallback by that same endpoint.
 *
 *    Ephemeral on purpose, for the same reason deploy-status.js is: a build
 *    doesn't survive a process restart either, so losing its log alongside
 *    it isn't a new failure mode.
 *
 * 2. THE CLASSIFIER. An exit code alone sends people (and agents) guessing.
 *    describeBuildFailure turns the ones with an unambiguous meaning into a
 *    sentence naming the likely cause, appended to errorDetail rather than
 *    replacing it — the raw error still travels with it.
 */

// A tail, not the whole log: enough to hold the failing step and the
// output around it, bounded so a pathological build can't grow this map
// without limit.
const MAX_LOG_CHARS = 64 * 1024;

// railpack on a cold cache prints a lot. exec's 1MB default silently
// truncates (and can kill the child), which is how the failing command
// went missing in the first place.
const BUILD_OUTPUT_MAX_BUFFER = 10 * 1024 * 1024;

const logs = new Map(); // appName -> { output, capturedAt }

function tail(text) {
  if (text.length <= MAX_LOG_CHARS) return text;
  return `[… earlier build output truncated …]\n${text.slice(-MAX_LOG_CHARS)}`;
}

// exec resolves with {stdout, stderr} and rejects with an Error carrying
// those same two fields, so one helper serves both paths.
function combineOutput(result) {
  if (!result) return '';
  const parts = [];
  if (result.stdout && result.stdout.trim()) parts.push(result.stdout.trimEnd());
  if (result.stderr && result.stderr.trim()) parts.push(result.stderr.trimEnd());
  return parts.join('\n');
}

function setBuildLog(appName, result) {
  const output = combineOutput(result);
  if (!output) return;
  logs.set(appName, { output: tail(output), capturedAt: new Date().toISOString() });
}

function getBuildLog(appName) {
  return logs.get(appName) || null;
}

// Only codes whose meaning is unambiguous get a hint — a wrong confident
// explanation is worse than none, since it sends someone fixing the wrong
// thing. Everything else falls through to the raw error.
function describeBuildFailure(error) {
  const exitCode = typeof error?.code === 'number' ? error.code : null;

  if (exitCode === 127) {
    return {
      exitCode,
      hint:
        'Exit code 127 means a command in the build script was not found while building your app. ' +
        "Usually one of: the build tool is missing from the app's dependencies/devDependencies, or " +
        'the root package.json delegates its build to a subdirectory (e.g. "npm --prefix frontend ' +
        'run build") whose own dependencies are never installed — only the archive root is. If the ' +
        'real app lives in a subdirectory, deploy that subdirectory directly instead of the folder ' +
        'above it.',
    };
  }

  if (exitCode === 137) {
    return {
      exitCode,
      hint:
        'Exit code 137 means the build was killed for running out of memory — this is the build ' +
        'step itself, not the running app. Reduce what the build has to hold at once, or drop an ' +
        'unusually heavy build-time dependency.',
    };
  }

  return { exitCode, hint: null };
}

module.exports = {
  setBuildLog,
  getBuildLog,
  describeBuildFailure,
  BUILD_OUTPUT_MAX_BUFFER,
};
