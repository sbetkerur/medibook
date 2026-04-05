'use strict';

const { tenantQuery, tenantTransaction } = require('../../db');
const { format, addDays, parseISO } = require('date-fns');
const { fromZonedTime, toZonedTime } = require('../../utils/dateTz');
const logger = require('../../utils/logger');
const { SLOT_LOOKAHEAD_DAYS } = require('../../utils/errors');

const IST = 'Asia/Kolkata';
const {
  STATES,
  getPatient,
  getPatients,
  updateSession,
  notifyAdminWhatsApp,
} = require('./utils');

async function showMyAppointments(phone, schema, tenant, send) {
  // Use getPatients (plural) to support family booking — a single phone number
  // can have multiple patient profiles (e.g. parent booking for child/spouse).
  // The old getPatient (singular) only returned the FIRST profile, so appointments
  // booked for other family members were invisible in this view.
  const patients = await getPatients(schema, phone);
  if (!patients.length) {
    await send.text('We don\'t have any appointments linked to this number.\n\nReply *Hi* and tap *Book Appointment* to schedule your first one! 😊');
    return;
  }

  const patientIds = patients.map(p => p.id);
  const multiplePatients = patientIds.length > 1;

  const [upcomingR, pastR] = await Promise.all([
    tenantQuery(schema,
      `SELECT a.booking_id, a.appointment_date, a.appointment_time, a.status,
              d.name as doctor_name, h.name as hospital_name, p.name as patient_name
       FROM appointments a
       JOIN doctors d ON d.id=a.doctor_id
       JOIN hospitals h ON h.id=a.hospital_id
       JOIN patients p ON p.id=a.patient_id
       WHERE a.patient_id = ANY($1::uuid[]) AND a.appointment_date >= CURRENT_DATE AND a.status NOT IN ('cancelled')
       ORDER BY a.appointment_date, a.appointment_time
       LIMIT 5`,
      [patientIds]),
    tenantQuery(schema,
      `SELECT a.booking_id, a.appointment_date, a.appointment_time, a.status,
              d.name as doctor_name, p.name as patient_name
       FROM appointments a
       JOIN doctors d ON d.id=a.doctor_id
       JOIN patients p ON p.id=a.patient_id
       WHERE a.patient_id = ANY($1::uuid[]) AND a.appointment_date < CURRENT_DATE
       ORDER BY a.appointment_date DESC, a.appointment_time DESC
       LIMIT 3`,
      [patientIds]),
  ]);

  if (!upcomingR.rows.length && !pastR.rows.length) {
    await send.text('You have no appointments yet.\n\nReply *Hi* and tap *Book Appointment* to get started! 📅');
    return;
  }

  const statusLabel = (s) => ({ confirmed: '✅ Confirmed', completed: '🏁 Completed', cancelled: '❌ Cancelled', no_show: '⚠️ No Show' }[s] || s);

  let bodyText = '';

  if (upcomingR.rows.length) {
    const upcomingList = upcomingR.rows.map((a, i) => {
      let dt = a.appointment_date;
      try { dt = format(parseISO(a.appointment_date), 'EEE, d MMM'); } catch {}
      const patientLine = multiplePatients && a.patient_name ? `\n   👤 ${a.patient_name}` : '';
      return `${i + 1}. *${a.booking_id}*\n   👨‍⚕️ Dr. ${a.doctor_name}\n   📅 ${dt} at ${(a.appointment_time || '').slice(0, 5)}\n   ${statusLabel(a.status)}${patientLine}`;
    }).join('\n\n');
    bodyText += `📅 *Upcoming Appointments*\n\n${upcomingList}`;
  } else {
    bodyText += '📅 No upcoming appointments.';
  }

  if (pastR.rows.length) {
    const pastList = pastR.rows.map(a => {
      let dt = a.appointment_date;
      try { dt = format(parseISO(a.appointment_date), 'd MMM yyyy'); } catch {}
      const patientSuffix = multiplePatients && a.patient_name ? ` · ${a.patient_name}` : '';
      return `• *${a.booking_id}* — Dr. ${a.doctor_name}, ${dt} — ${statusLabel(a.status)}${patientSuffix}`;
    }).join('\n');
    bodyText += `\n\n📜 *Past Appointments*\n${pastList}`;
  }

  bodyText += '\n\nWhat would you like to do?';

  const buttons = upcomingR.rows.length
    ? ['🔄 Reschedule', '❌ Cancel Appointment', '🏠 Main Menu']
    : ['🏠 Main Menu'];
  await send.buttons(bodyText, buttons);
  await updateSession(schema, phone, STATES.MY_APPOINTMENTS, { _appts: upcomingR.rows });
}

async function handleRescheduleSelect(phone, schema, tenant, send, ctx, input) {
  // Only allow the patient who owns the booking to reschedule it.
  const appt = await tenantQuery(schema,
    `SELECT a.*, d.name as doctor_name, d.slot_duration_minutes
     FROM appointments a
     JOIN doctors d ON d.id=a.doctor_id
     JOIN patients p ON p.id=a.patient_id
     WHERE a.booking_id=$1 AND a.status='confirmed' AND p.phone=$2`,
    [input.toUpperCase(), phone]);
  if (!appt.rows[0]) {
    await send.text('Booking ID not found or already cancelled. Please try again.\n\nReply *Hi* to go back.');
    return;
  }
  const a = appt.rows[0];
  // 2-hour minimum notice check — appointment_time is stored in IST; parse it
  // as IST before comparing to the current UTC wall-clock time.
  // Guard against null appointment_time (legacy rows) — skip the check rather
  // than producing an Invalid Date that makes hoursUntilR NaN (always falsy).
  if (a.appointment_time) {
    const nowDateR = new Date();
    const apptDateTimeR = fromZonedTime(`${a.appointment_date}T${a.appointment_time}`, IST);
    const hoursUntilR = (apptDateTimeR - nowDateR) / (1000 * 60 * 60);
    if (!isNaN(hoursUntilR) && hoursUntilR < 2 && hoursUntilR >= 0) {
      await send.text(`⚠️ Rescheduling must be done at least 2 hours before the appointment.\n\nYour appointment is in less than 2 hours. Please call the clinic directly.\n\nReply *Hi* to return to main menu.`);
      await updateSession(schema, phone, STATES.IDLE, {});
      return;
    }
  }

  // Use IST "today" so the date range is correct during the 5.5-hour window
  // between UTC midnight and IST midnight (new Date() would give yesterday in IST).
  const today = toZonedTime(new Date(), IST);
  const startStr = format(addDays(today, 1), 'yyyy-MM-dd');
  const endStr = format(addDays(today, SLOT_LOOKAHEAD_DAYS), 'yyyy-MM-dd');

  const datesResult = await tenantQuery(schema, `
    SELECT slot_date::text AS date, COUNT(*) AS slots
    FROM time_slots
    WHERE doctor_id = $1
      AND slot_date BETWEEN $2 AND $3
      AND slot_date != $4
      AND status = 'available'
      AND NOT EXISTS (
        SELECT 1 FROM doctor_leaves dl WHERE dl.doctor_id = $1 AND dl.leave_date = slot_date
      )
      AND NOT EXISTS (
        SELECT 1 FROM clinic_holidays ch WHERE ch.holiday_date = slot_date AND (ch.hospital_id = $5 OR ch.hospital_id IS NULL)
      )
    GROUP BY slot_date
    ORDER BY slot_date
    LIMIT 7
  `, [a.doctor_id, startStr, endStr, a.appointment_date, a.hospital_id]);

  const dates = datesResult.rows.map(r => ({
    date: r.date,
    label: format(parseISO(r.date), 'EEE, d MMM'),
    slots: parseInt(r.slots),
  }));
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
    `🔄 *Reschedule — ${a.booking_id}*\n\nCurrently: Dr. ${a.doctor_name} on ${oldDate} at ${(a.appointment_time || '').slice(0, 5)}\n\nPick a *new date*:`,
    'Choose New Date', sections
  );
  await updateSession(schema, phone, STATES.RESCHEDULE_DATE, ctx);
}

async function handleRescheduleDate(phone, schema, tenant, send, ctx, choice) {
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
  // Cap at 10 rows — WhatsApp list messages reject more than 10 rows per section.
  const visibleRescheduleSlots = slots.rows.slice(0, 10);
  ctx._reschedule_slots = visibleRescheduleSlots;
  let dateLabel = choice;
  try { dateLabel = format(parseISO(choice), 'EEE, d MMM'); } catch {}
  const sections = [{
    title: 'Available Slots',
    rows: visibleRescheduleSlots.map(s => ({
      id: s.id,
      title: `${s.start_time.slice(0, 5)} – ${s.end_time.slice(0, 5)}`,
    }))
  }];
  await send.list(`⏰ *Select New Time*\n\nSlots on ${dateLabel}:`, 'Choose Time', sections);
  await updateSession(schema, phone, STATES.RESCHEDULE_SLOT, ctx);
}

async function handleRescheduleSlot(phone, schema, tenant, send, ctx, choice, input) {
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
    `❌ Old: ${oldDate} at ${(ctx.reschedule_old_time || '').slice(0, 5)}\n` +
    `✅ New: ${newDate} at ${slot.start_time.slice(0, 5)}\n\n` +
    `Confirm the change?`,
    ['✅ Yes, Reschedule', '❌ No, Keep Original']
  );
  await updateSession(schema, phone, STATES.RESCHEDULE_CONFIRM, ctx);
}

async function handleRescheduleConfirm(phone, schema, tenant, send, ctx, choice) {
  if (/yes|reschedule|confirm|btn_0|^1$/.test(choice)) {
    // Atomic: lock new slot + release old slot + update appointment
    const rescheduled = await tenantTransaction(schema, async (client) => {
      const lock = await client.query(
        `UPDATE time_slots SET status='booked' WHERE id=$1 AND status='available' RETURNING id`,
        [ctx.reschedule_new_slot_id]
      );
      if (!lock.rows.length) return null; // slot taken
      await client.query(
        `UPDATE time_slots SET status='available' WHERE id=$1 AND status='booked'`,
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
      `Your booking has been moved successfully.\n\n` +
      `🪪 Booking ID: *${ctx.reschedule_booking_id}*\n` +
      `👨‍⚕️ Dr. ${ctx.reschedule_doctor_name}\n` +
      `📅 ${newDate}\n` +
      `⏰ ${(ctx.reschedule_new_time || '').slice(0, 5)}\n\n` +
      `We'll send you a fresh reminder 24 hours before. See you then! 😊`
    );
    logger.info(`Rescheduled: ${ctx.reschedule_booking_id}`, { phone, tenant: tenant.name });
    // Notify clinic admin via WhatsApp
    (async () => {
      let oldDateLabel = ctx.reschedule_old_date || '';
      try { oldDateLabel = format(parseISO(String(ctx.reschedule_old_date).slice(0, 10)), 'EEE, d MMM'); } catch {}
      await notifyAdminWhatsApp(schema, tenant,
        `🔄 *Appointment Rescheduled*\n\n` +
        `Booking: *${ctx.reschedule_booking_id}*\n` +
        `Patient: ${phone}\n` +
        `Dr. ${ctx.reschedule_doctor_name}\n` +
        `Old: ${oldDateLabel} at ${(ctx.reschedule_old_time || '').slice(0, 5)}\n` +
        `New: ${newDate} at ${(ctx.reschedule_new_time || '').slice(0, 5)}`
      );
    })().catch(() => {});
  } else {
    await send.text('No changes made — your original appointment is kept. ✅\n\nReply *Hi* for the main menu.');
  }
  await updateSession(schema, phone, STATES.IDLE, {});
}

async function handleCancelSelect(phone, schema, tenant, send, ctx, input) {
  // Only allow the patient who owns the booking to cancel it.
  const appt = await tenantQuery(schema,
    `SELECT a.*, d.name as doctor_name FROM appointments a
     JOIN doctors d ON d.id=a.doctor_id
     JOIN patients p ON p.id=a.patient_id
     WHERE a.booking_id=$1 AND a.status='confirmed' AND p.phone=$2`,
    [input.toUpperCase(), phone]);
  if (!appt.rows[0]) {
    await send.text('Booking ID not found or already cancelled. Please try again.\n\nReply *Hi* to go back.');
    return;
  }
  const a = appt.rows[0];
  // 2-hour minimum notice check — appointment_time is stored in IST; parse it
  // as IST before comparing to the current UTC wall-clock time.
  // Guard against null appointment_time (legacy rows) to avoid an Invalid Date
  // that makes hoursUntilAppt NaN and silently skips the notice check.
  if (a.appointment_time) {
    const nowDate = new Date();
    const apptDateTime = fromZonedTime(`${a.appointment_date}T${a.appointment_time}`, IST);
    const hoursUntilAppt = (apptDateTime - nowDate) / (1000 * 60 * 60);
    if (!isNaN(hoursUntilAppt) && hoursUntilAppt < 2 && hoursUntilAppt >= 0) {
      await send.text(`⚠️ Cancellations must be made at least 2 hours before the appointment.\n\nYour appointment is in less than 2 hours. Please call the clinic directly.\n\nReply *Hi* to return to main menu.`);
      await updateSession(schema, phone, STATES.IDLE, {});
      return;
    }
  }
  ctx.cancel_appt_id = a.id;
  ctx.cancel_slot_id = a.slot_id;
  ctx.cancel_doctor_id = a.doctor_id;
  ctx.cancel_booking_id = a.booking_id;
  ctx.cancel_doctor_name = a.doctor_name;
  ctx.cancel_date = a.appointment_date;
  ctx.cancel_time = a.appointment_time;
  let cancelDateLabel = a.appointment_date;
  try { cancelDateLabel = format(parseISO(a.appointment_date), 'EEE, d MMM'); } catch {}
  await send.buttons(
    `❌ *Cancel Appointment*\n\n` +
    `Booking: *${a.booking_id}*\n` +
    `👨‍⚕️ Dr. ${a.doctor_name}\n` +
    `📅 ${cancelDateLabel} at ${(a.appointment_time || '').slice(0, 5)}\n\n` +
    `Before we cancel — could you tell us why?`,
    ['Doctor not available', 'Schedule conflict', 'Other reason']
  );
  await updateSession(schema, phone, STATES.CANCEL_REASON, ctx);
}

async function handleCancelReason(phone, schema, tenant, send, ctx, input, buttonId) {
  const reasonMap = { btn_0: 'Doctor not available', btn_1: 'Schedule conflict', btn_2: 'Other' };
  // WhatsApp button IDs include a timestamp suffix (e.g. btn_0_1712345678), so match by prefix
  const matchedKey = Object.keys(reasonMap).find(k => (buttonId || '').startsWith(k + '_') || buttonId === k);
  ctx.cancel_reason = (matchedKey ? reasonMap[matchedKey] : null) || input || 'Not specified';
  let confirmDateLabel = ctx.cancel_date;
  try { confirmDateLabel = format(parseISO(ctx.cancel_date), 'EEE, d MMM'); } catch {}
  await send.buttons(
    `❌ *Confirm Cancellation*\n\n` +
    `Booking: *${ctx.cancel_booking_id}*\n` +
    `👨‍⚕️ Dr. ${ctx.cancel_doctor_name}\n` +
    `📅 ${confirmDateLabel} at ${(ctx.cancel_time || '').slice(0, 5)}\n` +
    `📝 Reason: ${ctx.cancel_reason}\n\n` +
    `This cannot be undone. Are you sure?`,
    ['Yes, Cancel It', 'No, Keep It']
  );
  await updateSession(schema, phone, STATES.CANCEL_CONFIRM, ctx);
}

async function handleCancelConfirm(phone, schema, tenant, send, ctx, choice) {
  if (/yes|cancel|btn_0|^1$/.test(choice)) {
    const cancelled = await tenantTransaction(schema, async (client) => {
      const r = await client.query(
        `UPDATE appointments SET status='cancelled', cancellation_reason=$1, cancelled_by='bot', cancelled_at=NOW(), updated_at=NOW() WHERE id=$2 AND status='confirmed' RETURNING id`,
        [ctx.cancel_reason || null, ctx.cancel_appt_id]);
      // Only release the slot if the appointment was actually cancelled — prevents
      // releasing a slot that now belongs to a different booking (e.g. admin already
      // cancelled and the slot was re-booked by someone else between state transitions).
      if (r.rows.length > 0) {
        await client.query(
          `UPDATE time_slots SET status='available' WHERE id=$1 AND status='booked'`, [ctx.cancel_slot_id]);
        return true;
      }
      return false;
    });
    if (!cancelled) {
      await send.text('⚠️ This appointment has already been cancelled or modified. Reply *Hi* to check your appointments.');
      await updateSession(schema, phone, STATES.IDLE, {});
      return;
    }
    await send.text(
      '✅ *Appointment Cancelled*\n\n' +
      'Your appointment has been cancelled and the slot released.\n\n' +
      'We hope everything is okay. Whenever you\'re ready, reply *Hi* to book again. 🙏'
    );
    // Notify clinic admin via WhatsApp
    (async () => {
      let dateLabel = ctx.cancel_date || '';
      try { dateLabel = format(parseISO(String(ctx.cancel_date).slice(0, 10)), 'EEE, d MMM yyyy'); } catch {}
      await notifyAdminWhatsApp(schema, tenant,
        `❌ *Appointment Cancelled*\n\n` +
        `Booking: *${ctx.cancel_booking_id}*\n` +
        `Patient: ${phone}\n` +
        `Dr. ${ctx.cancel_doctor_name}\n` +
        `📅 ${dateLabel} at ${(ctx.cancel_time || '').slice(0, 5)}\n` +
        `📝 Reason: ${ctx.cancel_reason || 'Not specified'}`
      );
    })().catch(() => {});
  } else {
    await send.text('No worries, your appointment is still on! ✅\n\nReply *Hi* for the main menu.');
  }
  await updateSession(schema, phone, STATES.IDLE, {});
}

module.exports = {
  showMyAppointments,
  handleRescheduleSelect,
  handleRescheduleDate,
  handleRescheduleSlot,
  handleRescheduleConfirm,
  handleCancelSelect,
  handleCancelReason,
  handleCancelConfirm,
};
