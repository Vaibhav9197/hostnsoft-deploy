/**
 * internal-auth.js
 *
 * Authenticates hostnsoft-api's own calls INTO this service (e.g.
 * POST /internal/apps/:appName/config, see docs/Customdomain-req.md) —
 * the reverse direction of every other internal call in this system,
 * which all go this service -> hostnsoft-api authenticated by a
 * per-company deploy token. There's no per-company concept on this side
 * of the call, so this is a single shared platform-internal secret
 * instead, checked with a constant-time comparison (same reasoning as
 * comparing deploy token hashes: an early-exit string compare would leak
 * timing information about how many leading characters matched).
 */
const { timingSafeEqual } = require('crypto');
const logger = require('./logger');

if (!process.env.INTERNAL_API_SECRET) {
  logger.error('FATAL: INTERNAL_API_SECRET environment variable is not set.');
  logger.error("Must match hostnsoft-api's INTERNAL_API_SECRET exactly.");
  process.exit(1);
}
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

function constantTimeEquals(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Buffers of different length would throw in timingSafeEqual — the
  // length check itself is safe to short-circuit on, only the actual
  // byte comparison needs to be constant-time.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function requireInternalSecret(req, res, next) {
  const provided = req.headers['x-internal-secret'];
  if (typeof provided !== 'string' || !constantTimeEquals(provided, INTERNAL_API_SECRET)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

module.exports = { requireInternalSecret };
