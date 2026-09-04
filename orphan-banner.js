/**
 * orphan-banner.js
 *
 * Injects a standalone script (and a reference to it) into an anonymous
 * ("orphan") deploy's source before it's built — see
 * docs/Anonymous-deploy-req.md #5 — so anyone who visits the live URL
 * directly sees the same expiry warning the deploy response itself
 * carries.
 *
 * Known limitation, accepted rather than solved: this only works for
 * apps with a static `index.html` at the source root the platform can
 * modify pre-build (true for most frontend frameworks, whose build
 * tooling generally carries an existing index.html template through to
 * the final output). A pure backend/API-only app has no generic
 * injection point and is silently skipped — it's still tracked and
 * torn down identically at expiry, it just won't display an in-app
 * notice. The deploy response's `orphan.message` is the notice of
 * record regardless of whether this succeeds.
 */
const fs = require('fs-extra');
const path = require('path');
const logger = require('./logger');

const SCRIPT_FILENAME = 'orphan-script.js';

function buildBannerScript(expiresAtIso, loginUrl) {
  // JSON.stringify here is just safe JS-literal escaping for these two
  // strings, not data interchange.
  const expiresAtLiteral = JSON.stringify(expiresAtIso);
  const loginUrlLiteral = JSON.stringify(loginUrl);
  return `(function () {
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
})();
`;
}

async function injectOrphanBanner(buildDir, expiresAtIso, loginUrl) {
  const indexPath = path.join(buildDir, 'index.html');
  if (!(await fs.pathExists(indexPath))) {
    logger.info('[orphan-banner] no index.html in source root — skipping in-app notice (backend/API-only app, or a framework whose build output moves it elsewhere)');
    return;
  }

  await fs.writeFile(path.join(buildDir, SCRIPT_FILENAME), buildBannerScript(expiresAtIso, loginUrl));

  const html = await fs.readFile(indexPath, 'utf8');
  const scriptTag = `<script src="/${SCRIPT_FILENAME}"></script>`;
  const injected = html.includes('</body>')
    ? html.replace('</body>', `${scriptTag}\n</body>`)
    : `${html}\n${scriptTag}\n`;
  await fs.writeFile(indexPath, injected);
  logger.info('[orphan-banner] injected expiry notice into index.html');
}

module.exports = { injectOrphanBanner };
