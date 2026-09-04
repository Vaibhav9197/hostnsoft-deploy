/**
 * proxy.js — orphan-expiry banner injector, language/framework-agnostic.
 *
 * Sits in front of an orphan app's own container (only while
 * claim.isOrphan is true — see ../nomad-job-spec.js and
 * ../docs/Anonymous-deploy-req.md #5) and rewrites any text/html
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
 * Reaches the real app via 127.0.0.1 using Nomad's own dynamically
 * allocated host port for it (TARGET_PORT) — the exact same mechanism
 * Traefik itself already uses to reach every app container, see this
 * task's `network_mode = "host"` in nomad-job-spec.js.
 */
'use strict';

const http = require('http');
const net = require('net');

const LISTEN_PORT = process.env.LISTEN_PORT;
const TARGET_PORT = process.env.TARGET_PORT;
const BANNER_EXPIRES_AT = process.env.BANNER_EXPIRES_AT;
const BANNER_LOGIN_URL = process.env.BANNER_LOGIN_URL;

for (const [name, value] of Object.entries({ LISTEN_PORT, TARGET_PORT, BANNER_EXPIRES_AT, BANNER_LOGIN_URL })) {
  if (!value) {
    console.error(`[orphan-proxy] FATAL: ${name} environment variable is not set.`);
    process.exit(1);
  }
}

function buildBannerTag() {
  // JSON.stringify here is just safe JS-literal escaping for these two
  // strings, not data interchange.
  const expiresAtLiteral = JSON.stringify(BANNER_EXPIRES_AT);
  const loginUrlLiteral = JSON.stringify(BANNER_LOGIN_URL);
  return `<script>(function () {
  var expiresAt = new Date(${expiresAtLiteral});
  var loginUrl = ${loginUrlLiteral};
  var el = document.createElement('div');
  el.id = '__embarko_orphan_banner';
  el.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:2147483647;' +
    'background:#1a1a1a;color:#fff;font:13px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;' +
    'padding:10px 16px;text-align:center;';
  el.innerHTML = 'This app will be deleted at ' + expiresAt.toLocaleString() +
    ' \\u2014 <a href="' + loginUrl + '" style="color:#8ab4ff;text-decoration:underline;">log in to keep it</a>';
  function mount() {
    if (document.body) {
      document.body.appendChild(el);
    } else {
      document.addEventListener('DOMContentLoaded', function () {
        document.body.appendChild(el);
      });
    }
  }
  mount();
})();</script>`;
}

const BANNER_TAG = buildBannerTag();

function injectBanner(html) {
  return html.includes('</body>')
    ? html.replace('</body>', `${BANNER_TAG}\n</body>`)
    : `${html}\n${BANNER_TAG}\n`;
}

const server = http.createServer((clientReq, clientRes) => {
  // Ask the backend for uncompressed output — lets us safely
  // string-rewrite text/html bodies without gunzip/regzip. Every other
  // content type is streamed straight through regardless, untouched.
  const headers = { ...clientReq.headers };
  delete headers['accept-encoding'];

  const proxyReq = http.request(
    { host: '127.0.0.1', port: TARGET_PORT, method: clientReq.method, path: clientReq.url, headers },
    (proxyRes) => {
      const contentType = proxyRes.headers['content-type'] || '';
      if (!contentType.startsWith('text/html')) {
        clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(clientRes);
        return;
      }

      const chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('end', () => {
        const injected = injectBanner(Buffer.concat(chunks).toString('utf8'));
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
  const backendSocket = net.connect(TARGET_PORT, '127.0.0.1', () => {
    const headerLines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
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

server.listen(Number(LISTEN_PORT), '0.0.0.0', () => {
  console.log(`[orphan-proxy] listening on :${LISTEN_PORT}, proxying to 127.0.0.1:${TARGET_PORT}`);
});
