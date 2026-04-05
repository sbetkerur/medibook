'use strict';

const cron = require('node-cron');
const { query, tenantQuery } = require('../db');
const logger = require('../utils/logger');
const { withCronLock } = require('../utils/cronLock');

const SESSION_EXPIRY_HOURS = 4;

async function cleanStaleSessions() {
  const tenants = await query(`SELECT schema_name, name FROM tenants WHERE status='active'`);
  let totalReset = 0;

  for (const tenant of tenants.rows) {
    try {
      const result = await tenantQuery(tenant.schema_name, `
        UPDATE bot_sessions
        SET state = 'idle', context = '{}', last_activity = NOW()
        WHERE state <> 'idle'
          AND last_activity < NOW() - INTERVAL '${SESSION_EXPIRY_HOURS} hours'
        RETURNING phone
      `);
      if (result.rows.length > 0) {
        logger.info(`Session cleaner: reset ${result.rows.length} stale session(s)`, {
          tenant: tenant.name,
          expiry_hours: SESSION_EXPIRY_HOURS,
        });
        totalReset += result.rows.length;
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
  // Run every 30 minutes
  const task = cron.schedule('*/30 * * * *', async () => {
    await withCronLock('session_cleaner', async () => {
      await cleanStaleSessions();
    });
  });
  logger.info(`Session cleaner cron registered (every 30 min, ${SESSION_EXPIRY_HOURS}h expiry)`);
  return task;
}

module.exports = { startSessionCleanerCron, cleanStaleSessions };
