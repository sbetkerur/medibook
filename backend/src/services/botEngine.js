const { tenantQuery, query, pool, tenantTransaction } = require('../db');
const wa = require('./whatsapp');
const { decrypt } = require('../utils/encryption');
const logger = require('../utils/logger');
const { format, addDays, parseISO } = require('date-fns');
const emailService = require('./email');
const { SLOT_LOOKAHEAD_DAYS } = require('../utils/errors');

const IST = 'Asia/Kolkata';

const STATES = {
  IDLE: 'idle',
  MAIN_MENU: 'main_menu',
  SELECT_HOSPITAL: 'select_hospital',
  SELECT_VISIT_TYPE: 'select_visit_type',
  SELECT_DEPARTMENT: 'select_department',
  SELECT_DOCTOR: 'select_doctor',
  SELECT_DATE: 'select_date',
  SELECT_SLOT: 'select_slot',
  COLLECT_NAME: 'collect_name',
  COLLECT_DOB: 'collect_dob',
  COLLECT_GENDER: 'collect_gender',
  CONFIRM_BOOKING: 'confirm_booking',
  MY_APPOINTMENTS: 'my_appointments',
  RESCHEDULE_SELECT: 'reschedule_select',
  RESCHEDULE_DATE: 'reschedule_date',
  RESCHEDULE_SLOT: 'reschedule_slot',
  RESCHEDULE_CONFIRM: 'reschedule_confirm',
  CANCEL_SELECT: 'cancel_select',
  CANCEL_REASON: 'cancel_reason',
  CANCEL_CONFIRM: 'cancel_confirm',
  COLLECT_EMAIL: 'collect_email',
  CHECK_BOOKING_STATUS: 'check_booking_status',
  WAITLIST_CONFIRM: 'waitlist_confirm',
  COLLECT_FEEDBACK_RATING: 'collect_feedback_rating',
  COLLECT_FEEDBACK_COMMENT: 'collect_feedback_comment',
};

function genBookingId() {
  const { randomUUID } = require('crypto');
  return 'MB' + randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
}

// Simple Levenshtein distance for fuzzy matching
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

function fuzzyFind(items, input, nameField = 'name') {
  const lower = input.toLowerCase();
  const exact = items.find(item =>
    item[nameField].toLowerCase() === lower ||
    item[nameField].toLowerCase().includes(lower)
  );
  if (exact) return exact;
  let best = null, bestDist = Infinity;
  for (const item of items) {
    const dist = levenshtein(lower, item[nameField].toLowerCase());
    const threshold = Math.max(2, Math.floor(item[nameField].length * 0.4));
    if (dist < bestDist && dist <= threshold) {
      bestDist = dist;
      best = item;
    }
  }
  return best;
}

async function getSession(schemaName, phone) {
  const r = await tenantQuery(schemaName,
    `SELECT * FROM bot_sessions WHERE phone = $1`, [phone]);
  if (r.rows.length === 0) {
    const ins = await tenantQuery(schemaName,
      `INSERT INTO bot_sessions (phone, state, context) VALUES ($1, $2, $3) RETURNING *`,
      [phone, STATES.IDLE, JSON.stringify({})]);
    return ins.rows[0];
  }
  return r.rows[0];
}

async function updateSession(schemaName, phone, state, context) {
  const contextStr = JSON.stringify(context || {});
  if (contextStr.length > 10000) {
    logger.warn(`Session context too large for ${phone} (${contextStr.length} bytes), resetting to idle`);
    await tenantQuery(schemaName,
      `UPDATE bot_sessions SET state='idle', context='{}', last_activity=NOW() WHERE phone=$1`, [phone]);
    return;
  }
  await tenantQuery(schemaName,
    `UPDATE bot_sessions SET state=$1, context=$2, last_activity=NOW() WHERE phone=$3`,
    [state, contextStr, phone]);
}

async function getPatient(schemaName, phone) {
  const r = await tenantQuery(schemaName,
    `SELECT * FROM patients WHERE phone=$1`, [phone]);
  return r.rows[0] || null;
}

async function logMessage(schemaName, phone, direction, type, content, waMessageId) {
  try {
    await tenantQuery(schemaName,
      `INSERT INTO wa_messages (phone, direction, message_type, content, wa_message_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [phone, direction, type, content, waMessageId || null]);
  } catch (_) {}
}

async function handle({ phone, text, buttonId, tenant, waMessageId }) {
  if (!text && !buttonId) return;

  const schema = tenant.schema_name;
  const waToken = tenant.wa_access_token_enc ? decrypt(tenant.wa_access_token_enc) : null;
  const waPhoneId = tenant.wa_phone_number_id;

  await logMessage(schema, phone, 'in', buttonId ? 'interactive' : 'text', text || buttonId, waMessageId);

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
  const isGreeting = /^(hi|hello|hey|menu|start|helo|hy|hai)$/i.test(input);

  let session = await getSession(schema, phone);
  let ctx = {};
  try {
    ctx = session.context
      ? (typeof session.context === 'string' ? JSON.parse(session.context) : session.context)
      : {};
  } catch (err) {
    logger.warn(`Malformed session context for ${phone}, resetting to idle`, { error: err.message });
    await updateSession(schema, phone, STATES.IDLE, {});
    await send.text('Sorry, something went wrong. Let\'s start over — reply *Hi* to continue.');
    return;
  }

  // ── FEEDBACK FLOW ─────────────────────────────────────────────
  if (session.state === STATES.COLLECT_FEEDBACK_RATING) {
    return handleFeedbackRating(phone, schema, send, ctx, choice, input);
  }
  if (session.state === STATES.COLLECT_FEEDBACK_COMMENT) {
    return handleFeedbackComment(phone, schema, send, ctx, input);
  }

  // ── REMINDER BUTTON SHORTCUTS ─────────────────────────────────
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

  // Reset on greeting
  if (isGreeting || session.state === STATES.IDLE) {
    const patient = await getPatient(schema, phone);
    const firstName = patient?.name ? `, ${patient.name.split(' ')[0]}` : '';
    await send.buttons(
      `👋 Welcome${firstName} to *${tenant.name}*!\n\nHow can I help you today?`,
      ['📅 Book Appointment', '🗓 My Appointments', '📋 Check Status']
    );
    await updateSession(schema, phone, STATES.MAIN_MENU, {});
    return;
  }

  // ── MAIN MENU ──────────────────────────────────────────────────
  if (session.state === STATES.MAIN_MENU) {
    if (/book|btn_0/i.test(choice) || choice === '1') {
      return startBooking(phone, schema, tenant, send, ctx, waToken, waPhoneId);
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

  // ── CHECK BOOKING STATUS ───────────────────────────────────────
  if (session.state === STATES.CHECK_BOOKING_STATUS) {
    const bookingId = input.toUpperCase().trim();
    const apptR = await tenantQuery(schema,
      `SELECT a.*, d.name as doctor_name, h.name as hospital_name, p.name as patient_name
       FROM appointments a
       JOIN doctors d ON d.id=a.doctor_id
       JOIN hospitals h ON h.id=a.hospital_id
       JOIN patients p ON p.id=a.patient_id
       WHERE a.booking_id=$1`,
      [bookingId]);
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

  // ── BOOKING FLOW ───────────────────────────────────────────────
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
    if (input.length < 2) { await send.text('Please enter your full name (at least 2 characters).'); return; }
    ctx.patient_name = input;
    await send.text('🎂 *Date of Birth*\n\nEnter your DOB in DD/MM/YYYY format:\nExample: 15/08/1990');
    await updateSession(schema, phone, STATES.COLLECT_DOB, ctx);
    return;
  }
  if (session.state === STATES.COLLECT_DOB) {
    const m = input.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (!m) { await send.text('Invalid format. Please use DD/MM/YYYY\nExample: 15/08/1990'); return; }
    const [_, dd, mm, yyyy] = m;
    const day = parseInt(dd, 10), mon = parseInt(mm, 10), yr = parseInt(yyyy, 10);
    // Use Date object to catch impossible dates (e.g. 31/02, 30/02)
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
    await send.text('📧 *Email Address* (optional)\n\nEnter your email to receive booking confirmations:\n\nReply *Skip* to skip.');
    await updateSession(schema, phone, STATES.COLLECT_EMAIL, ctx);
    return;
  }
  if (session.state === STATES.COLLECT_EMAIL) {
    if (!/skip/i.test(input) && input.length > 0) {
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input)) {
        ctx.patient_email = input.toLowerCase();
      } else {
        await send.text('Invalid email format. Please enter a valid email or reply *Skip* to skip.');
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

  // ── MY APPOINTMENTS FLOW ───────────────────────────────────────
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
    const appt = await tenantQuery(schema,
      `SELECT a.*, d.name as doctor_name, d.slot_duration_minutes
       FROM appointments a
       JOIN doctors d ON d.id=a.doctor_id
       WHERE a.booking_id=$1 AND a.status='confirmed'`,
      [input.toUpperCase()]);
    if (!appt.rows[0]) {
      await send.text('Booking ID not found or already cancelled. Please try again.\n\nReply *Hi* to go back.');
      return;
    }
    const a = appt.rows[0];
    const today = new Date();
    const dates = [];
    for (let i = 1; i <= SLOT_LOOKAHEAD_DAYS && dates.length < 7; i++) {
      const d = addDays(today, i);
      const dateStr = format(d, 'yyyy-MM-dd');
      if (dateStr === a.appointment_date) continue;
      const count = await tenantQuery(schema,
        `SELECT COUNT(*) FROM time_slots WHERE doctor_id=$1 AND slot_date=$2 AND status='available'`,
        [a.doctor_id, dateStr]);
      const n = parseInt(count.rows[0].count);
      if (n > 0) dates.push({ date: dateStr, label: format(d, 'EEE, d MMM'), slots: n });
    }
    if (!dates.length) {
      await send.text(`No available slots for Dr. ${a.doctor_name} in the next ${SLOT_LOOKAHEAD_DAYS} days.\n\nReply *Hi* to go back.`);
      await updateSession(schema, phone, STATES.IDLE, {});
      return;
    }
    ctx.reschedule_appt_id = a.id;
    ctx.reschedule_old_slot_id = a.slot_id;
    ctx.reschedule_doctor_id = a.doctor_id;
    ctx.reschedule_doctor_name = a.doctor_name;
    ctx.reschedule_booking_id = a.booking_id;
    ctx.reschedule_old_date = a.appointment_date;
    ctx.reschedule_old_time = a.appointment_time;
    const sections = [{
      title: 'Available Dates',
      rows: dates.map(d => ({ id: d.date, title: d.label, description: `${d.slots} slots available` }))
    }];
    let oldDate = a.appointment_date;
    try { oldDate = format(parseISO(a.appointment_date), 'd MMM'); } catch {}
    await send.list(
      `🔄 *Reschedule — ${a.booking_id}*\n\nCurrently: Dr. ${a.doctor_name} on ${oldDate} at ${a.appointment_time.slice(0,5)}\n\nPick a *new date*:`,
      'Choose New Date', sections
    );
    await updateSession(schema, phone, STATES.RESCHEDULE_DATE, ctx);
    return;
  }

  if (session.state === STATES.RESCHEDULE_DATE) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(choice)) {
      await send.text('Please select a date from the list.');
      return;
    }
    ctx.reschedule_new_date = choice;
    const slots = await tenantQuery(schema,
      `SELECT id, start_time, end_time FROM time_slots
       WHERE doctor_id=$1 AND slot_date=$2 AND status='available'
       ORDER BY start_time`,
      [ctx.reschedule_doctor_id, choice]);
    if (!slots.rows.length) {
      await send.text('No slots available for that date. Please pick another.\n\nReply *Hi* to start over.');
      return;
    }
    ctx._reschedule_slots = slots.rows;
    let dateLabel = choice;
    try { dateLabel = format(parseISO(choice), 'EEE, d MMM'); } catch {}
    const sections = [{
      title: 'Available Slots',
      rows: slots.rows.map(s => ({
        id: s.id,
        title: s.start_time.slice(0, 5),
        description: `${s.start_time.slice(0, 5)} – ${s.end_time.slice(0, 5)}`
      }))
    }];
    await send.list(`⏰ *Select New Time*\n\nSlots on ${dateLabel}:`, 'Choose Time', sections);
    await updateSession(schema, phone, STATES.RESCHEDULE_SLOT, ctx);
    return;
  }

  if (session.state === STATES.RESCHEDULE_SLOT) {
    const slots = ctx._reschedule_slots || [];
    const slot = slots.find(s =>
      s.id === choice ||
      s.start_time.slice(0, 5) === input ||
      s.start_time.slice(0, 5) === choice
    );
    if (!slot) { await send.text('Please select a time slot from the list.'); return; }
    ctx.reschedule_new_slot_id = slot.id;
    ctx.reschedule_new_time = slot.start_time;

    let oldDate = ctx.reschedule_old_date;
    let newDate = ctx.reschedule_new_date;
    try { oldDate = format(parseISO(oldDate), 'EEE, d MMM'); } catch {}
    try { newDate = format(parseISO(newDate), 'EEE, d MMM'); } catch {}

    await send.buttons(
      `🔄 *Confirm Reschedule*\n\n` +
      `Dr. ${ctx.reschedule_doctor_name}\n\n` +
      `❌ Old: ${oldDate} at ${ctx.reschedule_old_time.slice(0, 5)}\n` +
      `✅ New: ${newDate} at ${slot.start_time.slice(0, 5)}\n\n` +
      `Confirm the change?`,
      ['✅ Yes, Reschedule', '❌ No, Keep Original']
    );
    await updateSession(schema, phone, STATES.RESCHEDULE_CONFIRM, ctx);
    return;
  }

  if (session.state === STATES.RESCHEDULE_CONFIRM) {
    if (/yes|reschedule|confirm|btn_0/i.test(choice)) {
      // Atomic: lock new slot + release old slot + update appointment in one transaction
      const rescheduled = await tenantTransaction(schema, async (client) => {
        const lock = await client.query(
          `UPDATE time_slots SET status='booked' WHERE id=$1 AND status='available' RETURNING id`,
          [ctx.reschedule_new_slot_id]
        );
        if (!lock.rows.length) return null; // slot taken
        await client.query(
          `UPDATE time_slots SET status='available' WHERE id=$1`,
          [ctx.reschedule_old_slot_id]
        );
        await client.query(
          `UPDATE appointments SET
             slot_id=$1, appointment_date=$2, appointment_time=$3,
             reminder_24h_sent=false, reminder_2h_sent=false, updated_at=NOW()
           WHERE id=$4`,
          [ctx.reschedule_new_slot_id, ctx.reschedule_new_date, ctx.reschedule_new_time, ctx.reschedule_appt_id]
        );
        return true;
      });
      if (!rescheduled) {
        await send.text('⚠️ That slot was just taken! Reply *Hi* to pick another time.');
        await updateSession(schema, phone, STATES.IDLE, {});
        return;
      }

      let newDate = ctx.reschedule_new_date;
      try { newDate = format(parseISO(newDate), 'EEE, d MMM yyyy'); } catch {}
      await send.text(
        `✅ *Appointment Rescheduled!*\n\n` +
        `Booking ID: *${ctx.reschedule_booking_id}*\n` +
        `👨‍⚕️ Dr. ${ctx.reschedule_doctor_name}\n` +
        `📅 ${newDate} at ${ctx.reschedule_new_time.slice(0, 5)}\n\n` +
        `A new reminder will be sent 24 hours before.\n\n` +
        `Reply *Hi* for the main menu.`
      );
      logger.info(`Rescheduled: ${ctx.reschedule_booking_id}`, { phone, tenant: tenant.name });
    } else {
      await send.text('No changes made. Your original appointment is kept. ✅\n\nReply *Hi* for the main menu.');
    }
    await updateSession(schema, phone, STATES.IDLE, {});
    return;
  }

  if (session.state === STATES.CANCEL_SELECT) {
    const appt = await tenantQuery(schema,
      `SELECT a.*, d.name as doctor_name FROM appointments a
       JOIN doctors d ON d.id=a.doctor_id
       WHERE a.booking_id=$1 AND a.status='confirmed'`,
      [input.toUpperCase()]);
    if (!appt.rows[0]) {
      await send.text('Booking ID not found or already cancelled. Please try again.\n\nReply *Hi* to go back.');
      return;
    }
    const a = appt.rows[0];
    ctx.cancel_appt_id = a.id;
    ctx.cancel_slot_id = a.slot_id;
    ctx.cancel_doctor_id = a.doctor_id;
    ctx.cancel_booking_id = a.booking_id;
    ctx.cancel_doctor_name = a.doctor_name;
    ctx.cancel_date = a.appointment_date;
    ctx.cancel_time = a.appointment_time;
    await send.buttons(
      `❌ *Cancel Appointment*\n\nBooking: *${a.booking_id}*\nDr. ${a.doctor_name}\n${a.appointment_date} at ${a.appointment_time.slice(0,5)}\n\nWhy are you cancelling?`,
      ['Doctor not available', 'Schedule conflict', 'Other reason']
    );
    await updateSession(schema, phone, STATES.CANCEL_REASON, ctx);
    return;
  }

  if (session.state === STATES.CANCEL_REASON) {
    const reasonMap = { btn_0: 'Doctor not available', btn_1: 'Schedule conflict', btn_2: 'Other' };
    ctx.cancel_reason = reasonMap[buttonId] || input || 'Not specified';
    await send.buttons(
      `❌ *Confirm Cancellation*\n\nBooking: *${ctx.cancel_booking_id}*\nDr. ${ctx.cancel_doctor_name}\n${ctx.cancel_date} at ${ctx.cancel_time?.slice(0,5)}\nReason: ${ctx.cancel_reason}\n\nAre you sure?`,
      ['Yes, Cancel It', 'No, Keep It']
    );
    await updateSession(schema, phone, STATES.CANCEL_CONFIRM, ctx);
    return;
  }

  if (session.state === STATES.CANCEL_CONFIRM) {
    if (/yes|cancel|btn_0/i.test(choice)) {
      await tenantTransaction(schema, async (client) => {
        await client.query(
          `UPDATE appointments SET status='cancelled', cancellation_reason=$1, cancelled_by='bot', cancelled_at=NOW(), updated_at=NOW() WHERE id=$2 AND status='confirmed'`,
          [ctx.cancel_reason || null, ctx.cancel_appt_id]);
        await client.query(
          `UPDATE time_slots SET status='available' WHERE id=$1 AND status='booked'`, [ctx.cancel_slot_id]);
      });
      // Notify waitlist for this doctor since a slot opened up
      if (ctx.cancel_doctor_id) {
        notifyWaitlistForDoctor(schema, ctx.cancel_doctor_id, tenant).catch(() => {});
      }
      await send.text('✅ Appointment cancelled successfully.\n\nReply *Hi* to book a new appointment anytime.');
    } else {
      await send.text('Your appointment is kept. ✅\n\nReply *Hi* for the main menu.');
    }
    await updateSession(schema, phone, STATES.IDLE, {});
    return;
  }

  // Fallback
  await send.text('Sorry, I didn\'t understand that. 🤔\n\nReply *Hi* to return to the main menu.');
  await updateSession(schema, phone, STATES.IDLE, {});
}

// ── BOOKING STEP HANDLERS ─────────────────────────────────────

async function startBooking(phone, schema, tenant, send, ctx, waToken, waPhoneId) {
  const hospitals = await tenantQuery(schema,
    `SELECT id, name, city FROM hospitals WHERE is_active=true ORDER BY name`);

  if (!hospitals.rows.length) {
    await send.text('No hospitals available right now. Please try again later.');
    await updateSession(schema, phone, STATES.IDLE, {});
    return;
  }

  if (hospitals.rows.length === 1) {
    ctx.hospital_id = hospitals.rows[0].id;
    ctx.hospital_name = hospitals.rows[0].name;
    return askVisitType(phone, schema, send, ctx);
  }

  const sections = [{
    title: 'Our Locations',
    rows: hospitals.rows.map(h => ({ id: h.id, title: h.name, description: h.city || '' }))
  }];
  await send.list('🏥 *Select a Hospital/Clinic*\n\nChoose your preferred location:', 'View Locations', sections);
  await updateSession(schema, phone, STATES.SELECT_HOSPITAL, ctx);
}

async function askVisitType(phone, schema, send, ctx) {
  await send.buttons(
    '🩺 *Type of Consultation*\n\nHow would you like to see the doctor?',
    ['🏥 In-Person Visit', '📱 Video Consultation']
  );
  await updateSession(schema, phone, STATES.SELECT_VISIT_TYPE, ctx);
}

async function handleSelectHospital(phone, schema, tenant, send, ctx, choice, input) {
  const hospitals = await tenantQuery(schema, `SELECT id, name FROM hospitals WHERE is_active=true`);
  const h = hospitals.rows.find(r =>
    r.id === choice || r.name.toLowerCase().includes(input.toLowerCase())
  );
  if (!h) { await send.text('Please select a location from the options.'); return; }
  ctx.hospital_id = h.id;
  ctx.hospital_name = h.name;
  return askVisitType(phone, schema, send, ctx);
}

async function handleSelectVisitType(phone, schema, tenant, send, ctx, choice) {
  ctx.visit_type = /video|online|btn_1/i.test(choice) ? 'video' : 'in_person';
  ctx.visit_label = ctx.visit_type === 'video' ? '📱 Video Consultation' : '🏥 In-Person Visit';

  const depts = await tenantQuery(schema,
    `SELECT DISTINCT d.id, d.name FROM departments d
     JOIN doctors doc ON doc.department_id=d.id
     WHERE d.hospital_id=$1 AND d.is_active=true AND doc.is_active=true
     ORDER BY d.name`, [ctx.hospital_id]);

  if (!depts.rows.length) {
    await send.text('No specialties available right now. Please contact the clinic directly.\n\nReply *Hi* to start over.');
    await updateSession(schema, phone, STATES.IDLE, {});
    return;
  }

  ctx._depts = depts.rows;

  if (depts.rows.length <= 3) {
    await send.buttons('🏥 *Select Specialty*\n\nWhat type of doctor do you need?',
      depts.rows.map(d => d.name));
  } else {
    const sections = [{ title: 'Specialties', rows: depts.rows.map(d => ({ id: d.id, title: d.name })) }];
    await send.list('🏥 *Select Specialty*\n\nWhat type of doctor do you need?', 'View Specialties', sections);
  }
  await updateSession(schema, phone, STATES.SELECT_DEPARTMENT, ctx);
}

async function handleSelectDept(phone, schema, tenant, send, ctx, choice, input) {
  const depts = ctx._depts || [];
  const dept = depts.find(d => d.id === choice) || fuzzyFind(depts, input);
  if (!dept) { await send.text('Please select a specialty from the options.'); return; }

  ctx.department_id = dept.id;
  ctx.department_name = dept.name;

  const doctors = await tenantQuery(schema,
    `SELECT id, name, qualification, consultation_fee FROM doctors
     WHERE department_id=$1 AND hospital_id=$2 AND is_active=true ORDER BY name`,
    [dept.id, ctx.hospital_id]);

  if (!doctors.rows.length) {
    await send.text(`No doctors available in ${dept.name}.\n\nReply *Hi* to choose another specialty.`);
    return;
  }

  ctx._doctors = doctors.rows;

  if (doctors.rows.length <= 3) {
    await send.buttons(`👨‍⚕️ *Select Doctor*\n\nAvailable ${dept.name} doctors:`,
      doctors.rows.map(d => `Dr. ${d.name}`));
  } else {
    const sections = [{
      title: `${dept.name} Doctors`,
      rows: doctors.rows.map(d => ({
        id: d.id,
        title: `Dr. ${d.name}`,
        description: [d.qualification, d.consultation_fee ? '₹' + d.consultation_fee : ''].filter(Boolean).join(' • ')
      }))
    }];
    await send.list(`👨‍⚕️ *Select Doctor*`, 'View Doctors', sections);
  }
  await updateSession(schema, phone, STATES.SELECT_DOCTOR, ctx);
}

async function handleSelectDoctor(phone, schema, tenant, send, ctx, choice, input) {
  const doctors = ctx._doctors || [];
  const cleanInput = input.toLowerCase().replace(/^dr\.?\s*/i, '').trim();
  const doc = doctors.find(d => d.id === choice) || fuzzyFind(doctors, cleanInput);
  if (!doc) { await send.text('Please select a doctor from the options shown.'); return; }

  ctx.doctor_id = doc.id;
  ctx.doctor_name = doc.name;

  // Find available dates including today if there are future slots today
  const today = new Date();
  const dates = [];
  // Check today first (same-day booking)
  const todayStr = format(today, 'yyyy-MM-dd');
  const todayCount = await tenantQuery(schema,
    `SELECT COUNT(*) FROM time_slots WHERE doctor_id=$1 AND slot_date=$2 AND status='available' AND start_time > (NOW() AT TIME ZONE 'Asia/Kolkata')::time`,
    [doc.id, todayStr]);
  const todayN = parseInt(todayCount.rows[0].count);
  if (todayN > 0) dates.push({ date: todayStr, label: `Today (${format(today, 'd MMM')})`, slots: todayN });

  for (let i = 1; i <= SLOT_LOOKAHEAD_DAYS && dates.length < 7; i++) {
    const d = addDays(today, i);
    const dateStr = format(d, 'yyyy-MM-dd');
    const count = await tenantQuery(schema,
      `SELECT COUNT(*) FROM time_slots WHERE doctor_id=$1 AND slot_date=$2 AND status='available'`,
      [doc.id, dateStr]);
    const n = parseInt(count.rows[0].count);
    if (n > 0) dates.push({ date: dateStr, label: format(d, 'EEE, d MMM'), slots: n });
  }

  if (!dates.length) {
    await send.buttons(
      `No available slots for Dr. ${doc.name} in the next ${SLOT_LOOKAHEAD_DAYS} days.\n\nWould you like to join the waiting list? We'll notify you when a slot opens!`,
      ['🔔 Join Waiting List', '🔙 Choose Another Doctor']
    );
    await updateSession(schema, phone, STATES.WAITLIST_CONFIRM, ctx);
    return;
  }

  const sections = [{
    title: 'Available Dates',
    rows: dates.map(d => ({ id: d.date, title: d.label, description: `${d.slots} slots available` }))
  }];
  await send.list(`📅 *Select Date*\n\nAvailable dates for Dr. ${doc.name}:`, 'Choose Date', sections);
  await updateSession(schema, phone, STATES.SELECT_DATE, ctx);
}

async function handleWaitlistConfirm(phone, schema, tenant, send, ctx, choice) {
  if (/join|waitlist|🔔|btn_0/i.test(choice)) {
    const patient = await getPatient(schema, phone);
    let patientId = patient?.id;

    if (!patientId) {
      await send.text('To join the waiting list, please provide your name first.\n\nEnter your full name:');
      ctx._waitlist_pending = true;
      await updateSession(schema, phone, STATES.COLLECT_NAME, ctx);
      return;
    }

    await tenantQuery(schema,
      `INSERT INTO waiting_list (patient_id, doctor_id, hospital_id) VALUES ($1,$2,$3)`,
      [patientId, ctx.doctor_id, ctx.hospital_id]);

    await send.text(
      `✅ *You've joined the waiting list!*\n\n` +
      `We'll send you a WhatsApp notification as soon as Dr. ${ctx.doctor_name} has an available slot.\n\n` +
      `Reply *Hi* for the main menu.`
    );
    await updateSession(schema, phone, STATES.IDLE, {});
  } else {
    await send.text('Okay, let\'s choose a different doctor.\n\nReply *Hi* to start over.');
    await updateSession(schema, phone, STATES.IDLE, {});
  }
}

async function handleSelectDate(phone, schema, tenant, send, ctx, choice) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(choice)) {
    await send.text('Please select a date from the list.');
    return;
  }
  ctx.appointment_date = choice;

  const slots = await tenantQuery(schema,
    `SELECT id, start_time, end_time FROM time_slots
     WHERE doctor_id=$1 AND slot_date=$2 AND status='available'
     ORDER BY start_time`,
    [ctx.doctor_id, choice]);

  if (!slots.rows.length) {
    await send.text('No slots left for that date. Please select another date.\n\nReply *Hi* to start over.');
    return;
  }

  ctx._slots = slots.rows;
  const sections = [{
    title: 'Available Slots',
    rows: slots.rows.map(s => ({
      id: s.id,
      title: s.start_time.slice(0, 5),
      description: `${s.start_time.slice(0, 5)} – ${s.end_time.slice(0, 5)}`
    }))
  }];

  let dateLabel = choice;
  try { dateLabel = format(parseISO(choice), 'EEE, d MMM'); } catch {}

  await send.list(`⏰ *Select Time*\n\nSlots on ${dateLabel}:`, 'Choose Time', sections);
  await updateSession(schema, phone, STATES.SELECT_SLOT, ctx);
}

async function handleSelectSlot(phone, schema, tenant, send, ctx, choice, input) {
  const slots = ctx._slots || [];
  const slot = slots.find(s =>
    s.id === choice ||
    s.start_time.slice(0, 5) === input ||
    s.start_time.slice(0, 5) === choice
  );
  if (!slot) { await send.text('Please select a time slot from the list.'); return; }

  ctx.slot_id = slot.id;
  ctx.appointment_time = slot.start_time;

  const patient = await getPatient(schema, phone);
  if (patient?.name) {
    ctx.patient_id = patient.id;
    ctx.patient_name = patient.name;
    return showConfirmation(phone, schema, send, ctx, updateSession);
  }

  await send.text('👤 *Your Name*\n\nPlease enter your full name:');
  await updateSession(schema, phone, STATES.COLLECT_NAME, ctx);
}

async function showConfirmation(phone, schema, send, ctx, updateSessionFn) {
  let dateLabel = ctx.appointment_date;
  try { dateLabel = format(parseISO(ctx.appointment_date), 'EEEE, d MMMM yyyy'); } catch {}
  const time = ctx.appointment_time?.slice(0, 5);

  const summary =
    `📋 *Booking Summary*\n\n` +
    `🏥 ${ctx.hospital_name}\n` +
    `🏷 ${ctx.department_name}\n` +
    `👨‍⚕️ Dr. ${ctx.doctor_name}\n` +
    `📅 ${dateLabel}\n` +
    `⏰ ${time}\n` +
    `${ctx.visit_label}\n` +
    `👤 ${ctx.patient_name}\n\n` +
    `Shall I confirm this booking?`;

  await send.buttons(summary, ['✅ Confirm', '❌ Cancel']);
  await updateSessionFn(schema, phone, STATES.CONFIRM_BOOKING, ctx);
}

async function completeBooking(phone, schema, tenant, send, ctx) {
  // Phone rate limit: max 3 confirmed bookings per hour
  try {
    const recentR = await tenantQuery(schema,
      `SELECT COUNT(*) FROM appointments a
       JOIN patients p ON p.id=a.patient_id
       WHERE p.phone=$1 AND a.status='confirmed' AND a.created_at >= NOW() - INTERVAL '1 hour'`,
      [phone]);
    if (parseInt(recentR.rows[0].count) >= 3) {
      await send.text('⚠️ You\'ve made 3 bookings in the last hour. Please wait before booking again.\n\nReply *Hi* for the main menu.');
      await updateSession(schema, phone, STATES.IDLE, {});
      return;
    }
  } catch (_) {} // rate limit check is non-fatal

  // Single transaction: slot lock + patient upsert + appointment insert
  const client = await pool.connect();
  let bookingId;
  let patientId = ctx.patient_id;

  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO "${schema}", public`);

    // Atomic slot lock
    const slotUpdate = await client.query(
      `UPDATE time_slots SET status='booked' WHERE id=$1 AND status='available' RETURNING id`,
      [ctx.slot_id]);

    if (!slotUpdate.rows.length) {
      await client.query('ROLLBACK');
      await send.text('⚠️ Sorry, that slot was just taken! Reply *Hi* to choose another time.');
      await updateSession(schema, phone, STATES.IDLE, {});
      return;
    }

    // Upsert patient (include email if collected)
    if (!patientId) {
      const pr = await client.query(
        `INSERT INTO patients (phone, name, date_of_birth, gender, email, visit_count)
         VALUES ($1,$2,$3,$4,$5,1)
         ON CONFLICT (phone) DO UPDATE SET
           name=EXCLUDED.name, date_of_birth=EXCLUDED.date_of_birth,
           gender=EXCLUDED.gender,
           email=COALESCE(EXCLUDED.email, patients.email),
           visit_count=patients.visit_count+1, updated_at=NOW()
         RETURNING id`,
        [phone, ctx.patient_name, ctx.patient_dob || null, ctx.patient_gender || null, ctx.patient_email || null]);
      patientId = pr.rows[0].id;
    } else {
      await client.query(
        `UPDATE patients SET visit_count=visit_count+1, updated_at=NOW() WHERE id=$1`, [patientId]);
    }

    bookingId = genBookingId();
    await client.query(
      `INSERT INTO appointments
       (booking_id, patient_id, doctor_id, hospital_id, slot_id, appointment_date, appointment_time, visit_type, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'confirmed')`,
      [bookingId, patientId, ctx.doctor_id, ctx.hospital_id, ctx.slot_id,
       ctx.appointment_date, ctx.appointment_time, ctx.visit_type || 'in_person']);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Booking transaction failed', { error: err.message });
    await send.text('⚠️ Sorry, there was an error completing your booking. Please try again.\n\nReply *Hi* to start over.');
    await updateSession(schema, phone, STATES.IDLE, {});
    return;
  } finally {
    client.release();
  }

  // Post-transaction actions
  notifyWaitlistForDoctor(schema, ctx.doctor_id, tenant).catch(() => {});

  let dateLabel = ctx.appointment_date;
  try { dateLabel = format(parseISO(ctx.appointment_date), 'EEE, d MMM yyyy'); } catch {}

  await send.text(
    `✅ *Appointment Confirmed!*\n\n` +
    `Booking ID: *${bookingId}*\n` +
    `👨‍⚕️ Dr. ${ctx.doctor_name}\n` +
    `📅 ${dateLabel} at ${ctx.appointment_time.slice(0, 5)}\n` +
    `🏥 ${ctx.hospital_name}\n\n` +
    `You'll receive a reminder 24 hours before your appointment.\n\n` +
    `Reply *Hi* to book another appointment or *Status* to view appointments.`
  );

  // Email confirmation (best-effort)
  if (patientId) {
    try {
      const patientR = await tenantQuery(schema, `SELECT email FROM patients WHERE id=$1`, [patientId]);
      const patientEmail = patientR.rows[0]?.email;
      if (patientEmail) {
        let dateLabel2 = ctx.appointment_date;
        try { dateLabel2 = format(parseISO(ctx.appointment_date), 'EEE, d MMM yyyy'); } catch {}
        await emailService.sendBookingConfirmation(patientEmail, {
          bookingId,
          patientName: ctx.patient_name,
          doctorName: ctx.doctor_name,
          hospitalName: ctx.hospital_name,
          date: dateLabel2,
          time: ctx.appointment_time?.slice(0, 5),
          visitType: ctx.visit_type || 'in_person',
        });
      }
    } catch (emailErr) {
      logger.error('Email confirmation failed', { error: emailErr.message });
      // WA fallback notification (best-effort)
      try {
        await send.text(`📧 Note: We couldn't send an email confirmation, but your booking *${bookingId}* is confirmed.`);
      } catch (_) {}
    }
  }

  await updateSession(schema, phone, STATES.IDLE, {});
  logger.info(`✅ Booking confirmed: ${bookingId}`, { phone, tenant: tenant.name });
}

async function notifyWaitlistForDoctor(schema, doctorId, tenant) {
  try {
    const waToken = tenant?.wa_access_token_enc ? decrypt(tenant.wa_access_token_enc) : null;
    const waPhoneId = tenant?.wa_phone_number_id;
    if (!waToken || !waPhoneId) return;

    const doctorR = await tenantQuery(schema, `SELECT name FROM doctors WHERE id=$1`, [doctorId]);
    const doctorName = doctorR.rows[0]?.name || 'your doctor';

    const wl = await tenantQuery(schema,
      `SELECT wl.*, p.phone FROM waiting_list wl JOIN patients p ON p.id=wl.patient_id
       WHERE wl.doctor_id=$1 AND wl.notified=false LIMIT 5`, [doctorId]);
    for (const entry of wl.rows) {
      try {
        await wa.sendText(entry.phone,
          `🎉 *Slot Available!*\n\nA slot has opened up with Dr. ${doctorName}.\n\nReply *Hi* to book your appointment now before it's taken!`,
          waToken, waPhoneId
        );
        await tenantQuery(schema,
          `UPDATE bot_sessions SET state='main_menu', context='{}', last_activity=NOW() WHERE phone=$1`, [entry.phone]);
        await tenantQuery(schema,
          `UPDATE waiting_list SET notified=true WHERE id=$1`, [entry.id]);
      } catch (_) {}
    }
  } catch (_) {}
}

async function showMyAppointments(phone, schema, tenant, send) {
  const patient = await getPatient(schema, phone);
  if (!patient) {
    await send.text('No appointments found for your number.\n\nReply *Hi* to book your first appointment! 😊');
    return;
  }

  const appts = await tenantQuery(schema,
    `SELECT a.booking_id, a.appointment_date, a.appointment_time, a.status,
            d.name as doctor_name, h.name as hospital_name
     FROM appointments a
     JOIN doctors d ON d.id=a.doctor_id
     JOIN hospitals h ON h.id=a.hospital_id
     WHERE a.patient_id=$1 AND a.appointment_date >= CURRENT_DATE AND a.status NOT IN ('cancelled')
     ORDER BY a.appointment_date, a.appointment_time
     LIMIT 5`,
    [patient.id]);

  if (!appts.rows.length) {
    await send.text('No upcoming appointments found.\n\nReply *Hi* to book a new appointment! 📅');
    return;
  }

  const list = appts.rows.map((a, i) => {
    let dt = a.appointment_date;
    try { dt = format(parseISO(a.appointment_date), 'd MMM'); } catch {}
    return `${i + 1}. *${a.booking_id}*\n   Dr. ${a.doctor_name}\n   ${dt} at ${a.appointment_time.slice(0, 5)} — ${a.status}`;
  }).join('\n\n');

  await send.buttons(
    `📅 *Your Upcoming Appointments*\n\n${list}\n\nWhat would you like to do?`,
    ['🔄 Reschedule', '❌ Cancel Appointment', '🏠 Main Menu']
  );

  await updateSession(schema, phone, STATES.MY_APPOINTMENTS, { _appts: appts.rows });
}

// ── FEEDBACK HANDLERS ──────────────────────────────────────────

async function handleFeedbackRating(phone, schema, send, ctx, choice, input) {
  const ratingMap = { btn_0: 1, btn_1: 2, btn_2: 3, btn_3: 4, btn_4: 5 };
  let rating = ratingMap[choice] || parseInt(input);
  if (/skip/i.test(input)) {
    await send.text('No problem! Reply *Hi* for the main menu.');
    await updateSession(schema, phone, STATES.IDLE, {});
    return;
  }
  if (!rating || rating < 1 || rating > 5) {
    await send.buttons(
      `Please rate your experience (1-5):\n1⭐ Poor → 5⭐ Excellent\n\nOr reply with a number 1-5.`,
      ['⭐ 1', '⭐⭐⭐ 3', '⭐⭐⭐⭐⭐ 5']
    );
    return;
  }
  ctx.feedback_rating = rating;
  await send.text(
    `${rating >= 4 ? '🌟' : '📝'} Thank you for rating ${rating}/5!\n\n` +
    `Would you like to leave a comment? (Reply *Skip* to finish)`
  );
  await updateSession(schema, phone, STATES.COLLECT_FEEDBACK_COMMENT, ctx);
}

async function handleFeedbackComment(phone, schema, send, ctx, input) {
  const comment = /skip/i.test(input) ? null : input;
  try {
    if (ctx.feedback_appointment_id && ctx.feedback_patient_id) {
      await tenantQuery(schema,
        `INSERT INTO appointment_feedback (appointment_id, patient_id, rating, comment)
         VALUES ($1,$2,$3,$4)`,
        [ctx.feedback_appointment_id, ctx.feedback_patient_id, ctx.feedback_rating, comment]);
    }
  } catch (_) {}
  await send.text('✅ Thank you for your feedback! It helps us serve you better.\n\nReply *Hi* for the main menu.');
  await updateSession(schema, phone, STATES.IDLE, {});
}

async function triggerFeedback(schemaName, phone, appointmentId, patientId, doctorName) {
  try {
    await tenantQuery(schemaName,
      `UPDATE bot_sessions SET state=$1, context=$2, last_activity=NOW() WHERE phone=$3`,
      [
        STATES.COLLECT_FEEDBACK_RATING,
        JSON.stringify({ feedback_appointment_id: appointmentId, feedback_patient_id: patientId, doctor_name: doctorName }),
        phone
      ]
    );
  } catch (_) {}
}

module.exports = { handle, triggerFeedback };
