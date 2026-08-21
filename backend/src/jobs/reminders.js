const cron = require('node-cron');
const { query, tenantQuery } = require('../db');
const { forEachActiveTenantParallel } = require('../utils/tenantUtils');
const { format, parseISO, subDays } = require('date-fns');
const { toZonedTime, IST_TODAY_SQL } = require('../utils/dateTz');
const logger = require('../utils/logger');
const { withCronLock } = require('../utils/cronLock');
const { FEEDBACK_BATCH_LIMIT } = require('../utils/errors');
// Cron sends go through these so they land in the tenant's message history —
// wa.sendText/sendTemplate on their own do not record anything.
const { sendPatientText, sendPatientTemplate, sendPatientMessage } = require('../services/outbound');
// Every message below asks the patient a question. On a shared WhatsApp number
// the answer routes to whichever clinic the patient last selected, so record
// who is actually waiting for it (see services/pendingReply.js).
const { KINDS, recordPendingReply } = require('../services/pendingReply');
// Persistent logs (logs/combined.log in production) must not carry full patient
// numbers — same helper the webhook and bot engine use.
const { maskPhone, notifyAdminWhatsApp } = require('../services/bot/utils');
// Reminders are NEVER gated by this — a patient with an appointment tomorrow
// wants that message. Only the discretionary sends below are.
const { canSendDiscretionary, budgetFor } = require('../services/messageBudget');

// Allow timezone override via env var so multi-region deployments work without code changes
const TIMEZONE = /^[A-Za-z0-9_/+-]+$/.test(process.env.TIMEZONE || '')
  ? process.env.TIMEZONE
  : 'Asia/Kolkata';

async function sendReminders() {
  await forEachActiveTenantParallel('sendReminders', async (tenant) => {
    // ── CONFIGURABLE REMINDER TIMING ────────────────────────────
    const settings = tenant.settings || {};
    const reminder24hEnabled = settings.reminder_24h_enabled !== false; // default true
    const hours24 = parseInt(settings.reminder_hours_before_24) || 24;

    if (!reminder24hEnabled) return;

    // ── 24-HOUR REMINDERS ──────────────────────────────────
    // Match on the appointment TIMESTAMP entering the N-hour window, not on a
    // whole-date comparison. The old check
    //   appointment_date = (NOW() + 24h)::DATE
    // matched ALL of tomorrow's appointments at the first hourly run after
    // midnight, so patients received "reminders" at 00:30 IST — up to 33 hours
    // early and in the middle of the night. With the timestamp window, a 9 AM
    // appointment enters the window at ~9 AM the day before. The date > today
    // guard keeps the old "only remind for future days" semantics.
    // reminder_24h_sent prevents duplicates across cron runs.
    //
    // NOTE: a same-day booking gets NO appointment reminder at all — this is
    // the only one, and it is gated on the appointment being on a FUTURE
    // date. That used to be covered by the (now removed) 2-hour reminder;
    // there is no substitute today.
    const r24 = await tenantQuery(tenant.schema_name, `
      SELECT a.id, a.booking_id, a.appointment_date, a.appointment_time,
             p.phone, p.name as patient_name,
             d.name as doctor_name, h.name as hospital_name,
             dep.pre_visit_checklist,
             tp.title AS treatment_title, tp.total_visits, a.visit_number
      FROM appointments a
      JOIN patients p ON p.id=a.patient_id
      JOIN doctors d ON d.id=a.doctor_id
      JOIN hospitals h ON h.id=a.hospital_id
      LEFT JOIN treatment_plans tp ON tp.id=a.treatment_plan_id
      LEFT JOIN departments dep ON dep.id=COALESCE(a.department_id, d.department_id)
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

        // A treatment sitting is not an interchangeable appointment — "visit 2
        // of 3 for your root canal" is what makes a patient keep it, and what
        // stops them cancelling it as a duplicate of the one they remember.
        const treatmentLine = appt.treatment_title
          ? `🦷 *${appt.treatment_title}*` +
            (appt.visit_number && appt.total_visits ? ` — visit ${appt.visit_number} of ${appt.total_visits}` : '') + `\n`
          : '';

        // Kept word-for-word in step with the `appointment_reminder_24h_v3`
        // template (docs/whatsapp-templates.md). This is the text a patient
        // gets whenever the template is not approved — which is every clinic
        // until their WhatsApp account is set up — so the two drifting apart
        // means half the patients get the polished version and half don't.
        //
        // The old wall of generic advice ("bring X-rays, tell us about
        // medications, don't eat beforehand") is gone: sent identically to
        // everyone, every time, it is what trains people to stop reading.
        // The per-treatment checklist below is the part that is actually
        // specific, and it survives.
        const reminderText =
          `🔔 *Your appointment is tomorrow*\n\n` +
          treatmentLine +
          `🦷 *${dt} at ${(appt.appointment_time || '').slice(0, 5)}*\n` +
          `with Dr. ${appt.doctor_name}\n\n` +
          `At ${appt.hospital_name}` +
          `${departmentChecklist}\n\n` +
          `Arriving 10 minutes early helps us start on time. If you can't make it, tell us now and we'll offer the slot to someone who's waiting.\n\n` +
          `Reply *Yes* to confirm, or *Reschedule* / *Cancel Appointment*.`;

        try {
          await sendPatientTemplate(
            tenant.schema_name,
            appt.phone,
            'appointment_reminder_24h_v3',
            [{
              type: 'body',
              parameters: [
                { type: 'text', text: appt.doctor_name },
                { type: 'text', text: dt },
                { type: 'text', text: (appt.appointment_time || '').slice(0, 5) },
                { type: 'text', text: appt.hospital_name },
              ]
            }],
            reminderText,
            // Index-aligned with the template's three quick replies. The
            // labels read like sentences; these are what the engine matches.
            ['Yes', 'Reschedule', 'Cancel appointment']
          );
        } catch (_templateErr) {
          await sendPatientText(tenant.schema_name, appt.phone, reminderText);
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

        // The reply ("yes"/"no") must come back to THIS clinic even if the
        // patient's shared-number session now points at another one. 48h
        // covers the appointment itself plus a late answer.
        await recordPendingReply(appt.phone, tenant.id, KINDS.CONFIRMATION, 48);
      } catch (err) {
        logger.error(`24h reminder failed for ${appt.booking_id}`, { error: err.message });
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
  // "cancel" is deliberately NOT here: it is a standalone bot command (cancel
  // appointment), and routes/webhook.js excludes it from the replies it hands
  // to this function. Accepting it would only ever be dead code — or, if that
  // filter were relaxed, would swallow a cancellation request as a decline.
  const isNo  = /^(no|nahi|won'?t|not attending)$/i.test(text.trim());
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
    logger.warn('handleReminderConfirmation DB error', { phone: maskPhone(phone), schemaName, error: err.message });
    return false;
  }
}

// Trigger feedback collection for appointments completed/no_show yesterday
async function sendFeedbackRequests() {
  const { triggerFeedback } = require('../services/botEngine');

  await forEachActiveTenantParallel('sendFeedbackRequests', async (tenant) => {
    // follow_up_sent is a leftover from the (now removed) post-appointment
    // follow-up cron, which used to ask for feedback 1-2h after the visit.
    // Kept here purely so an appointment that already got THAT ask, back when
    // it existed, is not asked again by this one — nothing sets the flag true
    // any more, so for every appointment created after its removal this
    // condition is always satisfied.
    const appts = await tenantQuery(tenant.schema_name, `
      SELECT a.id, a.status, a.appointment_date::text AS appointment_date,
             p.phone, p.id as patient_id, p.name as patient_name, d.name as doctor_name
      FROM appointments a
      JOIN patients p ON p.id=a.patient_id
      JOIN doctors d ON d.id=a.doctor_id
      WHERE a.status IN ('completed', 'no_show')
        -- Key the window off when the appointment became ELIGIBLE, not off the
        -- visit date. 'completed'/'no_show' is a status the clinic sets by hand,
        -- and a practice that reconciles the week on Monday marks Tue–Fri all at
        -- once: with a visit-date window, Tue/Wed/Thu were already outside it and
        -- never got a request, ever. updated_at moves with the status change
        -- (every status route sets updated_at=NOW()), so all four are picked up.
        --
        -- Window is a RANGE, not exactly "yesterday". With a hard LIMIT and a
        -- single-day window, every patient past the limit was dropped forever,
        -- because that day is never "yesterday" again. Combined with
        -- feedback_request_sent below, the backlog now drains over later runs.
        --
        -- Rolling NOW() interval, not an IST_TODAY_SQL date: updated_at is a
        -- TIMESTAMPTZ, and comparing one to a ::date coerces at the server
        -- timezone (UTC) and reintroduces the 5.5-hour skew.
        AND a.updated_at >= NOW() - INTERVAL '3 days'
        -- Independent sanity bound on the visit itself. Without it, a clinic
        -- finally tidying up months-old records would blast "how was your visit?"
        -- at patients who came in last spring. 30 days is the outer edge of a
        -- rating a patient can still meaningfully give; the '1 day' end means a
        -- visit completed today is asked about starting tomorrow's run, not today's.
        AND a.appointment_date BETWEEN ${IST_TODAY_SQL} - INTERVAL '30 days'
                                   AND ${IST_TODAY_SQL} - INTERVAL '1 day'
        AND a.follow_up_sent IS NOT TRUE
        AND a.feedback_request_sent IS NOT TRUE
        -- Once per patient per month, not once per appointment. Keyed on the
        -- PATIENT rather than the phone: a family shares one number, and the
        -- father's root canal must not silence the daughter's first visit.
        AND NOT EXISTS (
          SELECT 1 FROM appointments prev
           WHERE prev.patient_id = a.patient_id
             AND prev.id <> a.id
             AND prev.feedback_request_sent IS TRUE
             AND prev.updated_at >= NOW() - INTERVAL '30 days'
        )
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
        // Name the actual date rather than saying "yesterday": now that the
        // window keys off updated_at, a visit marked no_show during a weekly
        // reconciliation can be several days back.
        let visitLabel = 'recently';
        try { visitLabel = 'on ' + format(parseISO(appt.appointment_date), 'EEE, d MMM'); } catch {}
        // no_show patients didn't have a visit — a "how was your visit?" message
        // would be tone-deaf. Nudge them to rebook instead.
        // In step with `appointment_missed_rebook` / `appointment_feedback_request`.
        // No scolding in the no-show branch: a patient who missed an appointment
        // is usually embarrassed already, and the message that opens by naming
        // their failure is the one they don't answer. The discomfort line
        // supplies the urgency instead.
        const message = appt.status === 'no_show'
          ? `Hi ${firstName}, you weren't able to make your appointment with Dr. ${appt.doctor_name} at ${tenant.name} ${visitLabel} — that's alright, it happens.\n\n` +
            `Whenever you're ready we'll find you another time. Sooner is better if you were in any discomfort.\n\n` +
            `Reply *Menu* to book.`
          : `⭐ *How did we do?*\n\n` +
            `Hi ${firstName}, we hope Dr. ${appt.doctor_name} at ${tenant.name} took good care of you.\n\n` +
            `Reply with a number from *1* (poor) to *5* (excellent). It goes only to the clinic — nothing is published anywhere.`;
        if (!await canSendDiscretionary(tenant.schema_name, appt.phone, budgetFor(tenant))) continue;

        // Template-first for the same reason as the feedback job: this runs
        // days after the visit, well outside the 24-hour window.
        await sendPatientMessage(tenant.schema_name, appt.phone, {
          template: appt.status === 'no_show' ? 'appointment_missed_rebook' : 'appointment_feedback_request',
          buttonPayloads: appt.status === 'no_show' ? ['Menu'] : ['5', '3', '1'],
          components: [{
            type: 'body',
            parameters: [
              { type: 'text', text: firstName },
              { type: 'text', text: appt.doctor_name },
              // {{3}} on BOTH templates — they are interchangeable here, so the
              // parameter list has to fit either.
              { type: 'text', text: tenant.name },
            ],
          }],
          text: message,
        });
        // Marked the moment the send SUCCEEDS, and before the bookkeeping
        // below. It still means "not sent, try next run" if sendPatientMessage
        // threw — but the message has now definitely gone out, and anything
        // that fails after this point must not buy the patient a second copy.
        // With the flag set last, a transient failure in triggerFeedback or
        // recordPendingReply left it false while the "⭐ How did we do?" message
        // was already delivered, and the row still matched the window on the
        // next two daily runs: three rating requests for one visit, which is
        // exactly what the once-a-month-per-patient rule exists to prevent.
        await tenantQuery(tenant.schema_name,
          `UPDATE appointments SET feedback_request_sent=true WHERE id=$1`, [appt.id]);

        // Only arm the rating flow for completed visits — no_show patients got
        // a rebook nudge, not a rating request. Its own try: failing to arm the
        // session costs this one rating, and that is strictly better than
        // re-sending the request to get it.
        if (appt.status !== 'no_show') {
          try {
            await triggerFeedback(
              tenant.schema_name,
              appt.phone,
              appt.id,
              appt.patient_id,
              appt.doctor_name
            );
            // Same reason as the follow-up above: the rating must come back to
            // the clinic whose session is armed for it. no_show patients got a
            // rebook nudge, not a question, so nothing to wait for.
            await recordPendingReply(appt.phone, tenant.id, KINDS.FEEDBACK, 24);
          } catch (armErr) {
            logger.warn(`Feedback sent but rating flow not armed for appointment ${appt.id}`,
              { error: armErr.message });
          }
        }
        logger.info(`Feedback request sent for appointment ${appt.id}`);
      } catch (err) {
        logger.error(`Feedback request failed for appointment ${appt.id}`, { error: err.message });
      }
    }
  });
}

// ── WEEKLY SUMMARY FOR THE OWNER ─────────────────────────────
/**
 * The one report that reaches a clinic owner without them logging in.
 *
 * It used to be an email, and went out with services/email.js. That left the
 * dashboard as the only place to see how the week went — and an owner who is
 * chairside all day does not open the dashboard. So it now goes where they
 * already are: WhatsApp, to whichever admins have set a notify_phone.
 *
 * Deliberately short. A wall of per-dentist statistics is a report nobody reads
 * twice; the numbers here are the ones an owner acts on — who came, who did
 * not, and what is still owed to the practice in unbooked treatment.
 */
async function sendWeeklyDigests() {
  const nowIST = toZonedTime(new Date(), TIMEZONE);
  // The window ends YESTERDAY and spans exactly 7 days. It used to run
  // subWeeks(now,1) .. now, which with an inclusive SQL BETWEEN on a DATE column
  // is EIGHT days with a Monday at each end: last Monday was counted twice (it
  // had already been reported in the previous digest), and TODAY was counted
  // too — at 08:00 none of today's appointments have happened, so they inflated
  // `total` and `revenue` while contributing nothing to `completed`, and the
  // owner read "23 appointments · 3 completed" for a week that went fine. The
  // message calls itself "Last week", so it must not contain today.
  const rangeEnd   = format(subDays(nowIST, 1), 'yyyy-MM-dd');
  const rangeStart = format(subDays(nowIST, 7), 'yyyy-MM-dd');

  await forEachActiveTenantParallel('sendWeeklyDigests', async (tenant) => {
    try {
      const [statsR, outstandingR] = await Promise.all([
        tenantQuery(tenant.schema_name, `
          SELECT COUNT(*)::int AS total,
                 COUNT(*) FILTER (WHERE a.status='completed')::int AS completed,
                 COUNT(*) FILTER (WHERE a.status='no_show')::int   AS no_show,
                 COUNT(*) FILTER (WHERE a.status='cancelled')::int AS cancelled,
                 COALESCE(SUM(COALESCE(NULLIF(a.effective_fee, 0), d.consultation_fee))
                          FILTER (WHERE a.status IN ('confirmed','completed')), 0)::int AS revenue
          FROM appointments a JOIN doctors d ON d.id=a.doctor_id
          WHERE a.appointment_date BETWEEN $1 AND $2
        `, [rangeStart, rangeEnd]),
        // Treatment advised and never booked — revenue already agreed and
        // sitting idle. This is the number that makes the message worth opening.
        tenantQuery(tenant.schema_name, `
          -- Must match GET /treatment-plans?outstanding=true exactly, because
          -- that queue is what this line tells the owner to go and work. Without
          -- the visit-count condition it counted every live plan, including ones
          -- whose remaining sittings are already on the calendar — so the digest
          -- said "12 treatments advised and not yet booked" and the dashboard
          -- queue it points at showed none. A number that disagrees with the
          -- screen is a number that stops being read.
          SELECT COUNT(*)::int AS n FROM treatment_plans tp
           WHERE tp.status IN ('proposed','in_progress')
             AND (SELECT COUNT(*) FROM appointments a
                   WHERE a.treatment_plan_id = tp.id AND a.status <> 'cancelled') < tp.total_visits
        `).catch(() => ({ rows: [{ n: null }] })),
      ]);

      const st = statsR.rows[0] || {};
      if (!st.total) return; // a week with no appointments is not worth a message

      let label = `${rangeStart} to ${rangeEnd}`;
      try {
        label = `${format(parseISO(rangeStart), 'd MMM')} – ${format(parseISO(rangeEnd), 'd MMM')}`;
      } catch (_) {}

      const outstanding = outstandingR.rows[0]?.n;
      const message =
        `📊 *Last week at ${tenant.name}*\n` +
        `_${label}_\n\n` +
        `${st.total} appointment${st.total === 1 ? '' : 's'} · ${st.completed} completed\n` +
        `${st.no_show} no-show${st.no_show === 1 ? '' : 's'} · ${st.cancelled} cancelled\n` +
        `₹${st.revenue.toLocaleString('en-IN')} booked\n` +
        (outstanding ? `\n${outstanding} treatment${outstanding === 1 ? '' : 's'} advised and not yet booked.\n` : '') +
        `\nOpen the dashboard for the detail.`;

      // notifyAdminWhatsApp fans out to every admin with a notify_phone and
      // logs each send, so it is called ONCE — never inside a per-admin loop.
      // A clinic with no notify_phone set simply gets nothing, which is the
      // correct behaviour for a number we were never given.
      await notifyAdminWhatsApp(tenant.schema_name, tenant, message);
      logger.info(`Weekly summary sent for tenant ${tenant.name}`);
    } catch (err) {
      logger.error(`Weekly summary failed for ${tenant.name}`, { error: err.message });
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

  // Weekly summary: Mondays 8 AM IST (02:30 UTC)
  const digestTask = cron.schedule('30 2 * * 1', async () => {
    await withCronLock('cron:weekly_digest', 3600, async () => {
      logger.info('Running weekly summary cron...');
      try {
        await sendWeeklyDigests();
        await query(`UPDATE cron_jobs SET last_run_at=NOW(), last_status='ok', last_error=NULL WHERE job_name='weekly_digest'`).catch(() => {});
      } catch (err) {
        logger.error('Weekly summary cron error', { error: err.message });
        await query(`UPDATE cron_jobs SET last_run_at=NOW(), last_status='error', last_error=$1 WHERE job_name='weekly_digest'`, [err.message.slice(0, 500)]).catch(() => {});
      }
    });
  });

  logger.info('Reminder cron registered (runs hourly)');
  logger.info('Feedback cron registered (daily at 10 AM IST)');
  logger.info('Weekly summary cron registered (Mondays 8 AM IST)');
  return [reminderTask, feedbackTask, digestTask];
}

module.exports = {
  startReminderCron,
  sendReminders,
  sendFeedbackRequests,
  sendWeeklyDigests,
  handleReminderConfirmation,
};
