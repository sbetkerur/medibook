'use strict';
/**
 * Feature flag checker with Redis caching (60s TTL).
 * Checks tenant-level overrides first, falls back to global default.
 */
const { query } = require('../db');
const logger = require('./logger');

let redisClient = null;
function getRedis() {
  if (!redisClient) {
    try { redisClient = require('./redisClient').getClient(); } catch (_) {}
  }
  return redisClient;
}

const CACHE_TTL_S = 60;

/**
 * Check if a feature flag is enabled for a tenant.
 * @param {string} tenantId - UUID of the tenant
 * @param {string} flagKey - flag key from feature_flags table
 * @returns {Promise<boolean>}
 */
async function isEnabled(tenantId, flagKey) {
  if (!tenantId || !flagKey) return false;

  const cacheKey = `ff:${tenantId}:${flagKey}`;

  // Check Redis cache
  try {
    const redis = getRedis();
    if (redis) {
      const cached = await redis.get(cacheKey);
      if (cached !== null) return cached === '1';
    }
  } catch (_) {}

  // Check DB: tenant override first, then global default
  try {
    const r = await query(`
      SELECT
        COALESCE(tff.enabled, ff.default_value) as enabled
      FROM feature_flags ff
      LEFT JOIN tenant_feature_flags tff
        ON tff.flag_key = ff.key AND tff.tenant_id = $1
      WHERE ff.key = $2
    `, [tenantId, flagKey]);

    const enabled = r.rows[0]?.enabled === true;

    // Cache the result
    try {
      const redis = getRedis();
      if (redis) await redis.set(cacheKey, enabled ? '1' : '0', 'EX', CACHE_TTL_S);
    } catch (_) {}

    return enabled;
  } catch (err) {
    logger.warn('featureFlags.isEnabled failed', { tenantId, flagKey, error: err.message });
    return false; // fail closed
  }
}

/**
 * Invalidate cached flag for a tenant (call after updating feature_flags).
 */
async function invalidate(tenantId, flagKey) {
  try {
    const redis = getRedis();
    if (redis) await redis.del(`ff:${tenantId}:${flagKey}`);
  } catch (_) {}
}

/**
 * Get all flags for a tenant (for dashboard display).
 */
async function getAllFlags(tenantId) {
  try {
    const r = await query(`
      SELECT ff.key, ff.description,
             COALESCE(tff.enabled, ff.default_value) as enabled
      FROM feature_flags ff
      LEFT JOIN tenant_feature_flags tff
        ON tff.flag_key = ff.key AND tff.tenant_id = $1
      ORDER BY ff.key
    `, [tenantId]);
    return r.rows;
  } catch (err) {
    logger.warn('featureFlags.getAllFlags failed', { tenantId, error: err.message });
    return [];
  }
}

/**
 * Set a flag override for a tenant.
 */
async function setFlag(tenantId, flagKey, enabled) {
  await query(`
    INSERT INTO tenant_feature_flags (tenant_id, flag_key, enabled)
    VALUES ($1, $2, $3)
    ON CONFLICT (tenant_id, flag_key) DO UPDATE SET enabled = EXCLUDED.enabled
  `, [tenantId, flagKey, enabled]);
  await invalidate(tenantId, flagKey);
}

module.exports = { isEnabled, invalidate, getAllFlags, setFlag };
