const cron = require('node-cron');
const { query, tenantQuery } = require('../db');
const wa = require('../services/whatsapp');
const { decrypt } = require('../utils/encryption');
const { format, parseISO } = require('date-fns');
const logger = require('../utils/logger');

async function sendReminders() {
  let tenants;
  try {
    const r = await query(`SELECT * FROM tenants WHERE status='active'`);
    tenants = r.rows;
  } catch (err) {
    logger.error('Failed to fetch tenants for reminders', { error: err.message });
    return;
  }

  for (const tenant of tenants) {
    if (!tenant.wa_access_token_enc || !tenant.wa_phone_number_id) continue;
    const waToken = decrypt(tenant.wa_access_token_enc);
    const waPhoneId = tenant.wa_phone_number_id;
    if (!waToken) continue;

    try {
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
                { type: 'text', text: appt.appointment_time.slice(0, 5) },
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
      const r2 = await tenantQuery(tenant.schema_name, `
        SELECT a.id, a.booking_id, a.appointment_time,
               p.phone, p.name as patient_name, d.name as doctor_name
        FROM appointments a
        JOIN patients p ON p.id=a.patient_id
        JOIN doctors d ON d.id=a.doctor_id
        WHERE a.status='confirmed'
          AND a.reminder_2h_sent=false
          AND a.appointment_date = CURRENT_DATE
          AND (a.appointment_time - INTERVAL '2 hours') <= (NOW() AT TIME ZONE 'Asia/Kolkata')::time
          AND a.appointment_time > (NOW() AT TIME ZONE 'Asia/Kolkata')::time
      `);

      for (const appt of r2.rows) {
        try {
          await wa.sendTemplate(
            appt.phone,
            'appointment_reminder_2h',
            [{
              type: 'body',
              parameters: [
                { type: 'text', text: appt.doctor_name },
                { type: 'text', text: appt.appointment_time.slice(0, 5) },
              ]
            }],
            waToken, waPhoneId
          );
          await tenantQuery(tenant.schema_name,
            `UPDATE appointments SET reminder_2h_sent=true WHERE id=$1`, [appt.id]);
          logger.info(`2h reminder sent: ${appt.booking_id}`);
        } catch (err) {
          logger.error(`2h reminder failed for ${appt.booking_id}`, { error: err.message });
        }
      }

    } catch (err) {
      logger.error(`Reminder sweep failed for tenant ${tenant.name}`, { error: err.message });
    }
  }
}

function startReminderCron() {
  // Run every hour at :00
  cron.schedule('0 * * * *', async () => {
    logger.info('Running reminder cron...');
    try { await sendReminders(); } catch (err) {
      logger.error('Reminder cron error', { error: err.message });
    }
  });
  logger.info('Reminder cron registered (runs hourly)');
}

module.exports = { startReminderCron, sendReminders };
