/**
 * logger.js
 *
 * Every log line in this service goes through here so they all share one
 * shape: `<ISO timestamp> <request id>: <message>`. The request id comes
 * from request-context.js (AsyncLocalStorage) so every log made while
 * handling a deploy request — including deep inside claim-project.js,
 * record-deployment.js, etc. — is tagged with it automatically. Logs made
 * outside any request (startup, fatal env-var checks) get "-" instead.
 */
const { getRequestId } = require("./request-context");

function write(level, args) {
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  const requestId = getRequestId() || "-";
  fn(`${new Date().toISOString()} ${requestId}:`, ...args);
}

module.exports = {
  info: (...args) => write("info", args),
  warn: (...args) => write("warn", args),
  error: (...args) => write("error", args),
};
