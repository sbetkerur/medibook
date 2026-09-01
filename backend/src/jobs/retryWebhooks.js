const cron = require('node-cron');
const { query, tenantQuery } = require('../db');
const botEngine = require('../services/botEngine');
const logger = require('../utils/logger');
const { withCronLock } = require('../utils/cronLock');
// Same lock the BullMQ worker takes, and deliberately the same key format: a
// replay must serialise against a LIVE message from the same patient, not just
// against other replays. Without it this cron ran botEngine.handle concurrently
// with the worker on one bot_sessions row — the exact lost update the lock
// exists to prevent, and the replayed message is by definition one the patient
// already sent, so their current step is what gets clobbered.
const { acquirePhoneLock, releasePhoneLock } = require('../utils/phoneLock');
const { maskPhone } = require('../services/bot/utils');

// KNOWN LIMITATION: a replay goes straight to botEngine, so it also bypasses the
// greeting interception in routes/webhook.js — a replayed "Hi" resets to the
// CURRENT clinic's main menu instead of restarting the clinic search. Fixing it
// here means re-running the global-session reset + clinic search, which lives
// inline in the webhook's message handler; duplicating that (rather than
// extracting it) would give the platform a second, drifting copy of the entry
// step. Left as-is deliberately: the failure is one extra "Hi" from the patient.

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

  // The purge runs FIRST, and unconditionally. It used to sit at the bottom of
  // this function behind `if (!r.rows.length) return;`, so it only ever ran on a
  // tick that also found pending retries. On a healthy platform that is never:
  // one bad afternoon's rows are drained within the hour, and from then on every
  // 5-minute tick returned before reaching it — so the table only grew, holding
  // each patient's phone number and message text indefinitely for messages that
  // were successfully delivered days ago.
  await purgeOldWebhookRecords();

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

    // Duplicate-reply guard. A previous attempt can have delivered its reply and
    // then died before writing status='succeeded' — the 15-minute orphan sweep
    // above flips such a row back to 'pending' and we would replay it, so the
    // patient gets the same bot answer twice (the BullMQ path dedups inbound by
    // wa_message_id and completeBooking is idempotent, but a generic reply is
    // neither). If this is a retry (a prior attempt ran) and the clinic sent
    // this phone ANY outbound message after that attempt started, treat the
    // reply as already delivered: mark succeeded, don't replay.
    if (row.attempts > 0 && row.last_attempt_at && row.schema_name) {
      try {
        // Narrow window: a crashed attempt delivers its reply within seconds of
        // last_attempt_at. Bounding the look at +2min keeps an UNRELATED later
        // cron send (a reminder, a feedback request hours after) from being
        // misread as "this reply already went out" and dropping the owed reply.
        const already = await tenantQuery(row.schema_name,
          `SELECT 1 FROM wa_messages
            WHERE phone=$1 AND direction='out'
              AND created_at > $2 AND created_at <= $2::timestamptz + INTERVAL '2 minutes'
            LIMIT 1`,
          [row.phone, row.last_attempt_at]);
        if (already.rows.length) {
          await query(`UPDATE failed_webhooks SET status='succeeded' WHERE id=$1`, [row.id]);
          logger.info('Webhook retry skipped — a reply already went out after the last attempt', {
            phone: maskPhone(row.phone), id: row.id,
          });
          continue;
        }
      } catch (e) {
        // Best-effort — fall through to a normal replay if the check fails.
        logger.warn('Duplicate-reply guard check failed — replaying', { id: row.id, error: e.message });
      }
    }

    try {
      const tenant = {
        id: row.tenant_id,
        schema_name: row.schema_name,
        name: row.name,
        settings: row.settings,
        plan: row.plan,
        status: row.tenant_status,
      };

      // FAIL OPEN, as in jobs/botWorker.js and the webhook's pre-tenant lock: a
      // Redis blip must never mean the patient's message is dropped for good —
      // this is its last retry path.
      const lockKey = `botlock:${row.tenant_id}:${row.phone}`;
      const { acquired, token, notConfigured } = await acquirePhoneLock(lockKey);
      if (!acquired && !notConfigured) {
        logger.warn('Phone lock not acquired before deadline — replaying anyway', {
          phone: maskPhone(row.phone), tenantId: row.tenant_id,
        });
      }
      try {
        if (row.message_type === 'audio') {
          // Queued by the webhook's voice branch: `text` holds the Meta media id.
          await botEngine.handleVoiceMessage({ phone: row.phone, audioId: row.text, tenant });
        } else {
          await botEngine.handle({
            phone: row.phone,
            text: row.text || '',
            buttonId: row.button_id || null,
            tenant,
            // A first-contact (QR-scan) message that failed its first attempt
            // must still replay onto the clinic-name arrival banner, not the
            // plain menu.
            welcome: row.welcome === true,
          });
        }
      } finally {
        if (acquired) await releasePhoneLock(lockKey, token);
      }

      // Success — mark as succeeded
      await query(
        `UPDATE failed_webhooks SET status='succeeded' WHERE id=$1`,
        [row.id]
      );
      logger.info(`Webhook retry succeeded for phone ${maskPhone(row.phone)}`);
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

        // A permanently failed webhook used to raise a super-admin email.
        // With email gone the log line above is the only signal — it carries the
        // row id, and `failed_webhooks` keeps the payload for inspection.
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
}

/** Drop succeeded/failed records older than 7 days. Called on every tick. */
async function purgeOldWebhookRecords() {
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
