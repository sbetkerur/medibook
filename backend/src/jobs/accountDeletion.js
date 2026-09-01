'use strict';
/**
 * Carries out tenant-requested account deletions once the grace window has
 * elapsed (routes/account.js sets `deletion_scheduled_for`).
 *
 * This is the one irreversible cron in the system: it DROPs the tenant's whole
 * PG schema and deletes the `tenants` row. Recovery afterwards is only from the
 * ≤30-day encrypted backups. Safeguards:
 *   - runs only for rows where BOTH deletion_requested_at is set AND
 *     deletion_scheduled_for is in the past (cancelling clears both),
 *   - re-reads each row immediately before acting, so a cancellation that
 *     landed between the sweep SELECT and the DROP is honoured,
 *   - validates the schema name against the same /^tenant_[a-z0-9_]+$/ pattern
 *     db/index.js enforces before it is ever interpolated into DROP SCHEMA,
 *   - keeps billing_invoices (tenant_id is ON DELETE SET NULL) — financial
 *     records outlive the clinic.
 */
const cron = require('node-cron');
const { pool, query, validateSchemaName } = require('../db');
const { withCronLock } = require('../utils/cronLock');
const { invalidateTenantCache } = require('../middleware/auth');
const logger = require('../utils/logger');

async function purgeOne(t) {
  // Re-check under a fresh read — a cancel may have landed since the sweep.
  const fresh = await query(
    `SELECT id, slug, schema_name, deletion_requested_at, deletion_scheduled_for
       FROM tenants WHERE id=$1`, [t.id]);
  const row = fresh.rows[0];
  if (!row || !row.deletion_requested_at || new Date(row.deletion_scheduled_for).getTime() > Date.now()) {
    logger.info('account_deletion: skipped (cancelled or rescheduled)', { slug: t.slug });
    return;
  }

  try { validateSchemaName(row.schema_name); }
  catch (e) {
    logger.error('account_deletion: refusing to drop an invalid schema name', { slug: row.slug, schema: row.schema_name });
    return;
  }

  // A final snapshot must EXIST, not just be "scheduled earlier in the night".
  // The 03:30 IST slot only lands after the 02:30 backup if that backup ran and
  // succeeded — a failed pg_dump (disk full, binary missing, DB blip) on the
  // same night a deletion comes due would otherwise drop the schema with the
  // newest usable backup 24h+ stale, and the recovery file the docstring
  // promises absent. Skip loudly and retry next run; deletions are not urgent.
  try {
    const bk = await query(
      `SELECT 1 FROM backup_log
        WHERE status='success' AND completed_at > NOW() - INTERVAL '26 hours'
        LIMIT 1`);
    if (!bk.rows.length) {
      logger.error('account_deletion: no successful backup in the last 26h — deferring purge', { slug: row.slug });
      return;
    }
  } catch (e) {
    logger.error('account_deletion: backup check failed — deferring purge', { slug: row.slug, error: e.message });
    return;
  }

  // Cancel the Razorpay subscription outright — no reason to keep it around.
  try {
    const bR = await query(`SELECT razorpay_subscription_id FROM tenant_billing WHERE tenant_id=$1`, [row.id]);
    const subId = bR.rows[0]?.razorpay_subscription_id;
    if (subId) {
      const razorpay = require('../services/razorpay');
      if (razorpay.isConfigured()) await razorpay.cancelSubscription(subId, false).catch(() => {});
    }
  } catch (_) { /* best effort */ }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // DROP SCHEMA can't be parameterised; the name is validated above and is
    // additionally quoted here.
    await client.query(`DROP SCHEMA IF EXISTS "${row.schema_name}" CASCADE`);
    await client.query(`DELETE FROM tenants WHERE id=$1`, [row.id]);
    await client.query(`
      INSERT INTO audit_logs (actor_role, action, resource_type, resource_id, new_values)
      VALUES ('system','ACCOUNT_DELETED','tenant',$1,$2)
    `, [row.id, JSON.stringify({ slug: row.slug, schema: row.schema_name })]);
    await client.query('COMMIT');
    invalidateTenantCache(row.id);
    logger.warn('account_deletion: tenant permanently deleted', { slug: row.slug, schema: row.schema_name });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('account_deletion: purge failed — will retry next run', { slug: row.slug, error: err.message });
  } finally {
    client.release();
  }
}

async function runOnce() {
  const due = await query(`
    SELECT id, slug, schema_name FROM tenants
     WHERE deletion_requested_at IS NOT NULL
       AND deletion_scheduled_for IS NOT NULL
       AND deletion_scheduled_for < NOW()
  `);
  if (!due.rows.length) return;
  logger.warn('account_deletion: processing due deletions', { count: due.rows.length });
  for (const t of due.rows) {
    await purgeOne(t);
  }
}

function startAccountDeletionCron() {
  // 03:30 IST — deep quiet hours, well clear of the 02:30 backup so a final
  // snapshot exists before anything is dropped.
  const task = cron.schedule('30 3 * * *', async () => {
    await withCronLock('cron:account_deletion', 3600, async () => {
      try {
        await runOnce();
        await query(`UPDATE cron_jobs SET last_run_at=NOW(), last_status='ok', last_error=NULL WHERE job_name='account_deletion'`).catch(() => {});
      } catch (err) {
        logger.error('account_deletion cron error', { error: err.message });
        await query(`UPDATE cron_jobs SET last_run_at=NOW(), last_status='error', last_error=$1 WHERE job_name='account_deletion'`,
          [err.message?.slice(0, 500)]).catch(() => {});
      }
    });
  }, { timezone: 'Asia/Kolkata' });
  return task;
}

module.exports = { startAccountDeletionCron, runOnce };
