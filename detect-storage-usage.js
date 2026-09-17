/**
 * detect-storage-usage.js
 *
 * Cheap check for `window.storage` usage (Claude Artifacts' storage API,
 * which doesn't exist outside that sandbox). Two things keep this fast:
 *
 * 1. SKIPPED ENTIRELY if the app already declares a real database
 *    dependency (SQLite) — see hasRealDatabaseDependency().
 *    An app with real persistence already in place doesn't need this
 *    check, so there's no reason to pay for a source scan.
 *
 * 2. A native `grep -rl` pass finds CANDIDATE files fast (grep is a
 *    compiled binary and `-l` stops reading a file the instant it finds
 *    one match) — only files that pass this pre-filter get the heavier
 *    per-file AST check below, so an app that never mentions the string
 *    at all pays no parsing cost at all.
 *
 * Confirmed in practice: a plain text match on "window.storage" false-
 * positives on any file that merely *talks about* the API — a docs page
 * explaining the storage rule to its own users, a comment, a string in
 * an error message — none of which are actual usage. Each grep
 * candidate is now parsed and checked for a real `window.storage`
 * MEMBER EXPRESSION (actual executable code), which comments, string
 * literals, and JSX text nodes are structurally never part of — so this
 * isn't a regex heuristic bolted on top, the false-positive class is
 * excluded by construction.
 */
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const path = require('path');
const fs = require('fs/promises');
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const logger = require('./logger');

const REAL_DB_PACKAGE_PREFIXES = ['better-sqlite3', 'sqlite3'];

// Pass the already-parsed package.json `dependencies`+`devDependencies`
// object — server.js already reads this once, no need to read the file
// twice. PGlite was removed from this list when the platform narrowed to
// SQLite-only: an app declaring it is no longer treated as having real
// persistence, so it now correctly hits the window.storage rejection
// path instead of being waved through.
function hasRealDatabaseDependency(deps) {
  return Object.keys(deps).some(dep =>
    REAL_DB_PACKAGE_PREFIXES.some(prefix => dep.startsWith(prefix))
  );
}

// Both `window.storage` and `window['storage']` count as real usage;
// anything else (a string, a comment, JSX text) never produces a
// MemberExpression node at all, so it's excluded just by not matching.
function isWindowStorageMemberExpression(node) {
  if (node.object.type !== 'Identifier' || node.object.name !== 'window') return false;
  if (!node.computed) {
    return node.property.type === 'Identifier' && node.property.name === 'storage';
  }
  return node.property.type === 'StringLiteral' && node.property.value === 'storage';
}

// Returns true/false once actually parsed, or null if the file couldn't
// be parsed at all (caller decides the fallback — see below).
function fileHasRealWindowStorageUsage(filePath, source) {
  const isTs = /\.tsx?$/.test(filePath);
  let ast;
  try {
    ast = parse(source, {
      sourceType: 'unambiguous',
      plugins: [isTs ? 'typescript' : 'flow', 'jsx'],
      errorRecovery: true,
    });
  } catch {
    return null;
  }

  let found = false;
  try {
    traverse(ast, {
      MemberExpression(nodePath) {
        if (isWindowStorageMemberExpression(nodePath.node)) {
          found = true;
          nodePath.stop();
        }
      },
    });
  } catch {
    return null;
  }
  return found;
}

async function detectWindowStorageUsage(buildDir) {
  let candidates;
  try {
    const cmd = [
      'grep -rlF',
      "--include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx'",
      "--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=build",
      "-- 'window.storage'",
      `"${buildDir}"`,
    ].join(' ');

    const { stdout } = await execPromise(cmd);
    candidates = stdout.split('\n').map(f => f.trim()).filter(Boolean);
  } catch (e) {
    if (e.code === 1) {
      // grep's normal "no matches found" exit code — not an error
      return { detected: false, files: [] };
    }
    // Fail open: a broken scan should never block a legitimate deploy.
    logger.warn(`[detect-storage-usage] scan failed, skipping check: ${e.message}`);
    return { detected: false, files: [] };
  }

  const confirmed = [];
  for (const absPath of candidates) {
    const relPath = path.relative(buildDir, absPath);
    let source;
    try {
      source = await fs.readFile(absPath, 'utf8');
    } catch (e) {
      // Couldn't even read a file grep just found — treat as a hit
      // rather than silently drop it (same fail-closed reasoning as an
      // unparseable file below).
      logger.warn(`[detect-storage-usage] could not read "${relPath}" to confirm, treating as a hit: ${e.message}`);
      confirmed.push(relPath);
      continue;
    }

    const usesIt = fileHasRealWindowStorageUsage(relPath, source);
    if (usesIt === null) {
      // Couldn't parse this file (unusual syntax, parser gap) — fall
      // back to trusting the grep hit rather than silently clearing it;
      // a false positive needing a rebuild is far cheaper than shipping
      // an app that breaks at runtime.
      logger.warn(`[detect-storage-usage] could not parse "${relPath}" to confirm, treating as a hit`);
      confirmed.push(relPath);
    } else if (usesIt) {
      confirmed.push(relPath);
    }
    // usesIt === false: the string appears in this file (a comment, a
    // string literal, JSX text — e.g. a docs page describing the rule),
    // but never as actual code. Not a hit.
  }

  return { detected: confirmed.length > 0, files: confirmed };
}

module.exports = { detectWindowStorageUsage, hasRealDatabaseDependency };
