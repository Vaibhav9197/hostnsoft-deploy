/**
 * host-monitor.js — watches the server itself and posts to the platform
 * alert webhook when something on it is wrong. Part 2 of EAI-10; the
 * external uptime monitor (GET /health, platform-health.js) is Part 1.
 *
 * A separate pm2 process, like activator.js, and ONE per server, not one
 * per environment: disk, memory and Docker are shared by every environment
 * on the host, so a monitor per environment would send each alert twice.
 * It watches every pm2 process on the host, whichever environment it
 * belongs to.
 *
 *   pm2 start host-monitor.js --name host-monitor && pm2 save
 *
 * Every minute it runs the checks below. A check that is bad for its
 * `forMs` sends one "firing" alert, a reminder every REMIND_MS while it
 * stays bad, and one "resolved" when it clears. That state is kept in
 * STATE_FILE so a restart neither repeats a firing alert nor forgets to
 * resolve one. A failed POST is retried on the next run.
 *
 * It cannot report its own server dying. HEARTBEAT_URL, when set, is
 * pinged every run; the uptime service alerts when the pings stop.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const logger = require('./logger');

// The EAI-10 platform alert flow (viasocket). One flow for every
// environment; `env` and `host` in the payload say where an alert came from.
const ALERT_WEBHOOK_URL =
  process.env.ALERT_WEBHOOK_URL || 'https://flow.sokt.io/func/scriuEffs9iF';
const HEARTBEAT_URL = process.env.HEARTBEAT_URL || null;
const NOMAD_ADDR = process.env.NOMAD_ADDR || 'http://127.0.0.1:4646';
const DOCKER_SOCKET_PATH = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';
const ENV_NAME = process.env.APP_ENV || null;
const HOST = os.hostname();

const INTERVAL_MS = Number(process.env.HOST_MONITOR_INTERVAL_MS) || 60_000;
const REMIND_MS = 60 * 60_000;
// Gitignored. server-setup.sh's redeploy runs `git clean -fd` (no -x), which
// keeps ignored files, as it keeps .env.
const STATE_FILE = path.join(__dirname, '.host-monitor-state.json');
// Per call to Docker, Nomad, pm2, the webhook or the heartbeat.
const CALL_TIMEOUT_MS = 10_000;

const MINUTE = 60_000;
// How long each kind of problem must last before it alerts. pm2, Nomad and
// Docker get two minutes so a restart during a deploy does not page anyone;
// load gets fifteen because a build pegs the CPU for a few minutes by design.
const FOR_MS = {
  disk: 0,
  memory: 5 * MINUTE,
  load: 15 * MINUTE,
  pm2: 2 * MINUTE,
  crashloop: 0,
  nomad: 2 * MINUTE,
  docker: 2 * MINUTE,
  traefik: 2 * MINUTE,
};

const DISK_WARN = 0.8;
const DISK_CRIT = 0.9;
const MEM_WARN = 0.1; // fraction AVAILABLE
const MEM_CRIT = 0.05;
const LOAD_PER_CPU = 2; // 5-minute load average over CPU count
const CRASHLOOP_RESTARTS = 3;
const CRASHLOOP_WINDOW_MS = 10 * MINUTE;

// ---------------------------------------------------------------------
// Checks. Each returns [{ key, kind, severity, title }]; severity is
// 'ok' | 'warning' | 'critical'. A check that cannot run reports itself,
// never throws: one broken check must not stop the others.
// ---------------------------------------------------------------------

function result(key, kind, severity, title) {
  return { key, kind, severity, title };
}

function dockerGet(p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: DOCKER_SOCKET_PATH, path: p, method: 'GET', timeout: CALL_TIMEOUT_MS }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Docker ${p} -> ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Docker ${p} timed out`)));
    req.on('error', reject);
    req.end();
  });
}

async function nomadGet(p) {
  const res = await fetch(`${NOMAD_ADDR}${p}`, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Nomad ${p} -> ${res.status}`);
  return res.json();
}

// Used share the way df computes Use%: used / (used + available to
// non-root), so the numbers match what an operator sees on the box.
async function diskUsed(dir) {
  const s = await fsp.statfs(dir);
  const used = s.blocks - s.bfree;
  return used / (used + s.bavail);
}

async function checkDocker() {
  try {
    const info = await dockerGet('/info');
    return { results: [result('docker', 'docker', 'ok', 'Docker is answering')], rootDir: info.DockerRootDir };
  } catch (e) {
    return { results: [result('docker', 'docker', 'critical', `Docker is not answering: ${e.message}`)], rootDir: null };
  }
}

async function checkDisks(dockerRootDir) {
  const dirs = [['disk:/', '/']];
  if (dockerRootDir) dirs.push([`disk:${dockerRootDir}`, dockerRootDir]);
  const seenDevices = new Set();
  const out = [];
  for (const [key, dir] of dirs) {
    try {
      // Same filesystem as one already checked: one alert, not two.
      const { dev } = await fsp.stat(dir);
      if (seenDevices.has(dev)) continue;
      seenDevices.add(dev);
      const used = await diskUsed(dir);
      const pct = Math.round(used * 100);
      const severity = used >= DISK_CRIT ? 'critical' : used >= DISK_WARN ? 'warning' : 'ok';
      out.push(result(key, 'disk', severity, `Disk ${pct}% full on ${dir}`));
    } catch (e) {
      out.push(result(key, 'disk', 'warning', `Could not read disk usage of ${dir}: ${e.message}`));
    }
  }
  return out;
}

async function checkMemory() {
  try {
    const meminfo = await fsp.readFile('/proc/meminfo', 'utf8');
    const kb = (name) => Number((meminfo.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm')) || [])[1]);
    // MemAvailable, not MemFree: page cache counts as free in practice and
    // Linux fills it on purpose, so MemFree is always low on a healthy box.
    const available = kb('MemAvailable') / kb('MemTotal');
    const pct = Math.round(available * 100);
    const severity = available <= MEM_CRIT ? 'critical' : available <= MEM_WARN ? 'warning' : 'ok';
    return [result('memory', 'memory', severity, `Memory ${pct}% available`)];
  } catch (e) {
    return [result('memory', 'memory', 'warning', `Could not read memory: ${e.message}`)];
  }
}

function checkLoad() {
  const cpus = os.cpus().length;
  const load5 = os.loadavg()[1];
  const severity = load5 > LOAD_PER_CPU * cpus ? 'warning' : 'ok';
  return [result('load', 'load', severity, `5-minute load ${load5.toFixed(1)} on ${cpus} CPUs`)];
}

// Restart counts seen per process, for the crash-loop check. In memory
// only: after a monitor restart the window simply starts again.
const restartHistory = new Map();

async function checkPm2(now) {
  let list;
  try {
    // jlist carries every process's environment, secrets included: parsed
    // here, never logged.
    const { stdout } = await execFileAsync('pm2', ['jlist'], { timeout: CALL_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    list = JSON.parse(stdout);
  } catch (e) {
    return [result('pm2', 'pm2', 'critical', `pm2 is not answering: ${e.message.split('\n')[0]}`)];
  }

  const out = [];
  for (const p of list) {
    if (p.pid === process.pid) continue;
    const name = p.name;
    const status = p.pm2_env && p.pm2_env.status;
    // "stopped" is usually someone's `pm2 stop`: worth knowing, not paging.
    // Anything else not online (errored, a launch that never settles) is.
    const severity = status === 'online' ? 'ok' : status === 'stopped' ? 'warning' : 'critical';
    out.push(result(`pm2:${name}`, 'pm2', severity, `pm2 process ${name} is ${status}`));

    const restarts = Number(p.pm2_env && p.pm2_env.restart_time) || 0;
    const seen = (restartHistory.get(name) || []).filter((s) => now - s.at <= CRASHLOOP_WINDOW_MS);
    seen.push({ at: now, restarts });
    restartHistory.set(name, seen);
    const recent = restarts - seen[0].restarts;
    out.push(
      result(
        `crashloop:${name}`,
        'crashloop',
        recent >= CRASHLOOP_RESTARTS ? 'warning' : 'ok',
        `pm2 process ${name} restarted ${recent} times in 10 minutes`
      )
    );
  }
  return out;
}

async function checkNomad() {
  const out = [];
  try {
    await nomadGet('/v1/agent/health');
    out.push(result('nomad', 'nomad', 'ok', 'Nomad is answering'));
  } catch (e) {
    out.push(result('nomad', 'nomad', 'critical', `Nomad is not answering: ${e.message}`));
    // Traefik's job status comes from Nomad; with Nomad down it is unknown,
    // and the Nomad alert already covers it.
    return out;
  }
  try {
    // One Traefik job for every environment (server-setup.sh).
    const job = await nomadGet('/v1/job/traefik');
    const running = job && job.Status === 'running' && job.Stop !== true;
    out.push(
      result('traefik', 'traefik', running ? 'ok' : 'critical', `Traefik job is ${job ? job.Status : 'missing'}`)
    );
  } catch (e) {
    out.push(result('traefik', 'traefik', 'critical', `Could not read the Traefik job: ${e.message}`));
  }
  return out;
}

async function runChecks(now) {
  const docker = await checkDocker();
  const groups = await Promise.all([
    checkDisks(docker.rootDir),
    checkMemory(),
    checkPm2(now),
    checkNomad(),
  ]);
  return [...docker.results, ...checkLoad(), ...groups.flat()];
}

// ---------------------------------------------------------------------
// Deciding what to send. Pure: given the saved state, this run's results
// and the time, returns the new state and the alerts to send.
// ---------------------------------------------------------------------

function evaluate(state, results, now) {
  const next = {};
  const alerts = [];
  const byKey = new Map(results.map((r) => [r.key, r]));

  for (const key of new Set([...Object.keys(state), ...byKey.keys()])) {
    const prev = state[key];
    // A key that vanished (a pm2 process deleted, a disk no longer
    // separate) counts as recovered.
    const r = byKey.get(key) || { key, kind: prev.kind, severity: 'ok', title: `${prev.title} (no longer present)` };

    if (r.severity === 'ok') {
      if (prev && prev.firing) alerts.push({ ...r, state: 'resolved', severity: prev.severity });
      continue;
    }

    const entry = prev ? { ...prev } : { kind: r.kind, badSince: now, firing: false, lastSent: null };
    entry.title = r.title;
    const lasted = now - entry.badSince >= (FOR_MS[r.kind] ?? 0);
    const due = !entry.firing || entry.severity !== r.severity || now - entry.lastSent >= REMIND_MS;
    if (lasted && due) {
      alerts.push({ ...r, state: 'firing' });
      entry.firing = true;
      entry.lastSent = now;
    }
    entry.severity = r.severity;
    next[key] = entry;
  }
  return { state: next, alerts };
}

// ---------------------------------------------------------------------
// Sending, state, loop
// ---------------------------------------------------------------------

async function send(alert, now) {
  const payload = {
    source: 'host-monitor',
    env: ENV_NAME,
    host: HOST,
    severity: alert.severity,
    check: alert.key,
    title: alert.title,
    state: alert.state,
    time: new Date(now).toISOString(),
  };
  const res = await fetch(ALERT_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`webhook answered ${res.status}`);
}

async function loadState() {
  try {
    return JSON.parse(await fsp.readFile(STATE_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') logger.warn(`[host-monitor] could not read ${STATE_FILE}, starting fresh: ${e.message}`);
    return {};
  }
}

async function saveState(state) {
  const tmp = `${STATE_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2));
  await fsp.rename(tmp, STATE_FILE);
}

// Undo what evaluate() recorded for an alert that never went out, so the
// next run decides to send it again. badSince is kept: the problem did
// start when it started.
function unsend(next, prev, alert) {
  const before = prev[alert.key];
  if (alert.state === 'resolved') {
    next[alert.key] = before;
    return;
  }
  next[alert.key] = {
    ...next[alert.key],
    firing: before ? before.firing : false,
    lastSent: before ? before.lastSent : null,
    severity: before ? before.severity : next[alert.key].severity,
  };
}

let state = {};

async function tick() {
  const now = Date.now();
  const results = await runChecks(now);
  const { state: next, alerts } = evaluate(state, results, now);

  for (const alert of alerts) {
    try {
      await send(alert, now);
      logger.info(`[host-monitor] ${alert.state} ${alert.severity}: ${alert.title}`);
    } catch (e) {
      logger.error(`[host-monitor] could not send "${alert.title}": ${e.message}`);
      unsend(next, state, alert);
    }
  }

  state = next;
  await saveState(state).catch((e) => logger.error(`[host-monitor] could not save state: ${e.message}`));

  if (HEARTBEAT_URL) {
    await fetch(HEARTBEAT_URL, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) }).catch((e) =>
      logger.warn(`[host-monitor] heartbeat failed: ${e.message}`)
    );
  }
}

async function main() {
  state = await loadState();
  logger.info(
    `[host-monitor] started on ${HOST} (env ${ENV_NAME || 'unset'}), every ${INTERVAL_MS / 1000}s` +
      (HEARTBEAT_URL ? '' : ' — HEARTBEAT_URL not set, a dead server will not be noticed')
  );
  let running = false;
  const run = async () => {
    // A run slower than the interval is skipped, not stacked.
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (e) {
      logger.error(`[host-monitor] run failed: ${e.stack || e.message}`);
    } finally {
      running = false;
    }
  };
  await run();
  setInterval(run, INTERVAL_MS);
}

if (require.main === module) main();

module.exports = { evaluate, unsend, runChecks, FOR_MS, REMIND_MS };
