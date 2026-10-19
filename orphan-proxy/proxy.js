/**
 * proxy.js — orphan-expiry banner injector, language/framework-agnostic.
 *
 * Sits in front of an orphan app's own container (only while
 * claim.isOrphan is true — see ../nomad-job-spec.js and
 * ../docs/Anonymous-deploy-req.md #5) — or, as ONE shared instance run
 * by the static-server Nomad job, in front of the static server for
 * every orphan STATIC app (../docs/Static-apps-req.md) — and rewrites any text/html
 * response to add a small expiry banner (top of the page, normal flow) and
 * a "hosted on Embarko" badge (a fixed pill, bottom-left of the viewport,
 * always visible like a chat-widget launcher), via a script tag injected
 * just before `</body>` (or appended, if none is found).
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

const BADGE_LOGO =
  '<svg class="mk" viewBox="0 0 245 245" aria-hidden="true"><path d="M160.814 10.2161C170.654 9.8409 181.953 10.0699 191.858 10.0622C206.239 10.0092 220.619 10.0453 235 10.1702C233.881 12.4335 232.574 16.1623 231.5 18.6242C228.397 25.7222 225.516 31.6883 221.392 38.222C207.797 59.7602 188.871 73.0528 163.847 77.542C158.232 78.5493 152.569 79.1037 146.887 79.9221C140.545 80.8948 134.242 82.1144 127.993 83.5781C110.442 87.7762 96.8738 94.0396 81.2197 102.542C67.9784 110.667 55.8537 119.543 45.2649 131.08C43.3882 133.125 41.9269 135.482 40.2539 137.689C43.9665 125.108 47.6806 111.899 51.1877 99.2142C57.498 76.3896 62.3088 54.4298 79.2498 36.5815C102.089 12.5188 129.884 10.7803 160.814 10.2161Z"/><path d="M20.274 204.37C23.1248 192.924 27.7038 181.585 30.6594 170.158C32.9809 161.181 37.3719 155.745 42.7256 148.471C63.2563 120.579 95.4262 104.485 129.698 103.155C136.709 102.885 143.892 102.983 150.98 102.987C161.986 102.944 172.99 102.96 183.995 103.036C190.715 103.077 198.693 103.32 205.293 103.075C202.997 108.772 200.074 116.52 197.032 121.819C188.598 136.504 175.911 150.486 160.304 157.316C144.726 164.134 132.967 163.455 116.764 163.35C88.869 163.169 62.2926 171.497 40.144 188.701C33.4593 193.893 28.0684 199.519 22.0943 205.478C21.186 206.771 19.6305 208.519 18.5747 209.771C18.9406 208.227 19.7599 205.937 20.274 204.37Z"/><path d="M92.2857 184.037C103.114 183.192 117.676 184.546 128.782 184.705C144.418 184.929 159.94 184.922 175.577 184.932L189.842 184.908C192.668 184.897 196.095 184.979 198.868 184.647C194.889 190.952 191.513 196.544 186.634 202.328C175.038 216.079 158.911 225.853 141.725 230.669C133.536 232.964 125.313 233.938 116.913 234.654C101.028 234.96 85.1385 235.062 69.2503 234.964L10 234.929C11.8399 231.777 16.9894 224.685 19.325 221.969C39.6946 198.277 61.3318 186.485 92.2857 184.037Z"/></svg>';

const FOOTER_CSS = [
  '*{box-sizing:border-box;margin:0}',
  // Surface tokens: light by default, dark via data-tone, more opaque via data-busy
  '.w{--s:rgba(255,255,255,.62);--ink:#111214;--mut:rgba(17,18,20,.6);--edge:rgba(0,0,0,.09);--hi:rgba(255,255,255,.6);',
  '--sh:0 1px 2px rgba(0,0,0,.05),0 6px 20px rgba(0,0,0,.07);--cta:#111214;--cta-ink:#fff;--cta-h:#2b2c2f;',
  '--pw:116px;--ph:32px;--cw:248px;--ch:150px;position:relative;display:inline-block}',
  '.b{position:relative;width:var(--pw);height:var(--ph);border-radius:16px;overflow:hidden;color:var(--ink);',
  'background:var(--s);-webkit-backdrop-filter:blur(20px) saturate(180%);backdrop-filter:blur(20px) saturate(180%);',
  'border:1px solid var(--edge);box-shadow:inset 0 1px 0 var(--hi),var(--sh);',
  'font:400 13px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif;letter-spacing:-.005em;-webkit-font-smoothing:antialiased;',
  'transition:width .3s cubic-bezier(.2,.8,.2,1),height .3s cubic-bezier(.2,.8,.2,1),border-radius .3s cubic-bezier(.2,.8,.2,1),background-color .3s ease,border-color .3s ease,color .3s ease}',
  '.w[data-busy]{--s:rgba(255,255,255,.86)}',
  '.w[data-tone=dark]{--s:rgba(30,30,32,.56);--ink:#f5f5f7;--mut:rgba(245,245,247,.62);--edge:rgba(255,255,255,.13);--hi:rgba(255,255,255,.07);',
  '--sh:0 1px 2px rgba(0,0,0,.3),0 6px 20px rgba(0,0,0,.35);--cta:#f5f5f7;--cta-ink:#111214;--cta-h:#fff}',
  '.w[data-tone=dark][data-busy]{--s:rgba(30,30,32,.84)}',
  '.b.open{width:var(--cw);height:var(--ch);border-radius:14px}',
  '.mk{display:block;width:14px;height:14px;flex:none;fill:currentColor}',
  'button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}',
  // Dismiss (hover-revealed, top-right corner of the capsule)
  '.dis{position:absolute;top:-7px;right:-7px;z-index:1;width:18px;height:18px;border-radius:50%;background:var(--s);-webkit-backdrop-filter:blur(20px) saturate(180%);backdrop-filter:blur(20px) saturate(180%);border:1px solid var(--edge);box-shadow:inset 0 1px 0 var(--hi),var(--sh);color:var(--ink);display:grid;place-items:center;opacity:0;transform:scale(.8);transition:opacity .15s ease,transform .15s ease,background-color .2s ease}',
  '.dis svg{width:8px;height:8px}',
  '.dis:hover{background:var(--edge)}',
  '.w:hover .dis,.w:focus-within .dis{opacity:1;transform:none}',
  '.w.open .dis{display:none}',
  // Touch: no hover to reveal the corner cross, so the card's header button hides the badge instead
  '.x .xc{display:none}',
  '@media (hover:none){.dis{display:none}.x .xv{display:none}.x .xc{display:block}}',
  // Pill
  '.pill{position:absolute;left:0;bottom:0;height:calc(var(--ph) - 2px);display:inline-flex;align-items:center;gap:6px;padding:0 13px 0 11px;font-weight:500;white-space:nowrap;transition:opacity .15s ease .12s}',
  '.open .pill{opacity:0;pointer-events:none;transition-delay:0s}',
  // Card
  '.card{position:absolute;left:0;bottom:0;width:calc(var(--cw) - 2px);padding:12px 12px 12px 14px;opacity:0;visibility:hidden;transform:translateY(4px);transition:opacity .15s ease,transform .2s ease,visibility 0s linear .2s}',
  '.open .card{opacity:1;visibility:visible;transform:none;transition:opacity .2s ease .1s,transform .25s ease .08s,visibility 0s}',
  '.hd{display:flex;align-items:center;gap:6px;font-weight:600}',
  '.x{margin-left:auto;width:24px;height:24px;display:grid;place-items:center;border-radius:7px;color:var(--mut)}',
  '.x:hover{background:var(--edge);color:var(--ink)}',
  '.x svg{width:12px;height:12px}',
  '.t{margin-top:8px;font-size:15px;font-weight:600;line-height:1.3;letter-spacing:-.01em;padding-right:2px}',
  '.d{margin-top:2px;color:var(--mut)}',
  '.cta{margin-top:12px;display:flex;align-items:center;justify-content:center;gap:6px;height:34px;border-radius:9px;background:var(--cta);color:var(--cta-ink);text-decoration:none;font-weight:600;transition:background .2s ease}',
  '.cta:hover{background:var(--cta-h)}',
  '.cta svg{width:13px;height:13px;transition:transform .2s ease}',
  '.cta:hover svg,.cta:focus-visible svg{transform:translate(2px,-2px)}',
  '.pill:focus-visible,.x:focus-visible,.dis:focus-visible,.cta:focus-visible{outline:2px solid var(--ink);outline-offset:2px;border-radius:10px}',
  '@media (max-width:420px){.b{--cw:min(240px,calc(100vw - 24px))}}',
  '@media (prefers-reduced-motion:reduce){*{transition-duration:0s!important;transition-delay:0s!important}}',
].join('');

const FOOTER_HTML =
  '<div class="w">' +
  '<button class="dis" type="button" aria-label="Hide Embarko badge"><svg viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>' +
  '<div class="b" role="complementary" aria-label="Hosted on Embarko">' +
  '<button class="pill" type="button" aria-expanded="false" aria-controls="c">' + BADGE_LOGO + '<span>Embarko</span></button>' +
  '<div class="card" id="c">' +
  '<div class="hd">' + BADGE_LOGO + '<span>Embarko</span>' +
  '<button class="x" type="button" aria-label="Collapse"><svg class="xv" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 4.5 6 7.5l3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><svg class="xc" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button></div>' +
  '<p class="t">Hosting made ridiculously easy.</p>' +
  '<p class="d">From simple websites and internal tools to full agentic applications.</p>' +
  '<a class="cta" data-em-link target="_blank" rel="noopener noreferrer">Make yours live<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 12 12 4M5 4h7v7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></a>' +
  '</div>' +
  '</div>' +
  '</div>';

const FOOTER_TAG = `<script>(function () {
  if (!document.documentElement.attachShadow) return;
  if (window.__embarkoBadge) return; window.__embarkoBadge = true;
  var ref = location.hostname.split('.')[0];

  // Shadow DOM keeps the badge's look safe from the host site's CSS
  var host = document.createElement('embarko-badge');
  host.id = '__embarko_orphan_footer';
  var root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = '<style>' + ${JSON.stringify(FOOTER_CSS)} + '</style>' + ${JSON.stringify(FOOTER_HTML)};

  var wrap = root.querySelector('.w'), box = root.querySelector('.b'), pill = root.querySelector('.pill'), card = root.querySelector('.card'), x = root.querySelector('.x'), dis = root.querySelector('.dis');
  // Dismissed for this page view only — nothing is stored, so a reload shows it again.
  var dismissed = false, observer = null, timer = null;

  root.querySelectorAll('[data-em-link]').forEach(function (a) {
    var u = new URL('https://embarko.ai/');
    if (ref) u.searchParams.set('ref', ref);
    u.searchParams.set('utm_source', 'free_badge');
    a.href = u.toString();
  });

  // ---- Mandatory: keep the badge attached, visible and at the bottom-left ----
  var HOST_STYLE = ['all:initial', 'position:fixed', 'left:max(min(16px,3.2vw),env(safe-area-inset-left))', 'bottom:max(min(16px,3.2vw),env(safe-area-inset-bottom))',
    'right:auto', 'top:auto', 'z-index:2147483646', 'display:block', 'visibility:visible', 'opacity:1', 'transform:none', 'filter:none', 'clip-path:none',
    'pointer-events:auto', 'width:auto', 'height:auto', 'margin:0', 'padding:0'].map(function (d) { return d + ' !important'; }).join(';');
  function enforce() {
    if (dismissed) return;
    if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
    if (host.getAttribute('style') !== HOST_STYLE) host.setAttribute('style', HOST_STYLE);
    ['hidden', 'inert', 'aria-hidden', 'class'].forEach(function (a) { if (host.hasAttribute(a)) host.removeAttribute(a); });
  }
  function mount() {
    enforce(); measure(); tone();
    var queued = false;
    observer = new MutationObserver(function (recs) {
      // Ignore pure attribute changes on the badge itself (our own writes)
      if (recs.every(function (r) { return r.type === 'attributes' && r.target === host; })) { enforce(); return; }
      if (queued) return; queued = true; setTimeout(function () { queued = false; enforce(); tone(); }, 200);
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    timer = setInterval(enforce, 2000);
  }

  // ---- Size the box to fit the pill and card exactly ----
  function measure() {
    box.style.setProperty('--pw', (pill.offsetWidth + 2) + 'px');
    box.style.setProperty('--ch', (card.offsetHeight + 2) + 'px');
  }

  // ---- Adaptive contrast: read what sits behind the badge ----
  var cv = document.createElement('canvas').getContext('2d');
  function rgba(str) {
    if (!str || str === 'transparent') return null;
    cv.fillStyle = '#000'; cv.fillStyle = str; var v = cv.fillStyle, m;
    if (v[0] === '#') return { r: parseInt(v.substr(1, 2), 16), g: parseInt(v.substr(3, 2), 16), b: parseInt(v.substr(5, 2), 16), a: 1 };
    if ((m = v.match(/rgba?\\(([^)]+)\\)/))) { var p = m[1].split(/[\\s,\\/]+/).map(parseFloat); return { r: p[0], g: p[1], b: p[2], a: p[3] == null ? 1 : p[3] }; }
    return null;
  }
  function lum(c) { function f(v) { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); } return .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b); }
  var MEDIA = { IMG: 1, VIDEO: 1, CANVAS: 1, IFRAME: 1, PICTURE: 1, svg: 1, EMBED: 1, OBJECT: 1 };
  // Composite the stack of elements under one point, top to bottom
  function sample(px, py) {
    var els = document.elementsFromPoint(px, py), acc = { r: 0, g: 0, b: 0, a: 0 }, busy = false, unknown = false, top = null;
    for (var i = 0; i < els.length && acc.a < .99; i++) {
      var el = els[i]; if (el === host) continue; if (!top) top = el;
      if (MEDIA[el.tagName]) { busy = unknown = true; break; }
      var cs = getComputedStyle(el), c = rgba(cs.backgroundColor);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') {
        busy = true;
        // Gradients: average their colour stops. url() images can't be read
        var stops = cs.backgroundImage.match(/rgba?\\([^)]+\\)|#[0-9a-f]{3,8}\\b/gi);
        if (/url\\(/.test(cs.backgroundImage) || !stops) { unknown = true; break; }
        var s = { r: 0, g: 0, b: 0 }; stops.forEach(function (t) { var k = rgba(t) || { r: 0, g: 0, b: 0 }; s.r += k.r; s.g += k.g; s.b += k.b; });
        var n = stops.length; c = { r: s.r / n, g: s.g / n, b: s.b / n, a: 1 };
      }
      if (c && c.a > 0) { var w = (1 - acc.a) * c.a; acc.r += c.r * w; acc.g += c.g * w; acc.b += c.b * w; acc.a += w; }
    }
    // Fill what's left: white page canvas, or, behind images/video, a guess from the site's
    // own text colour there (light text means the site made that area dark)
    var fill = 255;
    if (unknown && top) { var tc = rgba(getComputedStyle(top).color); if (tc && lum(tc) > .4) fill = 0; }
    if (acc.a < .99) { var w2 = 1 - acc.a; acc.r += fill * w2; acc.g += fill * w2; acc.b += fill * w2; }
    return { l: lum(acc), busy: busy };
  }
  var lastTone = '';
  function tone() {
    if (dismissed || !host.isConnected) return;
    var r = host.getBoundingClientRect(), open = box.classList.contains('open');
    var w = open ? card.offsetWidth : r.width, h = open ? card.offsetHeight : r.height;
    var L = r.left, B = r.bottom, ls = [], busy = false;
    for (var i = 0; i < 3; i++) for (var j = 0; j < 2; j++) {
      var s = sample(L + 4 + (w - 8) * i / 2, B - 4 - (h - 8) * j); ls.push(s.l); busy = busy || s.busy;
    }
    var avg = ls.reduce(function (a, b) { return a + b; }, 0) / ls.length;
    var spread = Math.max.apply(0, ls) - Math.min.apply(0, ls);
    if (spread > .3) busy = true; // mixed light and dark behind it
    // Small dead zone so it doesn't flicker between tones
    var t = avg < .16 ? 'dark' : avg > .24 ? 'light' : (lastTone || 'light');
    lastTone = t; wrap.setAttribute('data-tone', t);
    if (busy) wrap.setAttribute('data-busy', ''); else wrap.removeAttribute('data-busy');
  }
  var raf = 0; function soon() { if (!raf) raf = requestAnimationFrame(function () { raf = 0; tone(); }); }
  window.addEventListener('scroll', soon, { passive: true });
  window.addEventListener('resize', function () { measure(); soon(); });

  // ---- Open / close ----
  function setOpen(o, focusPill) {
    box.classList.toggle('open', o); wrap.classList.toggle('open', o); pill.setAttribute('aria-expanded', o); tone();
    if (o) setTimeout(function () { root.querySelector('.cta').focus({ preventScroll: true }); }, 60);
    else if (focusPill) pill.focus({ preventScroll: true });
    // Outside click: the card's link still holds focus for a tick, which would flash the corner cross via :focus-within
    else if (root.activeElement) root.activeElement.blur();
  }
  pill.addEventListener('click', function () { setOpen(true); });
  function dismiss(e) {
    e.stopPropagation(); dismissed = true;
    if (observer) observer.disconnect();
    if (timer) clearInterval(timer);
    if (host.parentNode) host.parentNode.removeChild(host);
  }
  dis.addEventListener('click', dismiss);
  // Touch devices: the card's header button closes the badge (no hover to reveal the corner cross)
  var touch = matchMedia('(hover:none)').matches;
  if (touch) x.setAttribute('aria-label', 'Hide Embarko badge');
  x.addEventListener('click', function (e) { if (touch) dismiss(e); else setOpen(false, true); });
  document.addEventListener('pointerdown', function (e) { if (box.classList.contains('open') && e.composedPath().indexOf(host) < 0) setOpen(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && box.classList.contains('open')) setOpen(false, true); });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
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

// This sidecar listens before the app behind it does (cold start, redeploy).
// A refused connection in that gap is "not up yet": retry for a bounded
// window before answering 502. The client body is only piped once the
// backend socket has connected, so a failed connect leaves it untouched
// and replayable — no buffering, no size cap.
const BACKEND_WAIT_MS = Number(process.env.BACKEND_WAIT_MS) || 60000;
const BACKEND_RETRY_DELAY_MS = 300;
const RETRYABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'EPIPE']);

// Injecting the banner means buffering the whole HTML body (raw chunks,
// joined buffer, rewritten string — roughly 3x the page size). Bound
// that: an HTML response bigger than this is streamed through with no
// banner rather than held in memory. Real pages are well under 100KB.
const BANNER_MAX_HTML_BYTES = Number(process.env.BANNER_MAX_HTML_BYTES) || 3 * 1024 * 1024;
// Caps on how many in-flight requests can hold buffers at once and for
// how long, so slow or stuck clients cannot pile memory up until the
// container is OOM killed.
const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS) || 1000;
const HEADERS_TIMEOUT_MS = Number(process.env.HEADERS_TIMEOUT_MS) || 30000;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) || 300000;
const KEEPALIVE_TIMEOUT_MS = Number(process.env.KEEPALIVE_TIMEOUT_MS) || 5000;

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

  const deadline = Date.now() + BACKEND_WAIT_MS;
  let waited = false;

  const attempt = () => {
    let piped = false;
    const proxyReq = http.request(
      { host: TARGET_HOST, port: TARGET_PORT, method: clientReq.method, path: clientReq.url, headers },
      (proxyRes) => {
        const contentType = proxyRes.headers['content-type'] || '';
        const declaredLength = Number(proxyRes.headers['content-length']);
        const tooBig = Number.isFinite(declaredLength) && declaredLength > BANNER_MAX_HTML_BYTES;
        if (!banner || !contentType.startsWith('text/html') || tooBig) {
          clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(clientRes);
          return;
        }

        // Buffer the body; if it turns out bigger than the cap (no or
        // wrong content-length), stop buffering and flush what we have
        // plus the rest, untouched.
        const chunks = [];
        let received = 0;
        let bailed = false;
        proxyRes.on('data', (chunk) => {
          if (bailed) return;
          received += chunk.length;
          chunks.push(chunk);
          if (received > BANNER_MAX_HTML_BYTES) {
            bailed = true;
            const outHeaders = { ...proxyRes.headers };
            delete outHeaders['content-length'];
            clientRes.writeHead(proxyRes.statusCode, outHeaders);
            for (const c of chunks) clientRes.write(c);
            chunks.length = 0;
            proxyRes.pipe(clientRes);
          }
        });
        proxyRes.on('end', () => {
          if (bailed) return;
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

    // Send the body only once the backend has accepted the connection.
    proxyReq.on('socket', (socket) => {
      const start = () => {
        piped = true;
        if (waited) console.log(`[orphan-proxy] backend came up, ${clientReq.method} ${clientReq.url} forwarded`);
        clientReq.pipe(proxyReq);
      };
      if (socket.connecting) socket.once('connect', start);
      else start();
    });

    proxyReq.on('error', (err) => {
      const canRetry = !piped && RETRYABLE.has(err.code) && !clientRes.headersSent && Date.now() < deadline;
      if (canRetry) {
        if (!waited) {
          waited = true;
          console.log(`[orphan-proxy] backend not ready (${err.code}), waiting up to ${BACKEND_WAIT_MS}ms for ${clientReq.method} ${clientReq.url}`);
        }
        setTimeout(attempt, BACKEND_RETRY_DELAY_MS);
        return;
      }
      console.error('[orphan-proxy] backend request failed:', err.message);
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      clientRes.end('Bad Gateway');
    });
  };
  attempt();
});

// WebSocket / other Upgrade requests — raw byte pipe straight through.
// Same startup retry as above until the handshake has been forwarded.
server.on('upgrade', (req, clientSocket, head) => {
  const deadline = Date.now() + BACKEND_WAIT_MS;
  clientSocket.on('error', () => { });

  const connect = () => {
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
      clientSocket.on('error', () => backendSocket.destroy());
    });
    backendSocket.on('error', (err) => {
      if (!backendSocket.connecting && backendSocket.bytesWritten > 0) {
        clientSocket.destroy(); // failed after handshake: nothing to replay
        return;
      }
      if (RETRYABLE.has(err.code) && Date.now() < deadline && !clientSocket.destroyed) {
        setTimeout(connect, BACKEND_RETRY_DELAY_MS);
        return;
      }
      clientSocket.destroy();
    });
  };
  connect();
});

server.maxConnections = MAX_CONNECTIONS;
server.headersTimeout = HEADERS_TIMEOUT_MS;
server.requestTimeout = REQUEST_TIMEOUT_MS;
server.keepAliveTimeout = KEEPALIVE_TIMEOUT_MS;

server.listen(Number(LISTEN_PORT), LISTEN_HOST, () => {
  const mode = FOOTER_ALWAYS
    ? 'banner from env (per-app sidecar)'
    : 'banner from X-Orphan-* request headers (shared instance)';
  console.log(`[orphan-proxy] listening on ${LISTEN_HOST}:${LISTEN_PORT}, proxying to ${TARGET_HOST}:${TARGET_PORT} — ${mode}`);
});
