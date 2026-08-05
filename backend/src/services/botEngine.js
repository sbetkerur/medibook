'use strict';

const wa = require('./whatsapp');
const { decrypt } = require('../utils/encryption');
const { tenantQuery } = require('../db');
const logger = require('../utils/logger');
const { format, parseISO, addDays: _addDays } = require('date-fns');
const { toZonedTime: _toZonedTime } = require('../utils/dateTz');

// ── Sub-module imports ────────────────────────────────────────
const {
  STATES,
  getSession,
  updateSession,
  resetSessionToIdle,
  isOptedOut,
  getPatient,
  logMessage,
  maskPhone,
  parseChoiceNumber,
  sendConfirmButtons,
  confirmButtonIndex,
  clinicPhoneLine,
} = require('./bot/utils');

const {
  startBooking,
  handleSelectHospital,
  handleSelectDept,
  handleSelectDoctor,
  handleSelectDate,
  handleSelectSlot,
  handleSelectPatient,
  askChiefComplaint,
  handleChiefComplaint,
  showConfirmation,
  completeBooking,
} = require('./bot/bookingFlow');

const {
  showMyAppointments,
  handleRescheduleSelect,
  handleRescheduleDate,
  handleRescheduleSlot,
  handleRescheduleConfirm,
  handleCancelSelect,
  handleCancelReason,
  handleCancelConfirm,
} = require('./bot/appointmentFlow');

const {
  showTreatmentPlans,
  handleSelectTreatmentPlan,
} = require('./bot/treatmentFlow');

const {
  REQUEST_RE,
  handleCallbackRequest,
  handleAppointmentRequest,
} = require('./bot/requestFlow');

/**
 * The main menu — ONE implementation.
 *
 * There were five copies of this send, and a copy-wide change reached only two
 * of them: arriving via a stale-button tap or the mid-flow fallback still got
 * the old `👋 Welcome … to *Clinic*!` with no header or footer, so the clinic's
 * branding changed depending on which path a patient came in by. Every caller
 * now goes through here.
 *
 * @param {string} [lead] - replaces the greeting line, for the cases that need
 *   to say something first ("Booking cancelled.").
 * @param {boolean} [welcome] - set only when the patient has just arrived by
 *   scanning this clinic's QR code. Leads with the clinic's NAME in the body,
 *   not just the header: the number is shared, the header is small and grey,
 *   and the first thing someone who has pointed a camera at a poster needs is
 *   confirmation that they reached the practice they are standing in. It
 *   REPLACES the ordinary greeting rather than preceding it as a second
 *   message — an arrival should be one notification, not two.
 */
async function sendMainMenu(send, tenant, patient, lead, welcome) {
  const firstName = patient?.name ? `, ${patient.name.split(' ')[0]}` : '';
  const welcomeBody = welcome
    ? (patient?.name
      ? `👋 Welcome back to *${tenant.name}*${firstName}.\n\nHow can we help today?`
      : `👋 Welcome to *${tenant.name}*.\n\nYou can book an appointment, check an existing one or manage a booking — all right here.`)
    : null;
  const body = lead || welcomeBody || (patient?.name
    ? `Hello${firstName} — how can we help today?`
    : 'Book an appointment, check an existing one, or manage a booking — all here on WhatsApp.');
  return send.buttons(
    body,
    ['📅 Book Appointment', '🗓 My Appointments', '📍 Address & Phone'],
    // The header is the clinic's name on every interactive message, and it is
    // doing real work: the number is shared, so this is the only thing that
    // tells a patient whose desk they are talking to. The footer says "Menu"
    // rather than "Hi" because the two now do the same thing, and "Hi" used to
    // mean "leave this clinic" — copy must not imply that is still on offer.
    { header: String(tenant.name).slice(0, 60), footer: 'Reply Menu any time' }
  );
}

/**
 * Where we are and how to ring us.
 *
 * The bot tells patients to call in half a dozen places, so the number has to
 * be reachable from the menu in one tap rather than only appearing inside an
 * error. Lists every active branch: a patient of a two-branch clinic needs to
 * know which one they are going to, and the addresses are what tell them apart.
 */
async function showClinicInfo(phone, schema, tenant, send) {
  const r = await tenantQuery(schema,
    `SELECT name, address, city, phone FROM hospitals
      WHERE is_active=true AND deleted_at IS NULL ORDER BY created_at`).catch(() => null);
  const rows = r?.rows || [];

  if (!rows.length) {
    await send.text('Our contact details are not set up here yet — sorry about that.\n\nReply *Menu* to go back.');
    await updateSession(schema, phone, STATES.MAIN_MENU, {});
    return;
  }

  const blocks = rows.map(h => [
    `*${h.name}*`,
    [h.address, h.city].filter(Boolean).join(', '),
    h.phone ? `📞 ${h.phone}` : null,
  ].filter(Boolean).join('\n')).join('\n\n');

  await send.text(`${blocks}\n\nReply *Menu* for anything else.`);
  await updateSession(schema, phone, STATES.MAIN_MENU, {});
}

// "Book my next sitting." Deliberately narrow: it must not swallow a plain
// "book" (that is the ordinary booking menu option) and must not fire on the
// word "treatment" buried in a sentence describing symptoms.
const TREATMENT_KEYWORD_RE = /^(my )?(treatment|treatments|sitting|next sitting|book treatment|book my treatment)$/i;

// ── SMART INTENT DETECTION ────────────────────────────────────
// Detects shortcuts in free-text to skip bot flow steps.
// Returns an object with detected intent hints, or null.
function detectIntent(input) {
  if (!input || input.length > 200) return null;
  const lower = input.toLowerCase();
  const hints = {};

  // Dental-specific department shortcuts
  const deptPatterns = [
    { pattern: /root canal|rct|nerve pain|throbbing|pulp/i,               dept: 'Root Canal Treatment' },
    { pattern: /brace|aligner|crooked|gap|spacing|malocclus|ortho/i,      dept: 'Orthodontics & Braces' },
    { pattern: /implant|missing tooth|missing teeth|replace tooth/i,       dept: 'Dental Implants' },
    { pattern: /whiten|veneer|smile makeover|cosmetic|bleach/i,            dept: 'Cosmetic Dentistry' },
    { pattern: /child|kids? dent|baby teeth|paed|pediat/i,                 dept: 'Pediatric Dentistry' },
    { pattern: /wisdom|extract|removal|jaw|oral surg|maxillo/i,            dept: 'Oral Surgery' },
    { pattern: /checkup|clean|scaling|cavity|decay|filling|toothache|tooth pain|gum|general/i, dept: 'General Dentistry' },
  ];
  for (const { pattern, dept } of deptPatterns) {
    if (pattern.test(lower)) { hints.department_hint = dept; break; }
  }

  // Date shortcuts — use IST "now" so "today" and "tomorrow" are correct for
  // Indian users during the 5.5-hour window where UTC date ≠ IST date.
  const nowIST = _toZonedTime(new Date(), 'Asia/Kolkata');
  if (/\btoday\b/i.test(lower)) {
    hints.date_hint = format(nowIST, 'yyyy-MM-dd');
  } else if (/\btomorrow\b/i.test(lower)) {
    hints.date_hint = format(_addDays(nowIST, 1), 'yyyy-MM-dd');
  } else {
    const dayMap = { monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6, sunday:0 };
    for (const [day, dow] of Object.entries(dayMap)) {
      if (lower.includes(day)) {
        const todayDow = nowIST.getDay();
        let daysAhead = (dow - todayDow + 7) % 7;
        if (daysAhead === 0) daysAhead = 7; // next week same day
        hints.date_hint = format(_addDays(nowIST, daysAhead), 'yyyy-MM-dd');
        break;
      }
    }
  }

  return Object.keys(hints).length > 0 ? hints : null;
}

// ── MAIN HANDLER ──────────────────────────────────────────────
// `welcome` is set by routes/webhook.js only for the synthesised greeting that
// follows a QR scan, so the main menu can greet the patient by the clinic's name
// instead of sending a second "connecting you…" message ahead of it.
async function handle({ phone, text, buttonId, tenant, waMessageId, welcome }) {
  if (!text && !buttonId) return;

  const { LIMITS } = require('../utils/errors');
  // Input length guard
  if ((text || '').length > LIMITS.BOT_INPUT_MAX_LENGTH) {
    logger.warn(`Oversized input (${(text || '').length} chars), ignoring`);
    return;
  }

  const schema = tenant.schema_name;
  // Shared WhatsApp number — always use global META_* env vars (token/phoneId = null → fallback to env)
  const waToken = null;
  const waPhoneId = null;

  try {
    return await _handleInner({ phone, text, buttonId, tenant, waMessageId, schema, waToken, waPhoneId, welcome });
  } catch (err) {
    // Top-level safety net — if anything throws (DB error, circuit breaker open, etc.),
    // reset the session to idle and tell the user to try again. This prevents the bot
    // from silently dying and leaving the user stuck with no response.
    logger.error('Bot handle() uncaught error', {
      phone: maskPhone(phone), tenant: tenant.slug, error: err.message,
      stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
    });
    // Deliberately do NOT reset the session here. The rethrow below feeds the
    // BullMQ/failed_webhooks retry machinery, which replays this same message —
    // with the session wiped, every replay landed in IDLE as "didn't
    // understand" spam and could never succeed at the original intent. With
    // state intact, a retry after a transient failure (DB blip) completes the
    // step the patient was on. If failures persist, "Hi" always resets, and
    // the 4-hour session expiry catches abandoned flows.
    try {
      await wa.sendText(phone,
        'Something went wrong at our end — I am trying again. If nothing happens, reply *Menu* to start over.',
        waToken, waPhoneId);
    } catch (_) { /* ignore — circuit might be open */ }
    try { require('../utils/metrics').increment('bot_errors_total'); } catch (_) {}
    // Re-throw so BullMQ marks the job failed and the retry path engages
    throw err;
  }
}

async function _handleInner({ phone, text, buttonId, tenant, waMessageId, schema, waToken, waPhoneId, welcome }) {

  // Inbound message is already logged by the webhook handler for idempotency dedup.
  // Only log outgoing messages here to avoid a double-insert in wa_messages.

  // Send FIRST, then log with the id Meta returned. Logging first meant every
  // outbound row was written with wa_message_id NULL, so the sent/delivered/read
  // callbacks in routes/webhook.js could never match a row and the status column
  // stayed NULL forever. Consequence of the swap: a send that THROWS is no longer
  // written to history — the same policy services/outbound.js already documents
  // (history must record what actually went out). The throw still propagates to
  // handle()'s top-level catch exactly as before, which is what feeds the
  // BullMQ/failed_webhooks retry path.
  const send = {
    text: async (t) => {
      const id = await wa.sendText(phone, t, waToken, waPhoneId);
      await logMessage(schema, phone, 'out', 'text', t, id);
      return id;
    },
    // `opts` carries { header, footer } — WhatsApp's own slots, not bold text
    // faked inside the body. History logs the body only, which is what the
    // clinic reads back; the header/footer are chrome.
    buttons: async (t, btns, opts) => {
      const id = await wa.sendButtons(phone, t, btns, waToken, waPhoneId, opts);
      await logMessage(schema, phone, 'out', 'buttons', t, id);
      return id;
    },
    list: async (t, label, sections, opts) => {
      const id = await wa.sendList(phone, t, label, sections, waToken, waPhoneId, opts);
      await logMessage(schema, phone, 'out', 'list', t, id);
      return id;
    },
  };

  const input = (text || '').trim();
  const lowerInput = input.toLowerCase();
  const choice = buttonId || lowerInput;

  // ── OPTED-OUT check — silently drop all messages from opted-out patients ──
  // We check opted_out before any state handling so opted-out patients can
  // still send STOP/START but get no other bot responses.
  // isOptedOut (bot/utils) is the single definition — the webhook's
  // unsupported-type reply, the clinic-selection confirmation and the voice
  // path all sit OUTSIDE this function and have to ask the same question.
  if (!/^(stop|unsubscribe|opt.?out|block|start)$/i.test(input)) {
    if (await isOptedOut(schema, phone)) {
      logger.info(`Dropped message from opted-out patient`, { phone: maskPhone(phone) });
      return;
    }
  }

  // ── OPT-OUT handler ─────────────────────────────────────────
  if (/^(stop|unsubscribe|opt.?out|block)$/i.test(input)) {
    await tenantQuery(schema,
      `UPDATE patients SET opted_out=true, updated_at=NOW() WHERE phone=$1`, [phone])
      .catch(err => logger.warn('Opt-out patient update failed', { phone: maskPhone(phone), error: err.message }));
    await resetSessionToIdle(schema, phone)
      .catch(err => logger.warn('Opt-out session reset failed', { phone: maskPhone(phone), error: err.message }));
    await send.text(
      // Not "you have been unsubscribed from … notifications" — that is mailing
      // list language. A patient has just told their dentist to stop messaging,
      // and the reply should sound like the dentist heard them.
      `Done — ${tenant.name} will not message you here again.\n\nChanged your mind? Reply *Start* and we will turn them back on.`
    ).catch(err => logger.warn('Opt-out reply failed to send', { phone: maskPhone(phone), error: err.message }));
    logger.info(`Patient ${maskPhone(phone)} opted out from ${tenant.name}`);
    return;
  }

  // ── RE-SUBSCRIBE handler ─────────────────────────────────────
  if (/^start$/i.test(input)) {
    await tenantQuery(schema,
      `UPDATE patients SET opted_out=false, updated_at=NOW() WHERE phone=$1`, [phone])
      .catch(() => {});
  }

  const isGreeting = /^(hi|hello|hey|menu|start|helo|hy|hai)$/i.test(input);

  // ── GREETING — fast path ─────────────────────────────────────
  // Handled BEFORE session context loading so that "Hi" reliably
  // resets from ANY state — including corrupted/encrypted sessions
  // where context decryption would otherwise fail and return early.
  if (isGreeting) {
    await updateSession(schema, phone, STATES.MAIN_MENU, {});
    const patient = await getPatient(schema, phone).catch(() => null);
    const firstName = patient?.name ? `, ${patient.name.split(' ')[0]}` : '';
    // `welcome` only reaches here on the synthesised greeting that follows a QR
    // scan — an ordinary "Hi" or "Menu" from someone already in the thread is
    // not an arrival and gets the normal menu.
    await sendMainMenu(send, tenant, patient, null, welcome);
    // WhatsApp caps interactive messages at three buttons and all three are
    // spoken for, so an ongoing treatment is surfaced as a follow-up line rather
    // than a fourth option. Only shown when there is actually a sitting left to
    // book — otherwise it is noise on every greeting. Best-effort: a failure
    // here must never cost the patient their menu.
    try {
      const { getOpenPlans, planLabel } = require('./bot/treatmentFlow');
      const openPlans = await getOpenPlans(schema, phone);
      if (openPlans.length) {
        await send.text(
          `🦷 *Ongoing treatment*\n\n${openPlans.map(planLabel).join('\n')}\n\n` +
          `Reply *Treatment* to book your next sitting.`
        );
      }
    } catch (err) {
      logger.warn('Open treatment lookup failed on greeting', { error: err.message });
    }
    return;
  }

  let session = await getSession(schema, phone);
  let ctx = {};
  try {
    const raw = session.context
      ? (typeof session.context === 'string' ? JSON.parse(session.context) : session.context)
      : {};
    // Decrypt context if stored encrypted (see bot/utils.js updateSession)
    if (raw && raw._enc) {
      const decrypted = decrypt(raw._enc);
      if (!decrypted) {
        // Decryption failed (key rotation or corrupted data) — reset session entirely
        // so the bot doesn't stay stuck in a broken mid-flow state with empty context.
        logger.warn('Session context decryption failed, resetting to idle', { phone: maskPhone(phone) });
        await updateSession(schema, phone, STATES.IDLE, {});
        await send.text('Something went wrong at our end.\n\nReply *Menu* and we will pick up from there.');
        return;
      }
      ctx = JSON.parse(decrypted);
    } else {
      // Legacy unencrypted session — accept for backwards compat but log so
      // operators know these exist. They'll be re-encrypted on next updateSession.
      if (raw && Object.keys(raw).length > 0) {
        logger.warn('Unencrypted bot session context found — will be encrypted on next write', { phone: maskPhone(phone) });
      }
      ctx = raw;
    }
  } catch (err) {
    logger.warn(`Malformed session context, resetting to idle`, { error: err.message });
    await updateSession(schema, phone, STATES.IDLE, {});
    await send.text('Something went wrong at our end.\n\nReply *Menu* and we will pick up from there.');
    return;
  }

  // ── SESSION EXPIRY — 4-hour hard cutoff ─────────────────────
  // Any active (non-idle) session untouched for 4+ hours is silently reset.
  // The background sessionCleaner cron handles sessions where the patient
  // never sends another message; this catches the case where they do.
  const SESSION_EXPIRY_MS = 4 * 60 * 60 * 1000; // 4 hours
  if (!isGreeting && session.state !== STATES.IDLE && session.state !== STATES.MAIN_MENU) {
    const elapsed = Date.now() - new Date(session.last_activity).getTime();
    if (elapsed > SESSION_EXPIRY_MS) {
      await updateSession(schema, phone, STATES.IDLE, {});
      session.state = STATES.IDLE;
      // Fall through — treat this message as a fresh start
    }
  }

  // ── FEEDBACK FLOW ────────────────────────────────────────────
  // Greetings (Hi/Hello/Menu) escape feedback state so patients don't get stuck.
  if (!isGreeting && session.state === STATES.COLLECT_FEEDBACK_RATING) {
    return handleFeedbackRating(phone, schema, send, ctx, choice, input);
  }
  if (!isGreeting && session.state === STATES.COLLECT_FEEDBACK_COMMENT) {
    return handleFeedbackComment(phone, schema, send, ctx, input);
  }

  // ── REMINDER SHORTCUTS ───────────────────────────────────────
  // Shortcuts only fire when the patient is NOT mid-flow: typed answers inside
  // a booking legitimately contain these words — "toothache" at the
  // reason-for-visit prompt used to wipe the nearly-complete booking one step
  // before confirmation.
  const atRestingState = session.state === STATES.IDLE || session.state === STATES.MAIN_MENU;
  if (atRestingState && /^reschedule$/i.test(input) && !isGreeting) {
    const patient = await getPatient(schema, phone);
    if (!patient) {
      await send.text('You have no appointments with us yet.\n\nReply *Menu* to book one.');
      await updateSession(schema, phone, STATES.IDLE, {});
      return;
    }
    await send.text('Which one? Send its booking ID — it looks like *MB12AB3*.');
    await updateSession(schema, phone, STATES.RESCHEDULE_SELECT, {});
    return;
  }
  if (atRestingState && /^cancel appointment$/i.test(input) && !isGreeting) {
    const patient = await getPatient(schema, phone);
    if (!patient) {
      await send.text('You have no appointments with us yet.\n\nReply *Menu* to book one.');
      await updateSession(schema, phone, STATES.IDLE, {});
      return;
    }
    await send.text('Which one? Send its booking ID — it looks like *MB12AB3*.');
    await updateSession(schema, phone, STATES.CANCEL_SELECT, {});
    return;
  }

  // ── DENTAL EMERGENCY SHORTCUT ────────────────────────────────
  if (atRestingState && /^(emergency|toothache|tooth ache|dental emergency|urgent)$/i.test(input) && !isGreeting) {
    await send.text(
      // The old copy opened "We'll get you seen as soon as possible!" and then
      // sent the patient into the ordinary booking flow — a promise the bot
      // cannot keep, placed above the one instruction that actually helps.
      // Calling leads; booking online is the fallback, not the headline.
      `🚨 *If you are in pain right now, please call us.*\n\n` +
      `We can get you seen today — far quicker than booking online.` +
      await clinicPhoneLine(schema) + `\n\n` +
      `If it can wait, reply *Menu* and tap *Book Appointment* for the earliest free slot.`
    );
    await updateSession(schema, phone, STATES.IDLE, {});
    return;
  }

  // ── "Book my next treatment sitting" ─────────────────────────
  // Accepted from a resting state only, so it can never hijack a step of a
  // booking already in progress. This is the keyword the nudge cron and the
  // treatment reminders tell the patient to send.
  //
  // MUST stay ABOVE the IDLE fallback below. It used to sit under it, and the
  // fallback returns unconditionally for an idle session — so the `IDLE` half
  // of this test was dead code and the nudge's own call to action did nothing
  // on the first reply. Idle is the NORMAL state for the patient this cron
  // targets: their sitting was booked at the desk, so they have no bot session
  // in flight, and every completed flow ends at IDLE. They tapped "Book my
  // next sitting" and got the generic main menu; only a second "Treatment"
  // (now from MAIN_MENU) worked. Every test for this keyword sends "Hi" first,
  // which parks the session at MAIN_MENU, which is why the suite stayed green.
  if ((session.state === STATES.IDLE || session.state === STATES.MAIN_MENU)
      && !buttonId && TREATMENT_KEYWORD_RE.test(input.trim())) {
    return showTreatmentPlans(phone, schema, tenant, send, ctx);
  }

  // ── IDLE fallback — any non-greeting message when session is idle ──
  if (session.state === STATES.IDLE) {
    const patient = await getPatient(schema, phone);
    await sendMainMenu(send, tenant, patient);
    await updateSession(schema, phone, STATES.MAIN_MENU, {});
    return;
  }

  // ── "CALL ME BACK" ───────────────────────────────────────────
  // The way out of every dead end, and a menu option in its own right. In an
  // Indian practice a patient the bot cannot help simply phones; this is the
  // same thing from the other end, so the clinic learns they existed.
  //
  // Placed ABOVE the state handlers for the same reason the treatment keyword
  // is: offerRequest parks the session at IDLE, and the IDLE fallback below
  // returns unconditionally.
  if (atRestingState && REQUEST_RE.test(input)) {
    // A request that came out of a full diary carries what they had chosen;
    // one typed at the menu carries nothing, which is fine.
    return ctx.request_preferred_date || ctx.request_note
      ? handleAppointmentRequest(phone, schema, tenant, send, ctx)
      : handleCallbackRequest(phone, schema, tenant, send, ctx);
  }

  // ── MAIN MENU ────────────────────────────────────────────────
  if (session.state === STATES.MAIN_MENU) {
    if (/\bbook\b|btn_0/i.test(choice) || choice === '1') {
      const intents = detectIntent(input);
      return startBooking(phone, schema, tenant, send, intents ? { ...ctx, ...intents } : ctx);
    }
    if (/\bappointment\b|\bmy\b|btn_1/i.test(choice) || choice === '2') {
      return showMyAppointments(phone, schema, tenant, send);
    }
    // "status" stays a keyword — patients were told it for months — but it now
    // goes where it should always have gone: the list of THEIR appointments,
    // which needs no booking ID.
    if (/^status$|check status/i.test(choice)) {
      return showMyAppointments(phone, schema, tenant, send);
    }
    if (/address|phone|location|directions|contact|btn_2/i.test(choice) || choice === '3') {
      return showClinicInfo(phone, schema, tenant, send);
    }
    if (/help|info/i.test(choice)) {
      await send.text(
        `ℹ️ *Help*\n\n` +
        `• Reply *Book* — Book an appointment\n` +
        `• Reply *Treatment* — Book your next treatment sitting\n` +
        `• Reply *My* — See your appointments\n` +
        `• Reply *Address* — Where we are and our number\n` +
        `• Reply *Call me* — Ask the clinic to ring you\n` +
        `• Reply *Menu* — Return to main menu\n\n` +
        `In an emergency, please call us.` + await clinicPhoneLine(schema)
      );
      return;
    }
    // Free text at the menu is the most likely thing a real person sends first
    // ("I need a dentist", "tooth pain"), and it used to get the flattest reply
    // in the product. Two changes: when detectIntent recognises a complaint,
    // just START the booking with that hint rather than telling them off; and
    // when it doesn't, re-offer the menu with the buttons attached instead of a
    // bare line of text pointing at a menu they can no longer see.
    const intents = detectIntent(input);
    if (intents?.department_hint) {
      return startBooking(phone, schema, tenant, send, { ...ctx, ...intents });
    }
    await sendMainMenu(send, tenant, await getPatient(schema, phone).catch(() => null),
      `Sorry — I didn't follow that. I can do these three things, or reply *Help* for what else I understand.`);
    return;
  }

  // ── CHECK BOOKING STATUS ─────────────────────────────────────
  if (session.state === STATES.CHECK_BOOKING_STATUS) {
    const bookingId = input.toUpperCase().trim();
    // Only return appointment info to the patient who owns the booking (phone match).
    const apptR = await tenantQuery(schema,
      `SELECT a.*, d.name as doctor_name, h.name as hospital_name, p.name as patient_name
       FROM appointments a
       JOIN doctors d ON d.id=a.doctor_id
       JOIN hospitals h ON h.id=a.hospital_id
       JOIN patients p ON p.id=a.patient_id
       WHERE a.booking_id=$1 AND p.phone=$2`,
      [bookingId, phone]);
    if (!apptR.rows[0]) {
      await send.text('I cannot find a booking with that ID. It is worth checking it against your confirmation message.\n\nReply *Menu* to go back.');
      return;
    }
    const a = apptR.rows[0];
    let dt = a.appointment_date;
    try { dt = format(parseISO(a.appointment_date), 'EEE, d MMM yyyy'); } catch {}
    // Was seven lines each opening with a different emoji, led by a form title
    // and a SHOUTED status. Same shape as the booking confirmation now: WHEN
    // and WHO first, because that is what someone checking a booking came to
    // look at, then the supporting detail in one quiet block.
    const statusLabel = {
      confirmed: 'Confirmed', completed: 'Completed',
      cancelled: 'Cancelled', no_show: 'Marked as missed',
    }[a.status] || a.status.replace(/_/g, ' ');
    await send.text(
      `*${dt}*\n` +
      `*${(a.appointment_time || '').slice(0, 5)}* with Dr. ${a.doctor_name}\n\n` +
      `${a.hospital_name}\n` +
      `For ${a.patient_name}\n` +
      `${statusLabel} · Booking ID *${a.booking_id}*\n\n` +
      `Reply *Menu* for anything else.`
    );
    await updateSession(schema, phone, STATES.IDLE, {});
    return;
  }

  // ── GLOBAL ESCAPE — cancel / back / exit / stale-button at any point in booking ──
  const BOOKING_STATES = [
    STATES.SELECT_HOSPITAL, STATES.SELECT_DEPARTMENT, STATES.SELECT_DOCTOR,
    STATES.SELECT_DATE, STATES.SELECT_SLOT, STATES.SELECT_PATIENT,
    STATES.COLLECT_NAME, STATES.COLLECT_DOB,
    STATES.COLLECT_GENDER, STATES.COLLECT_EMAIL, STATES.COLLECT_CHIEF_COMPLAINT,
    STATES.CONFIRM_BOOKING,
  ];
  if (BOOKING_STATES.includes(session.state)) {
    // Explicit typed escape keywords
    if (/^(cancel|exit|back|quit|0|main menu|mainmenu)$/i.test(input)) {
      await sendMainMenu(send, tenant, await getPatient(schema, phone).catch(() => null),
        'No problem — nothing was booked. What would you like to do?');
      await updateSession(schema, phone, STATES.MAIN_MENU, {});
      return;
    }

    // Patient tapped a stale MAIN MENU button from a previous message (WhatsApp keeps
    // all buttons tappable). Those titles never appear as valid options inside the
    // booking flow, so they unambiguously mean "take me back to the menu".
    //
    // NOTE: do NOT treat other buttonId replies here as stale — every legitimate
    // list/button reply in the booking flow (branch, treatment, dentist, date, slot,
    // gender, Skip, ✅ Confirm, …) carries a buttonId. Genuinely stale taps (e.g. an
    // old date row while in SELECT_SLOT) fall through to the current state handler,
    // whose "option not found" fallback re-prompts or exits cleanly.
    const staleMainMenuButton =
      /book appointment|my appointments|check status/i.test(input);

    if (staleMainMenuButton) {
      await sendMainMenu(send, tenant, await getPatient(schema, phone).catch(() => null));
      await updateSession(schema, phone, STATES.MAIN_MENU, {});
      return;
    }
  }

  // ── TREATMENT SITTINGS ───────────────────────────────────────
  if (session.state === STATES.SELECT_TREATMENT_PLAN) {
    return handleSelectTreatmentPlan(phone, schema, tenant, send, ctx, choice, input);
  }

  // ── BOOKING FLOW ─────────────────────────────────────────────
  if (session.state === STATES.SELECT_HOSPITAL) {
    return handleSelectHospital(phone, schema, tenant, send, ctx, choice, input);
  }
  if (session.state === STATES.SELECT_DEPARTMENT) {
    return handleSelectDept(phone, schema, tenant, send, ctx, choice, input, buttonId);
  }
  if (session.state === STATES.SELECT_DOCTOR) {
    return handleSelectDoctor(phone, schema, tenant, send, ctx, choice, input);
  }
  if (session.state === STATES.SELECT_DATE) {
    return handleSelectDate(phone, schema, tenant, send, ctx, choice);
  }
  if (session.state === STATES.SELECT_SLOT) {
    return handleSelectSlot(phone, schema, tenant, send, ctx, choice, input);
  }
  if (session.state === STATES.SELECT_PATIENT) {
    return handleSelectPatient(phone, schema, send, ctx, choice, input);
  }
  if (session.state === STATES.COLLECT_NAME) {
    // A button/list tap here is a stale reply from an earlier message — the name
    // must be typed. Re-prompt instead of storing the button title as the name.
    if (buttonId) {
      await send.text('Please *type* the name — tapping an old button will not work here.');
      return;
    }
    if (input.length < 2 || input.length > 100) {
      await send.text('That does not look like a full name. Please type it out — first and last name is enough.');
      return;
    }
    ctx.patient_name = input;
    // A question, not a form field. Same information, a third of the words.
    await send.buttons('And your date of birth? Use DD/MM/YYYY — for example 15/08/1990.',
      ['⏭ Skip'], { header: 'Date of birth (optional)' });
    await updateSession(schema, phone, STATES.COLLECT_DOB, ctx);
    return;
  }
  if (session.state === STATES.COLLECT_DOB) {
    // Optional. Nothing in the product branches on age — it is a clinical record
    // the dentist can complete at the chair, and demanding it before a patient in
    // pain can book was the largest remaining piece of friction in this flow.
    if (/^skip$/i.test(input.trim()) || /^btn_0/.test(buttonId || '')) {
      return askChiefComplaint(phone, schema, send, ctx);
    }
    if (buttonId) {
      await send.buttons('Please *type* the date of birth as DD/MM/YYYY, or skip.',
        ['⏭ Skip'], { header: 'Date of birth (optional)' });
      return;
    }
    const m = input.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (!m) {
      await send.buttons('That doesn\'t look like a date. Use DD/MM/YYYY — for example 15/08/1990.',
        ['⏭ Skip'], { header: 'Date of birth (optional)' });
      return;
    }
    const [, dd, mm, yyyy] = m;
    const day = parseInt(dd, 10), mon = parseInt(mm, 10), yr = parseInt(yyyy, 10);
    const parsedDate = new Date(yr, mon - 1, day);
    const today = new Date();
    const isValidDate = parsedDate.getFullYear() === yr &&
      parsedDate.getMonth() === mon - 1 &&
      parsedDate.getDate() === day;
    if (!isValidDate || yr < 1900 || parsedDate > today || (today.getFullYear() - yr) > 150) {
      await send.buttons('That date doesn\'t look right. Use DD/MM/YYYY — for example 15/08/1990.',
        ['⏭ Skip'], { header: 'Date of birth (optional)' });
      return;
    }
    ctx.patient_dob = `${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}`;
    return askChiefComplaint(phone, schema, send, ctx);
  }
  // The gender and email questions were removed from the flow: nothing in the
  // product ever branched on gender, and the patient email only fed a
  // confirmation email — a channel that no longer exists at all. Both columns
  // remain in the schema; staff still set gender from the dashboard.
  //
  // These two states are kept ONLY to drain sessions that were already parked in
  // them when this shipped — they accept anything and move the patient on rather
  // than stranding a half-finished booking. bot_sessions are cleared after 4
  // hours, so both branches can be deleted a day after deploy.
  if (session.state === STATES.COLLECT_GENDER || session.state === STATES.COLLECT_EMAIL) {
    return askChiefComplaint(phone, schema, send, ctx);
  }
  if (session.state === STATES.COLLECT_CHIEF_COMPLAINT) {
    return handleChiefComplaint(phone, schema, send, ctx, choice, input, updateSession, tenant);
  }
  if (session.state === STATES.CONFIRM_BOOKING) {
    // Which button, if any, the patient actually tapped on the summary above.
    // A bare positional id ("btn_0" from ANY older message — WhatsApp keeps them
    // all tappable) is not consent to book; -1 means "stale tap" and falls
    // through to the re-prompt at the bottom of this branch.
    const btnIdx = confirmButtonIndex(ctx, choice);
    // Check negative intent FIRST — replies like "no, don't confirm" contain
    // words ("confirm") that would otherwise match the positive pattern below
    // and book an appointment the patient just declined. Mirrors
    // handleRescheduleConfirm/handleCancelConfirm in appointmentFlow.js.
    const isNegative = btnIdx === 1 || /\bno\b|\bdon'?t\b|\bdont\b|\bkeep\b|\bcancel\b|\bnahi\b|^2$/i.test(choice);
    if (isNegative) {
      await send.text('Booking cancelled — nothing has been reserved.\n\nReply *Menu* whenever you want to start again.');
      await updateSession(schema, phone, STATES.IDLE, {});
      return;
    }
    if (btnIdx === 0 || /^(yes|confirm|ok|sure|haan)$|^1$/.test(choice)) {
      return completeBooking(phone, schema, tenant, send, ctx);
    }
    // Re-prompt — and re-bind, because these are freshly minted buttons; the
    // window recorded for the previous prompt no longer describes what is on
    // the patient's screen. The session write persists the new binding.
    await sendConfirmButtons(send, ctx, 'Please check the details above and confirm.', ['✅ Confirm', '❌ Cancel']);
    await updateSession(schema, phone, STATES.CONFIRM_BOOKING, ctx);
    return;
  }

  // ── MY APPOINTMENTS FLOW ─────────────────────────────────────
  if (session.state === STATES.MY_APPOINTMENTS) {
    // Guard: only offer reschedule/cancel when there are actually upcoming appointments.
    // Without this check, the "🏠 Main Menu" button (btn_0 when no upcoming appointments)
    // would erroneously match /btn_0/ and trigger the reschedule prompt.
    const hasUpcoming = Array.isArray(ctx._appts) && ctx._appts.length > 0;
    if (hasUpcoming && /reschedule|btn_0/i.test(choice)) {
      await send.text('Which one? Send its booking ID — it looks like *MB12AB3*.');
      await updateSession(schema, phone, STATES.RESCHEDULE_SELECT, ctx);
      return;
    }
    if (hasUpcoming && /cancel|btn_1/i.test(choice)) {
      await send.text('Which one? Send its booking ID — it looks like *MB12AB3*.');
      await updateSession(schema, phone, STATES.CANCEL_SELECT, ctx);
      return;
    }
    await sendMainMenu(send, tenant, await getPatient(schema, phone).catch(() => null));
    await updateSession(schema, phone, STATES.MAIN_MENU, {});
    return;
  }
  if (session.state === STATES.RESCHEDULE_SELECT) {
    return handleRescheduleSelect(phone, schema, tenant, send, ctx, input);
  }
  if (session.state === STATES.RESCHEDULE_DATE) {
    return handleRescheduleDate(phone, schema, tenant, send, ctx, choice);
  }
  if (session.state === STATES.RESCHEDULE_SLOT) {
    return handleRescheduleSlot(phone, schema, tenant, send, ctx, choice, input);
  }
  if (session.state === STATES.RESCHEDULE_CONFIRM) {
    return handleRescheduleConfirm(phone, schema, tenant, send, ctx, choice);
  }
  if (session.state === STATES.CANCEL_SELECT) {
    return handleCancelSelect(phone, schema, tenant, send, ctx, input);
  }
  if (session.state === STATES.CANCEL_REASON) {
    // Note: signature is (phone, schema, tenant, send, ctx, input, buttonId)
    return handleCancelReason(phone, schema, tenant, send, ctx, input, buttonId);
  }
  if (session.state === STATES.CANCEL_CONFIRM) {
    return handleCancelConfirm(phone, schema, tenant, send, ctx, choice);
  }

  // Fallback
  await send.text(
    // Was a second, slightly-different copy of the Help menu — so the two drifted
    // apart and a patient who typed both got contradictory lists. Help is one
    // reply away, so this says the two useful things and stops.
    `I did not follow that.\n\n` +
    `Reply *Menu* to see what I can do, or *Help* for the full list.`
  );
  await updateSession(schema, phone, STATES.IDLE, {});
}

// ── FEEDBACK HANDLERS ────────────────────────────────────────
async function handleFeedbackRating(phone, schema, send, ctx, choice, input) {
  if (ctx.feedback_appointment_id) {
    try {
      const existing = await tenantQuery(schema,
        `SELECT id FROM appointment_feedback WHERE appointment_id = $1`, [ctx.feedback_appointment_id]);
      if (existing.rows.length > 0) {
        await send.text('You have already left feedback for that visit — thank you.');
        await updateSession(schema, phone, STATES.IDLE, {});
        return;
      }
    } catch (_) {}
  }
  if (/^skip$/i.test((input || '').trim())) {
    await send.text('No problem.\n\nReply *Menu* for anything else.');
    await updateSession(schema, phone, STATES.IDLE, {});
    return;
  }
  // Buttons are ['⭐ 1 — Poor', '⭐⭐⭐ 3 — Okay', '⭐⭐⭐⭐⭐ 5 — Great'] (3 buttons).
  // WhatsApp button IDs include a timestamp suffix (e.g. btn_0_1712345678),
  // so we match by prefix rather than exact key.
  const ratingMap = { btn_0: 1, btn_1: 3, btn_2: 5 };
  const matchedKey = Object.keys(ratingMap).find(k => (choice || '').startsWith(k + '_') || choice === k);
  // parseChoiceNumber, not parseInt: parseInt pulls a leading digit run out of
  // anything, so "3rd visit, staff were lovely" was filed as a 3-star rating and
  // the compliment thrown away. A whole-string number or nothing.
  let rating = matchedKey ? ratingMap[matchedKey] : parseChoiceNumber(input);
  if (!rating || rating < 1 || rating > 5) {
    await send.buttons(
      `Please reply with a number from *1* to *5* — 1 is poor, 5 is excellent.`,
      ['⭐ 1 — Poor', '⭐⭐⭐ 3 — Okay', '⭐⭐⭐⭐⭐ 5 — Great']
    );
    return;
  }
  ctx.feedback_rating = rating;
  const ratingComment = rating === 5 ? 'Amazing!' : rating === 4 ? 'Great to hear!' : rating === 3 ? 'Thanks for the feedback.' : 'Sorry to hear that.';
  await send.text(
    `Thank you — *${rating}/5, ${String(ratingComment).toLowerCase()}*.\n\n` +
    `Anything you would like to add? Type it here, or reply *Skip* to finish.`
  );
  await updateSession(schema, phone, STATES.COLLECT_FEEDBACK_COMMENT, ctx);
}

async function handleFeedbackComment(phone, schema, send, ctx, input) {
  // Exact match only — an unanchored /skip/ silently discarded any genuine
  // comment containing the word ("the receptionist skipped my X-ray review").
  const comment = /^skip$/i.test((input || '').trim()) ? null : input;
  try {
    if (ctx.feedback_appointment_id && ctx.feedback_patient_id) {
      await tenantQuery(schema,
        `INSERT INTO appointment_feedback (appointment_id, patient_id, rating, comment)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (appointment_id) DO NOTHING`,
        [ctx.feedback_appointment_id, ctx.feedback_patient_id, ctx.feedback_rating, comment]);
    }
  } catch (_) {}
  await send.text('Thank you — that is genuinely useful, and the clinic reads every one.\n\nReply *Menu* for anything else.');
  await updateSession(schema, phone, STATES.IDLE, {});
}

async function triggerFeedback(schemaName, phone, appointmentId, patientId, doctorName) {
  try {
    const { getSession, updateSession: _updateSession } = require('./bot/utils');
    // Don't interrupt an active booking/cancel/reschedule flow — only set
    // feedback state when the patient is idle or at the main menu.
    const session = await getSession(schemaName, phone);
    if (session && session.state !== STATES.IDLE && session.state !== STATES.MAIN_MENU) {
      logger.info(`Skipping feedback for ${maskPhone(phone)} — active session state: ${session.state}`);
      return;
    }
    // Use updateSession() so the context is encrypted (protects appointment/patient IDs)
    // and the session size check is applied consistently.
    await _updateSession(schemaName, phone, STATES.COLLECT_FEEDBACK_RATING, {
      feedback_appointment_id: appointmentId,
      feedback_patient_id: patientId,
      doctor_name: doctorName,
    });
  } catch (err) {
    logger.warn('triggerFeedback failed', { phone: maskPhone(phone), error: err.message });
  }
}

/**
 * Handle a voice/audio message by transcribing it (Whisper API) and processing as text.
 * Called by webhook.js when msg.type === 'audio' and voice_transcription_enabled feature flag is set.
 */
async function handleVoiceMessage({ phone, audioId, tenant }) {
  const schema = tenant.schema_name;
  // Shared phone — use global env vars
  const waToken = null;
  const waPhoneId = null;

  // Voice replies go through the logging wrapper for the same reason the bot's
  // own send.* helpers do: a patient who only ever sends voice notes would
  // otherwise have a conversation history containing none of the bot's answers.
  const { sendPatientText } = require('./outbound');

  // Opt-out is enforced inside _handleInner, which this function only reaches
  // AFTER a Meta media download and a paid Whisper call — and both replies
  // below are sent before it is consulted at all, so an opted-out patient got
  // an answer from a clinic they unsubscribed from. Check first: silence, and
  // no spend. (Re-subscribing stays a typed *START*; a transcript is not a
  // reliable enough signal to reopen a channel the patient closed.)
  if (await isOptedOut(schema, phone)) {
    logger.info('Dropped voice message from opted-out patient', { phone: maskPhone(phone) });
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    await sendPatientText(schema, phone, 'I can only read typed messages, I am afraid. Please type what you need.');
    return;
  }

  try {
    const axios = require('axios');
    const FormData = require('form-data');

    // Step 1: Get media URL from Meta
    const mediaRes = await axios.get(
      `https://graph.facebook.com/v21.0/${audioId}`,
      { headers: { Authorization: `Bearer ${waToken || process.env.META_ACCESS_TOKEN}` } }
    );
    const mediaUrl = mediaRes.data?.url;
    if (!mediaUrl) throw new Error('No media URL returned');

    // Step 2: Download audio
    const audioRes = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      headers: { Authorization: `Bearer ${waToken || process.env.META_ACCESS_TOKEN}` },
    });

    // Step 3: Transcribe via Whisper
    const form = new FormData();
    form.append('file', Buffer.from(audioRes.data), { filename: 'audio.ogg', contentType: 'audio/ogg' });
    form.append('model', 'whisper-1');
    const whisperRes = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    });

    const transcribed = whisperRes.data?.text?.trim();
    if (!transcribed) {
      await sendPatientText(schema, phone, 'I could not make out that voice note. Please type it instead.');
      return;
    }

    logger.info('Audio transcribed', { phone: maskPhone(phone), length: transcribed.length });
    // Process transcribed text through bot engine
    await handle({ phone, text: transcribed, buttonId: null, tenant });
  } catch (err) {
    logger.warn('Voice transcription failed', { phone: maskPhone(phone), error: err.message });
    await sendPatientText(schema, phone, 'I could not play that voice note. Please type *Menu* to start.')
      .catch(() => {});
  }
}

module.exports = { handle, triggerFeedback, handleVoiceMessage };
