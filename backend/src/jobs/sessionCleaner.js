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
      // ONE guarded statement, not a SELECT followed by a per-phone reset.
      //
      // The old shape read the stale phones, then looped calling
      // resetSessionToIdle() — a round trip each. On a clinic with a few hundred
      // stale sessions that loop runs for a while, and it holds no phone lock,
      // unlike every other writer of this row (jobs/botWorker.js and
      // jobs/retryWebhooks.js both take botlock:<tenant>:<phone> precisely to
      // avoid a lost update here). So a patient whose session went stale 4h01m
      // ago could answer the bot's "which date?" at the top of the loop, have
      // the worker write state='select_slot' with their chosen date, and have
      // this loop reach their phone a moment later and overwrite it with idle —
      // silently discarding a booking they were three steps into. Re-testing
      // last_activity inside the UPDATE closes that: their reply refreshed it,
      // so the row no longer matches.
      //
      // Writing context='{}' directly rather than through the helper is the same
      // write the sanctioned oversize-context path in bot/utils.js makes, so
      // getSession already reads it; the helper's encryption only matters for a
      // non-empty context, and this reset has none.
      const reset = await tenantQuery(tenant.schema_name, `
        UPDATE bot_sessions
           SET state='idle', context='{}', last_activity=last_activity
         WHERE state <> 'idle'
           AND last_activity < NOW() - INTERVAL '${SESSION_EXPIRY_HOURS} hours'
        RETURNING phone
      `);
      if (reset.rows.length > 0) {
        logger.info(`Session cleaner: reset ${reset.rows.length} stale session(s)`, {
          tenant: tenant.name,
          expiry_hours: SESSION_EXPIRY_HOURS,
        });
        totalReset += reset.rows.length;
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
