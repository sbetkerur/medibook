const cron = require('node-cron');
const { query, tenantQuery } = require('../db');
const wa = require('../services/whatsapp');
const { decrypt } = require('../utils/encryption');
const { forEachActiveTenantParallel } = require('../utils/tenantUtils');
const { format, parseISO } = require('date-fns');
const { toZonedTime } = require('date-fns-tz');
const logger = require('../utils/logger');
const { withCronLock } = require('../utils/cronLock');

// Allow timezone override via env var so multi-region deployments work without code changes
const TIMEZONE = /^[A-Za-z0-9_/+-]+$/.test(process.env.TIMEZONE || '')
  ? process.env.TIMEZONE
  : 'Asia/Kolkata';

async function sendReminders() {
  await forEachActiveTenantParallel('sendReminders', async (tenant) => {
    if (!tenant.wa_access_token_enc || !tenant.wa_phone_number_id) return;
    const waToken = decrypt(tenant.wa_access_token_enc);
    const waPhoneId = tenant.wa_phone_number_id;
    if (!waToken) return;

    // ── 24-HOUR REMINDERS ──────────────────────────────────
    const r24 = await tenantQuery(tenant.schema_name, `
      SELECT a.id, a.booking_id, a.appointment_date, a.appointment_time,
             p.phone, p.name as patient_name,
             d.name as doctor_name, h.name as hospital_name
      FROM appointments a
      JOIN patients p ON p.id=a.patient_id
      JOIN doctors d ON d.id=a.doctor_id
      JOIN hospitals h ON h.id=a.hospital_id
      WHERE a.status='confirmed'
        AND a.reminder_24h_sent=false
        AND a.appointment_date = CURRENT_DATE + INTERVAL '1 day'
    `);

    for (const appt of r24.rows) {
      try {
        let dt = appt.appointment_date;
        try { dt = format(parseISO(appt.appointment_date), 'EEE, d MMM'); } catch {}

        await wa.sendTemplate(
          appt.phone,
          'appointment_reminder_24h',
          [{
            type: 'body',
            parameters: [
              { type: 'text', text: appt.doctor_name },
              { type: 'text', text: dt },
              { type: 'text', text: (appt.appointment_time || '').slice(0, 5) },
              { type: 'text', text: appt.hospital_name },
            ]
          }],
          waToken, waPhoneId
        );
        await tenantQuery(tenant.schema_name,
          `UPDATE appointments SET reminder_24h_sent=true WHERE id=$1`, [appt.id]);
        logger.info(`24h reminder sent: ${appt.booking_id}`);
      } catch (err) {
        logger.error(`24h reminder failed for ${appt.booking_id}`, { error: err.message });
      }
    }

    // ── 2-HOUR REMINDERS ────────────────────────────────────
    // Compute current time in the configured timezone in JS and pass as a
    // parameterized value — avoids interpolating TIMEZONE into the SQL string.
    const nowInTz = toZonedTime(new Date(), TIMEZONE);
    const nowTimeStr = format(nowInTz, 'HH:mm:ss');
    const r2 = await tenantQuery(tenant.schema_name, `
      SELECT a.id, a.booking_id, a.appointment_time,
             p.phone, p.name as patient_name, d.name as doctor_name
      FROM appointments a
      JOIN patients p ON p.id=a.patient_id
      JOIN doctors d ON d.id=a.doctor_id
      WHERE a.status='confirmed'
        AND a.reminder_2h_sent=false
        AND a.appointment_date = CURRENT_DATE
        AND (a.appointment_time - INTERVAL '2 hours') <= $1::time
        AND a.appointment_time > $1::time
    `, [nowTimeStr]);

    for (const appt of r2.rows) {
      try {
        // Try template first, fall back to plain text with pre-visit checklist
        try {
          await wa.sendTemplate(
            appt.phone,
            'appointment_reminder_2h',
            [{
              type: 'body',
              parameters: [
                { type: 'text', text: appt.doctor_name },
                { type: 'text', text: (appt.appointment_time || '').slice(0, 5) },
              ]
            }],
            waToken, waPhoneId
          );
        } catch (_templateErr) {
          await wa.sendText(
            appt.phone,
            `⏰ *Heads up — appointment in 2 hours!*\n\n` +
            `👨‍⚕️ Dr. ${appt.doctor_name}\n` +
            `🕐 ${(appt.appointment_time || '').slice(0, 5)}\n\n` +
            `📋 *Quick checklist before you go:*\n` +
            `• Arrive 10 minutes early\n` +
            `• Bring any previous reports or prescriptions\n` +
            `• Carry a valid photo ID\n` +
            `• Have a list of your symptoms or questions ready\n\n` +
            `Need to make changes? Reply *Reschedule* or *Cancel Appointment*.`,
            waToken, waPhoneId
          );
        }
        await tenantQuery(tenant.schema_name,
          `UPDATE appointments SET reminder_2h_sent=true WHERE id=$1`, [appt.id]);
        logger.info(`2h reminder sent: ${appt.booking_id}`);
      } catch (err) {
        logger.error(`2h reminder failed for ${appt.booking_id}`, { error: err.message });
      }
    }
  });
}

// Trigger feedback collection for appointments completed/no_show yesterday
async function sendFeedbackRequests() {
  const { triggerFeedback } = require('../services/botEngine');

  await forEachActiveTenantParallel('sendFeedbackRequests', async (tenant) => {
    if (!tenant.wa_access_token_enc || !tenant.wa_phone_number_id) return;
    const waToken = decrypt(tenant.wa_access_token_enc);
    const waPhoneId = tenant.wa_phone_number_id;
    if (!waToken) return;

    const appts = await tenantQuery(tenant.schema_name, `
      SELECT a.id, a.status, p.phone, p.id as patient_id, p.name as patient_name, d.name as doctor_name
      FROM appointments a
      JOIN patients p ON p.id=a.patient_id
      JOIN doctors d ON d.id=a.doctor_id
      WHERE a.status IN ('completed', 'no_show')
        AND a.appointment_date = CURRENT_DATE - INTERVAL '1 day'
        AND NOT EXISTS (
          SELECT 1 FROM appointment_feedback af WHERE af.appointment_id=a.id
        )
      LIMIT 10
    `);

    for (const appt of appts.rows) {
      try {
        const firstName = appt.patient_name ? appt.patient_name.split(' ')[0] : 'there';
        await wa.sendText(
          appt.phone,
          `⭐ *How did it go, ${firstName}?*\n\n` +
          `We hope your visit with Dr. ${appt.doctor_name} went well!\n\n` +
          `Rate your experience:\n` +
          `1 ⭐ — Poor\n` +
          `2 ⭐⭐ — Below average\n` +
          `3 ⭐⭐⭐ — Average\n` +
          `4 ⭐⭐⭐⭐ — Good\n` +
          `5 ⭐⭐⭐⭐⭐ — Excellent\n\n` +
          `Just reply with a number *1–5*. Takes 5 seconds! 🙏`,
          waToken, waPhoneId
        );
        await triggerFeedback(
          tenant.schema_name,
          appt.phone,
          appt.id,
          appt.patient_id,
          appt.doctor_name
        );
        logger.info(`Feedback request sent for appointment ${appt.id}`);
      } catch (err) {
        logger.error(`Feedback request failed for appointment ${appt.id}`, { error: err.message });
      }
    }
  });
}

function startReminderCron() {
  // Run every hour at :00
  const reminderTask = cron.schedule('0 * * * *', async () => {
    await withCronLock('cron:reminders', 3540, async () => {
      logger.info('Running reminder cron...');
      try {
        await sendReminders();
        try {
          await query(
            `UPDATE cron_jobs SET last_run_at=NOW(), last_status='ok', last_error=NULL WHERE job_name='reminders'`
          );
        } catch (_) {}
      } catch (err) {
        logger.error('Reminder cron error', { error: err.message });
        try {
          await query(
            `UPDATE cron_jobs SET last_run_at=NOW(), last_status='error', last_error=$1 WHERE job_name='reminders'`,
            [err.message.slice(0, 500)]
          );
        } catch (_) {}
      }
    });
  });

  // Send feedback requests daily at 10 AM IST (04:30 UTC)
  const feedbackTask = cron.schedule('30 4 * * *', async () => {
    await withCronLock('cron:feedback', 3600, async () => {
      logger.info('Running feedback request cron...');
      try {
        await sendFeedbackRequests();
        try {
          await query(
            `UPDATE cron_jobs SET last_run_at=NOW(), last_status='ok', last_error=NULL WHERE job_name='feedback'`
          );
        } catch (_) {}
      } catch (err) {
        logger.error('Feedback cron error', { error: err.message });
        try {
          await query(
            `UPDATE cron_jobs SET last_run_at=NOW(), last_status='error', last_error=$1 WHERE job_name='feedback'`,
            [err.message.slice(0, 500)]
          );
        } catch (_) {}
      }
    });
  });

  logger.info('Reminder cron registered (runs hourly)');
  logger.info('Feedback cron registered (daily at 10 AM IST)');
  return [reminderTask, feedbackTask];
}

module.exports = { startReminderCron, sendReminders, sendFeedbackRequests };
