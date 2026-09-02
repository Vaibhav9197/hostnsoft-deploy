/**
 * logger.js
 *
 * Every log line in this service goes through here so they all share one
 * shape: `[<ISO timestamp>] [<LEVEL>] <message>`. Before this, call sites
 * used raw console.log/warn/error inconsistently, with no timestamp —
 * made it hard to correlate a log line with a specific deploy attempt or
 * tell how stale a line in a scrollback was.
 */
function write(level, args) {
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  fn(`[${new Date().toISOString()}] [${level.toUpperCase()}]`, ...args);
}

module.exports = {
  info: (...args) => write("info", args),
  warn: (...args) => write("warn", args),
  error: (...args) => write("error", args),
};
