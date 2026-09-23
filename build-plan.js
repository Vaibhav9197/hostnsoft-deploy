/**
 * build-plan.js
 *
 * Asks Railpack what it WOULD do with an uploaded app, without building
 * anything — `railpack info --format json` runs the same detection
 * `railpack build` starts with, stopped before BuildKit is involved. It
 * takes milliseconds for a static upload; for a Node app the only slow
 * part is mise resolving a runtime version, which a build does anyway.
 *
 * The one answer the deploy path needs from it: is this a STATIC app?
 * Railpack's own verdict for that is "the deploy start command is
 * `caddy run ...`" — a static site has no server of its own, so Railpack
 * bakes its bundled Caddy into the image to serve the files. That
 * verdict, not a heuristic of ours, is what the static fast path keys
 * off (see docs/Static-apps-req.md). The fast path must only ever take
 * an app the container path would have served with Caddy anyway, so a
 * visitor sees the same site either way; only the image build and the
 * per-app container disappear.
 *
 * Two flavours of static, told apart by metadata.providers:
 *   - "staticfile": plain files — an index.html at the upload root, a
 *     public/ directory, or a Staticfile naming the root. Nothing to
 *     build; the upload IS the site. This is what the fast path serves.
 *   - "node" with nodeIsSPA=true: a Vite/CRA/etc. app whose `npm run
 *     build` output is static. Its build still has to run somewhere, so
 *     it stays on the container path for now — reported here (isSpa) so
 *     the deploy log says so. See docs/Static-apps-req.md, "Next".
 *
 * Never throws: a failure here means "could not tell", and the caller
 * falls back to the container path, where `railpack build` reports the
 * same problem in Railpack's own words, exactly as it did before this
 * file existed.
 */
'use strict';

const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

const CADDY_START = /^caddy run\b/;

// The staticfile provider writes the Caddyfile it will run into the
// build step's assets, with a `root * <dir>` line: "." for an index.html
// at the upload root, "public" when the site lives in public/, or
// whatever a Staticfile's `root:` names. That line is the only place the
// plan says WHICH directory is the site, so it is read from there rather
// than re-implementing Railpack's own lookup order here.
function staticRootFromPlan(plan) {
  const build = (plan.steps || []).find((s) => s.name === 'build');
  const caddyfile = build && build.assets && build.assets.Caddyfile;
  if (typeof caddyfile !== 'string') return null;
  const match = caddyfile.match(/^\s*root\s+\*\s+(\S+)\s*$/m);
  return match ? match[1] : null;
}

async function inspectBuildPlan(dir) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync('railpack', ['info', '--format', 'json', dir], {
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (e) {
    // Non-zero exit when nothing is detected at all; whatever JSON it
    // still managed to produce is on stdout.
    stdout = e.stdout || '';
    if (!stdout.trim()) {
      return { ok: false, error: (e.stderr || e.message || 'railpack info failed').trim() };
    }
  }

  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    return { ok: false, error: 'railpack info produced non-JSON output' };
  }
  if (info.success === false) {
    return { ok: false, error: 'railpack could not detect how to build this app' };
  }

  const plan = info.plan || {};
  const metadata = info.metadata || {};
  const providers = typeof metadata.providers === 'string' ? metadata.providers : '';
  const startCommand = (plan.deploy && plan.deploy.startCommand) || '';
  const isStatic = CADDY_START.test(startCommand);
  const isPlainStatic = isStatic && providers === 'staticfile';
  const isSpa = isStatic && metadata.nodeIsSPA === 'true';

  return {
    ok: true,
    providers,
    startCommand,
    isStatic,
    isPlainStatic,
    isSpa,
    // Relative to the upload root; only meaningful for a plain static app.
    rootDir: isPlainStatic ? staticRootFromPlan(plan) || '.' : null,
    railpackVersion: info.railpackVersion || null,
  };
}

module.exports = { inspectBuildPlan };
