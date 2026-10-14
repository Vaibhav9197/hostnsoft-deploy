/**
 * rate-limit.js
 *
 * Shared rate limiter for any route in this service. Counters live in
 * Redis (the shared client in redis.js), so the limit holds across pm2
 * restarts and across every worker that shares the Redis.
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
 * something else, and scope ('token' | 'company' | 'ip') so the 429
 * message names the right thing.
 *
 * ipLimiter() is the ready-made "always by client IP" variant. Stack it
 * in FRONT of a per-caller limiter when one address must not escape the
 * limit just by presenting many different tokens.
 *
 * If Redis is unreachable the request is let through and logged
 * (passOnStoreError): a Redis outage must not take the service down with
 * it. Redis itself is what monitoring should page on.
 */

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const logger = require('./logger');
const { errorBody } = require('./deploy-response');
const { redisSend } = require('./redis');

// The address of the real client, for counting purposes.
//
// When Cloudflare proxies the request it puts the original client's
// address in CF-Connecting-IP. That header survives any number of hops
// (load balancer, Traefik) in between, whereas req.ip only reaches the
// hop `trust proxy` points at — one hop today, so with a load balancer
// in front of Traefik req.ip would be the balancer and every client
// would share one counter.
//
// Only honest if the box is reachable ONLY through Cloudflare: a client
// that can hit the origin directly can send any CF-Connecting-IP it
// likes and dodge the per-IP limit. Keep the origin firewalled to
// Cloudflare's published ranges (or Traefik's ipAllowList) when the
// deploy host is proxied. Without Cloudflare the header is absent and
// req.ip (X-Forwarded-For from Traefik) is used as before.
function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return ipKeyGenerator(cf.trim());
  return ipKeyGenerator(req.ip);
}

// Who is making this request, for counting purposes: { scope, key }.
//   - Authorization: Bearer <deploy token>  -> scope 'token', the token
//     itself. NOT validated here (that costs a hostnsoft-api round trip);
//     a bad token still gets its 401 in the route. A made-up token only
//     rate-limits itself.
//   - proxy_auth_token + X-Company-Id      -> scope 'company', the id.
//   - nothing                              -> scope 'ip', the client IP
//     (see clientIp()).
function identifyCaller(req) {
  const auth = req.headers.authorization;
  const token = auth ? auth.split(' ')[1] : null;
  if (token) return { scope: 'token', key: token };

  const company = req.headers['x-company-id'];
  if (req.headers['proxy_auth_token'] && typeof company === 'string' && company) {
    return { scope: 'company', key: company };
  }

  return { scope: 'ip', key: clientIp(req) };
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

function createLimiter({ prefix, limit, windowMs, label = 'requests', keyGenerator, scope }) {
  // Default key carries the scope too, so a token, a company id and an
  // IP can never share a counter by accident.
  const keyOf = keyGenerator || ((req) => {
    const { scope, key } = identifyCaller(req);
    return `${scope}:${key}`;
  });
  // A fixed scope goes with a custom keyGenerator: the message must
  // describe what was counted, not what identifyCaller() would have
  // picked.
  const scopeOf = scope ? () => scope : (req) => identifyCaller(req).scope;
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
      const scope = scopeOf(req);
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

// Counts every request by client IP (see clientIp()), whether or not it
// carries a token or company id. Same options as createLimiter minus the
// key/scope.
function ipLimiter({ prefix, limit, windowMs, label }) {
  return createLimiter({
    prefix,
    limit,
    windowMs,
    label,
    scope: 'ip',
    keyGenerator: (req) => `ip:${clientIp(req)}`,
  });
}

module.exports = { createLimiter, ipLimiter, identifyCaller, clientIp, intEnv };
