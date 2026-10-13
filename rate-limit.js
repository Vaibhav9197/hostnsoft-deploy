/**
 * rate-limit.js
 *
 * Shared rate limiter for any route in this service. Counters live in
 * the box's local Redis, so the limit holds across pm2 restarts and
 * across every worker that shares the Redis.
 *
 * Usage:
 *
 *   const { createLimiter, identifyCaller } = require('./rate-limit');
 *   const limiter = createLimiter({
 *     prefix: 'logs',          // namespaces the Redis keys for THIS route
 *     limit: 60,               // how many requests ...
 *     windowMs: 60_000,        // ... per this long
 *     label: 'log requests',   // plural noun used in the 429 message
 *   });
 *   app.get('/apps/:name/logs', limiter, handler);
 *
 * By default a caller is whoever identifyCaller() says: the deploy token
 * if one is sent, else the company id of a dashboard call, else the
 * client IP. Pass your own keyGenerator(req) -> string to count by
 * something else.
 *
 * If Redis is unreachable the request is let through and logged
 * (passOnStoreError): a Redis outage must not take the service down with
 * it. Redis itself is what monitoring should page on.
 */

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { createClient } = require('redis');
const logger = require('./logger');
const { errorBody } = require('./deploy-response');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

// One client for every limiter, connected on first use. redis v6's
// sendCommand takes the args as ONE array; rate-limit-redis hands them
// over spread, hence the wrapper.
let client = null;
let connecting = null;
async function redisSend(...args) {
  if (!client) {
    client = createClient({ url: REDIS_URL });
    client.on('error', (e) => logger.error(`[rate-limit] redis: ${e.message}`));
  }
  if (!client.isOpen) {
    connecting = connecting || client.connect().finally(() => { connecting = null; });
    await connecting;
  }
  return client.sendCommand(args);
}

// Who is making this request, for counting purposes: { scope, key }.
//   - Authorization: Bearer <deploy token>  -> scope 'token', the token
//     itself. NOT validated here (that costs a hostnsoft-api round trip);
//     a bad token still gets its 401 in the route. A made-up token only
//     rate-limits itself.
//   - proxy_auth_token + X-Company-Id      -> scope 'company', the id.
//   - nothing                              -> scope 'ip', the client IP
//     (needs app.set('trust proxy', 1) so it is the real one, not
//     Traefik's).
function identifyCaller(req) {
  const auth = req.headers.authorization;
  const token = auth ? auth.split(' ')[1] : null;
  if (token) return { scope: 'token', key: token };

  const company = req.headers['x-company-id'];
  if (req.headers['proxy_auth_token'] && typeof company === 'string' && company) {
    return { scope: 'company', key: company };
  }

  return { scope: 'ip', key: ipKeyGenerator(req.ip) };
}

const SCOPE_TEXT = {
  token: 'this deploy token',
  company: 'this company',
  ip: 'your address',
};

// Reads a positive integer from the environment, else the fallback.
function intEnv(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function createLimiter({ prefix, limit, windowMs, label = 'requests', keyGenerator }) {
  // Default key carries the scope too, so a token, a company id and an
  // IP can never share a counter by accident.
  const keyOf = keyGenerator || ((req) => {
    const { scope, key } = identifyCaller(req);
    return `${scope}:${key}`;
  });
  const windowMinutes = Math.round(windowMs / 60_000);

  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    passOnStoreError: true,
    keyGenerator: keyOf,
    store: new RedisStore({
      prefix: `deploy-service:ratelimit:${prefix}:`,
      sendCommand: redisSend,
    }),
    handler: (req, res) => {
      const { scope } = identifyCaller(req);
      const resetAt = req.rateLimit?.resetTime?.getTime() ?? Date.now();
      const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
      logger.warn(`[rate-limit] 429 ${prefix} scope=${scope} limit=${limit}/${windowMinutes}m`);
      res.set('Retry-After', String(retryAfterSeconds));
      res.status(429).json(errorBody({
        host: req.get('host'),
        appName: req.headers['x-app-name'],
        code: 'rate_limited',
        error: `Too many ${label} for ${SCOPE_TEXT[scope]}: limit is ${limit} per ${windowMinutes} minutes. Try again in ${retryAfterSeconds} seconds.`,
        extra: { scope, limit, windowMinutes, retryAfterSeconds },
      }));
    },
  });
}

module.exports = { createLimiter, identifyCaller, intEnv };
