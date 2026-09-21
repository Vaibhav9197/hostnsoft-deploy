/**
 * detect-manifest-root.js
 *
 * Confirms a freshly extracted upload actually has a buildable manifest
 * (or, for a static site, an index.html) at buildDir's own root — the
 * same rule scripts/deploy.sh and SKILL.md already state to callers.
 * Railpack only ever looks at that root; an upload whose real app is
 * nested one level down (a zip that already contained a wrapping folder,
 * then packaged again) extracts here with nothing at the top, and
 * Railpack still limps into some provider and fails deep inside the
 * build (e.g. "npm run build" exiting 127) with an error that never
 * names the real cause.
 *
 * The dashboard's own upload flow already strips exactly one wrapping
 * folder client-side before it ever reaches here (see hostnsoft's
 * app/lib/pack.ts, stripCommonRoot) — this mirrors that same rule
 * server-side so a tarball behaves identically whether it came from the
 * dashboard, the CLI/agent skill, or a direct API call that skipped both.
 */
const path = require('path');
const fs = require('fs-extra');

const MANIFEST_FILES = [
  'package.json', 'requirements.txt', 'pyproject.toml', 'go.mod',
  'Gemfile', 'composer.json', 'Cargo.toml', 'index.html',
];
const IGNORED_ENTRIES = new Set(['node_modules', '.git', '.next', 'dist', 'venv', '__pycache__']);

// Ways a package.json script hands the real work to a subdirectory. Each
// pattern captures the directory it delegates into.
const DELEGATION_PATTERNS = [
  /--prefix[= ]+(\S+)/,                  // npm --prefix frontend run build
  /--cwd[= ]+(\S+)/,                     // yarn --cwd frontend build
  /--dir[= ]+(\S+)/,                     // pnpm --dir frontend build
  /(?:^|&&|;|\|)\s*cd\s+([^\s&;|]+)/,    // cd frontend && npm run build
];

async function hasManifestAt(dir) {
  for (const name of MANIFEST_FILES) {
    if (await fs.pathExists(path.join(dir, name))) return true;
  }
  return false;
}

// Moves every entry inside `from` up into `to`, then removes the
// now-empty `from` — flattens a single wrapping folder so buildDir
// itself becomes the real app root for every later step (railpack,
// the Nomad job spec, etc.), not just for this check.
async function flattenInto(from, to) {
  const entries = await fs.readdir(from);
  for (const entry of entries) {
    await fs.move(path.join(from, entry), path.join(to, entry), { overwrite: true });
  }
  await fs.remove(from);
}

// Returns one of:
//   { ok: true }                          — buildDir root is already fine
//   { ok: true, flattened: "<dirname>" }  — one wrapping folder was found and removed
//   { ok: false, hint: "<path>" | null }  — nothing buildable at the root; hint
//                                            names where a manifest WAS found, if
//                                            a shallow scan turned one up
async function resolveBuildRoot(buildDir) {
  if (await hasManifestAt(buildDir)) {
    return { ok: true };
  }

  const entries = (await fs.readdir(buildDir, { withFileTypes: true }))
    .filter(e => !IGNORED_ENTRIES.has(e.name));

  // The one unambiguous case: exactly one real top-level entry, and it's
  // a directory holding the actual app. Safe to auto-correct because
  // there's no other plausible root to have meant.
  if (entries.length === 1 && entries[0].isDirectory()) {
    const nested = path.join(buildDir, entries[0].name);
    if (await hasManifestAt(nested)) {
      const name = entries[0].name;
      await flattenInto(nested, buildDir);
      return { ok: true, flattened: name };
    }
  }

  // Anything less clear-cut (multiple top-level entries, or a single
  // nested folder that itself has no manifest either) — don't guess.
  // Still do a shallow, one-level-deep scan so the failure response can
  // name exactly where a manifest DOES live, if anywhere, instead of
  // leaving the caller to hunt for it.
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const nested = path.join(buildDir, entry.name);
    for (const name of MANIFEST_FILES) {
      if (await fs.pathExists(path.join(nested, name))) {
        return { ok: false, hint: `${entry.name}/${name}` };
      }
    }
  }

  return { ok: false, hint: null };
}

// The case resolveBuildRoot above CANNOT catch: a root package.json that
// exists (so the root looks buildable, and railpack duly picks its Node
// provider) but declares no dependencies of its own and hands the build
// to a subdirectory — the "wrapper root" of a frontend/backend split:
//
//   { "scripts": { "build": "npm --prefix frontend run build" } }
//
// railpack installs at the ARCHIVE ROOT only, so frontend/node_modules is
// never created and the delegated build dies on a missing binary (exit
// 127) minutes later, naming nothing useful. Detected here in seconds
// instead.
//
// Deliberately narrow, because a false positive would block a working
// deploy: it fires only when the root declares ZERO dependencies AND a
// script delegates somewhere AND that somewhere really does hold its own
// package.json. A root with its own dependencies installs and builds
// normally, whatever else its scripts do, so it never reaches the checks
// below.
async function detectDelegatingRoot(buildDir) {
  const pkgPath = path.join(buildDir, 'package.json');
  if (!(await fs.pathExists(pkgPath))) return null;

  let pkg;
  try {
    pkg = await fs.readJson(pkgPath);
  } catch {
    // An unparseable root package.json is a different (and self-evident)
    // problem — let railpack be the one to report it rather than guessing.
    return null;
  }

  const depCount =
    Object.keys(pkg.dependencies || {}).length +
    Object.keys(pkg.devDependencies || {}).length;
  if (depCount > 0) return null;

  const candidates = [];
  const scripts = pkg.scripts || {};
  for (const scriptName of ['build', 'start']) {
    const text = scripts[scriptName];
    if (typeof text !== 'string') continue;
    for (const pattern of DELEGATION_PATTERNS) {
      const match = pattern.exec(text);
      if (match) candidates.push({ dir: match[1], script: `"${scriptName}": "${text}"` });
    }
  }

  // npm/yarn workspaces describe the same shape declaratively. A glob
  // ("packages/*") is left alone on purpose — it names no single
  // directory to point someone at, and the confirmation below would
  // fail on it anyway.
  const workspaces = Array.isArray(pkg.workspaces)
    ? pkg.workspaces
    : (pkg.workspaces && Array.isArray(pkg.workspaces.packages) ? pkg.workspaces.packages : []);
  for (const entry of workspaces) {
    if (typeof entry === 'string') candidates.push({ dir: entry, script: null });
  }

  for (const candidate of candidates) {
    const dir = candidate.dir.replace(/^\.\//, '').replace(/\/+$/, '');
    // Nothing escaping the build directory, and nothing that just points
    // back at the root — neither would be the nested app we're after.
    if (!dir || dir === '.' || dir.includes('..') || path.isAbsolute(dir)) continue;
    if (await fs.pathExists(path.join(buildDir, dir, 'package.json'))) {
      return { subdir: dir, script: candidate.script };
    }
  }

  return null;
}

module.exports = { resolveBuildRoot, detectDelegatingRoot, MANIFEST_FILES };
