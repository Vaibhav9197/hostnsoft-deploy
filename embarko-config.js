/**
 * embarko-config.js
 *
 * Reads the app's optional embarko.json from the uploaded archive, before
 * the claim and before anything is extracted or built. It is where an app
 * declares platform settings that live with its code: `appId` (which app
 * this code deploys to, from the first deploy's reply) and `schedules`
 * (hostnsoft-api's docs/schedules.md). Spec and the reasoning behind each
 * rule: docs/embarko-json.md.
 *
 *   { "$schema": "https://embarko.ai/schema/embarko.json",
 *     "appId": "cm2x7k9qp0001abcd",
 *     "schedules": [{ "cron": "0 9 * * 1-5", "path": "/tasks/daily", "timezone": "Asia/Kolkata" }] }
 *
 * Refuses the deploy (400) only for a file that can't be trusted to mean
 * what it says: not JSON, not an object, too big, `schedules` not a list,
 * or something that looks like a secret. Everything else is a warning in
 * the deploy reply: unknown keys (ignored), the file in a subfolder, or a
 * near-miss name (.embarko, embarko.yaml...).
 *
 * Schedule CONTENT (cron, path, timezone) is checked by hostnsoft-api at
 * claim time, the one place the rules live.
 */
const tar = require('tar');
const logger = require('./logger');

const FILE_NAME = 'embarko.json';
const MAX_BYTES = 64 * 1024;
const KNOWN_KEYS = new Set(['$schema', 'appId', 'schedules']);
// Same shape server.js accepts in X-App-Id: the app.id a deploy reply gave.
const APP_ID_RE = /^[a-z0-9]{1,64}$/;

// Names an agent or person might use by mistake. Matched at the top folder
// only, case-insensitively, so "Embarko.json" counts too.
const NEAR_MISSES = new Set([
  '.embarko', '.embarko.json', 'embarko.jsonc', 'embarko.config.json', 'embarko.config.js',
  'embarko.yaml', 'embarko.yml', 'embarko.toml', 'embarko', 'embarko.json.txt',
]);

// A key whose name says it holds a secret.
const SECRET_KEY_RE = /(secret|passw|token|api[-_]?key|private[-_]?key|credential)/i;
// A value that is a well-known credential format, or carries one in a URL.
const SECRET_VALUE_RES = [
  /sk_(live|test)_[A-Za-z0-9]{8,}/,          // Stripe
  /\b(ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}/,     // GitHub
  /github_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,           // Slack
  /\bAKIA[0-9A-Z]{16}\b/,                     // AWS
  /\bsk-(proj-|ant-)?[A-Za-z0-9_-]{20,}/,     // OpenAI / Anthropic style
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // a JWT
  /[?&](token|key|secret|password|api_key|apikey|access_token)=[^&\s]+/i,
];

function stripDot(name) {
  return name.replace(/^\.\//, '');
}

function isIgnoredPath(name) {
  return /(^|\/)(node_modules|\.git|dist|build|\.next|venv|\.venv)\//.test(name);
}

// Every entry name in the archive, and the root embarko.json's content.
async function scanArchive(archivePath) {
  const names = [];
  let content = null;
  let tooBig = false;
  await tar.t({
    file: archivePath,
    onentry(entry) {
      const name = stripDot(entry.path);
      names.push(name);
      if (name === FILE_NAME && entry.type === 'File') {
        if (entry.size > MAX_BYTES) {
          tooBig = true;
          entry.resume();
          return;
        }
        const chunks = [];
        entry.on('data', (c) => chunks.push(c));
        entry.on('end', () => { content = Buffer.concat(chunks).toString('utf8'); });
      } else {
        entry.resume();
      }
    },
  });
  return { names, content, tooBig };
}

function lineAndColumn(text, position) {
  const before = text.slice(0, position);
  const line = before.split('\n').length;
  const column = position - before.lastIndexOf('\n');
  return { line, column };
}

// The first place something secret-looking appears, as a JSON path.
function findSecret(value, path = '') {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findSecret(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const here = path ? `${path}.${k}` : k;
      if (k !== '$schema' && SECRET_KEY_RE.test(k)) return here;
      const hit = findSecret(v, here);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value === 'string' && SECRET_VALUE_RES.some((re) => re.test(value))) return path || '(root)';
  return null;
}

function fail(code, error) {
  return { ok: false, code, error };
}

/**
 * Returns
 *   { ok: true, present, schedules, warnings }  — schedules is undefined
 *     when the file is absent or has no `schedules` key (= leave them as
 *     they are); warnings is a list of {code, detail}.
 *   { ok: false, code, error }                   — refuse the deploy.
 * An unreadable archive is not this module's to report: it returns
 * ok/absent and lets extraction fail the deploy with its usual error.
 */
async function readEmbarkoConfig(archivePath) {
  const warnings = [];
  let scan;
  try {
    scan = await scanArchive(archivePath);
  } catch (e) {
    logger.warn(`[embarko-config] could not list the archive, skipping embarko.json: ${e.message}`);
    return { ok: true, present: false, schedules: undefined, warnings };
  }

  const nested = scan.names.filter((n) => n !== FILE_NAME && n.endsWith(`/${FILE_NAME}`) && !isIgnoredPath(n));
  const misnamed = scan.names.filter((n) => !n.includes('/') && n !== FILE_NAME && NEAR_MISSES.has(n.toLowerCase()));

  if (scan.tooBig) {
    return fail('invalid_embarko_json', `embarko.json is larger than ${MAX_BYTES / 1024} KB. It should only hold a few settings.`);
  }

  if (scan.content === null) {
    if (nested.length) {
      warnings.push({
        code: 'embarko_json_not_at_top',
        detail: `Found ${nested.join(', ')}, but only embarko.json in the app's top folder (next to package.json) is read. Move it there and deploy again.`,
      });
    }
    if (misnamed.length) {
      warnings.push({
        code: 'embarko_json_misnamed',
        detail: `Found ${misnamed.join(', ')}. Embarko reads only a file named exactly embarko.json (JSON). Rename it and deploy again.`,
      });
    }
    return { ok: true, present: false, schedules: undefined, warnings };
  }

  let config;
  try {
    config = JSON.parse(scan.content);
  } catch (e) {
    const m = String(e.message).match(/position (\d+)/);
    const where = m ? (({ line, column }) => ` at line ${line}, column ${column}`)(lineAndColumn(scan.content, Number(m[1]))) : '';
    return fail('invalid_embarko_json', `embarko.json is not valid JSON${where}. Fix it and deploy again. Comments are not allowed.`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return fail('invalid_embarko_json', 'embarko.json must be one JSON object, like {"schedules": [...]}.');
  }

  const secretAt = findSecret(config);
  if (secretAt) {
    return fail(
      'secrets_in_embarko_json',
      `embarko.json looks like it holds a secret (at "${secretAt}"). It is part of the code and is never treated as private. ` +
        'Remove it and set it as an env var instead. A scheduled route checks the CRON_SECRET env var, which Embarko creates for you.'
    );
  }

  const unknown = Object.keys(config).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length) {
    warnings.push({
      code: 'embarko_json_unknown_keys',
      detail: `embarko.json has keys Embarko doesn't use: ${unknown.join(', ')}. They were ignored. Supported: appId, schedules.`,
    });
  }

  if (config.schedules !== undefined && !Array.isArray(config.schedules)) {
    return fail('invalid_embarko_json', 'In embarko.json, "schedules" must be a list, e.g. [{"cron":"0 9 * * 1-5","path":"/tasks/daily"}], or [] to remove all.');
  }

  // Refused rather than ignored: ignoring it would deploy by name alone,
  // which is how a renamed app used to get a second copy.
  if (config.appId !== undefined && (typeof config.appId !== 'string' || !APP_ID_RE.test(config.appId))) {
    return fail('invalid_embarko_json', 'In embarko.json, "appId" must be the app.id from a deploy reply, exactly as given, e.g. "cm2x7k9qp0001abcd". Remove it to deploy by name.');
  }

  if (nested.length) {
    warnings.push({ code: 'embarko_json_not_at_top', detail: `Also found ${nested.join(', ')}; only the top-folder embarko.json is read.` });
  }

  return { ok: true, present: true, appId: config.appId, schedules: config.schedules, warnings };
}

module.exports = { readEmbarkoConfig, FILE_NAME };
