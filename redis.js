/**
 * redis.js
 *
 * One shared Redis client for this service, connected on first use.
 * Anything that needs Redis goes through here so the process holds a
 * single connection, whatever the number of callers.
 *
 * Usage:
 *
 *   const { getRedis, redisSend } = require('./redis');
 *
 *   const r = await getRedis();            // the connected redis client
 *   await r.set('key', 'value');
 *
 *   await redisSend('INCR', 'counter');    // one raw command, for
 *                                          // libraries that take a
 *                                          // sendCommand(...args) hook
 *
 * REDIS_URL picks the server. Optional, defaults to the box's local
 * Redis.
 *
 * No background reconnect. The redis client would otherwise retry a
 * lost connection forever on its own timer, logging every attempt. Here
 * a failed connect or a dropped socket just fails the call in hand; the
 * next call opens a fresh connection. Each caller decides what to do
 * when a command fails (the rate limiter lets the request through).
 */

const { createClient } = require('redis');
const logger = require('./logger');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

let client = null;
let connecting = null;

// The shared client, connected. Concurrent callers wait on the same
// connect() rather than each opening their own. If that connect fails
// the client is thrown away, so the next call starts clean instead of
// reusing a client stuck in a failed state.
async function getRedis() {
  if (!client) {
    client = createClient({
      url: REDIS_URL,
      // Talk the older RESP2 protocol. The client's default RESP3
      // handshake (HELLO 3) is refused by Redis 5, which prod runs, and
      // every store call then fails open with no rate limiting at all.
      // RESP2 works on Redis 5 and on every newer version.
      RESP: 2,
      socket: { reconnectStrategy: false },
    });
    client.on('error', (e) => logger.error(`[redis] ${e.message}`));
  }
  if (!client.isOpen) {
    connecting = connecting || client.connect()
      .catch((e) => { client = null; throw e; })
      .finally(() => { connecting = null; });
    await connecting;
  }
  return client;
}

// Runs one raw command. redis v6's sendCommand takes the args as ONE
// array; some libraries (rate-limit-redis) hand them over spread, hence
// the rest parameter.
async function redisSend(...args) {
  const r = await getRedis();
  return r.sendCommand(args);
}

module.exports = { getRedis, redisSend, REDIS_URL };
