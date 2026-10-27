// Wake-ups the activator could not complete, one JSON line each:
// {at, app, reason, ms}. The activator used to only log these, so nothing
// could say which sleeping apps visitors found broken. Written by
// activator.js, read by admin-overview.js for the admin Customer apps page.
//
// Kept beside the sleep-state files (same owner, same disk), trimmed to the
// last 7 days whenever the file passes MAX_BYTES.

const fs = require('fs/promises');
const { appDataPathFor } = require('./nomad-job-spec');

const FILE = `${appDataPathFor('.scale-to-zero')}/wake-failures.jsonl`;
const KEEP_MS = 7 * 24 * 3600_000;
const MAX_BYTES = 512 * 1024;

async function readAll() {
  let text;
  try {
    text = await fs.readFile(FILE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A half-written last line after a crash: skip it.
    }
  }
  return out;
}

// Never throws: losing one record must not change what the visitor gets.
async function recordWakeFailure(app, reason, ms) {
  try {
    await fs.mkdir(appDataPathFor('.scale-to-zero'), { recursive: true });
    await fs.appendFile(FILE, `${JSON.stringify({ at: new Date().toISOString(), app, reason, ms })}\n`);
    const { size } = await fs.stat(FILE);
    if (size > MAX_BYTES) {
      const cutoff = Date.now() - KEEP_MS;
      const kept = (await readAll()).filter((r) => Date.parse(r.at) >= cutoff);
      const tmp = `${FILE}.${process.pid}.tmp`;
      await fs.writeFile(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''));
      await fs.rename(tmp, FILE);
    }
  } catch {
    // Best effort.
  }
}

// Failures since `sinceMs`, oldest first.
async function readWakeFailures(sinceMs) {
  return (await readAll()).filter((r) => Date.parse(r.at) >= sinceMs);
}

module.exports = { recordWakeFailure, readWakeFailures, WAKE_FAILURES_FILE: FILE };
