/**
 * json-source.js
 *
 * Lets POST /apps take the source as JSON instead of a multipart tarball:
 *
 *   Content-Type: application/json
 *   { "appName": "my-app", "appType": "portfolio", "agentName": "claude", "files": [ { "path": "index.html", "content": "..." },
 *                                     { "path": "logo.png", "content": "<b64>", "encoding": "base64" } ] }
 *
 * Why this exists: an MCP tool call (claude.ai connector -> viasocket ->
 * here) can only carry JSON arguments, never a file. Without this path the
 * only way to deploy was for the agent to `curl -F source=@...` from its
 * own sandbox, which the sandbox's egress policy blocks. The tool call
 * itself travels server to server, so shipping the code INSIDE it needs no
 * network change on the user's side.
 *
 * Deliberately a thin adapter, not a second deploy path: it writes the
 * files out, packs them into the exact tar.gz the multipart path produces,
 * and sets req.file — so everything after (claim, manifest-root check,
 * build plan, static/Nomad deploy, cleanup) runs unchanged. Body fields
 * are mapped onto the X-* headers the handler already reads; an explicit
 * header wins.
 */
const path = require('path');
const fs = require('fs-extra');
const tar = require('tar');
const express = require('express');
const { randomUUID } = require('crypto');

const UPLOAD_DIR = '/tmp/platform-uploads/';
// The body is the whole app, generated token by token by an agent — well
// past anything reasonable to send this way. Bigger apps belong on the
// multipart path.
const MAX_BODY = '25mb';
const MAX_FILES = 2000;

const parseJson = express.json({ limit: MAX_BODY });

function fail(res, status, code, error) {
  return res.status(status).json({ error, code });
}

// A relative path that stays inside the build dir — no absolute paths, no
// `..` segments, no drive letters, no NUL.
function safeRelativePath(p) {
  if (typeof p !== 'string' || !p || p.includes('\0')) return null;
  const normalized = path.posix.normalize(p.replace(/\\/g, '/')).replace(/^(\.\/)+/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null;
  if (normalized.split('/').includes('..')) return null;
  return normalized;
}

function jsonSource(req, res, next) {
  // Multipart (or no body) — the original path, untouched.
  if (!req.is('application/json')) return next();

  parseJson(req, res, async (parseErr) => {
    if (parseErr) {
      if (parseErr.type === 'entity.too.large') {
        return fail(res, 413, 'source_too_large', `JSON source is over ${MAX_BODY}. Deploy large apps with a multipart tar.gz upload instead.`);
      }
      return fail(res, 400, 'invalid_json', 'Request body is not valid JSON.');
    }

    const body = req.body || {};
    if (body.appName !== undefined && !req.headers['x-app-name']) req.headers['x-app-name'] = String(body.appName);
    if (body.version !== undefined && !req.headers['x-app-version']) req.headers['x-app-version'] = String(body.version);
    if (body.scaleToZero !== undefined && !req.headers['x-scale-to-zero']) req.headers['x-scale-to-zero'] = String(body.scaleToZero);
    if (body.appType !== undefined && !req.headers['x-app-type']) req.headers['x-app-type'] = String(body.appType);
    if (body.agentName !== undefined && !req.headers['x-agent-name']) req.headers['x-agent-name'] = String(body.agentName);

    const files = body.files;
    if (!Array.isArray(files) || files.length === 0) {
      return fail(res, 400, 'missing_source_file', 'JSON deploys need a non-empty "files" array of { path, content, encoding? }.');
    }
    if (files.length > MAX_FILES) {
      return fail(res, 413, 'too_many_files', `At most ${MAX_FILES} files per JSON deploy. Leave out node_modules, build output and .git.`);
    }

    const stageDir = path.join(UPLOAD_DIR, `json-${randomUUID()}`);
    const tarPath = `${stageDir}.tar.gz`;
    try {
      const seen = new Set();
      for (const [i, f] of files.entries()) {
        const rel = safeRelativePath(f && f.path);
        if (!rel) {
          await fs.remove(stageDir);
          return fail(res, 400, 'invalid_file_path', `files[${i}].path must be a relative path inside the app (got ${JSON.stringify(f && f.path)}).`);
        }
        if (typeof f.content !== 'string') {
          await fs.remove(stageDir);
          return fail(res, 400, 'invalid_file_content', `files[${i}].content must be a string.`);
        }
        const encoding = f.encoding === undefined ? 'utf8' : f.encoding;
        if (encoding !== 'utf8' && encoding !== 'base64') {
          await fs.remove(stageDir);
          return fail(res, 400, 'invalid_file_encoding', `files[${i}].encoding must be "utf8" or "base64".`);
        }
        seen.add(rel.split('/')[0]);
        const dest = path.join(stageDir, rel);
        await fs.ensureDir(path.dirname(dest));
        await fs.writeFile(dest, Buffer.from(f.content, encoding));
      }

      await tar.c({ gzip: true, file: tarPath, cwd: stageDir }, [...seen]);
      await fs.remove(stageDir);
    } catch (err) {
      await fs.remove(stageDir).catch(() => {});
      await fs.remove(tarPath).catch(() => {});
      return next(err);
    }

    req.file = { path: tarPath, fieldname: 'source', originalname: 'source.tar.gz' };
    next();
  });
}

module.exports = { jsonSource, safeRelativePath };
