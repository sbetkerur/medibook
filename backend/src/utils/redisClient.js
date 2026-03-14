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

module.exports = { getClient, redisHealthCheck, closeClient };
