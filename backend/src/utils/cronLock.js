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
    // No localhost default: withCronLock returns early when REDIS_URL is unset,
    // so this is only reached with a real URL. Keeping the fallback here meant
    // one reordering away from every cron silently connecting to nothing.
    if (!process.env.REDIS_URL) return null;
    const client = new Redis(process.env.REDIS_URL, {
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
  // The TTL argument is required — calling withCronLock(name, fn) would
  // silently treat the function as the TTL and never run the job.
  if (typeof ttlSeconds !== 'number' || typeof fn !== 'function') {
    throw new Error(`withCronLock("${lockName}") requires (lockName, ttlSeconds, fn)`);
  }

  // No Redis configured — single-instance deployment; run directly.
  // (Attempting the localhost default here would fail on every tick and, in
  // production, skip every cron: no slots, no reminders, no retries.)
  if (!process.env.REDIS_URL) return fn();

  const client = getRedisClient();
  if (!client) return fn();

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
  } catch (redisErr) {
    // Redis IS configured but unreachable. With multiple instances, running
    // without a lock risks duplicate cron work (double-sent reminders), so
    // skip in production; dev/staging is single-instance, run unlocked.
    if (process.env.NODE_ENV === 'production') {
      logger.error(`Cron lock "${lockName}" Redis error in production — skipping to prevent duplicate runs`, { error: redisErr.message });
      return;
    }
    logger.warn(`Cron lock "${lockName}" Redis error, running without lock`, { error: redisErr.message });
    return fn();
  }

  // We hold the lock — run the job OUTSIDE the Redis try/catch so a job error
  // is never mistaken for a Redis error (which used to re-run the job in dev).
  try {
    await fn();
    // Success: keep the lock until its TTL expires. Callers size ttlSeconds
    // just under the cron interval as an interval guard — releasing early
    // would let another instance's slightly-later tick duplicate the run.
  } catch (jobErr) {
    // Failure: release so the next tick can retry without waiting out the TTL.
    await client.eval(RELEASE_LOCK_SCRIPT, 1, lockName, lockToken).catch(() => {});
    logger.error(`Cron "${lockName}" job failed`, { error: jobErr.message });
  }
}

function closeRedisClient() {
  if (redisClient) {
    redisClient.quit().catch(() => {});
    redisClient = null;
  }
}

module.exports = { withCronLock, closeRedisClient };
