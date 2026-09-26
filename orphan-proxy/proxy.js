/**
 * proxy.js — orphan-expiry banner injector, language/framework-agnostic.
 *
 * Sits in front of an orphan app's own container (only while
 * claim.isOrphan is true — see ../nomad-job-spec.js and
 * ../docs/Anonymous-deploy-req.md #5) — or, as ONE shared instance run
 * by the static-server Nomad job, in front of the static server for
 * every orphan STATIC app (../docs/Static-apps-req.md) — and rewrites any text/html
 * response to add a small fixed banner just before `</body>` (or
 * appended, if none is found). Every other response — JSON, assets,
 * streaming, WebSocket upgrades — passes through completely untouched.
 *
 * Operates purely on HTTP bytes, so it works identically no matter what
 * language or framework the underlying app is written in — unlike the
 * old build-time source-injection approach (string-replacing a static
 * index.html, or scanning a Node entry file for an inline HTML template
 * literal), which only ever covered a handful of specific cases.
 *
 * Reaches the real app via TARGET_HOST:TARGET_PORT — Nomad's own
 * dynamically allocated host port for it, at whatever host address
 * Docker actually published it to. Confirmed in practice: that is NOT
 * necessarily 127.0.0.1 — on this platform's Nomad setup, published
 * ports are bound to the box's advertised/public IP specifically (the
 * same address Traefik itself uses to reach every app container), not
 * to 0.0.0.0 or loopback. TARGET_HOST must be set to that same address
 * (see nomad-job-spec.js / ORIGIN_IP) — don't assume 127.0.0.1 works.
 */
'use strict';

const http = require('http');
const net = require('net');

const LISTEN_PORT = process.env.LISTEN_PORT;
// 0.0.0.0 for the per-app sidecar (Nomad publishes its port on the host
// address); the shared instance in front of the static server binds
// loopback only, since only Traefik on the same box ever talks to it.
const LISTEN_HOST = process.env.LISTEN_HOST || '0.0.0.0';
const TARGET_HOST = process.env.TARGET_HOST;
const TARGET_PORT = process.env.TARGET_PORT;
// Banner content. Fixed for the whole process in the per-app sidecar
// (both set, from the app's Nomad job spec); per REQUEST in the shared
// instance fronting static apps (neither set), where each orphan app's
// Traefik router middleware carries them in X-Orphan-Expires-At /
// X-Orphan-Login-Url — see ../traefik-router-file.js. A request with
// neither source is proxied untouched, without a banner.
const BANNER_EXPIRES_AT = process.env.BANNER_EXPIRES_AT;
const BANNER_LOGIN_URL = process.env.BANNER_LOGIN_URL;

for (const [name, value] of Object.entries({ LISTEN_PORT, TARGET_HOST, TARGET_PORT })) {
  if (!value) {
    console.error(`[orphan-proxy] FATAL: ${name} environment variable is not set.`);
    process.exit(1);
  }
}
if (Boolean(BANNER_EXPIRES_AT) !== Boolean(BANNER_LOGIN_URL)) {
  console.error('[orphan-proxy] FATAL: set both BANNER_EXPIRES_AT and BANNER_LOGIN_URL, or neither (per-request headers).');
  process.exit(1);
}

function buildBannerTag(expiresAt, loginUrl) {
  // JSON.stringify here is just safe JS-literal escaping for these two
  // strings, not data interchange.
  const expiresAtLiteral = JSON.stringify(expiresAt);
  const loginUrlLiteral = JSON.stringify(loginUrl);
  return `<script>(function () {
  var expiresAt = new Date(${expiresAtLiteral});
  var loginUrl = ${loginUrlLiteral};

  // Shadow DOM keeps this banner's appearance fully isolated from the
  // host app's own CSS in both directions — confirmed in practice: a
  // plain inline-styled element was getting invisible-on-dark-background
  // text on some client apps, because a page-wide dark theme (a global
  // "*"/element selector, an !important rule, or a CSS custom property
  // consumed as a color value) still cascaded/inherited into it despite
  // the inline style. A shadow root's own stylesheet is a separate scope
  // that no outer page selector can reach into, and nothing inside it
  // leaks back out either. Falls back to the old unisolated approach
  // only on the handful of ancient browsers with no attachShadow, rather
  // than not showing anything at all.
  var host = document.createElement('div');
  host.id = '__embarko_orphan_banner';
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;right:0;z-index:2147483647;display:block;';

  var isolated = !!host.attachShadow;
  var root = isolated ? host.attachShadow({ mode: 'open' }) : host;

  if (isolated) {
    var style = document.createElement('style');
    style.textContent =
      '.bar{all:initial;display:block;box-sizing:border-box;width:100%;' +
      'background:#1a1a1a;color:#fff;font:13px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;' +
      'padding:10px 16px;text-align:center;}' +
      '.bar a{color:#8ab4ff;text-decoration:underline;}';
    root.appendChild(style);
  }

  var bar = document.createElement('div');
  bar.className = 'bar';
  if (!isolated) {
    bar.style.cssText = 'background:#1a1a1a;color:#fff;font:13px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;padding:10px 16px;text-align:center;';
  }
  var textEl = document.createElement('span');
  bar.appendChild(textEl);
  bar.appendChild(document.createTextNode(' \\u2014 '));
  var linkEl = document.createElement('a');
  linkEl.href = loginUrl;
  if (!isolated) linkEl.style.cssText = 'color:#8ab4ff;text-decoration:underline;';
  linkEl.textContent = 'log in to keep it';
  bar.appendChild(linkEl);
  root.appendChild(bar);

  // Ticks down live rather than showing a fixed wall-clock time, which a
  // visitor would otherwise have to do the subtraction on themselves.
  function render() {
    var msLeft = expiresAt.getTime() - Date.now();
    if (msLeft <= 0) {
      textEl.textContent = 'This app has expired and may be deleted at any moment';
      return;
    }
    var totalMinutes = Math.floor(msLeft / 60000);
    var hh = Math.floor(totalMinutes / 60);
    var mm = totalMinutes % 60;
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    textEl.textContent = 'This app will be deleted in ' + pad(hh) + ':' + pad(mm);
  }

  function mount() {
    if (document.body) {
      document.body.appendChild(host);
    } else {
      document.addEventListener('DOMContentLoaded', function () {
        document.body.appendChild(host);
      });
    }
    render();
    setInterval(render, 30000);
  }
  mount();
})();</script>`;
}

// One tag per distinct (expiry, login URL) pair — for the sidecar that
// is exactly one entry, built once. Bounded so a stream of made-up
// header values (only Traefik sets them, but still) cannot grow it
// without limit.
const bannerCache = new Map();
const BANNER_CACHE_MAX = 500;
function bannerTagFor(expiresAt, loginUrl) {
  const key = `${expiresAt}\n${loginUrl}`;
  let tag = bannerCache.get(key);
  if (!tag) {
    if (bannerCache.size >= BANNER_CACHE_MAX) bannerCache.clear();
    tag = buildBannerTag(expiresAt, loginUrl);
    bannerCache.set(key, tag);
  }
  return tag;
}

// Set by Traefik on an orphan static app's router; this proxy's
// business, not the app's, so they are stripped before forwarding.
const ORPHAN_HEADERS = ['x-orphan-expires-at', 'x-orphan-login-url'];

// Where this request's banner values come from: the request's own
// headers (shared instance) or this process's env (sidecar). null when
// there is nothing to inject.
function bannerConfigFor(req) {
  const expiresAt = req.headers['x-orphan-expires-at'] || BANNER_EXPIRES_AT;
  const loginUrl = req.headers['x-orphan-login-url'] || BANNER_LOGIN_URL;
  if (!expiresAt || !loginUrl) return null;
  return { expiresAt: String(expiresAt), loginUrl: String(loginUrl) };
}

function injectBanner(html, { expiresAt, loginUrl }) {
  const tag = bannerTagFor(expiresAt, loginUrl);
  return html.includes('</body>')
    ? html.replace('</body>', `${tag}\n</body>`)
    : `${html}\n${tag}\n`;
}

const server = http.createServer((clientReq, clientRes) => {
  const banner = bannerConfigFor(clientReq);
  const headers = { ...clientReq.headers };
  for (const name of ORPHAN_HEADERS) delete headers[name];
  // Ask the backend for uncompressed output — lets us safely
  // string-rewrite text/html bodies without gunzip/regzip. Every other
  // content type is streamed straight through regardless, untouched.
  // Only when there is a banner to inject; a banner-less request keeps
  // whatever encoding the client negotiated.
  if (banner) delete headers['accept-encoding'];

  const proxyReq = http.request(
    { host: TARGET_HOST, port: TARGET_PORT, method: clientReq.method, path: clientReq.url, headers },
    (proxyRes) => {
      const contentType = proxyRes.headers['content-type'] || '';
      if (!banner || !contentType.startsWith('text/html')) {
        clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(clientRes);
        return;
      }

      const chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('end', () => {
        const injected = injectBanner(Buffer.concat(chunks).toString('utf8'), banner);
        const outHeaders = { ...proxyRes.headers };
        delete outHeaders['content-encoding'];
        delete outHeaders['transfer-encoding'];
        outHeaders['content-length'] = Buffer.byteLength(injected);
        clientRes.writeHead(proxyRes.statusCode, outHeaders);
        clientRes.end(injected);
      });
    }
  );

  proxyReq.on('error', (err) => {
    console.error('[orphan-proxy] backend request failed:', err.message);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
    }
    clientRes.end('Bad Gateway');
  });

  clientReq.pipe(proxyReq);
});

// WebSocket / other Upgrade requests — raw byte pipe straight through,
// no HTML inspection (never applies to an upgraded connection anyway).
server.on('upgrade', (req, clientSocket, head) => {
  const backendSocket = net.connect(TARGET_PORT, TARGET_HOST, () => {
    const headerLines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (ORPHAN_HEADERS.includes(req.rawHeaders[i].toLowerCase())) continue;
      headerLines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    backendSocket.write(headerLines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) backendSocket.write(head);
    backendSocket.pipe(clientSocket);
    clientSocket.pipe(backendSocket);
  });
  backendSocket.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => backendSocket.destroy());
});

server.listen(Number(LISTEN_PORT), LISTEN_HOST, () => {
  const mode = BANNER_EXPIRES_AT
    ? 'banner from env (per-app sidecar)'
    : 'banner from X-Orphan-* request headers (shared instance)';
  console.log(`[orphan-proxy] listening on ${LISTEN_HOST}:${LISTEN_PORT}, proxying to ${TARGET_HOST}:${TARGET_PORT} — ${mode}`);
});
