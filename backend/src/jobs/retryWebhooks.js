const cron = require('node-cron');
const { query } = require('../db');
const botEngine = require('../services/botEngine');
const logger = require('../utils/logger');
const { withCronLock } = require('../utils/cronLock');

async function retryFailedWebhooks() {
  // Recover rows orphaned in 'processing' — a crash/redeploy between the claim
  // and the terminal status update would otherwise strand them forever (the
  // picker below only selects 'pending').
  await query(`
    UPDATE failed_webhooks SET status='pending'
    WHERE status='processing' AND last_attempt_at < NOW() - INTERVAL '15 minutes'
  `).catch(e => logger.warn('Failed to recover orphaned processing webhooks', { error: e.message }));

  // Fetch up to 20 pending webhooks ready for retry
  const r = await query(`
    SELECT fw.*, t.schema_name, t.name,
           t.settings, t.plan, t.status as tenant_status
    FROM failed_webhooks fw
    JOIN tenants t ON t.id = fw.tenant_id
    WHERE fw.status = 'pending'
      AND fw.next_retry_at <= NOW()
      AND fw.attempts < fw.max_attempts
      AND t.status = 'active'
    ORDER BY fw.created_at ASC
    LIMIT 20
  `);

  if (!r.rows.length) return;
  logger.info(`Retrying ${r.rows.length} failed webhooks`);

  for (const row of r.rows) {
    // Atomically claim the row — the status='pending' guard means that if
    // another instance (or an overlapping run) already claimed it, we skip.
    const claimed = await query(
      `UPDATE failed_webhooks SET status='processing', last_attempt_at=NOW(), attempts=attempts+1
       WHERE id=$1 AND status='pending' RETURNING id`,
      [row.id]
    );
    if (!claimed.rows[0]) continue; // claimed by someone else

    try {
      const tenant = {
        id: row.tenant_id,
        schema_name: row.schema_name,
        name: row.name,
        settings: row.settings,
        plan: row.plan,
        status: row.tenant_status,
      };

      await botEngine.handle({
        phone: row.phone,
        text: row.text || '',
        buttonId: row.button_id || null,
        tenant,
      });

      // Success — mark as succeeded
      await query(
        `UPDATE failed_webhooks SET status='succeeded' WHERE id=$1`,
        [row.id]
      );
      logger.info(`Webhook retry succeeded for phone ${row.phone.slice(-4).padStart(row.phone.length, '*')}`);
    } catch (err) {
      logger.warn(`Webhook retry attempt failed`, { id: row.id, error: err.message });

      // row.attempts is the pre-increment value from the SELECT; the DB was incremented
      // above but the JS object still holds the original count. Add 1 to get the actual
      // attempt number that just ran, so the max_attempts comparison is accurate.
      const nextAttemptNum = row.attempts + 1;
      if (nextAttemptNum >= row.max_attempts) {
        // All retries exhausted
        await query(
          `UPDATE failed_webhooks SET status='failed', error_message=$1 WHERE id=$2`,
          [err.message?.slice(0, 500), row.id]
        );
        logger.error(`Webhook permanently failed after ${row.max_attempts} attempts`, { id: row.id });

        // Alert super admins via email
        try {
          const emailService = require('../services/email');
          const admins = await query(`SELECT email FROM super_admins LIMIT 3`);
          for (const admin of admins.rows) {
            await emailService.sendAdminBookingAlert({
              toEmail: admin.email,
              bookingId: `WEBHOOK-${row.id.slice(-8).toUpperCase()}`,
              patientName: `Phone: ****${row.phone.slice(-4)}`,
              doctorName: 'N/A',
              hospitalName: row.name || 'Unknown Tenant',
              date: new Date().toISOString().slice(0, 10),
              time: new Date().toTimeString().slice(0, 5),
              visitType: `Failed after ${row.max_attempts} retries: ${err.message?.slice(0, 100)}`,
            });
          }
        } catch (_) {}
      } else {
        // Exponential backoff: 2^attempts minutes
        const backoffMinutes = Math.min(Math.pow(2, nextAttemptNum), 1440); // cap at 24h
        await query(`
          UPDATE failed_webhooks
          SET status='pending', error_message=$1, next_retry_at=NOW() + ($2 || ' minutes')::INTERVAL
          WHERE id=$3
        `, [err.message?.slice(0, 500), backoffMinutes, row.id]);

        // Append to sanitized payload attempts log
        const sanitized = {
          phone_masked: '*'.repeat(Math.max(0, row.phone.length - 4)) + row.phone.slice(-4),
          message_type: row.message_type,
          text_preview: row.text ? row.text.slice(0, 50) : null,
          attempt: nextAttemptNum,
          error: err.message?.slice(0, 200),
          attempted_at: new Date().toISOString(),
        };
        await query(`
          UPDATE failed_webhooks
          SET sanitized_payload = COALESCE(sanitized_payload, '[]'::jsonb) || $1::jsonb
          WHERE id=$2
        `, [JSON.stringify([sanitized]), row.id]).catch(() => {});
      }
    }
  }

  // Purge old succeeded/failed records older than 7 days
  await query(`
    DELETE FROM failed_webhooks
    WHERE status IN ('succeeded','failed') AND created_at < NOW() - INTERVAL '7 days'
  `).catch(() => {});
}

function startWebhookRetryCron() {
  // Run every 5 minutes. Cron lock prevents duplicate retries (= duplicate
  // WhatsApp messages to patients) when multiple backend instances run.
  const task = cron.schedule('*/5 * * * *', async () => {
    await withCronLock('cron:webhook_retry', 270, async () => {
      try {
        await retryFailedWebhooks();
      } catch (err) {
        logger.error('Webhook retry cron error', { error: err.message });
      }
    });
  });
  logger.info('Webhook retry cron registered (every 5 minutes)');
  return task;
}

module.exports = { startWebhookRetryCron, retryFailedWebhooks };
