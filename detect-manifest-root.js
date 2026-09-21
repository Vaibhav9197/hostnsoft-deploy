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

module.exports = { resolveBuildRoot, MANIFEST_FILES };
