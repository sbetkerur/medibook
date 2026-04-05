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
  getPatient,
  logMessage,
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
async function handle({ phone, text, buttonId, tenant, waMessageId }) {
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
    return await _handleInner({ phone, text, buttonId, tenant, waMessageId, schema, waToken, waPhoneId });
  } catch (err) {
    // Top-level safety net — if anything throws (DB error, circuit breaker open, etc.),
    // reset the session to idle and tell the user to try again. This prevents the bot
    // from silently dying and leaving the user stuck with no response.
    logger.error('Bot handle() uncaught error — resetting session to idle', {
      phone, tenant: tenant.slug, error: err.message,
      stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
    });
    try {
      await updateSession(schema, phone, STATES.IDLE, {});
    } catch (_) { /* ignore — DB might be down */ }
    try {
      await wa.sendText(phone,
        'Sorry, something went wrong. Please reply *Hi* to continue.',
        waToken, waPhoneId);
    } catch (_) { /* ignore — circuit might be open */ }
    // Re-throw so BullMQ knows the job failed and can retry correctly
    throw err;
  }
}

async function _handleInner({ phone, text, buttonId, tenant, waMessageId, schema, waToken, waPhoneId }) {

  // Inbound message is already logged by the webhook handler for idempotency dedup.
  // Only log outgoing messages here to avoid a double-insert in wa_messages.

  const send = {
    text: async (t) => {
      await logMessage(schema, phone, 'out', 'text', t, null);
      return wa.sendText(phone, t, waToken, waPhoneId);
    },
    buttons: async (t, btns) => {
      await logMessage(schema, phone, 'out', 'buttons', t, null);
      return wa.sendButtons(phone, t, btns, waToken, waPhoneId);
    },
    list: async (t, label, sections) => {
      await logMessage(schema, phone, 'out', 'list', t, null);
      return wa.sendList(phone, t, label, sections, waToken, waPhoneId);
    },
  };

  const input = (text || '').trim();
  const lowerInput = input.toLowerCase();
  const choice = buttonId || lowerInput;

  // ── OPTED-OUT check — silently drop all messages from opted-out patients ──
  // We check opted_out before any state handling so opted-out patients can
  // still send STOP/START but get no other bot responses.
  if (!/^(stop|unsubscribe|opt.?out|block|start)$/i.test(input)) {
    try {
      const optedR = await tenantQuery(schema,
        `SELECT opted_out FROM patients WHERE phone=$1`, [phone]);
      if (optedR.rows[0]?.opted_out === true) {
        logger.info(`Dropped message from opted-out patient`, { phone });
        return;
      }
    } catch (_) {} // non-fatal — proceed if table or column missing
  }

  // ── OPT-OUT handler ─────────────────────────────────────────
  if (/^(stop|unsubscribe|opt.?out|block)$/i.test(input)) {
    await tenantQuery(schema,
      `UPDATE patients SET opted_out=true, updated_at=NOW() WHERE phone=$1`, [phone])
      .catch(err => logger.warn('Opt-out patient update failed', { phone, error: err.message }));
    await tenantQuery(schema,
      `UPDATE bot_sessions SET state='idle', context='{}' WHERE phone=$1`, [phone])
      .catch(err => logger.warn('Opt-out session reset failed', { phone, error: err.message }));
    await wa.sendText(phone,
      `You have been unsubscribed from ${tenant.name} WhatsApp notifications.\n\nTo re-subscribe, reply *START*.`,
      waToken, waPhoneId).catch(err => logger.warn('Opt-out reply failed to send', { phone, error: err.message }));
    logger.info(`Patient ${phone} opted out from ${tenant.name}`);
    return;
  }

  // ── RE-SUBSCRIBE handler ─────────────────────────────────────
  if (/^start$/i.test(input)) {
    await tenantQuery(schema,
      `UPDATE patients SET opted_out=false, updated_at=NOW() WHERE phone=$1`, [phone])
      .catch(() => {});
  }

  const isGreeting = /^(hi|hello|hey|menu|start|helo|hy|hai)$/i.test(input);

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
        logger.warn('Session context decryption failed, resetting to idle', { phone });
        await updateSession(schema, phone, STATES.IDLE, {});
        await send.text('Sorry, something went wrong. Let\'s start over — reply *Hi* to continue.');
        return;
      }
      ctx = JSON.parse(decrypted);
    } else {
      // Legacy unencrypted session — accept for backwards compat but log so
      // operators know these exist. They'll be re-encrypted on next updateSession.
      if (raw && Object.keys(raw).length > 0) {
        logger.warn('Unencrypted bot session context found — will be encrypted on next write', { phone });
      }
      ctx = raw;
    }
  } catch (err) {
    logger.warn(`Malformed session context, resetting to idle`, { error: err.message });
    await updateSession(schema, phone, STATES.IDLE, {});
    await send.text('Sorry, something went wrong. Let\'s start over — reply *Hi* to continue.');
    return;
  }

  // ── SESSION EXPIRY & 24H RESUME ──────────────────────────────
  const SESSION_FLOW_EXPIRY_MS = 30 * 60 * 1000;       // 30 min — reset idle mid-flows
  const SESSION_RESUME_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h — offer to resume
  if (!isGreeting && session.state !== STATES.IDLE && session.state !== STATES.MAIN_MENU) {
    const elapsed = Date.now() - new Date(session.last_activity).getTime();
    if (elapsed > SESSION_FLOW_EXPIRY_MS) {
      if (elapsed < SESSION_RESUME_WINDOW_MS && ctx.doctor_name && ctx.appointment_date) {
        // Offer to resume incomplete booking
        await send.buttons(
          `👋 Welcome back! You were booking an appointment with *Dr. ${ctx.doctor_name}* on *${ctx.appointment_date}*.\n\nWould you like to continue?`,
          ['✅ Yes, continue', '🔄 Start fresh']
        );
        await updateSession(schema, phone, STATES.RESUME_CONFIRM, ctx);
        return;
      }
      // Beyond 24h or no resumable context — reset to idle
      await updateSession(schema, phone, STATES.IDLE, {});
      session.state = STATES.IDLE;
    }
  }

  // ── RESUME CONFIRM ───────────────────────────────────────────
  if (session.state === STATES.RESUME_CONFIRM) {
    const resumeChoice = buttonId || lowerInput;
    if (/yes|continue|btn_0/i.test(resumeChoice)) {
      // Resume from where they left off — go to the appropriate state
      const resumeState = ctx.slot_id ? STATES.CONFIRM_BOOKING
        : ctx.appointment_date ? STATES.SELECT_SLOT
        : ctx.doctor_id ? STATES.SELECT_DATE
        : STATES.IDLE;
      session.state = resumeState;
      await updateSession(schema, phone, resumeState, ctx);
      if (resumeState === STATES.CONFIRM_BOOKING) {
        return showConfirmation(phone, schema, send, ctx, updateSession);
      }
      if (resumeState === STATES.SELECT_SLOT) {
        // Re-fetch and re-render the slot list for the cached date so the user
        // actually sees something to tap — a text hint alone leaves them stuck.
        return handleSelectDate(phone, schema, tenant, send, ctx, ctx.appointment_date);
      }
      if (resumeState === STATES.SELECT_DATE) {
        // Re-render the date list for the cached doctor. Populate _doctors so
        // handleSelectDoctor can locate the doc by ID without a DB re-fetch.
        ctx._doctors = [{ id: ctx.doctor_id, name: ctx.doctor_name }];
        return handleSelectDoctor(phone, schema, tenant, send, ctx, ctx.doctor_id, ctx.doctor_name);
      }
      await send.text('Reply *Hi* to start over.');
      return;
    }
    // Start fresh
    await updateSession(schema, phone, STATES.IDLE, {});
    session.state = STATES.IDLE;
    // Fall through to greeting handler below
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
  if (/^reschedule$/i.test(input) && !isGreeting) {
    const patient = await getPatient(schema, phone);
    if (!patient) {
      await send.text('No appointments found. Reply *Hi* to book your first appointment.');
      await updateSession(schema, phone, STATES.IDLE, {});
      return;
    }
    await send.text('Please enter the Booking ID you want to reschedule (e.g. MB12AB3):');
    await updateSession(schema, phone, STATES.RESCHEDULE_SELECT, {});
    return;
  }
  if (/^cancel appointment$/i.test(input) && !isGreeting) {
    const patient = await getPatient(schema, phone);
    if (!patient) {
      await send.text('No appointments found. Reply *Hi* to book your first appointment.');
      await updateSession(schema, phone, STATES.IDLE, {});
      return;
    }
    await send.text('Please enter the Booking ID you want to cancel (e.g. MB12AB3):');
    await updateSession(schema, phone, STATES.CANCEL_SELECT, {});
    return;
  }

  // ── DENTAL EMERGENCY SHORTCUT ────────────────────────────────
  if (/^(emergency|toothache|tooth ache|dental emergency|urgent)$/i.test(input) && !isGreeting) {
    await send.text(
      `🚨 *Dental Emergency*\n\n` +
      `We'll get you seen as soon as possible!\n\n` +
      `Please reply *Hi* and tap *Book Appointment* to find the earliest available slot.\n\n` +
      `If you need immediate assistance, please call the clinic directly.`
    );
    await updateSession(schema, phone, STATES.IDLE, {});
    return;
  }

  // ── GREETING → MAIN MENU ─────────────────────────────────────
  if (isGreeting || session.state === STATES.IDLE) {
    const patient = await getPatient(schema, phone);
    const firstName = patient?.name ? `, ${patient.name.split(' ')[0]}` : '';
    const isReturning = !!patient?.name;
    const subtitle = isReturning
      ? 'How can I help you today?'
      : 'Book a dental appointment, check your status, or manage existing bookings.';
    await send.buttons(
      `🦷 Welcome${firstName} to *Swalambha AI Technologies*!\n\n${subtitle}`,
      ['📅 Book Appointment', '🗓 My Appointments', '📋 Check Status']
    );
    await updateSession(schema, phone, STATES.MAIN_MENU, {});
    return;
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
    if (/status|check|btn_2/i.test(choice) || choice === '3') {
      await send.text('📋 *Check Appointment Status*\n\nPlease enter your Booking ID (e.g. MB12AB3):');
      await updateSession(schema, phone, STATES.CHECK_BOOKING_STATUS, {});
      return;
    }
    if (/help|info/i.test(choice)) {
      await send.text(
        `ℹ️ *Help*\n\n` +
        `• Reply *Book* — Book an appointment\n` +
        `• Reply *Status* — Check appointment status\n` +
        `• Reply *My* — View your appointments\n` +
        `• Reply *Hi* — Return to main menu\n\n` +
        `For emergencies, please call the clinic directly.`
      );
      return;
    }
    await send.text('Please choose an option from the menu. Reply *Hi* to see the menu again.');
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
      await send.text('Booking ID not found. Please check and try again.\n\nReply *Hi* to go back.');
      return;
    }
    const a = apptR.rows[0];
    let dt = a.appointment_date;
    try { dt = format(parseISO(a.appointment_date), 'EEE, d MMM yyyy'); } catch {}
    const statusEmoji = { confirmed: '✅', completed: '🏁', cancelled: '❌', no_show: '⚠️' }[a.status] || '📋';
    await send.text(
      `📋 *Appointment Status*\n\n` +
      `Booking ID: *${a.booking_id}*\n` +
      `${statusEmoji} Status: *${a.status.replace('_', ' ').toUpperCase()}*\n\n` +
      `👤 ${a.patient_name}\n` +
      `👨‍⚕️ Dr. ${a.doctor_name}\n` +
      `🦷 ${a.hospital_name}\n` +
      `📅 ${dt} at ${(a.appointment_time || '').slice(0, 5)}\n\n` +
      `Reply *Hi* for the main menu.`
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
      await send.buttons(
        '❌ Booking cancelled.\n\nWhat would you like to do?',
        ['📅 Book Appointment', '🗓 My Appointments', '📋 Check Status']
      );
      await updateSession(schema, phone, STATES.MAIN_MENU, {});
      return;
    }

    // Patient tapped a stale button from a previous message (WhatsApp keeps all buttons tappable).
    // Any button title that isn't valid for the current step means they stepped outside the flow.
    // Exit cleanly: cancel the booking and show the main menu so the intent is clear.
    const staleMainMenuButton =
      /book appointment|my appointments|check status/i.test(input);
    const staleOtherButton =
      // A WhatsApp interactive button was tapped (buttonId present) but its title doesn't
      // look like free-text input — e.g. tapping a stale "✅ Confirm" or "❌ Cancel" or
      // a treatment/doctor/date button from an earlier step while on a different step.
      buttonId &&
      !/^(hi|hello|hey|menu|start|cancel|exit|back|quit)$/i.test(input) &&
      !staleMainMenuButton;

    if (staleMainMenuButton || staleOtherButton) {
      const patient = await getPatient(schema, phone);
      const firstName = patient?.name ? `, ${patient.name.split(' ')[0]}` : '';
      await send.buttons(
        `👋 Welcome${firstName} to *Swalambha AI Technologies*!\n\nHow can I help you today?`,
        ['📅 Book Appointment', '🗓 My Appointments', '📋 Check Status']
      );
      await updateSession(schema, phone, STATES.MAIN_MENU, {});
      return;
    }
  }

  // ── BOOKING FLOW ─────────────────────────────────────────────
  if (session.state === STATES.SELECT_HOSPITAL) {
    return handleSelectHospital(phone, schema, tenant, send, ctx, choice, input);
  }
  if (session.state === STATES.SELECT_DEPARTMENT) {
    return handleSelectDept(phone, schema, tenant, send, ctx, choice, input);
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
    if (input.length < 2 || input.length > 100) {
      await send.text('Please enter your full name (between 2 and 100 characters).');
      return;
    }
    ctx.patient_name = input;
    await send.text('🎂 *Date of Birth*\n\nEnter your DOB in DD/MM/YYYY format:\nExample: 15/08/1990');
    await updateSession(schema, phone, STATES.COLLECT_DOB, ctx);
    return;
  }
  if (session.state === STATES.COLLECT_DOB) {
    const m = input.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (!m) { await send.text('Invalid format. Please use DD/MM/YYYY\nExample: 15/08/1990'); return; }
    const [, dd, mm, yyyy] = m;
    const day = parseInt(dd, 10), mon = parseInt(mm, 10), yr = parseInt(yyyy, 10);
    const parsedDate = new Date(yr, mon - 1, day);
    const today = new Date();
    const isValidDate = parsedDate.getFullYear() === yr &&
      parsedDate.getMonth() === mon - 1 &&
      parsedDate.getDate() === day;
    if (!isValidDate || yr < 1900 || parsedDate > today || (today.getFullYear() - yr) > 150) {
      await send.text('Please enter a valid date of birth in DD/MM/YYYY format.\nExample: 15/08/1990');
      return;
    }
    ctx.patient_dob = `${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}`;
    await send.buttons('👤 *Your Gender*', ['Male', 'Female', 'Other']);
    await updateSession(schema, phone, STATES.COLLECT_GENDER, ctx);
    return;
  }
  if (session.state === STATES.COLLECT_GENDER) {
      // Check female BEFORE male — 'female' contains 'male' so order matters
    ctx.patient_gender = /female|btn_1/i.test(choice) ? 'female' : /male|btn_0/i.test(choice) ? 'male' : 'other';
    await send.buttons('📧 *Email Address* _(optional)_\n\nShare your email to receive a booking confirmation, or tap Skip to continue:', ['⏭ Skip']);
    await updateSession(schema, phone, STATES.COLLECT_EMAIL, ctx);
    return;
  }
  if (session.state === STATES.COLLECT_EMAIL) {
    if (!/^skip$/i.test(input) && !/^btn_0/.test(buttonId || '') && input.length > 0) {
      // Stricter email regex: requires valid local part, domain with at least one dot,
      // and a TLD of 2+ chars. Rejects `test@.com`, `a@b.c`, consecutive dots in domain.
      if (/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(input) && !/\.{2,}/.test(input)) {
        ctx.patient_email = input.toLowerCase();
      } else {
        await send.buttons('Invalid email format. Please enter a valid email address, or tap Skip:', ['⏭ Skip']);
        return;
      }
    }
    return askChiefComplaint(phone, schema, send, ctx);
  }
  if (session.state === STATES.COLLECT_CHIEF_COMPLAINT) {
    return handleChiefComplaint(phone, schema, send, ctx, choice, input, updateSession);
  }
  if (session.state === STATES.CONFIRM_BOOKING) {
    if (/^(yes|confirm|ok|sure|haan)$|^btn_0|^1$/.test(choice)) {
      return completeBooking(phone, schema, tenant, send, ctx);
    }
    if (/\bno\b|\bcancel\b|\bnahi\b|btn_1|^2$/.test(choice)) {
      await send.text('Booking cancelled. Reply *Hi* to start over anytime. 👋');
      await updateSession(schema, phone, STATES.IDLE, {});
      return;
    }
    await send.buttons('Please confirm your booking:', ['✅ Confirm', '❌ Cancel']);
    return;
  }

  // ── MY APPOINTMENTS FLOW ─────────────────────────────────────
  if (session.state === STATES.MY_APPOINTMENTS) {
    // Guard: only offer reschedule/cancel when there are actually upcoming appointments.
    // Without this check, the "🏠 Main Menu" button (btn_0 when no upcoming appointments)
    // would erroneously match /btn_0/ and trigger the reschedule prompt.
    const hasUpcoming = Array.isArray(ctx._appts) && ctx._appts.length > 0;
    if (hasUpcoming && /reschedule|btn_0/i.test(choice)) {
      await send.text('Enter the *Booking ID* to reschedule (e.g. MB12AB3):');
      await updateSession(schema, phone, STATES.RESCHEDULE_SELECT, ctx);
      return;
    }
    if (hasUpcoming && /cancel|btn_1/i.test(choice)) {
      await send.text('Enter the *Booking ID* to cancel (e.g. MB12AB3):');
      await updateSession(schema, phone, STATES.CANCEL_SELECT, ctx);
      return;
    }
    const patient = await getPatient(schema, phone);
    const firstName = patient?.name ? `, ${patient.name.split(' ')[0]}` : '';
    const isReturning = !!patient?.name;
    const subtitle = isReturning
      ? 'How can I help you today?'
      : 'I can help you book appointments, check your status, or manage existing bookings.';
    await send.buttons(
      `👋 Welcome${firstName} to *${tenant.name}*!\n\n${subtitle}`,
      ['📅 Book Appointment', '🗓 My Appointments', '📋 Check Status']
    );
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
    `I didn't quite get that. 🤔\n\n` +
    `Here's what you can do:\n` +
    `• Reply *Hi* — Main menu\n` +
    `• Reply *Book* — Book an appointment\n` +
    `• Reply *Status* — Check appointment status\n` +
    `• Reply *Cancel Appointment* — Cancel a booking`
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
        await send.text('You have already submitted feedback for this appointment. Thank you!');
        await updateSession(schema, phone, STATES.IDLE, {});
        return;
      }
    } catch (_) {}
  }
  if (/skip/i.test(input)) {
    await send.text('No problem! Reply *Hi* for the main menu.');
    await updateSession(schema, phone, STATES.IDLE, {});
    return;
  }
  // Buttons are ['⭐ 1 — Poor', '⭐⭐⭐ 3 — Okay', '⭐⭐⭐⭐⭐ 5 — Great'] (3 buttons).
  // WhatsApp button IDs include a timestamp suffix (e.g. btn_0_1712345678),
  // so we match by prefix rather than exact key.
  const ratingMap = { btn_0: 1, btn_1: 3, btn_2: 5 };
  const matchedKey = Object.keys(ratingMap).find(k => (choice || '').startsWith(k + '_') || choice === k);
  let rating = matchedKey ? ratingMap[matchedKey] : parseInt(input, 10);
  if (!rating || rating < 1 || rating > 5) {
    await send.buttons(
      `Please reply with a number from *1 to 5*:\n\n1 ⭐ — Poor\n3 ⭐⭐⭐ — Average\n5 ⭐⭐⭐⭐⭐ — Excellent`,
      ['⭐ 1 — Poor', '⭐⭐⭐ 3 — Okay', '⭐⭐⭐⭐⭐ 5 — Great']
    );
    return;
  }
  ctx.feedback_rating = rating;
  const ratingComment = rating === 5 ? 'Amazing!' : rating === 4 ? 'Great to hear!' : rating === 3 ? 'Thanks for the feedback.' : 'Sorry to hear that.';
  await send.text(
    `${rating >= 4 ? '🌟' : '📝'} *${rating}/5 — ${ratingComment}*\n\n` +
    `Would you like to add a comment? Your feedback helps us improve.\n\n` +
    `_(Reply *Skip* to finish)_`
  );
  await updateSession(schema, phone, STATES.COLLECT_FEEDBACK_COMMENT, ctx);
}

async function handleFeedbackComment(phone, schema, send, ctx, input) {
  const comment = /skip/i.test(input) ? null : input;
  try {
    if (ctx.feedback_appointment_id && ctx.feedback_patient_id) {
      await tenantQuery(schema,
        `INSERT INTO appointment_feedback (appointment_id, patient_id, rating, comment)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (appointment_id) DO NOTHING`,
        [ctx.feedback_appointment_id, ctx.feedback_patient_id, ctx.feedback_rating, comment]);
    }
  } catch (_) {}
  await send.text('✅ *Thank you for your feedback!*\n\nIt genuinely helps the clinic improve. We appreciate you taking the time. 🙏\n\nReply *Hi* for the main menu.');
  await updateSession(schema, phone, STATES.IDLE, {});
}

async function triggerFeedback(schemaName, phone, appointmentId, patientId, doctorName) {
  try {
    const { getSession, updateSession: _updateSession } = require('./bot/utils');
    // Don't interrupt an active booking/cancel/reschedule flow — only set
    // feedback state when the patient is idle or at the main menu.
    const session = await getSession(schemaName, phone);
    if (session && session.state !== STATES.IDLE && session.state !== STATES.MAIN_MENU) {
      logger.info(`Skipping feedback for ${phone} — active session state: ${session.state}`);
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
    logger.warn('triggerFeedback failed', { phone, error: err.message });
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

  if (!process.env.OPENAI_API_KEY) {
    await wa.sendText(phone,
      'Sorry, I can only process text messages. Please type your request.',
      waToken, waPhoneId);
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
      await wa.sendText(phone, 'Sorry, I couldn\'t understand the audio. Please type your message.', waToken, waPhoneId);
      return;
    }

    logger.info('Audio transcribed', { phone, length: transcribed.length });
    // Process transcribed text through bot engine
    await handle({ phone, text: transcribed, buttonId: null, tenant });
  } catch (err) {
    logger.warn('Voice transcription failed', { phone, error: err.message });
    await wa.sendText(phone,
      'Sorry, I couldn\'t process your audio. Please type *Hi* to start.',
      waToken, waPhoneId).catch(() => {});
  }
}

module.exports = { handle, triggerFeedback, handleVoiceMessage };
