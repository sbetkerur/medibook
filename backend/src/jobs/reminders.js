const cron = require('node-cron');
const { query, tenantQuery } = require('../db');
const wa = require('../services/whatsapp');
const { forEachActiveTenantParallel } = require('../utils/tenantUtils');
const { format, parseISO, subWeeks } = require('date-fns');
const { toZonedTime, IST_TODAY_SQL } = require('../utils/dateTz');
const logger = require('../utils/logger');
const { withCronLock } = require('../utils/cronLock');
const { FEEDBACK_BATCH_LIMIT } = require('../utils/errors');
const emailService = require('../services/email');

// Allow timezone override via env var so multi-region deployments work without code changes
const TIMEZONE = /^[A-Za-z0-9_/+-]+$/.test(process.env.TIMEZONE || '')
  ? process.env.TIMEZONE
  : 'Asia/Kolkata';

async function sendReminders() {
  await forEachActiveTenantParallel('sendReminders', async (tenant) => {
    // Shared phone — use global META_* env vars
    const waToken = null;
    const waPhoneId = null;

    // ── CONFIGURABLE REMINDER TIMING ────────────────────────────
    const settings = tenant.settings || {};
    const reminder24hEnabled = settings.reminder_24h_enabled !== false; // default true
    const reminder2hEnabled  = settings.reminder_2h_enabled  !== false; // default true
    const hours24 = parseInt(settings.reminder_hours_before_24) || 24;
    const hours2  = parseInt(settings.reminder_hours_before_2)  || 2;

    if (!reminder24hEnabled && !reminder2hEnabled) return;

    // ── 24-HOUR REMINDERS ──────────────────────────────────
    if (reminder24hEnabled) {
      // Match on the appointment TIMESTAMP entering the N-hour window, not on a
      // whole-date comparison. The old check
      //   appointment_date = (NOW() + 24h)::DATE
      // matched ALL of tomorrow's appointments at the first hourly run after
      // midnight, so patients received "reminders" at 00:30 IST — up to 33 hours
      // early and in the middle of the night. With the timestamp window, a 9 AM
      // appointment enters the window at ~9 AM the day before. The date > today
      // guard keeps the old "only remind for future days" semantics (same-day
      // bookings are covered by the 2-hour reminder), and reminder_24h_sent
      // prevents duplicates across cron runs.
      const r24 = await tenantQuery(tenant.schema_name, `
        SELECT a.id, a.booking_id, a.appointment_date, a.appointment_time,
               p.phone, p.name as patient_name,
               d.name as doctor_name, h.name as hospital_name,
               dep.pre_visit_checklist
        FROM appointments a
        JOIN patients p ON p.id=a.patient_id
        JOIN doctors d ON d.id=a.doctor_id
        JOIN hospitals h ON h.id=a.hospital_id
        LEFT JOIN departments dep ON dep.id=d.department_id
        WHERE a.status='confirmed'
          AND a.reminder_24h_sent=false
          AND a.appointment_date > (NOW() AT TIME ZONE $2)::date
          AND timezone($2, (a.appointment_date::text || ' ' || COALESCE(a.appointment_time::text, '09:00:00'))::timestamp)
              <= NOW() + make_interval(hours => $1::int)
          AND p.opted_out IS NOT TRUE
      `, [String(hours24), TIMEZONE]);

      for (const appt of r24.rows) {
        try {
          let dt = appt.appointment_date;
          try { dt = format(parseISO(appt.appointment_date), 'EEE, d MMM'); } catch {}

          // Use checklist already fetched via LEFT JOIN in the main query
          const departmentChecklist = appt.pre_visit_checklist
            ? `\n\n📋 *Checklist for your visit:*\n${appt.pre_visit_checklist}`
            : '';

          try {
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
          } catch (_templateErr) {
            await wa.sendText(
              appt.phone,
              `🔔 *Dental Appointment Reminder*\n\nYou have an appointment tomorrow!\n\n` +
              `👨‍⚕️ Dr. ${appt.doctor_name}\n` +
              `📅 ${dt} at ${(appt.appointment_time || '').slice(0, 5)}\n` +
              `🦷 ${appt.hospital_name}` +
              `\n\n📋 *Before your visit:*\n• Arrive 10 minutes early\n• Bring any previous dental X-rays or records\n• Inform us of any medications or allergies\n• Avoid eating 1 hour before your appointment` +
              `${departmentChecklist}\n\n` +
              `Need to make changes? Reply *Reschedule* or *Cancel Appointment*.`,
              waToken, waPhoneId
            );
          }
          await tenantQuery(tenant.schema_name,
            `UPDATE appointments SET reminder_24h_sent=true WHERE id=$1`, [appt.id]);
          logger.info(`24h reminder sent: ${appt.booking_id}`);

          // Insert pending confirmation record (will be updated when patient replies)
          await tenantQuery(tenant.schema_name, `
            INSERT INTO reminder_confirmations (appointment_id, phone)
            VALUES ($1, $2)
            ON CONFLICT (appointment_id) DO NOTHING
          `, [appt.id, appt.phone]).catch(e => logger.warn('Failed to insert reminder confirmation record', { appointment_id: appt.id, error: e.message }));
        } catch (err) {
          logger.error(`24h reminder failed for ${appt.booking_id}`, { error: err.message });
        }
      }
    }

    // ── 2-HOUR REMINDERS ────────────────────────────────────
    if (reminder2hEnabled) {
      // Combine appointment_date + appointment_time into a timezone-aware timestamp
      // and compare against UTC NOW(). This correctly handles windows that cross
      // midnight — e.g. nowTime=23:00 IST, windowEnd=01:00 IST next day — where the
      // old TIME-only comparison (appointment_time > '23:00' AND <= '01:00') is always
      // false and silently skips all reminders for late-evening appointments.
      const r2 = await tenantQuery(tenant.schema_name, `
        SELECT a.id, a.booking_id, a.appointment_date::text as appointment_date, a.appointment_time,
               p.phone, p.name as patient_name, d.name as doctor_name,
               dep.pre_visit_checklist
        FROM appointments a
        JOIN patients p ON p.id=a.patient_id
        JOIN doctors d ON d.id=a.doctor_id
        LEFT JOIN departments dep ON dep.id=d.department_id
        WHERE a.status='confirmed'
          AND a.reminder_2h_sent=false
          AND timezone($1, (a.appointment_date::text || ' ' || COALESCE(a.appointment_time::text, '00:00:00'))::timestamp)
              BETWEEN NOW() AND NOW() + ($2 || ' hours')::interval
          AND p.opted_out IS NOT TRUE
      `, [TIMEZONE, String(hours2)]);

      // The window crosses midnight (see comment above), so an appointment in it
      // is either today or tomorrow IST — never claim "Today" for a post-midnight one.
      const todayIST = format(toZonedTime(new Date(), TIMEZONE), 'yyyy-MM-dd');

      for (const appt of r2.rows) {
        const dayLabel = appt.appointment_date === todayIST ? 'Today' : 'Tomorrow';
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
            // Use checklist already fetched via LEFT JOIN in the main query (no extra DB round-trip)
            const departmentChecklist = appt.pre_visit_checklist
              ? `\n\n📋 *Checklist for your visit:*\n${appt.pre_visit_checklist}`
              : '';

            await wa.sendText(
              appt.phone,
              // The hourly cron fires this anywhere within the next ${hours2}h window,
              // so state the exact time rather than an imprecise "in N hours".
              `⏰ *Reminder: your dental appointment is coming up!*\n\n` +
              `👨‍⚕️ Dr. ${appt.doctor_name}\n` +
              `🕐 ${dayLabel} at ${(appt.appointment_time || '').slice(0, 5)}\n\n` +
              `🦷 *Quick reminders:*\n• Please arrive 10 minutes early\n• Bring any dental X-rays or records\n• Avoid eating 1 hour before your appointment` +
              `${departmentChecklist}\n\n` +
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
    }
  });
}

/**
 * Handle patient confirmation reply to a reminder.
 * Called by webhook.js when patient sends YES/NO/CONFIRM.
 * Returns true if the message was a reminder confirmation (consumed), false otherwise.
 */
async function handleReminderConfirmation(schemaName, phone, text) {
  const isYes = /^(yes|confirm|ok|sure|haan|ha|attending)$/i.test(text.trim());
  const isNo  = /^(no|cancel|nahi|won'?t|not attending)$/i.test(text.trim());
  if (!isYes && !isNo) return false;

  try {
    // Check if there's a pending confirmation for upcoming appointment from this phone
    const r = await tenantQuery(schemaName, `
      SELECT rc.id, rc.appointment_id
      FROM reminder_confirmations rc
      JOIN appointments a ON a.id = rc.appointment_id
      WHERE rc.phone = $1
        AND rc.response IS NULL
        AND a.appointment_date >= ${IST_TODAY_SQL}
        AND a.appointment_date <= ${IST_TODAY_SQL} + INTERVAL '2 days'
        AND a.status = 'confirmed'
      ORDER BY a.appointment_date ASC
      LIMIT 1
    `, [phone]);

    if (!r.rows[0]) return false;

    await tenantQuery(schemaName, `
      UPDATE reminder_confirmations SET response=$1, responded_at=NOW() WHERE id=$2
    `, [isYes ? 'yes' : 'no', r.rows[0].id]);

    return isYes ? 'yes' : 'no'; // consumed — caller uses this to send the appropriate response
  } catch (err) {
    logger.warn('handleReminderConfirmation DB error', { phone, schemaName, error: err.message });
    return false;
  }
}

// Post-appointment follow-up: send feedback request 1-2 hours after appointment ends
async function sendPostAppointmentFollowup() {
  await forEachActiveTenantParallel('sendPostApptFollowup', async (tenant) => {
    // Check feature flag — default to disabled on error so we don't spam tenants
    // who haven't opted in
    try {
      const { isEnabled } = require('../utils/featureFlags');
      if (!await isEnabled(tenant.id, 'post_appointment_followup')) return;
    } catch (flagErr) {
      logger.warn('Feature flag check failed for post_appointment_followup — skipping tenant', {
        tenant_id: tenant.id, error: flagErr.message,
      });
      return;
    }

    // Shared phone — use global META_* env vars
    const waToken = null;
    const waPhoneId = null;

    // Use timezone-aware comparison for the same midnight-crossing reason as the 2h
    // reminder above: time-only comparison fails when the 1–2 hour window straddles
    // midnight (e.g. it is 01:30 IST, so 1h-ago = 00:30 and 2h-ago = 23:30).
    const appts = await tenantQuery(tenant.schema_name, `
      SELECT a.id, a.booking_id, a.patient_id, p.phone, p.name as patient_name, d.name as doctor_name
      FROM appointments a
      JOIN patients p ON p.id = a.patient_id
      JOIN doctors d ON d.id = a.doctor_id
      WHERE a.status = 'confirmed'
        AND timezone($1, (a.appointment_date::text || ' ' || COALESCE(a.appointment_time::text, '00:00:00'))::timestamp)
            BETWEEN NOW() - INTERVAL '2 hours' AND NOW() - INTERVAL '1 hour'
        AND a.follow_up_sent IS NOT TRUE
        AND p.opted_out IS NOT TRUE
      LIMIT $2
    `, [TIMEZONE, FEEDBACK_BATCH_LIMIT]);

    for (const appt of appts.rows) {
      try {
        const firstName = appt.patient_name ? appt.patient_name.split(' ')[0] : 'there';
        await wa.sendText(appt.phone,
          `😊 Hi ${firstName}! How did your visit with Dr. ${appt.doctor_name} go?\n\n` +
          `We'd love your feedback! Rate your experience:\n` +
          `⭐ 1 — Poor\n⭐⭐ 2 — Below Average\n⭐⭐⭐ 3 — Average\n⭐⭐⭐⭐ 4 — Good\n⭐⭐⭐⭐⭐ 5 — Excellent\n\n` +
          `Just reply with a number 1–5!`,
          waToken, waPhoneId);
        await tenantQuery(tenant.schema_name,
          `UPDATE appointments SET follow_up_sent=true WHERE id=$1`, [appt.id]);
        // Trigger feedback state in bot session.
        // Use the appointment's OWN patient_id. This used to re-look-up by phone
        // (`SELECT id FROM patients WHERE phone=$1`), but patients.phone is
        // deliberately non-unique for family booking — so a parent booking for a
        // child filed the feedback against whichever profile Postgres returned
        // first. sendFeedbackRequests below already carries patient_id correctly.
        const { triggerFeedback } = require('../services/botEngine');
        await triggerFeedback(tenant.schema_name, appt.phone, appt.id, appt.patient_id, appt.doctor_name);
        logger.info(`Post-appointment follow-up sent: ${appt.booking_id}`);
      } catch (err) {
        logger.error(`Follow-up failed for ${appt.booking_id}`, { error: err.message });
      }
    }
  });
}

// Trigger feedback collection for appointments completed/no_show yesterday
async function sendFeedbackRequests() {
  const { triggerFeedback } = require('../services/botEngine');

  await forEachActiveTenantParallel('sendFeedbackRequests', async (tenant) => {
    // Shared phone — use global META_* env vars
    const waToken = null;
    const waPhoneId = null;

    // Skip appointments that already received the 2-hour post-appointment
    // follow-up (follow_up_sent) so patients aren't asked for feedback twice.
    const appts = await tenantQuery(tenant.schema_name, `
      SELECT a.id, a.status, p.phone, p.id as patient_id, p.name as patient_name, d.name as doctor_name
      FROM appointments a
      JOIN patients p ON p.id=a.patient_id
      JOIN doctors d ON d.id=a.doctor_id
      WHERE a.status IN ('completed', 'no_show')
        -- Window is a RANGE, not exactly "yesterday". With a hard LIMIT and a
        -- single-day window, every patient past the limit was dropped forever,
        -- because that date is never "yesterday" again. Combined with
        -- feedback_request_sent below, the backlog now drains over later runs.
        AND a.appointment_date BETWEEN ${IST_TODAY_SQL} - INTERVAL '3 days'
                                   AND ${IST_TODAY_SQL} - INTERVAL '1 day'
        AND a.follow_up_sent IS NOT TRUE
        AND a.feedback_request_sent IS NOT TRUE
        AND NOT EXISTS (
          SELECT 1 FROM appointment_feedback af WHERE af.appointment_id=a.id
        )
        AND p.opted_out IS NOT TRUE
      ORDER BY a.appointment_date, a.id
      LIMIT $1
    `, [FEEDBACK_BATCH_LIMIT]);

    if (appts.rows.length === FEEDBACK_BATCH_LIMIT) {
      logger.warn('Feedback batch hit its limit — remaining patients roll over to the next run', {
        tenant: tenant.slug, limit: FEEDBACK_BATCH_LIMIT,
      });
    }

    for (const appt of appts.rows) {
      try {
        const firstName = appt.patient_name ? appt.patient_name.split(' ')[0] : 'there';
        // no_show patients didn't have a visit — a "how was your visit?" message
        // would be tone-deaf. Nudge them to rebook instead.
        const message = appt.status === 'no_show'
          ? `🦷 Hi ${firstName}, we missed you at your appointment with Dr. ${appt.doctor_name} yesterday.\n\n` +
            `No worries — these things happen! Reply *Hi* to book a new appointment whenever you're ready. 😊`
          : `⭐ *How was your dental visit, ${firstName}?*\n\n` +
            `We hope Dr. ${appt.doctor_name} took great care of your smile! 🦷\n\n` +
            `Rate your experience:\n` +
            `1 ⭐ — Poor\n` +
            `2 ⭐⭐ — Below average\n` +
            `3 ⭐⭐⭐ — Average\n` +
            `4 ⭐⭐⭐⭐ — Good\n` +
            `5 ⭐⭐⭐⭐⭐ — Excellent\n\n` +
            `Just reply with a number *1–5*. Takes 5 seconds! 🙏`;
        await wa.sendText(appt.phone, message, waToken, waPhoneId);
        // Only arm the rating flow for completed visits — no_show patients got
        // a rebook nudge, not a rating request.
        if (appt.status !== 'no_show') {
          await triggerFeedback(
            tenant.schema_name,
            appt.phone,
            appt.id,
            appt.patient_id,
            appt.doctor_name
          );
        }
        // Mark AFTER a successful send so a failed send is retried on the next
        // run rather than silently consumed (same policy as reminder_*_sent).
        await tenantQuery(tenant.schema_name,
          `UPDATE appointments SET feedback_request_sent=true WHERE id=$1`, [appt.id]);
        logger.info(`Feedback request sent for appointment ${appt.id}`);
      } catch (err) {
        logger.error(`Feedback request failed for appointment ${appt.id}`, { error: err.message });
      }
    }
  });
}

// ── WEEKLY DENTIST PERFORMANCE DIGEST ────────────────────────
async function sendWeeklyDigests() {
  const nowIST = toZonedTime(new Date(), TIMEZONE);
  // Use the previous 7 days as the reporting window
  const rangeEnd   = format(nowIST, 'yyyy-MM-dd');
  const rangeStart = format(subWeeks(nowIST, 1), 'yyyy-MM-dd');

  await forEachActiveTenantParallel('sendWeeklyDigests', async (tenant) => {
    try {
      // Get all admin users for this tenant
      const adminR = await tenantQuery(tenant.schema_name,
        `SELECT email, name FROM users WHERE role='admin' AND is_active=true LIMIT 5`);
      if (!adminR.rows.length) return;

      // Per-doctor stats for the past week
      const statsR = await tenantQuery(tenant.schema_name, `
        SELECT d.name,
               COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE a.status='completed')::int AS completed,
               COUNT(*) FILTER (WHERE a.status='no_show')::int AS no_show,
               COUNT(*) FILTER (WHERE a.status='cancelled')::int AS cancelled,
               COALESCE(SUM(COALESCE(NULLIF(a.effective_fee, 0), d.consultation_fee)) FILTER (WHERE a.status IN ('confirmed','completed')), 0)::int AS revenue
        FROM appointments a JOIN doctors d ON d.id=a.doctor_id
        WHERE a.appointment_date BETWEEN $1 AND $2
        GROUP BY d.name ORDER BY total DESC
      `, [rangeStart, rangeEnd]);

      const stats = {
        weekStart: rangeStart,
        weekEnd: rangeEnd,
        doctors: statsR.rows,
      };

      for (const admin of adminR.rows) {
        await emailService.sendWeeklyDigest(admin.email, tenant.name, stats);
      }
      logger.info(`Weekly digest sent for tenant ${tenant.name}`);
    } catch (err) {
      logger.error(`Weekly digest failed for ${tenant.name}`, { error: err.message });
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

  // Weekly digest: every Monday at 8 AM IST (02:30 UTC)
  const digestTask = cron.schedule('30 2 * * 1', async () => {
    await withCronLock('cron:weekly_digest', 3600, async () => {
      logger.info('Running weekly digest cron...');
      try {
        await sendWeeklyDigests();
        await query(`UPDATE cron_jobs SET last_run_at=NOW(), last_status='ok', last_error=NULL WHERE job_name='weekly_digest'`).catch(() => {});
      } catch (err) {
        logger.error('Weekly digest cron error', { error: err.message });
        await query(`UPDATE cron_jobs SET last_run_at=NOW(), last_status='error', last_error=$1 WHERE job_name='weekly_digest'`, [err.message.slice(0, 500)]).catch(() => {});
      }
    });
  });

  // Post-appointment follow-up: every 30 minutes
  const followupTask = cron.schedule('*/30 * * * *', async () => {
    await withCronLock('cron:post_appt_followup', 1740, async () => {
      try { await sendPostAppointmentFollowup(); } catch (err) {
        logger.error('Post-appointment follow-up cron error', { error: err.message });
      }
    });
  });
  logger.info('Post-appointment follow-up cron registered (every 30 minutes)');

  logger.info('Reminder cron registered (runs hourly)');
  logger.info('Feedback cron registered (daily at 10 AM IST)');
  logger.info('Weekly digest cron registered (Mondays 8 AM IST)');
  return [reminderTask, feedbackTask, digestTask, followupTask];
}

module.exports = {
  startReminderCron,
  sendReminders,
  sendFeedbackRequests,
  sendPostAppointmentFollowup,
  sendWeeklyDigests,
  handleReminderConfirmation,
};
