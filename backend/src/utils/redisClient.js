/**
 * Shared Redis client for health checks and non-BullMQ uses.
 * Uses lazy connect so it doesn't block startup if Redis is unavailable.
 */
const Redis = require('ioredis');
const logger = require('./logger');

let sharedClient = null;

/** True when a Redis endpoint is actually configured for this deployment. */
function isRedisConfigured() {
  return !!process.env.REDIS_URL;
}

/**
 * Shared Redis client, or null when REDIS_URL is unset.
 *
 * Returning null (rather than falling back to redis://localhost:6379) mirrors
 * the guard in utils/cronLock.js. Without it, a Redis-less deployment attempted
 * a doomed localhost connection on EVERY authenticated request (tenantRateLimit),
 * every feature-flag check and every inbound webhook — all of which fail open,
 * so it cost latency and log noise for nothing.
 *
 * Every caller must handle null. The helpers below already do.
 */
function getClient() {
  if (!isRedisConfigured()) return null;
  if (!sharedClient) {
    sharedClient = new Redis(process.env.REDIS_URL, {
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

/**
 * Increment `key`, setting `ttlSeconds` on first increment. Returns the count.
 * Throws REDIS_NOT_CONFIGURED when there is no Redis — callers already treat a
 * throw as "fall back to the in-process limiter", so this needs no new handling.
 */
async function incrWithTTL(key, ttlSeconds) {
  const client = getClient();
  if (!client) {
    const err = new Error('Redis not configured (REDIS_URL unset)');
    err.code = 'REDIS_NOT_CONFIGURED';
    throw err;
  }
  return client.eval(INCR_WITH_TTL_SCRIPT, 1, key, ttlSeconds);
}

async function redisHealthCheck() {
  if (!isRedisConfigured()) return 'not_configured';
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

module.exports = { getClient, isRedisConfigured, incrWithTTL, redisHealthCheck, closeClient };
