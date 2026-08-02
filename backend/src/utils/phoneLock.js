'use strict';
/**
 * Short-lived per-phone Redis lock.
 *
 * Two messages from the same patient can be handled concurrently — by two
 * BullMQ worker slots, or (before a clinic is even resolved) by two webhook
 * deliveries landing at once. Both read-modify-write the same session row, so
 * the second writer's stale copy clobbers the first's progress.
 *
 * Extracted from jobs/botWorker.js so the pre-tenant path in routes/webhook.js
 * serialises the same way instead of carrying a second copy of this logic.
 *
 * Policy everywhere: FAIL OPEN. If Redis is unavailable or the current holder
 * outlasts the wait window, process the message anyway — a rare race beats
 * silence from the bot.
 */
const crypto = require('crypto');
const logger = require('./logger');
const { getClient } = require('./redisClient');

// Atomic release: only DEL if our token still owns the lock, so a slow job
// cannot delete a lock that has since expired and been re-acquired.
const RELEASE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

const DEFAULT_TTL_MS = 15000;       // safety net if a holder crashes before releasing
const DEFAULT_MAX_WAIT_MS = 12000;  // give the current holder time to finish its turn
const POLL_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @returns {Promise<{acquired: boolean, token: string|null, notConfigured?: boolean, redisError?: boolean}>}
 */
async function acquirePhoneLock(lockKey, { ttlMs = DEFAULT_TTL_MS, maxWaitMs = DEFAULT_MAX_WAIT_MS } = {}) {
  const client = getClient();
  // No Redis configured — single instance, nothing to serialise against.
  if (!client) return { acquired: false, token: null, notConfigured: true };

  const token = crypto.randomBytes(16).toString('hex');
  const deadline = Date.now() + maxWaitMs;
  while (true) {
    try {
      const result = await client.set(lockKey, token, 'NX', 'PX', ttlMs);
      if (result === 'OK') return { acquired: true, token };
    } catch (err) {
      logger.warn('Phone lock acquire failed, processing without lock', { error: err.message });
      return { acquired: false, token: null, redisError: true };
    }
    if (Date.now() >= deadline) return { acquired: false, token: null };
    await sleep(POLL_MS);
  }
}

async function releasePhoneLock(lockKey, token) {
  if (!token) return;
  const client = getClient();
  if (!client) return;
  try {
    await client.eval(RELEASE_SCRIPT, 1, lockKey, token);
  } catch (err) {
    logger.warn('Phone lock release failed (will expire via TTL)', { error: err.message });
  }
}

module.exports = { acquirePhoneLock, releasePhoneLock };
