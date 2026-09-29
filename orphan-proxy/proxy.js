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
// Shown as "Join N+ apps live on Embarko" in the footer.
const APPS_LIVE_COUNT = 1000;

const PROMPT_TO_DEPLOY = `
List this app on the Embarko Showcase (embarko.ai/showcase).

If it isn't deployed to Embarko yet, deploy it first: read https://embarko.ai/docs/agent-quickstart.md and follow it.
Use my deploy token — DEPLOY_TOKEN or ~/.embarko/credentials if either is set; if neither is, ask me for one from https://embarko.ai/app/tokens.

Then list it: read https://embarko.ai/docs/api.md#showcase for how to call the Showcase API.
Use my company's own Showcase page as the page slug (ask me for it if you can't tell), and these details, inferring what you can from the project and asking me for the rest:
- name and a one-line tagline
- what it does, and why it was built (a short paragraph each)
- creator name, and a profile link if I have one
- which AI built it (Claude, Codex, Cursor, Lovable, Replit, or other)
- a category (AI Tool, Personal, Business, Productivity, Education, Game, Developer Tool, Other) and a few tags
- a screenshot URL, and a video URL if there is one

When it's live, give me the link to its Showcase page.`

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

const EMBARKO_LOGO_SVG = '<svg class="fb-logo" viewBox="0 0 245 245" aria-hidden="true"><path d="M160.814 10.2161C170.654 9.8409 181.953 10.0699 191.858 10.0622C206.239 10.0092 220.619 10.0453 235 10.1702C233.881 12.4335 232.574 16.1623 231.5 18.6242C228.397 25.7222 225.516 31.6883 221.392 38.222C207.797 59.7602 188.871 73.0528 163.847 77.542C158.232 78.5493 152.569 79.1037 146.887 79.9221C140.545 80.8948 134.242 82.1144 127.993 83.5781C110.442 87.7762 96.8738 94.0396 81.2197 102.542C67.9784 110.667 55.8537 119.543 45.2649 131.08C43.3882 133.125 41.9269 135.482 40.2539 137.689C43.9665 125.108 47.6806 111.899 51.1877 99.2142C57.498 76.3896 62.3088 54.4298 79.2498 36.5815C102.089 12.5188 129.884 10.7803 160.814 10.2161Z" fill="currentColor"/><path d="M20.274 204.37C23.1248 192.924 27.7038 181.585 30.6594 170.158C32.9809 161.181 37.3719 155.745 42.7256 148.471C63.2563 120.579 95.4262 104.485 129.698 103.155C136.709 102.885 143.892 102.983 150.98 102.987C161.986 102.944 172.99 102.96 183.995 103.036C190.715 103.077 198.693 103.32 205.293 103.075C202.997 108.772 200.074 116.52 197.032 121.819C188.598 136.504 175.911 150.486 160.304 157.316C144.726 164.134 132.967 163.455 116.764 163.35C88.869 163.169 62.2926 171.497 40.144 188.701C33.4593 193.893 28.0684 199.519 22.0943 205.478C21.186 206.771 19.6305 208.519 18.5747 209.771C18.9406 208.227 19.7599 205.937 20.274 204.37Z" fill="currentColor"/><path d="M92.2857 184.037C103.114 183.192 117.676 184.546 128.782 184.705C144.418 184.929 159.94 184.922 175.577 184.932L189.842 184.908C192.668 184.897 196.095 184.979 198.868 184.647C194.889 190.952 191.513 196.544 186.634 202.328C175.038 216.079 158.911 225.853 141.725 230.669C133.536 232.964 125.313 233.938 116.913 234.654C101.028 234.96 85.1385 235.062 69.2503 234.964L10 234.929C11.8399 231.777 16.9894 224.685 19.325 221.969C39.6946 198.277 61.3318 186.485 92.2857 184.037Z" fill="currentColor"/></svg>';
const COPY_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

const FOOTER_CSS = [
  ':host{all:initial}',
  '*{box-sizing:border-box}',
  '.embarko-footer{--mx:70%;--my:40%;position:relative;overflow:hidden;background:#000;color:#d4d4d4;font:15px/1.5 Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased;text-align:left;border-top:1px solid rgba(255,255,255,.14)}',
  'a{color:inherit;text-decoration:none}',
  'button{font:inherit;color:inherit}',
  '.fb-glow{position:absolute;inset:-40%;background:radial-gradient(600px circle at var(--mx) var(--my),rgba(255,255,255,.12),transparent 45%);opacity:.6;filter:blur(40px);animation:ef-spin 18s linear infinite;pointer-events:none}',
  '.fb-in{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:32px;align-items:center;padding:40px 36px 28px}',
  '.fb-h{font-family:Inter,system-ui,sans-serif;font-weight:800;font-size:clamp(30px,3.6vw,48px);line-height:1.08;letter-spacing:-.045em;color:#fff;margin:0;text-wrap:balance}',
  '.fb-h>span{display:block}',
  '.fb-h .fb-l2{color:#8a8a8a;font-weight:700}',
  '.fb-h em{font-family:"Instrument Serif",serif;font-weight:400;font-style:italic;font-size:1.12em;letter-spacing:-.01em;line-height:0;color:#fff;padding:0 .04em}',
  '.fb-brand{display:inline-flex;align-items:center;gap:.14em;white-space:nowrap;vertical-align:bottom}',
  '.fb-logo{width:.78em;height:.78em;margin-left:.06em;transform:translateY(.02em)}',
  '.fb-cta{display:flex;justify-content:flex-end}',
  '.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:14px 22px;border-radius:14px;border:1px solid #fff;background:#fff;color:#000;cursor:pointer;font-weight:600;font-size:15px;box-shadow:0 8px 30px rgba(255,255,255,.12);transition:.2s}',
  '.btn:hover{transform:translateY(-1px);box-shadow:0 12px 40px rgba(255,255,255,.2)}',
  '.fb-sign{position:relative;display:flex;justify-content:space-between;gap:12px;padding:12px 36px;border-top:1px solid rgba(255,255,255,.2);font-size:11px;color:#737373}',
  '.fb-sign a:hover{color:#fff}',
  '.fb-sign b{color:#e5e5e5;font-weight:600}',
  '.fb-up{text-decoration:underline!important;text-underline-offset:3px;text-decoration-color:rgba(255,255,255,.25)!important}',
  '@keyframes ef-spin{to{transform:rotate(360deg)}}',
  '@media(max-width:900px){.fb-in{grid-template-columns:1fr;gap:14px}.fb-cta{justify-content:flex-start}}',
  '@media(max-width:600px){.fb-in{padding:32px 16px 24px}.fb-sign{padding:12px 16px}}',
  '@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}',
].join('');

// "This app is hosted on Embarko" footer, appended as the last element
// of <body> so it sits at the end of the page in normal flow. Same Shadow DOM isolation as the banner, for the same
// reasons; unlike the banner there is no unisolated fallback — this
// much styling would never survive a host page's CSS — so on a browser
// without attachShadow the footer is simply skipped.
// The app name is read from the page's own hostname (its subdomain), so
// the tag is identical for every app and every request — built once.
const FOOTER_TAG = `<script>(function () {
  if (!document.documentElement.attachShadow) return;
  var subdomain = location.hostname.split('.')[0];
  // "next-dynamic1" -> "Next Dynamic1"
  var appName = subdomain
    ? subdomain.split('-').map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ')
    : 'Your app';
  var appsLive = ${APPS_LIVE_COUNT};

  // Fonts have to be declared at document level — @font-face inside a
  // shadow root is not reliably honoured. Only adds font definitions,
  // no rules that could restyle the host page.
  if (!document.getElementById('__embarko_footer_fonts')) {
    var fonts = document.createElement('link');
    fonts.id = '__embarko_footer_fonts';
    fonts.rel = 'stylesheet';
    fonts.href = 'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@700;800&display=swap';
    (document.head || document.documentElement).appendChild(fonts);
  }

  var host = document.createElement('div');
  host.id = '__embarko_orphan_footer';
  host.style.cssText = 'all:initial;display:block;width:100%;';
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML =
    '<style>' + ${JSON.stringify(FOOTER_CSS)} + '</style>' +
    '<footer class="embarko-footer">' +
      '<div class="fb-glow"></div>' +
      '<div class="fb-in">' +
        '<h3 class="fb-h"><span class="fb-l1"><span data-ef="app">This app</span> is hosted on ' +
          '<a class="fb-brand" data-ef-link>' + ${JSON.stringify(EMBARKO_LOGO_SVG)} + 'Embarko</a></span>' +
          '<span class="fb-l2">Deploy yours with <em>one</em> prompt.</span></h3>' +
        '<div class="fb-cta"><button class="btn" type="button" data-ef="copy">' + ${JSON.stringify(COPY_ICON_SVG)} + 'Copy deployment prompt</button></div>' +
      '</div>' +
      '<div class="fb-sign"><a data-ef-link>Join <b data-ef="count"></b> apps live on Embarko</a>' +
        '<a class="fb-up" data-ef-link data-ef-path="pricing">Remove this footer \\u00b7 Upgrade</a></div>' +
    '</footer>';

  var f = root.querySelector('.embarko-footer');
  root.querySelector('[data-ef=app]').textContent = appName;
  root.querySelector('[data-ef=count]').textContent = appsLive.toLocaleString('en-US') + '+';
  root.querySelectorAll('[data-ef-link]').forEach(function (a) {
    var u = new URL('https://embarko.ai/' + (a.getAttribute('data-ef-path') || ''));
    if (subdomain) u.searchParams.set('ref', subdomain);
    u.searchParams.set('utm_source', 'free_footer');
    a.href = u.toString(); a.target = '_blank'; a.rel = 'noopener';
  });
  f.addEventListener('mousemove', function (e) {
    var r = f.getBoundingClientRect();
    f.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    f.style.setProperty('--my', (e.clientY - r.top) + 'px');
  });
  var btn = root.querySelector('[data-ef=copy]'), orig = btn.innerHTML;
  btn.addEventListener('click', function () {
    if (navigator.clipboard) navigator.clipboard.writeText(${JSON.stringify(PROMPT_TO_DEPLOY.trim())}).catch(function () {});
    btn.textContent = '\\u2713 Paste in your agent';
    setTimeout(function () { btn.innerHTML = orig; }, 1800);
  });

  function mount() { document.body.appendChild(host); }
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
