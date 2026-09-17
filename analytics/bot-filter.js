/**
 * analytics/bot-filter.js
 *
 * Decides whether a logged request represents a REAL visit or automated
 * background noise. Used by idle detection (see idle-report.js): an app
 * that has only been touched by credential scanners has not actually
 * been used, and under scale-to-zero it should be allowed to sleep
 * rather than be woken to serve a bot probing for its `.env`.
 *
 * Confirmed against real production data: a freshly deployed app picked
 * up ~2 requests/minute within seconds of its first TLS certificate —
 * /.env, /.env.local, /.git/config, /v2/_catalog, /trace.axd. Scanners
 * watch Certificate Transparency logs, so every new hostname gets this.
 * The traffic decays as the hostname stops being new (older apps on the
 * same box sit idle for hours), so this is about accuracy, not survival.
 *
 * BIAS: when unsure, call it REAL. The two failure directions are not
 * symmetric — treating bot traffic as real keeps an app awake that could
 * have slept (costs a little money, harms nobody), while treating real
 * traffic as bot puts a live app to sleep and inflicts a cold start on
 * an actual user. Everything here errs toward the first.
 *
 * Note what is deliberately NOT treated as a bot: curl, wget, and
 * similar CLI agents. They look automated, but on this platform they are
 * just as likely to be an app's real API client or someone's monitoring
 * script — that IS usage.
 */

// Self-identifying automation. Matched case-insensitively against the
// User-Agent. Search-engine crawlers are included: a crawl is not a user
// visit, and nothing breaks if an app is asleep when one arrives.
const BOT_UA_PATTERN =
  /(bot\b|crawler|spider|scraper|scanner|nuclei|zgrab|masscan|censys|shodan|internet-?measurement|semrush|ahrefs|mj12|dotbot|petalbot|bingpreview|facebookexternalhit|slackbot|whatsapp|telegrambot|headlesschrome|phantomjs|python-requests|go-http-client|libwww-perl|okhttp|java\/|nikto|sqlmap|dirbuster|gobuster|feroxbuster)/i;

// Paths that no legitimate visitor asks for. Independent of User-Agent,
// since a scanner can trivially send a browser UA — and it usually does.
// Kept narrow on purpose: every entry is something an app would never
// legitimately serve, so a real request can't be misclassified by it.
const SCAN_PATH_PATTERN =
  /^\/(\.env|\.git\/|\.aws\/|\.ssh\/|\.DS_Store|wp-admin|wp-login|wp-content|xmlrpc\.php|phpmyadmin|trace\.axd|v2\/_catalog|actuator|config\.json|\.vscode\/|\.idea\/|vendor\/|server-status|cgi-bin\/|admin\.php|shell\.php|eval-stdin\.php)/i;

// A request with NO User-Agent at all. Browsers and real HTTP clients
// always send one; bulk scanners frequently don't.
//
// IMPORTANT: this must distinguish "the log had an empty UA" from "this
// row predates User-Agent capture". A NULL user_agent means the latter —
// rows written before the column existed — and those must count as REAL,
// or every historical row would suddenly look like a bot and every app
// would appear idle. Only an explicitly empty string counts as missing.
function isBotRequest({ userAgent, path }) {
  if (typeof path === 'string' && SCAN_PATH_PATTERN.test(path)) return true;

  if (userAgent === null || userAgent === undefined) return false; // unknown -> treat as real
  if (userAgent === '' || userAgent === '-') return true;

  return BOT_UA_PATTERN.test(userAgent);
}

module.exports = { isBotRequest, BOT_UA_PATTERN, SCAN_PATH_PATTERN };
