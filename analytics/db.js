/**
 * analytics/db.js
 *
 * Local, per-environment time-series store backing GET
 * /internal/apps/:appName/analytics — see access-log-tailer.js (traffic)
 * and resource-poller.js (CPU/memory) for what populates it, and
 * query.js for how it's read back.
 *
 * Deliberately lives OUTSIDE this repo's own checkout (ANALYTICS_DB_PATH
 * is computed by server-setup.sh under /opt/hostnsoft-analytics/<env>/,
 * never inside this git-managed directory) — server-setup.sh's own
 * clean_pull() does `git reset --hard && git clean -fd` on every re-run,
 * which would destroy any file living inside this checkout.
 *
 * Uses Node's own built-in node:sqlite (stable since Node 22.5) rather
 * than a third-party SQLite package — one less native module that has
 * to successfully compile on a fresh production host.
 *
 * prod/test/demo all share exactly ONE Traefik instance and ONE access
 * log (see server-setup.sh's Traefik section: "There is only ONE
 * Traefik job regardless of environment") — each environment's own
 * hostnsoft-deploy independently tails that SAME shared log into its
 * OWN local DB here, rather than standing up one shared singleton
 * ingestion service. Since app slugs are unique platform-wide, every
 * environment's DB ends up holding a complete (if redundant across
 * environments) copy of every app's analytics — harmless duplication at
 * this platform's current scale, and far simpler to operate.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const logger = require('../logger');

let db = null;

// Shared guard used by the tailer, poller, and retention loop — all
// three ultimately call getDb(), which throws if ANALYTICS_DB_PATH
// isn't set. Checking this up front (instead of letting that throw
// happen on the first tick) avoids each of them spinning up anyway and
// then logging the same failure forever, once per poll interval.
function isAnalyticsEnabled() {
  return Boolean(process.env.ANALYTICS_DB_PATH);
}

function getDb() {
  if (db) return db;

  const dbPath = process.env.ANALYTICS_DB_PATH;
  if (!dbPath) {
    throw new Error('ANALYTICS_DB_PATH is not set');
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  // WAL so the tailer/poller (writers) and an incoming analytics request
  // (reader) never block each other.
  db.exec('PRAGMA journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_name TEXT NOT NULL,
      ts INTEGER NOT NULL,
      status INTEGER NOT NULL,
      duration_ms REAL NOT NULL,
      path TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_request_log_app_ts ON request_log(app_name, ts);

    CREATE TABLE IF NOT EXISTS resource_sample (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_name TEXT NOT NULL,
      ts INTEGER NOT NULL,
      cpu_percent REAL,
      memory_mb REAL
    );
    CREATE INDEX IF NOT EXISTS idx_resource_sample_app_ts ON resource_sample(app_name, ts);

    -- One row, keyed by the log file's own path — lets the tailer resume
    -- from where it left off across restarts, and detect rotation (a
    -- changed inode, or a file that's now smaller than our last offset).
    CREATE TABLE IF NOT EXISTS tail_state (
      log_path TEXT PRIMARY KEY,
      inode INTEGER NOT NULL,
      byte_offset INTEGER NOT NULL
    );
  `);

  // Additive migration rather than a change to the CREATE TABLE above:
  // every existing deployment already has a request_log, so a new column
  // in the CREATE statement would only ever apply to a fresh database.
  //
  // Left NULLABLE on purpose, and rows written before this existed stay
  // NULL. analytics/bot-filter.js treats NULL as "unknown, assume real"
  // — the alternative (defaulting to '') would make every historical
  // request look like a bot with no User-Agent, which would make every
  // app on the box appear instantly idle. That is exactly the kind of
  // mistake that, downstream of scale-to-zero, stops a live app.
  const requestLogColumns = db.prepare('PRAGMA table_info(request_log)').all();
  if (!requestLogColumns.some((c) => c.name === 'user_agent')) {
    db.exec('ALTER TABLE request_log ADD COLUMN user_agent TEXT');
    logger.info('[analytics-db] migrated request_log: added user_agent');
  }

  logger.info(`[analytics-db] opened ${dbPath}`);
  return db;
}

module.exports = { getDb, isAnalyticsEnabled };
