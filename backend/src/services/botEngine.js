'use strict';

const wa = require('./whatsapp');
const { decrypt } = require('../utils/encryption');
const { tenantQuery, tenantTransaction } = require('../db');
const logger = require('../utils/logger');
const { format, parseISO } = require('date-fns');

// ── Sub-module imports ────────────────────────────────────────
const {
  STATES,
  getSession,
  updateSession,
  getPatient,
  logMessage,
  notifyWaitlistForDoctor,
} = require('./bot/utils');

const {
  startBooking,
  handleSelectHospital,
  handleSelectVisitType,
  handleSelectDept,
  handleSelectDoctor,
  handleWaitlistConfirm,
  handleSelectDate,
  handleSelectSlot,
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
  const waToken = tenant.wa_access_token_enc ? decrypt(tenant.wa_access_token_enc) : null;
  const waPhoneId = tenant.wa_phone_number_id;

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
      ctx = decrypted ? JSON.parse(decrypted) : {};
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

  // ── FEEDBACK FLOW ────────────────────────────────────────────
  if (session.state === STATES.COLLECT_FEEDBACK_RATING) {
    return handleFeedbackRating(phone, schema, send, ctx, choice, input);
  }
  if (session.state === STATES.COLLECT_FEEDBACK_COMMENT) {
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

  // ── GREETING → MAIN MENU ─────────────────────────────────────
  if (isGreeting || session.state === STATES.IDLE) {
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

  // ── MAIN MENU ────────────────────────────────────────────────
  if (session.state === STATES.MAIN_MENU) {
    if (/book|btn_0/i.test(choice) || choice === '1') {
      return startBooking(phone, schema, tenant, send, ctx);
    }
    if (/appointment|my|btn_1/i.test(choice) || choice === '2') {
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
      `🏥 ${a.hospital_name}\n` +
      `📅 ${dt} at ${a.appointment_time.slice(0, 5)}\n\n` +
      `Reply *Hi* for the main menu.`
    );
    await updateSession(schema, phone, STATES.IDLE, {});
    return;
  }

  // ── BOOKING FLOW ─────────────────────────────────────────────
  if (session.state === STATES.SELECT_HOSPITAL) {
    return handleSelectHospital(phone, schema, tenant, send, ctx, choice, input);
  }
  if (session.state === STATES.SELECT_VISIT_TYPE) {
    return handleSelectVisitType(phone, schema, tenant, send, ctx, choice);
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
  if (session.state === STATES.WAITLIST_CONFIRM) {
    return handleWaitlistConfirm(phone, schema, tenant, send, ctx, choice);
  }
  if (session.state === STATES.COLLECT_NAME) {
    if (input.length < 2 || input.length > 100) {
      await send.text('Please enter your full name (between 2 and 100 characters).');
      return;
    }
    ctx.patient_name = input;

    // _waitlist_pending is set when a new patient tries to join the waitlist
    // before they have an account — upsert patient and join waitlist directly.
    if (ctx._waitlist_pending) {
      const patientR = await tenantQuery(schema,
        `INSERT INTO patients (phone, name, visit_count) VALUES ($1, $2, 0)
         ON CONFLICT (phone) DO UPDATE SET name=EXCLUDED.name, updated_at=NOW()
         RETURNING id`,
        [phone, input]);
      const patientId = patientR.rows[0].id;
      await tenantQuery(schema,
        `INSERT INTO waiting_list (patient_id, doctor_id, hospital_id) VALUES ($1,$2,$3)
         ON CONFLICT (patient_id, doctor_id) DO NOTHING`,
        [patientId, ctx.doctor_id, ctx.hospital_id]);
      await send.text(
        `✅ *You've joined the waiting list!*\n\n` +
        `We'll notify you on WhatsApp as soon as Dr. ${ctx.doctor_name} has a free slot.\n\n` +
        `Reply *Hi* for the main menu.`
      );
      await updateSession(schema, phone, STATES.IDLE, {});
      return;
    }

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
    ctx.patient_gender = /male|btn_0/i.test(choice) ? 'male' : /female|btn_1/i.test(choice) ? 'female' : 'other';
    await send.buttons('📧 *Email Address* _(optional)_\n\nShare your email to receive a booking confirmation, or tap Skip to continue:', ['⏭ Skip']);
    await updateSession(schema, phone, STATES.COLLECT_EMAIL, ctx);
    return;
  }
  if (session.state === STATES.COLLECT_EMAIL) {
    if (!/skip/i.test(input) && input.length > 0) {
      // Stricter email regex: requires valid local part, domain with at least one dot,
      // and a TLD of 2+ chars. Rejects `test@.com`, `a@b.c`, consecutive dots in domain.
      if (/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(input) && !/\.{2,}/.test(input)) {
        ctx.patient_email = input.toLowerCase();
      } else {
        await send.buttons('Invalid email format. Please enter a valid email address, or tap Skip:', ['⏭ Skip']);
        return;
      }
    }
    return showConfirmation(phone, schema, send, ctx, updateSession);
  }
  if (session.state === STATES.CONFIRM_BOOKING) {
    if (/yes|confirm|ok|sure|haan|btn_0/i.test(choice)) {
      return completeBooking(phone, schema, tenant, send, ctx);
    }
    if (/no|cancel|nahi|btn_1/i.test(choice)) {
      await send.text('Booking cancelled. Reply *Hi* to start over anytime. 👋');
      await updateSession(schema, phone, STATES.IDLE, {});
      return;
    }
    await send.buttons('Please confirm your booking:', ['✅ Confirm', '❌ Cancel']);
    return;
  }

  // ── MY APPOINTMENTS FLOW ─────────────────────────────────────
  if (session.state === STATES.MY_APPOINTMENTS) {
    if (/reschedule|btn_0/i.test(choice)) {
      await send.text('Enter the *Booking ID* to reschedule (e.g. MB12AB3):');
      await updateSession(schema, phone, STATES.RESCHEDULE_SELECT, ctx);
      return;
    }
    if (/cancel|btn_1/i.test(choice)) {
      await send.text('Enter the *Booking ID* to cancel (e.g. MB12AB3):');
      await updateSession(schema, phone, STATES.CANCEL_SELECT, ctx);
      return;
    }
    await updateSession(schema, phone, STATES.IDLE, {});
    await handle({ phone, text: 'hi', buttonId: null, tenant });
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
    // Use updateSession() so the context is encrypted (protects appointment/patient IDs)
    // and the session size check is applied consistently.
    const { updateSession: _updateSession } = require('./bot/utils');
    await _updateSession(schemaName, phone, STATES.COLLECT_FEEDBACK_RATING, {
      feedback_appointment_id: appointmentId,
      feedback_patient_id: patientId,
      doctor_name: doctorName,
    });
  } catch (err) {
    logger.warn('triggerFeedback failed', { phone, error: err.message });
  }
}

module.exports = { handle, triggerFeedback };
