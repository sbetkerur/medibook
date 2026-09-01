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
const { maskPhone, notifyAdminWhatsApp, sendStaffWhatsApp } = require('../services/bot/utils');
// Reminders are NEVER gated by this — a patient with an appointment tomorrow
// wants that message. Only the discretionary sends below are.
const { canSendDiscretionary, budgetFor } = require('../services/messageBudget');
// triggerFeedback writes bot_sessions.state; without the per-phone lock it can
// race a live inbound message and clobber the patient's current step (or be
// clobbered). Same lock key the BullMQ worker and the webhook-retry cron use.
const { acquirePhoneLock, releasePhoneLock } = require('../utils/phoneLock');

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
    // The old `AND a.follow_up_sent IS NOT TRUE` guard is gone: the
    // post-appointment follow-up cron that set that flag was removed years ago,
    // so the condition was always true and only obscured the query. The column
    // stays in the schema (dropping per-tenant columns is the irreversible move)
    // but nothing reads it now.
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
        const sendResult = await sendPatientMessage(tenant.schema_name, appt.phone, {
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
        // The trial send cap suppresses the message without throwing (returns
        // { via: 'suppressed_cap' }). Setting feedback_request_sent=true here
        // would then permanently drop the request for a patient who never saw
        // it — a thrown error at least leaves the flag false for the next run.
        // Skip all the bookkeeping so the row stays eligible. Same guard the
        // treatment-nudge and recall crons apply to a suppressed send.
        if (sendResult?.via === 'suppressed_cap') {
          logger.info(`Feedback request suppressed by trial send cap — will retry`, { appointment: appt.id });
          continue;
        }
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
          // Serialise the bot_sessions write against any live inbound message
          // from this phone. FAILS OPEN (same policy as everywhere else): a
          // Redis blip must not stop the rating flow being armed.
          const lockKey = `botlock:${tenant.id}:${appt.phone}`;
          const { acquired, token } = await acquirePhoneLock(lockKey);
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
          } finally {
            if (acquired) await releasePhoneLock(lockKey, token);
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

// ── "IS YOUR QR CODE ACTUALLY UP?" ──────────────────────────
/**
 * The QR code is the ONLY way a patient reaches the bot (CLAUDE.md). A clinic
 * whose poster never got printed — or got taken down — is silently unreachable:
 * the dashboard still works, so nobody notices until the practice wonders where
 * its WhatsApp bookings went. This is the one signal that catches that.
 *
 * Fires only when the clinic HAS launched (active > 21 days) and NO inbound
 * patient message has arrived in 14 days — so a brand-new clinic still setting
 * up, and a clinic that simply had a quiet fortnight after a busy one, are both
 * left alone the first time (a genuinely dead QR keeps tripping it). Throttled
 * to once per 21 days via settings.unreachable_alert_at; opt out with
 * settings.unreachable_alerts_enabled = false.
 */
async function sendUnreachableClinicAlerts() {
  await forEachActiveTenantParallel('sendUnreachableClinicAlerts', async (tenant) => {
    const settings = tenant.settings || {};
    if (settings.unreachable_alerts_enabled === false) return;
    if (!tenant.activated_at || new Date(tenant.activated_at).getTime() > Date.now() - 21 * 864e5) return;

    const last = settings.unreachable_alert_at ? new Date(settings.unreachable_alert_at).getTime() : 0;
    if (last > Date.now() - 21 * 864e5) return; // already nudged them recently

    try {
      const r = await tenantQuery(tenant.schema_name, `
        SELECT
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '14 days') AS recent,
          COUNT(*) AS ever
        FROM wa_messages WHERE direction = 'in'
      `);
      const recent = parseInt(r.rows[0].recent);
      const ever = parseInt(r.rows[0].ever);
      // A fortnight of silence is the trigger, whether the QR was never put up
      // (ever === 0, and we already know the clinic is 21+ days old) or it came
      // down / stopped working (ever > 0 but recent === 0). Either way, one nudge.
      if (recent > 0) return;

      await notifyAdminWhatsApp(tenant.schema_name, tenant,
        `⚠️ *No WhatsApp bookings coming in*\n\n` +
        `${tenant.name} hasn't had a single patient message on WhatsApp in the last 14 days.\n\n` +
        `Patients can only reach the booking bot by scanning your clinic's QR code, so if that's unexpected:\n` +
        `• check the QR poster is up where patients wait\n` +
        `• print a fresh one from *Settings* in the dashboard\n\n` +
        `If your QR is up and this still seems wrong, reply here and we'll look into it.`);

      await query(
        `UPDATE tenants SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb),
           '{unreachable_alert_at}', to_jsonb(NOW()::text)) WHERE id = $1`,
        [tenant.id]).catch(e => logger.warn('unreachable alert: settings stamp failed', { tenant: tenant.slug, error: e.message }));
      logger.info(`Unreachable-clinic alert sent for ${tenant.name}`, { ever_inbound: ever });
    } catch (err) {
      logger.error(`Unreachable-clinic check failed for ${tenant.name}`, { error: err.message });
    }
  });
}

// ── EACH DENTIST'S OWN DAY ───────────────────────────────────
/**
 * The weekly digest reaches the OWNER. This reaches each DENTIST — their own
 * list for today, on WhatsApp, so a dentist who is chairside and never opens the
 * dashboard still walks in knowing what the morning holds.
 *
 * Staff-facing: goes out via sendStaffWhatsApp (clinic_staff_alert template,
 * logged as an 'admin_alert' row) so it never touches a patient's message
 * budget. Opt-in per clinic — settings.doctor_daily_schedule_enabled — because
 * a dentist's notify_phone is otherwise unused and auto-messaging it would
 * surprise a clinic that set one for another reason. A dentist with nothing on
 * today gets no message, same as the weekly digest skips an empty week.
 */
async function sendDoctorDailySchedules() {
  await forEachActiveTenantParallel('sendDoctorDailySchedules', async (tenant) => {
    if ((tenant.settings || {}).doctor_daily_schedule_enabled !== true) return;

    let dentists;
    try {
      dentists = await tenantQuery(tenant.schema_name, `
        SELECT d.id AS doctor_id, d.name AS doctor_name, u.notify_phone
        FROM doctors d
        JOIN users u ON u.id = d.user_id
        WHERE d.is_active = true
          AND u.is_active = true
          AND u.notify_phone IS NOT NULL AND u.notify_phone <> ''
      `);
    } catch (err) {
      logger.error(`Doctor schedule: dentist lookup failed for ${tenant.name}`, { error: err.message });
      return;
    }

    for (const dentist of dentists.rows) {
      try {
        const appts = await tenantQuery(tenant.schema_name, `
          SELECT a.appointment_time, a.status, a.visit_number,
                 p.name AS patient_name,
                 h.name AS hospital_name,
                 tp.title AS treatment_title, tp.total_visits
          FROM appointments a
          JOIN patients p ON p.id = a.patient_id
          JOIN hospitals h ON h.id = a.hospital_id
          LEFT JOIN treatment_plans tp ON tp.id = a.treatment_plan_id
          WHERE a.doctor_id = $1
            AND a.appointment_date = ${IST_TODAY_SQL}
            AND a.status <> 'cancelled'
          ORDER BY a.appointment_time
        `, [dentist.doctor_id]);

        if (!appts.rows.length) continue; // nothing today — no message

        const branches = new Set(appts.rows.map(r => r.hospital_name).filter(Boolean));
        const multiBranch = branches.size > 1;
        const MAX_LINES = 15;
        const lines = appts.rows.slice(0, MAX_LINES).map(r => {
          const t = (r.appointment_time || '').slice(0, 5) || '--:--';
          let line = `${t}  ${r.patient_name || 'Patient'}`;
          if (r.treatment_title) {
            line += ` — ${r.treatment_title}`;
            if (r.visit_number && r.total_visits) line += ` (v${r.visit_number}/${r.total_visits})`;
          }
          if (multiBranch && r.hospital_name) line += ` @ ${r.hospital_name}`;
          return line;
        });
        if (appts.rows.length > MAX_LINES) lines.push(`…and ${appts.rows.length - MAX_LINES} more`);

        const n = appts.rows.length;
        const header = multiBranch
          ? `Today · ${n} appointment${n === 1 ? '' : 's'}`
          : `Today · ${n} appointment${n === 1 ? '' : 's'}${branches.size ? ` · ${[...branches][0]}` : ''}`;
        const message = `📅 *Your day, Dr. ${dentist.doctor_name}*\n${header}\n\n${lines.join('\n')}`;

        await sendStaffWhatsApp(tenant.schema_name, dentist.notify_phone, tenant.name, message);
        logger.info(`Daily schedule sent to Dr. ${dentist.doctor_name} at ${tenant.name}`);
      } catch (err) {
        logger.error(`Doctor schedule failed for a dentist at ${tenant.name}`, { error: err.message });
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

  // Weekly summary: Mondays 8 AM IST (02:30 UTC)
  const digestTask = cron.schedule('30 2 * * 1', async () => {
    await withCronLock('cron:weekly_digest', 3600, async () => {
      logger.info('Running weekly summary cron...');
      try {
        await sendWeeklyDigests();
        // Same Monday-morning cadence and same staff audience — the owner reads
        // both in one sitting. Its own try inside sendUnreachableClinicAlerts
        // per tenant, so a failure here does not lose the digest's ok status.
        await sendUnreachableClinicAlerts();
        await query(`UPDATE cron_jobs SET last_run_at=NOW(), last_status='ok', last_error=NULL WHERE job_name='weekly_digest'`).catch(() => {});
      } catch (err) {
        logger.error('Weekly summary cron error', { error: err.message });
        await query(`UPDATE cron_jobs SET last_run_at=NOW(), last_status='error', last_error=$1 WHERE job_name='weekly_digest'`, [err.message.slice(0, 500)]).catch(() => {});
      }
    });
  });

  // Each dentist's own day: 07:30 IST (02:00 UTC)
  const doctorScheduleTask = cron.schedule('0 2 * * *', async () => {
    await withCronLock('cron:doctor_schedule', 3600, async () => {
      logger.info('Running per-dentist daily schedule cron...');
      try {
        await sendDoctorDailySchedules();
        await query(`UPDATE cron_jobs SET last_run_at=NOW(), last_status='ok', last_error=NULL WHERE job_name='doctor_schedule'`).catch(() => {});
      } catch (err) {
        logger.error('Per-dentist daily schedule cron error', { error: err.message });
        await query(`UPDATE cron_jobs SET last_run_at=NOW(), last_status='error', last_error=$1 WHERE job_name='doctor_schedule'`, [err.message.slice(0, 500)]).catch(() => {});
      }
    });
  });

  logger.info('Reminder cron registered (runs hourly)');
  logger.info('Feedback cron registered (daily at 10 AM IST)');
  logger.info('Weekly summary cron registered (Mondays 8 AM IST)');
  logger.info('Per-dentist daily schedule cron registered (daily at 07:30 IST)');
  return [reminderTask, feedbackTask, digestTask, doctorScheduleTask];
}

module.exports = {
  startReminderCron,
  sendReminders,
  sendFeedbackRequests,
  sendWeeklyDigests,
  sendUnreachableClinicAlerts,
  sendDoctorDailySchedules,
  handleReminderConfirmation,
};
