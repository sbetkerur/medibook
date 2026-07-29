'use strict';

const cron = require('node-cron');
const { query, tenantQuery } = require('../db');
const logger = require('../utils/logger');
const { withCronLock } = require('../utils/cronLock');
const { resetSessionToIdle } = require('../services/bot/utils');

const SESSION_EXPIRY_HOURS = 4;

async function cleanStaleSessions() {
  const tenants = await query(`SELECT schema_name, name FROM tenants WHERE status='active'`);
  let totalReset = 0;

  for (const tenant of tenants.rows) {
    try {
      // Find the stale phones first, then reset each one through the sanctioned
      // resetSessionToIdle() helper (bot/utils.js) instead of a raw bulk UPDATE —
      // keeps this write on the same encryption/upsert code path as every other
      // session write, in case this is ever reused for a non-empty reset.
      const stale = await tenantQuery(tenant.schema_name, `
        SELECT phone FROM bot_sessions
        WHERE state <> 'idle'
          AND last_activity < NOW() - INTERVAL '${SESSION_EXPIRY_HOURS} hours'
      `);
      for (const row of stale.rows) {
        await resetSessionToIdle(tenant.schema_name, row.phone);
      }
      if (stale.rows.length > 0) {
        logger.info(`Session cleaner: reset ${stale.rows.length} stale session(s)`, {
          tenant: tenant.name,
          expiry_hours: SESSION_EXPIRY_HOURS,
        });
        totalReset += stale.rows.length;
      }
    } catch (err) {
      logger.error(`Session cleaner failed for tenant ${tenant.name}`, { error: err.message });
    }
  }

  if (totalReset > 0) {
    logger.info(`Session cleaner complete: ${totalReset} session(s) reset across ${tenants.rows.length} tenant(s)`);
  }
}

function startSessionCleanerCron() {
  // Run every 30 minutes. NOTE: withCronLock takes (lockName, ttlSeconds, fn) —
  // the TTL was previously omitted, which shifted the callback into the TTL slot
  // and meant this cron never actually ran.
  const task = cron.schedule('*/30 * * * *', async () => {
    await withCronLock('cron:session_cleaner', 1740, async () => {
      await cleanStaleSessions();
    });
  });
  logger.info(`Session cleaner cron registered (every 30 min, ${SESSION_EXPIRY_HOURS}h expiry)`);
  return task;
}

module.exports = { startSessionCleanerCron, cleanStaleSessions };
