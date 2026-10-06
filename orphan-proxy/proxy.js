/**
 * proxy.js — orphan-expiry banner injector, language/framework-agnostic.
 *
 * Sits in front of an orphan app's own container (only while
 * claim.isOrphan is true — see ../nomad-job-spec.js and
 * ../docs/Anonymous-deploy-req.md #5) — or, as ONE shared instance run
 * by the static-server Nomad job, in front of the static server for
 * every orphan STATIC app (../docs/Static-apps-req.md) — and rewrites any text/html
 * response to add a small expiry banner (top of the page) and a "hosted on
 * Embarko" footer (end of the page), both in normal flow, via a script
 * tag injected just before `</body>` (or appended, if none is found).
 * Every other response — JSON, assets,
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
// Footer: always injected for orphan AND free-plan apps. Sidecar: env
// FOOTER=1; shared static instance: X-Embarko-Footer: 1 request header.
// The expiry banner (header) is only injected when expiry/login are set,
// i.e. only for orphan apps.
const FOOTER_ALWAYS = process.env.FOOTER === '1';
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
  // In normal flow as the first child of <body>, not position:fixed —
  // a fixed bar sat on top of the app's own first ~40px (its header,
  // nav, title) and hid it. In flow, it pushes the page down instead.
  host.style.cssText = 'all:initial;display:block;width:100%;';

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
  bar.appendChild(document.createTextNode(', '));
  var linkEl = document.createElement('a');
  linkEl.href = loginUrl;
  if (!isolated) linkEl.style.cssText = 'color:#8ab4ff;text-decoration:underline;';
  linkEl.textContent = 'follow instructions on your AI agent to keep it';
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
    textEl.textContent = 'This app will be deleted in ' + pad(hh) + ':' + pad(mm) + ' hours';
  }

  function mount() {
    function place() { document.body.insertBefore(host, document.body.firstChild); }
    if (document.body) {
      place();
    } else {
      document.addEventListener('DOMContentLoaded', place);
    }
    render();
    setInterval(render, 30000);
  }
  mount();
})();</script>`;
}

const FOOTER_CSS = [
  ':host{all:initial;display:block;width:100%}',
  '*{box-sizing:border-box;margin:0}',
  '.embarko-colophon{--bg:#faf9f6;--ink:#20201f;--muted:#6a6863;--line:#dcd9d2;width:100%;padding:0 36px;background:var(--bg);color:var(--ink);border-top:1px solid var(--line);font:400 12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;text-align:center;-webkit-font-smoothing:antialiased}',
  '.em-dark{--bg:#171817;--ink:#f0efeb;--muted:#b2b1ab;--line:#363735;color-scheme:dark}',
  '.em-inner{max-width:1160px;min-height:150px;margin:0 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px}',
  '.em-line{font:italic 24px/1.3 Georgia,"Times New Roman",serif;color:var(--ink)}',
  '.em-bottom{display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap}',
  '.em-credit{display:inline-flex;align-items:center;gap:7px;color:var(--muted);font-size:15px}',
  '.em-brand{display:inline-flex;align-items:center;gap:7px;white-space:nowrap;color:var(--ink);text-decoration:none}',
  '.em-mark{display:block;width:18px;height:18px;flex:none;fill:currentColor;transition:transform .3s ease}',
  '.em-word{font-weight:550;font-size:16px;letter-spacing:-.25px}',
  '.em-dot{width:3px;height:3px;border-radius:50%;background:var(--muted)}',
  '.em-cta{display:inline-flex;align-items:center;gap:8px;min-height:32px;color:var(--ink);text-decoration:none;font:400 15px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;white-space:nowrap;cursor:pointer}',
  '.em-arrow{width:16px;height:16px;flex:none;transition:transform .22s ease}',
  '.em-cta:hover .em-label{text-decoration:underline;text-underline-offset:4px}',
  '.em-cta:hover .em-arrow,.em-cta:focus-visible .em-arrow{transform:translate(2px,-2px)}',
  '.em-inner:has(.em-cta:hover) .em-mark{transform:translateX(3px)}',
  'a:focus-visible{outline:2px solid var(--ink);outline-offset:5px;border-radius:4px}',
  '@media (max-width:600px){.embarko-colophon{padding:0 22px}.em-inner{min-height:136px}.em-line{font-size:20px}.em-bottom{gap:9px}}',
  '@media (prefers-reduced-motion:reduce){.em-mark,.em-arrow{transition:none}}',
].join('');

const FOOTER_HTML =
  '<footer class="embarko-colophon em-dark" aria-label="Hosting credit: Embarko">' +
    '<div class="em-inner">' +
      '<p class="em-line">A little place on the internet.</p>' +
      '<div class="em-bottom">' +
        '<span class="em-credit">Hosted on <a class="em-brand" data-em-link>' +
          '<svg class="em-mark" viewBox="0 0 245 245" aria-hidden="true"><path d="M160.814 10.2161C170.654 9.8409 181.953 10.0699 191.858 10.0622C206.239 10.0092 220.619 10.0453 235 10.1702C233.881 12.4335 232.574 16.1623 231.5 18.6242C228.397 25.7222 225.516 31.6883 221.392 38.222C207.797 59.7602 188.871 73.0528 163.847 77.542C158.232 78.5493 152.569 79.1037 146.887 79.9221C140.545 80.8948 134.242 82.1144 127.993 83.5781C110.442 87.7762 96.8738 94.0396 81.2197 102.542C67.9784 110.667 55.8537 119.543 45.2649 131.08C43.3882 133.125 41.9269 135.482 40.2539 137.689C43.9665 125.108 47.6806 111.899 51.1877 99.2142C57.498 76.3896 62.3088 54.4298 79.2498 36.5815C102.089 12.5188 129.884 10.7803 160.814 10.2161Z"/><path d="M20.274 204.37C23.1248 192.924 27.7038 181.585 30.6594 170.158C32.9809 161.181 37.3719 155.745 42.7256 148.471C63.2563 120.579 95.4262 104.485 129.698 103.155C136.709 102.885 143.892 102.983 150.98 102.987C161.986 102.944 172.99 102.96 183.995 103.036C190.715 103.077 198.693 103.32 205.293 103.075C202.997 108.772 200.074 116.52 197.032 121.819C188.598 136.504 175.911 150.486 160.304 157.316C144.726 164.134 132.967 163.455 116.764 163.35C88.869 163.169 62.2926 171.497 40.144 188.701C33.4593 193.893 28.0684 199.519 22.0943 205.478C21.186 206.771 19.6305 208.519 18.5747 209.771C18.9406 208.227 19.7599 205.937 20.274 204.37Z"/><path d="M92.2857 184.037C103.114 183.192 117.676 184.546 128.782 184.705C144.418 184.929 159.94 184.922 175.577 184.932L189.842 184.908C192.668 184.897 196.095 184.979 198.868 184.647C194.889 190.952 191.513 196.544 186.634 202.328C175.038 216.079 158.911 225.853 141.725 230.669C133.536 232.964 125.313 233.938 116.913 234.654C101.028 234.96 85.1385 235.062 69.2503 234.964L10 234.929C11.8399 231.777 16.9894 224.685 19.325 221.969C39.6946 198.277 61.3318 186.485 92.2857 184.037Z"/></svg>' +
          '<span class="em-word">Embarko</span></a></span>' +
        '<span class="em-dot" aria-hidden="true"></span>' +
        '<a class="em-cta" data-em-link aria-label="Host your own app on Embarko (opens in a new tab)"><span class="em-label">Host yours</span>' +
          '<svg class="em-arrow" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 12.5 12 4M4 4h8v8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></a>' +
      '</div>' +
    '</div>' +
  '</footer>';

// "Hosted on Embarko" colophon, appended as the last element of <body>
// so it sits at the end of the page in normal flow. Same Shadow DOM
// isolation as the banner, for the same reasons; unlike the banner there
// is no unisolated fallback — on a browser without attachShadow the
// footer is simply skipped. The ref is the page's own subdomain, so the
// tag is identical for every app and every request — built once.
const FOOTER_TAG = `<script>(function () {
  if (!document.documentElement.attachShadow) return;
  var ref = location.hostname.split('.')[0];

  var host = document.createElement('div');
  host.id = '__embarko_orphan_footer';
  // Normal flow, last child of <body>. High z-index so a page's fixed
  // sidebar/nav cannot sit over it.
  host.style.cssText = 'all:initial;display:block;width:100%;position:relative;z-index:2147483647;';
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<style>' + ${JSON.stringify(FOOTER_CSS)} + '</style>' + ${JSON.stringify(FOOTER_HTML)};

  root.querySelectorAll('[data-em-link]').forEach(function (a) {
    var u = new URL('https://embarko.ai/');
    if (ref) u.searchParams.set('ref', ref);
    u.searchParams.set('utm_source', 'free_footer_colophon');
    a.href = u.toString(); a.target = '_blank'; a.rel = 'noopener noreferrer';
  });

  // Apps that render inside their own fixed full-viewport scroll box
  // (Streamlit, some dashboards) leave <body> with no flow height, so a
  // body-level footer lands at the TOP of the viewport. When that
  // happens, append it at the end of that scroll box instead.
  // ponytail: picks the first big overflow:auto element; good enough
  // for Streamlit/Gradio, revisit if a nested-scroller app misplaces it.
  function scrollBox() {
    var els = document.body.getElementsByTagName('*');
    for (var i = 0; i < els.length; i++) {
      var el = els[i], cs = getComputedStyle(el);
      if (el === host) continue;
      if (/auto|scroll/.test(cs.overflowY) && el.clientHeight >= innerHeight * .5 && el.clientWidth >= innerWidth * .5) return el;
    }
    return null;
  }
  var container = document.body, pending = false;
  function place() {
    pending = false;
    if (!container.isConnected || (container === document.body && document.body.scrollHeight <= innerHeight && host.getBoundingClientRect().top < innerHeight * .5)) {
      container = scrollBox() || document.body;
    }
    // SPAs (Next/React hydration) append their root AFTER this script
    // ran, which pushed the footer above the app. Keep it last.
    if (container.lastElementChild !== host) container.appendChild(host);
  }
  function mount() {
    place();
    new MutationObserver(function () {
      if (!pending) { pending = true; requestAnimationFrame(place); }
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();</script>`;

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
    tag = expiresAt ? `${buildBannerTag(expiresAt, loginUrl)}\n${FOOTER_TAG}` : FOOTER_TAG;
    bannerCache.set(key, tag);
  }
  return tag;
}

// Set by Traefik on an orphan static app's router; this proxy's
// business, not the app's, so they are stripped before forwarding.
const ORPHAN_HEADERS = ['x-orphan-expires-at', 'x-orphan-login-url', 'x-embarko-footer'];

// Where this request's banner values come from: the request's own
// headers (shared instance) or this process's env (sidecar). null when
// there is nothing to inject.
function bannerConfigFor(req) {
  const expiresAt = req.headers['x-orphan-expires-at'] || BANNER_EXPIRES_AT;
  const loginUrl = req.headers['x-orphan-login-url'] || BANNER_LOGIN_URL;
  const orphan = !!(expiresAt && loginUrl);
  const footer = FOOTER_ALWAYS || req.headers['x-embarko-footer'] === '1';
  if (!orphan && !footer) return null;
  return { expiresAt: orphan ? String(expiresAt) : '', loginUrl: orphan ? String(loginUrl) : '' };
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
  const mode = FOOTER_ALWAYS
    ? 'banner from env (per-app sidecar)'
    : 'banner from X-Orphan-* request headers (shared instance)';
  console.log(`[orphan-proxy] listening on ${LISTEN_HOST}:${LISTEN_PORT}, proxying to ${TARGET_HOST}:${TARGET_PORT} — ${mode}`);
});
