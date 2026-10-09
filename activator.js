/**
 * activator.js — wakes an app that scale-to-zero stopped, and proxies for
 * it. Steps 4 and 6 of docs/scale-to-zero-gated-plan.md, which has the
 * routing design, the 502-window history and the tradeoffs.
 *
 * A separate pm2 process, not part of deploy-service: it holds visitor
 * connections open through a cold start and must not be able to take the
 * deploy API down with it.  
 * A file in /opt/traefik/dynamic/
 * (Traefik's file-provider directory — see server-setup.sh)
 *
 *   node activator.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const http = require('http');
const fsp = require('fs/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const { appDataPathFor, defaultDomainFor, specPathFor } = require('./nomad-job-spec');
const { imagesFromSpec, missingImages } = require('./scale-to-zero-images');
const { allApps, hostnamesFor } = require('./scale-to-zero-registry');
const { isBotRequest } = require('./analytics/bot-filter');
const { isSqliteFile, manifestEntryProblem } = require('./sqlite-data-check');

const NOMAD_ADDR = process.env.NOMAD_ADDR || 'http://127.0.0.1:4646';
const PORT = Number(process.env.ACTIVATOR_PORT) || 4200;

// Obscure enough that no real app serves it, and only ever answered for a
// request whose Host matches no app. See the handler.
const HEALTH_PATH = '/__activator/health';

// The same set idle-report.js stops from. Refreshed, not read once: an
// app can opt in at any time. Until the refresh lands it is not wakeable,
// which is the safe direction to fail.
const WAKEABLE_TTL_MS = Number(process.env.WAKEABLE_TTL_MS) || 30000;
let wakeable = { hosts: new Map(), names: new Set(), at: 0 };

async function wakeableNow() {
  if (Date.now() - wakeable.at < WAKEABLE_TTL_MS) return wakeable;
  try {
    const names = await allApps();
    const hosts = new Map();
    for (const name of names) {
      for (const host of await hostnamesFor(name)) hosts.set(host.toLowerCase(), name);
    }
    wakeable = { hosts, names: new Set(names), at: Date.now() };
  } catch (e) {
    // Keep serving the previous set rather than emptying it: a transient
    // read failure must not make every allowlisted app unreachable.
    log(`could not refresh the wakeable set (keeping previous): ${e.message}`);
    wakeable.at = Date.now();
  }
  return wakeable;
}

// How long to hold a visitor's request while the app cold-starts before
// giving up. A container pull is already local (force_pull = false), so
// this is mostly image start + the app's own boot.
const WAKE_TIMEOUT_MS = Number(process.env.WAKE_TIMEOUT_MS) || 90000;

// Requests arriving during a cold start have their body buffered so it
// can be replayed once the app is up. Capped rather than unbounded: this
// process must not be turned into a memory sink by a large upload aimed
// at a sleeping app.
const MAX_BODY_BYTES = Number(process.env.ACTIVATOR_MAX_BODY_BYTES) || 10 * 1024 * 1024;

// Keep-alive to the upstream app. Without it every proxied request
// opens and tears down a TCP connection, which was irrelevant when this
// only ran during a cold start and is not now that it carries an app's
// whole traffic.
const upstreamAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });

// Short TTL AND failure-driven invalidation: a TTL alone serves a dead
// address until it expires; invalidation alone can hold a stale address
// that still accepts. A connection error forces a full re-resolve.
const ADDR_TTL_MS = Number(process.env.ACTIVATOR_ADDR_TTL_MS) || 30000;
const addrCache = new Map();

function cachedAddr(appName) {
  const hit = addrCache.get(appName);
  if (!hit) return null;
  if (Date.now() - hit.at > ADDR_TTL_MS) {
    addrCache.delete(appName);
    return null;
  }
  return hit.addr;
}

function rememberAddr(appName, addr) {
  addrCache.set(appName, { addr, at: Date.now() });
  return addr;
}

function log(line) {
  console.log(`${new Date().toISOString()} [activator] ${line}`);
}

async function nomadGet(p) {
  const res = await fetch(`${NOMAD_ADDR}${p}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Nomad ${p} -> ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------
// Waking
// ---------------------------------------------------------------------

async function jobIsRunning(appName) {
  const job = await nomadGet(`/v1/job/${encodeURIComponent(appName)}`);
  return Boolean(job) && job.Status === 'running' && job.Stop !== true;
}

/**
/**
 * Refuse to start if the data directory disagrees with the manifest
 * idle-report.js wrote at stop time.
 *
 * BEFORE the start: an app that wakes to a missing database does not
 * crash, it creates a fresh one and reports itself healthy, and by then it
 * is writing over the evidence. Sizes, not checksums — the files are
 * quiescent between stop and wake, except for the one writer that is
 * allowed to touch them: see manifestEntryProblem in sqlite-data-check.js.
 */
async function verifyDataAgainstManifest(appName) {
  const manifestPath = `${appDataPathFor('.snapshots')}/${appName}/latest-manifest.json`;
  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') {
      // No manifest means this app was never stopped BY US — someone
      // stopped it by hand, or it predates the snapshot. There is
      // nothing to compare against, so there is also nothing to
      // contradict. Proceed, but say so: a wake with no integrity check
      // is exactly the case worth being able to find in a log later.
      log(`${appName}: no manifest at ${manifestPath} — waking WITHOUT an integrity check`);
      return;
    }
    throw e;
  }

  const dataDir = appDataPathFor(appName);
  const actual = new Map();
  let entries;
  try {
    entries = await fsp.readdir(dataDir, { withFileTypes: true, recursive: true });
  } catch (e) {
    throw new Error(
      `data directory ${dataDir} is unreadable (${e.code}) but the manifest lists ` +
        `${manifest.fileCount} file(s) — refusing to start an app that would create a fresh, empty one`
    );
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = `${entry.parentPath || entry.path}/${entry.name}`;
    const stat = await fsp.stat(full);
    actual.set(full.slice(dataDir.length + 1), stat.size);
  }

  // Which manifest entries are SQLite databases, judged by the file on
  // disk now (the manifest records only sizes, and older manifests have
  // nothing else to go on). Litestream's own `.<db>-litestream/` state
  // directories are dot-dirs it creates next to the database; they are
  // never in a manifest and only show up as "extra" below.
  const sqliteMains = new Set();
  for (const f of manifest.files) {
    if (actual.has(f.path) && (await isSqliteFile(`${dataDir}/${f.path}`))) sqliteMains.add(f.path);
  }

  const problems = [];
  const checkpointed = [];
  for (const f of manifest.files) {
    const problem = manifestEntryProblem(f, actual, sqliteMains);
    if (problem) {
      problems.push(problem);
    } else if (actual.get(f.path) !== f.bytes) {
      checkpointed.push(`${f.path} ${f.bytes} -> ${actual.has(f.path) ? actual.get(f.path) : 'gone'}`);
    }
  }
  if (checkpointed.length > 0) {
    log(`${appName}: sqlite checkpoint since stop, allowed: ${checkpointed.join('; ')}`);
  }
  // Extra files are reported but are NOT a failure on their own: nothing
  // here deletes, and a stray file cannot destroy data the way a missing
  // or truncated one can.
  for (const p of actual.keys()) {
    // Litestream keeps its own state in `.<db>-litestream/` next to each
    // database. Expected, and not worth a line per wake.
    if (/(^|\/)\.[^/]*-litestream\//.test(p)) continue;
    if (!manifest.files.some((f) => f.path === p)) log(`${appName}: note — extra file not in manifest: ${p}`);
  }

  if (problems.length > 0) {
    throw new Error(
      `DATA INTEGRITY CHECK FAILED for ${appName} against ${manifestPath}: ${problems.join('; ')}`
    );
  }
  log(`${appName}: data verified against manifest (${manifest.fileCount} file(s), ${manifest.totalBytes} bytes)`);
}

/**
/**
 * Re-register from the SAVED spec: job_gc_threshold (4h) removes a stopped
 * job from Nomad's state, and a long-idle app is the normal case here.
 */
async function runSavedSpec(appName) {
  const specPath = specPathFor(appName);
  await fsp.access(specPath).catch(() => {
    throw new Error(`no saved job spec at ${specPath} — cannot wake ${appName}`);
  });
  // -detach: without it `nomad job run` monitors the deployment and does
  // not return until it completes, which made a cold start look like a
  // hang. waitForAddress below is the real wait.
  //
  // Images checked first: Nomad's failure mode for a missing local image
  // is `pull access denied` minutes later, which reads as a registry auth
  // problem and is not.
  const spec = JSON.parse(await fsp.readFile(specPath, 'utf8'));
  const missing = await missingImages(imagesFromSpec(spec));
  if (missing.length > 0) {
    throw new Error(
      `image(s) missing on this host: ${missing.join(', ')} — these are built locally and pushed to no ` +
        `registry, so ${appName} cannot be started without redeploying it`
    );
  }

  // `nomad job inspect` writes {"Job": {...}}, which `job run -json`
  // reads back directly.
  await execFileAsync('nomad', ['job', 'run', '-detach', '-json', specPath]);
}

/**
 * Wait until Nomad's service registry has an address for the app. This
 * is the same registry Traefik's Nomad provider reads, so an entry here
 * means both that we have somewhere to forward to AND that Traefik is
 * about to route directly and stop involving this process.
 */
async function waitForAddress(appName, deadline) {
  for (;;) {
    const regs = await nomadGet(`/v1/service/${encodeURIComponent(appName)}`).catch(() => null);
    if (Array.isArray(regs) && regs.length > 0 && regs[0].Address && regs[0].Port) {
      return { host: regs[0].Address, port: regs[0].Port };
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${appName} to register an address`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

// Single-flight. A cold start takes tens of seconds, and a page load is
// a dozen parallel requests — without this, each one would fire its own
// `nomad job run`. Step 4's checklist tests exactly this.
const inFlight = new Map();

function ensureAwake(appName) {
  const existing = inFlight.get(appName);
  if (existing) return existing;
  const p = wake(appName).finally(() => inFlight.delete(appName));
  inFlight.set(appName, p);
  return p;
}

async function wake(appName) {
  const deadline = Date.now() + WAKE_TIMEOUT_MS;

  if (await jobIsRunning(appName)) {
    // Already up — the ordinary case now that this proxies live traffic,
    // rather than the rare race it used to be. Nothing to start, and no
    // integrity check: the app is running and writing, so the manifest is
    // legitimately out of date by now.
    return rememberAddr(appName, await waitForAddress(appName, deadline));
  }

  // Logged phase by phase, not just at the ends. A cold start is the one
  // path here that legitimately takes tens of seconds, so "no output yet"
  // and "wedged" look identical from outside — and that is exactly how
  // the blocking `nomad job run` above went unnoticed.
  const t0 = Date.now();
  log(`${appName}: cold start requested`);
  await verifyDataAgainstManifest(appName);
  await runSavedSpec(appName);
  log(`${appName}: job submitted (+${Date.now() - t0}ms), waiting for an address`);
  const addr = await waitForAddress(appName, deadline);
  log(`${appName}: awake at ${addr.host}:${addr.port} (+${Date.now() - t0}ms)`);
  return rememberAddr(appName, addr);
}

// ---------------------------------------------------------------------
// Proxying
// ---------------------------------------------------------------------

// Hostname -> app, via the same spec-derived map the routers are generated
// from, so the two cannot drift. A custom domain resolves here exactly
// like a default one; parsing the app name out of the hostname would not
// work for a custom domain at all.
async function appNameFromHost(hostHeader) {
  const host = String(hostHeader || '').split(':')[0].toLowerCase();
  const { hosts } = await wakeableNow();
  return hosts.get(host) || null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large to buffer during cold start'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function forward(req, res, addr, body) {
  return new Promise((resolve, reject) => {
    const headers = { ...req.headers };
    // Host is left exactly as the visitor sent it — the app may route on
    // it. Hop-by-hop headers are not ours to pass along.
    delete headers.connection;
    delete headers['keep-alive'];
    delete headers['transfer-encoding'];
    if (body.length > 0) headers['content-length'] = String(body.length);

    const upstream = http.request(
      { host: addr.host, port: addr.port, method: req.method, path: req.url, headers, agent: upstreamAgent },
      (upRes) => {
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
        upRes.on('end', resolve);
        upRes.on('error', reject);
      }
    );
    upstream.on('error', reject);
    upstream.end(body);
  });
}

// Connection-level failures worth another attempt. Shared by the cached
// fast path and the cold-start readiness loop so the two cannot disagree
// about what counts as "the app is not there yet".
const RETRYABLE = ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'EPIPE'];

/**
/**
 * Retrying the connection IS the readiness check — Nomad registers a
 * service when the task starts, not when it listens. Only connection-level
 * failures, and only before any response has begun, so replaying a POST
 * cannot duplicate anything.
 */
async function forwardWhenReady(req, res, addr, body, deadline) {
  for (;;) {
    try {
      return await forward(req, res, addr, body);
    } catch (e) {
      const retryable = RETRYABLE.includes(e.code);
      if (!retryable || Date.now() > deadline || res.headersSent) throw e;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

const server = http.createServer(async (req, res) => {
  const appName = await appNameFromHost(req.headers.host);

  // Health, for the watchdog. Only when the Host matches no app, so no
  // app's own path is shadowed. Cheap and SILENT: at one check every two
  // minutes, logging would add ~720 lines a day.
  if (!appName && req.url === HEALTH_PATH) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        uptimeSec: Math.round(process.uptime()),
        wakeable: wakeable.names.size,
        inFlight: inFlight.size,
        cachedAddrs: addrCache.size,
      })
    );
    return;
  }

  if (!appName) {
    // Nothing should ever reach here: Traefik only routes hostnames that
    // have a fallback router in /opt/traefik/dynamic/. A 404 rather than a proxy
    // attempt means a misconfiguration can never turn this process into
    // an open relay for an arbitrary Host header.
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found\n');
    return;
  }

  const started = Date.now();

  // Scanners must not COLD START a sleeping app. idle-report already
  // ignores them when deciding to stop; nothing filtered the decision to
  // WAKE, so /.env woke real apps for another full idle threshold.
  //
  // Only the cold start is refused — a RUNNING app still serves these
  // normally. 404 is what most apps return for these paths anyway.
  if (isBotRequest({ userAgent: req.headers['user-agent'] || null, path: req.url.split('?')[0] })) {
    if (!cachedAddr(appName) && !(await jobIsRunning(appName).catch(() => true))) {
      req.resume(); // drain rather than buffer a scanner's body
      log(`${appName}: not waking for automated ${req.method} ${req.url}`);
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found\n');
      return;
    }
  }

  // A visitor who gives up mid-cold-start (or a curl that is Ctrl-C'd)
  // is not a failure of this component, but it produces a write-to-dead-
  // socket error that reads exactly like one. Tracked so the log says
  // which happened.
  let clientGone = false;
  req.on('aborted', () => {
    clientGone = true;
  });
  res.on('close', () => {
    if (!res.writableFinished) clientGone = true;
  });

  try {
    const body = await readBody(req);
    const deadline = started + WAKE_TIMEOUT_MS;

    // Fast path: a cached address, forwarded with no Nomad calls at all.
    // This is the common case now that every request for an allowlisted
    // app comes through here.
    const cached = cachedAddr(appName);
    if (cached) {
      try {
        await forward(req, res, cached, body);
        return;
      } catch (e) {
        // A cached address that will not connect means the app moved or
        // was stopped since. Drop it and fall through to the full path,
        // which re-resolves and wakes if needed. Only safe before
        // anything has been written back: at that point nothing reached
        // the app, so replaying even a POST cannot duplicate an effect.
        if (res.headersSent || !RETRYABLE.includes(e.code)) throw e;
        addrCache.delete(appName);
        log(`${appName}: cached upstream was stale (${e.code}) — re-resolving`);
      }
    }

    const addr = await ensureAwake(appName);
    await forwardWhenReady(req, res, addr, body, deadline);
    log(`${appName}: ${req.method} ${req.url} served in ${Date.now() - started}ms`);
  } catch (e) {
    if (clientGone) {
      log(`${appName}: client disconnected after ${Date.now() - started}ms during ${req.method} ${req.url} (the wake itself continues)`);
      return;
    }
    log(`${appName}: FAILED ${req.method} ${req.url} after ${Date.now() - started}ms — ${e.message}`);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    // A clean error after a bounded wait, never a hang: Step 4's
    // checklist requires an app that cannot start to produce this rather
    // than holding the visitor's connection open indefinitely.
    res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '30' });
    res.end('This app is starting up and did not become ready in time. Please try again.\n');
  }
});

/**
/**
 * WebSocket / HTTP Upgrade. Upgrades never reached this process before it
 * fronted running apps, so an activator that cannot proxy one breaks them
 * silently — the page loads, the socket never connects.
 *
 * Not the keep-alive agent: an upgraded connection is hijacked for its
 * lifetime and must never return to a pool.
 */
server.on('upgrade', async (req, clientSocket, head) => {
  // Both sockets need an error handler before anything else. An
  // unhandled 'error' on a raw socket is an uncaught exception, which
  // would take the whole activator — and therefore every allowlisted
  // app — down with it.
  clientSocket.on('error', () => clientSocket.destroy());

  const appName = await appNameFromHost(req.headers.host);
  if (!appName) {
    clientSocket.destroy();
    return;
  }

  try {
    const addr = cachedAddr(appName) || (await ensureAwake(appName));
    const upstream = http.request({
      host: addr.host,
      port: addr.port,
      method: req.method,
      path: req.url,
      headers: req.headers,
      agent: false,
    });

    upstream.on('upgrade', (upRes, upSocket, upHead) => {
      upSocket.on('error', () => upSocket.destroy());

      // rawHeaders, not headers: it preserves duplicates and original
      // casing, and some clients are stricter about the handshake
      // response than they are about ordinary responses.
      let head101 = `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\n`;
      for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
        head101 += `${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}\r\n`;
      }
      clientSocket.write(`${head101}\r\n`);

      if (upHead && upHead.length) clientSocket.write(upHead);
      if (head && head.length) upSocket.write(head);

      upSocket.pipe(clientSocket);
      clientSocket.pipe(upSocket);

      const closeBoth = () => {
        upSocket.destroy();
        clientSocket.destroy();
      };
      upSocket.on('close', closeBoth);
      clientSocket.on('close', closeBoth);
      log(`${appName}: upgraded ${req.url}`);
    });

    // An upstream may answer an upgrade with an ORDINARY response, usually
    // because the path is not a WebSocket endpoint. Without this the client
    // hangs waiting for a 101 that never comes.
    upstream.on('response', (upRes) => {
      let head = `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\n`;
      for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
        head += `${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}\r\n`;
      }
      clientSocket.write(`${head}\r\n`);
      upRes.pipe(clientSocket);
      upRes.on('end', () => clientSocket.end());
      log(`${appName}: upgrade request answered ${upRes.statusCode} (not a WebSocket endpoint)`);
    });

    upstream.on('error', (e) => {
      // A stale cached address shows up here too, and the client will
      // reconnect — so drop the entry rather than serve the same dead
      // upstream to the retry.
      addrCache.delete(appName);
      log(`${appName}: upgrade failed — ${e.message}`);
      clientSocket.destroy();
    });

    upstream.end();
  } catch (e) {
    log(`${appName}: upgrade could not be served — ${e.message}`);
    clientSocket.destroy();
  }
});

// Longer than WAKE_TIMEOUT_MS: the whole point is to hold the connection
// through a cold start, and Node's 2-minute default would otherwise cut
// the visitor off before our own timeout had a chance to answer cleanly.
server.requestTimeout = WAKE_TIMEOUT_MS + 30000;
server.headersTimeout = WAKE_TIMEOUT_MS + 30000;

server.listen(PORT, '127.0.0.1', () => {
  wakeableNow().then(({ names }) =>
    log(`listening on 127.0.0.1:${PORT}, wakeable: ${[...names].join(', ')}`)
  );
});
