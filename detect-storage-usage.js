/**
 * detect-storage-usage.js
 *
 * Cheap check for `window.storage` usage (Claude Artifacts' storage API,
 * which doesn't exist outside that sandbox). Two things keep this fast:
 *
 * 1. SKIPPED ENTIRELY if the app already declares a real database
 *    dependency (PGlite or SQLite) — see hasRealDatabaseDependency().
 *    An app with real persistence already in place doesn't need this
 *    check, so there's no reason to pay for a source scan.
 *
 * 2. Uses a single native `grep -rl` call instead of Node walking and
 *    reading every file — grep is a compiled binary and `-l` stops
 *    reading a file the instant it finds one match, rather than Node
 *    loading each file's full contents into a JS string first.
 */
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const path = require('path');
const logger = require('./logger');

const REAL_DB_PACKAGE_PREFIXES = ['@electric-sql/pglite', 'better-sqlite3', 'sqlite3'];

// Pass the already-parsed package.json `dependencies`+`devDependencies`
// object — server.js already reads this once for memory sizing, no need
// to read the file twice.
function hasRealDatabaseDependency(deps) {
  return Object.keys(deps).some(dep =>
    REAL_DB_PACKAGE_PREFIXES.some(prefix => dep.startsWith(prefix))
  );
}

async function detectWindowStorageUsage(buildDir) {
  try {
    const cmd = [
      'grep -rlF',
      "--include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx'",
      "--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=build",
      "-- 'window.storage'",
      `"${buildDir}"`,
    ].join(' ');

    const { stdout } = await execPromise(cmd);
    const files = stdout
      .split('\n')
      .map(f => f.trim())
      .filter(Boolean)
      .map(f => path.relative(buildDir, f));

    return { detected: files.length > 0, files };
  } catch (e) {
    if (e.code === 1) {
      // grep's normal "no matches found" exit code — not an error
      return { detected: false, files: [] };
    }
    // Fail open: a broken scan should never block a legitimate deploy.
    logger.warn(`[detect-storage-usage] scan failed, skipping check: ${e.message}`);
    return { detected: false, files: [] };
  }
}

module.exports = { detectWindowStorageUsage, hasRealDatabaseDependency };
