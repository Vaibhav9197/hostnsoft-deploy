/**
 * detect-timers.js
 *
 * Spots apps that run timed jobs from inside the process (node-cron,
 * APScheduler...). Those timers work until the app is put to sleep for
 * being idle, then stop silently. The fix is a schedule declared on the
 * deploy (hostnsoft-api's docs/schedules.md), so the deploy reply warns the
 * agent; it never refuses the deploy.
 *
 * Two steps, cheapest first:
 *   1. The dependency manifests only (package.json, requirements.txt,
 *      pyproject.toml, Pipfile, Gemfile, go.mod). Browser code can't pull in
 *      these server-side libraries, so a plain setInterval refreshing a page
 *      is never flagged.
 *   2. Only when one is found: a text search of the source for cron
 *      expressions, so the warning can quote the timing to the agent.
 */
const { execFile } = require('child_process');
const util = require('util');
const path = require('path');
const fs = require('fs/promises');
const logger = require('./logger');

const execFilePromise = util.promisify(execFile);

// package.json dependency names.
const NODE_LIBS = ['node-cron', 'cron', 'node-schedule', 'agenda', 'bree', 'croner', 'toad-scheduler', 'cron-schedule'];
// Python distribution names, compared lowercased with - and _ treated alike.
const PYTHON_LIBS = ['apscheduler', 'schedule', 'rq-scheduler', 'django-crontab', 'django-q', 'huey'];
const RUBY_GEMS = ['whenever', 'rufus-scheduler', 'sidekiq-cron', 'clockwork'];
const GO_MODULES = ['github.com/robfig/cron', 'github.com/go-co-op/gocron'];

const MAX_EXPRESSIONS = 5;

async function readText(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

function normalizePy(name) {
  return name.toLowerCase().replace(/_/g, '-');
}

// Package names from requirements.txt / pyproject.toml / Pipfile text. A
// loose read on purpose: every line's leading name token, wherever it is.
function pythonNames(text) {
  const names = new Set();
  for (const line of text.split('\n')) {
    const m = line.trim().replace(/^["']/, '').match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
    if (m) names.add(normalizePy(m[1]));
  }
  return names;
}

async function findLibraries(buildDir, nodeDeps) {
  const found = [];
  for (const lib of NODE_LIBS) if (Object.prototype.hasOwnProperty.call(nodeDeps, lib)) found.push(lib);

  const pyTexts = await Promise.all(['requirements.txt', 'pyproject.toml', 'Pipfile'].map((f) => readText(path.join(buildDir, f))));
  const py = new Set();
  for (const t of pyTexts) if (t) for (const n of pythonNames(t)) py.add(n);
  for (const lib of PYTHON_LIBS) if (py.has(lib)) found.push(lib);

  const gemfile = await readText(path.join(buildDir, 'Gemfile'));
  if (gemfile) {
    for (const gem of RUBY_GEMS) if (new RegExp(`^\\s*gem\\s+["']${gem}["']`, 'm').test(gemfile)) found.push(gem);
  }

  const gomod = await readText(path.join(buildDir, 'go.mod'));
  if (gomod) for (const mod of GO_MODULES) if (gomod.includes(mod)) found.push(mod);

  return found;
}

// A quoted 5- or 6-field cron expression: "0 9 * * 1-5", '*/15 * * * *'.
// Each field is digits, *, /, -, , or a three-letter day/month name.
const FIELD = '(?:[0-9*/,?-]+|[A-Za-z]{3}(?:-[A-Za-z]{3})?)';
// The same field for grep -E, which has no (?:...) groups.
const FIELD_ERE = '([0-9*/,?-]+|[A-Za-z]{3}(-[A-Za-z]{3})?)';
const CRON_RE = new RegExp(`["'\`](${FIELD}(?:\\s+${FIELD}){4,5})["'\`]`, 'g');

async function findExpressions(buildDir) {
  let stdout = '';
  try {
    ({ stdout } = await execFilePromise('grep', [
      '-rnE',
      '--include=*.js', '--include=*.mjs', '--include=*.cjs', '--include=*.ts',
      '--include=*.py', '--include=*.rb', '--include=*.go',
      '--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=dist',
      '--exclude-dir=build', '--exclude-dir=.next', '--exclude-dir=venv', '--exclude-dir=.venv',
      // [[:space:]], not \s: portable across GNU and BSD grep.
      '--', `["'\`]${FIELD_ERE}([[:space:]]+${FIELD_ERE}){4,5}["'\`]`,
      buildDir,
    ], { maxBuffer: 1024 * 1024 }));
  } catch (e) {
    if (e.code !== 1) logger.warn(`[detect-timers] expression search failed, continuing without: ${e.message}`);
    return [];
  }

  const out = [];
  const seen = new Set();
  for (const line of stdout.split('\n')) {
    const m = line.match(/^(.*?):(\d+):(.*)$/);
    if (!m) continue;
    for (const hit of m[3].matchAll(CRON_RE)) {
      const cron = hit[1].trim().replace(/\s+/g, ' ');
      // A string of only stars and numbers with no * at all is more likely
      // a version or a date than a schedule ("1 2 3 4 5").
      if (!cron.includes('*') || seen.has(cron)) continue;
      seen.add(cron);
      out.push({ cron, file: `${path.relative(buildDir, m[1])}:${m[2]}` });
      if (out.length >= MAX_EXPRESSIONS) return out;
    }
  }
  return out;
}

/**
 * Returns null when no timer library is listed, else
 * { libraries: [...], expressions: [{ cron, file }] }. Never throws: a
 * failed check only means no warning.
 */
async function detectTimers(buildDir, nodeDeps = {}) {
  try {
    const libraries = await findLibraries(buildDir, nodeDeps);
    if (libraries.length === 0) return null;
    return { libraries, expressions: await findExpressions(buildDir) };
  } catch (e) {
    logger.warn(`[detect-timers] check failed, skipping: ${e.message}`);
    return null;
  }
}

module.exports = { detectTimers };
