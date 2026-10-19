/**
 * build-info.js
 *
 * Which code this process is running, read once at startup and reported by
 * GET /health. The deploy workflow (.github/workflows/deploy-prod.yml)
 * compares `commit` with the pushed commit, so a reload that failed and
 * left the old process serving shows up as a failed deploy instead of
 * passing silently.
 *
 * Read at startup on purpose: `git rev-parse` at request time would report
 * whatever was pulled onto disk, not what is loaded in memory.
 */
const { execFileSync } = require('child_process');

function readCommit() {
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

const BUILD_INFO = {
  commit: readCommit(),
  startedAt: new Date().toISOString(),
};

module.exports = { BUILD_INFO };
