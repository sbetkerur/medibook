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

// Lua script for atomic lock release: only DEL if our token still owns the lock.
// Prevents a race where our lock's TTL expires, another instance acquires it,
// and then our DEL removes the other instance's lock.
const RELEASE_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

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

  // Unique token per acquisition — used for atomic release via Lua script
  const lockToken = require('crypto').randomBytes(16).toString('hex');

  try {
    await client.connect().catch(() => {}); // no-op if already connected
    // SET lockName <token> NX EX ttlSeconds — atomic acquire
    const result = await client.set(lockName, lockToken, 'NX', 'EX', ttlSeconds);
    if (result === null) {
      logger.info(`Cron lock "${lockName}" held by another instance — skipping`);
      return;
    }
    // We hold the lock — run the job, then release atomically
    try {
      await fn();
    } finally {
      // Only DEL if we still own the lock (Lua script is atomic)
      await client.eval(RELEASE_LOCK_SCRIPT, 1, lockName, lockToken).catch(() => {});
    }
  } catch (redisErr) {
    // In production with multiple instances, running without a lock risks duplicate cron work
    // (double-sending reminders, double-generating slots). Skip instead.
    if (process.env.NODE_ENV === 'production') {
      logger.error(`Cron lock "${lockName}" Redis error in production — skipping to prevent duplicate runs`, { error: redisErr.message });
      return;
    }
    // Dev/staging: run unconditionally (single instance, safe)
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
