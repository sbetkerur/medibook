/**
 * Shared Redis client for health checks and non-BullMQ uses.
 * Uses lazy connect so it doesn't block startup if Redis is unavailable.
 */
const Redis = require('ioredis');
const logger = require('./logger');

let sharedClient = null;

function getClient() {
  if (!sharedClient) {
    sharedClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      connectTimeout: 3000,
    });
    sharedClient.on('error', () => { /* suppress noise */ });
  }
  return sharedClient;
}

// Atomic INCR + EXPIRE in one Lua script, shared by every rate limiter.
// The two-step INCR-then-EXPIRE has a race: if the process dies between the
// calls, the key persists with no TTL and the counter never resets.
const INCR_WITH_TTL_SCRIPT = `local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return c`;

/** Increment `key`, setting `ttlSeconds` on first increment. Returns the count. */
async function incrWithTTL(key, ttlSeconds) {
  return getClient().eval(INCR_WITH_TTL_SCRIPT, 1, key, ttlSeconds);
}

async function redisHealthCheck() {
  try {
    const client = getClient();
    const testKey = `health:check:${Date.now()}`;
    await client.set(testKey, '1', 'EX', 5);
    const val = await client.get(testKey);
    await client.del(testKey);
    return val === '1' ? 'ok' : 'degraded';
  } catch (e) {
    return 'error';
  }
}

function closeClient() {
  if (sharedClient) {
    sharedClient.quit().catch(() => {});
    sharedClient = null;
  }
}

module.exports = { getClient, incrWithTTL, redisHealthCheck, closeClient };
