/**
 * Distributed cron lock — prevents duplicate cron runs when multiple
 * backend instances are deployed (e.g. Railway with scale-out).
 *
 * Uses Redis SET NX EX (available in Redis 2.6+) for locking.
 * Falls back to running the job unconditionally if Redis is unavailable.
 */
const logger = require('./logger');

let redisClient = null;

function getRedisClient() {
  if (redisClient) return redisClient;
  try {
    const Redis = require('ioredis');
    const client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      lazyConnect: true,
      connectTimeout: 2000,
    });
    client.on('error', () => {}); // suppress noise
    redisClient = client;
    return client;
  } catch (_) {
    return null;
  }
}

/**
 * Acquire a Redis lock and run fn() if we get it.
 * Other instances that try the same lockName within ttlSeconds will skip.
 *
 * @param {string} lockName   - unique cron identifier, e.g. 'cron:slots'
 * @param {number} ttlSeconds - how long the lock is held (set to cron interval)
 * @param {Function} fn       - async function to run when lock is acquired
 */
async function withCronLock(lockName, ttlSeconds, fn) {
  const client = getRedisClient();

  if (!client) {
    // No Redis — run unconditionally (single-instance is safe)
    return fn();
  }

  try {
    await client.connect().catch(() => {}); // no-op if already connected
    // SET lockName 1 NX EX ttlSeconds — atomic acquire
    const result = await client.set(lockName, '1', 'NX', 'EX', ttlSeconds);
    if (result === null) {
      logger.info(`Cron lock "${lockName}" held by another instance — skipping`);
      return;
    }
    // We hold the lock — run the job, always release when done
    try {
      await fn();
    } finally {
      await client.del(lockName).catch(() => {});
    }
  } catch (redisErr) {
    // Redis error — run unconditionally rather than silently skip
    logger.warn(`Cron lock "${lockName}" Redis error, running without lock`, { error: redisErr.message });
    await fn();
  }
}

function closeRedisClient() {
  if (redisClient) {
    redisClient.quit().catch(() => {});
    redisClient = null;
  }
}

module.exports = { withCronLock, closeRedisClient };
