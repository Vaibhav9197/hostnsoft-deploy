/**
 * analytics/retention.js
 *
 * Bounds the analytics DB's growth by pruning rows older than
 * RETENTION_DAYS — this platform stores raw per-request rows (see
 * access-log-tailer.js), not pre-aggregated buckets, so unpruned this
 * would grow forever. Consequence: the "all" range in query.js is
 * really "since ~RETENTION_DAYS ago, or since the app's first request,
 * whichever is more recent" — not literally all-time.
 */
const logger = require('../logger');
const { getDb } = require('./db');

const RETENTION_DAYS = Number(process.env.ANALYTICS_RETENTION_DAYS) || 100;
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day is plenty

function prune() {
  const db = getDb();
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

  const { changes: requestsDeleted } = db.prepare('DELETE FROM request_log WHERE ts < ?').run(cutoff);
  const { changes: samplesDeleted } = db.prepare('DELETE FROM resource_sample WHERE ts < ?').run(cutoff);

  if (requestsDeleted || samplesDeleted) {
    logger.info(
      `[analytics-retention] pruned ${requestsDeleted} request_log row(s), ${samplesDeleted} resource_sample row(s) older than ${RETENTION_DAYS}d`
    );
  }
}

function startRetentionLoop() {
  // Run once shortly after startup too, not just once a day from now —
  // otherwise a service that restarts daily (e.g. every redeploy) could
  // go a long time before this ever actually fires.
  setTimeout(() => {
    try {
      prune();
    } catch (e) {
      logger.error(`[analytics-retention] initial prune failed: ${e.message}`);
    }
  }, 60 * 1000);

  setInterval(() => {
    try {
      prune();
    } catch (e) {
      logger.error(`[analytics-retention] prune failed: ${e.message}`);
    }
  }, RUN_INTERVAL_MS);
}

module.exports = { startRetentionLoop };
