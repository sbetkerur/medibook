'use strict';

const { tenantQuery, pool } = require('../../db');
const { format, addDays, parseISO } = require('date-fns');
const logger = require('../../utils/logger');
const emailService = require('../email');
const { SLOT_LOOKAHEAD_DAYS } = require('../../utils/errors');
const {
  STATES,
  genBookingId,
  fuzzyFind,
  getPatient,
  updateSession,
  notifyWaitlistForDoctor,
} = require('./utils');

async function startBooking(phone, schema, tenant, send, ctx) {
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

  // Single query for all available dates (avoids N+1 per-day COUNT loops)
  const today = new Date();
  const todayStr = format(today, 'yyyy-MM-dd');
  const endStr = format(addDays(today, SLOT_LOOKAHEAD_DAYS), 'yyyy-MM-dd');

  const datesResult = await tenantQuery(schema, `
    SELECT slot_date::text AS date, COUNT(*) AS slots
    FROM time_slots
    WHERE doctor_id = $1
      AND slot_date BETWEEN $2 AND $3
      AND status = 'available'
      AND (
        slot_date > $2
        OR start_time > (NOW() AT TIME ZONE 'Asia/Kolkata')::time
      )
      AND NOT EXISTS (
        SELECT 1 FROM doctor_leaves dl
        WHERE dl.doctor_id = $1 AND dl.leave_date = slot_date
      )
    GROUP BY slot_date
    ORDER BY slot_date
    LIMIT 7
  `, [doc.id, todayStr, endStr]);

  const dates = datesResult.rows.map(r => ({
    date: r.date,
    label: r.date === todayStr ? `Today (${format(today, 'd MMM')})` : format(parseISO(r.date), 'EEE, d MMM'),
    slots: parseInt(r.slots),
  }));

  if (!dates.length) {
    await send.buttons(
      `Dr. ${doc.name} has no available slots in the next ${SLOT_LOOKAHEAD_DAYS} days.\n\n` +
      `🔔 *Join the waiting list* and we'll WhatsApp you the moment a slot opens up — no need to keep checking!`,
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
      `INSERT INTO waiting_list (patient_id, doctor_id, hospital_id) VALUES ($1,$2,$3)
       ON CONFLICT (patient_id, doctor_id) DO NOTHING`,
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
    // Auto-suggest next available dates instead of dead-ending
    const nextDateR = await tenantQuery(schema, `
      SELECT slot_date::text AS date, COUNT(*) AS slots
      FROM time_slots
      WHERE doctor_id = $1
        AND slot_date > $2
        AND status = 'available'
        AND NOT EXISTS (
          SELECT 1 FROM doctor_leaves dl WHERE dl.doctor_id = $1 AND dl.leave_date = slot_date
        )
      GROUP BY slot_date
      ORDER BY slot_date
      LIMIT 3
    `, [ctx.doctor_id, choice]);

    if (nextDateR.rows.length) {
      const suggestions = nextDateR.rows.map(r => {
        let label = r.date;
        try { label = format(parseISO(r.date), 'EEE, d MMM'); } catch {}
        return `• ${label} (${r.slots} slots)`;
      }).join('\n');
      await send.text(`No slots available on that date.\n\n📅 *Next available dates for Dr. ${ctx.doctor_name}:*\n${suggestions}\n\nReply *Hi* to go back and choose a date.`);
    } else {
      await send.text('No slots left for that date. Please select another date.\n\nReply *Hi* to start over.');
    }
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

  // Fetch consultation fee if we have a doctor ID
  let feeText = '';
  if (ctx.doctor_id && ctx.hospital_name) {
    try {
      const { tenantQuery } = require('../../db');
      const feeR = await tenantQuery(schema,
        `SELECT consultation_fee FROM doctors WHERE id=$1`, [ctx.doctor_id]);
      const fee = feeR.rows[0]?.consultation_fee;
      if (fee > 0) feeText = `\n💰 Consultation Fee: ₹${fee}`;
    } catch (_) {}
  }

  const summary =
    `📋 *Please review your booking*\n\n` +
    `🏥 *Hospital:* ${ctx.hospital_name}\n` +
    `🏷 *Specialty:* ${ctx.department_name}\n` +
    `👨‍⚕️ *Doctor:* Dr. ${ctx.doctor_name}\n` +
    `📅 *Date:* ${dateLabel}\n` +
    `⏰ *Time:* ${time}\n` +
    `🩺 *Type:* ${ctx.visit_label}` +
    feeText +
    `\n👤 *Patient:* ${ctx.patient_name}\n\n` +
    `Tap *Confirm* to book your appointment.`;

  await send.buttons(summary, ['✅ Confirm', '❌ Cancel']);
  await updateSessionFn(schema, phone, STATES.CONFIRM_BOOKING, ctx);
}

async function completeBooking(phone, schema, tenant, send, ctx) {
  const { LIMITS } = require('../../utils/errors');
  // Phone rate limit: max N confirmed bookings per hour (prevents bot flooding)
  try {
    const recentR = await tenantQuery(schema,
      `SELECT COUNT(*) FROM appointments a
       JOIN patients p ON p.id=a.patient_id
       WHERE p.phone=$1 AND a.status='confirmed' AND a.created_at >= NOW() - INTERVAL '1 hour'`,
      [phone]);
    if (parseInt(recentR.rows[0].count) >= LIMITS.MAX_BOOKINGS_PER_HOUR) {
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
      await send.text(
        '⚠️ *Slot no longer available*\n\n' +
        'Someone just booked that slot. Please choose a different time.\n\n' +
        'Reply *Hi* to go back to the menu.'
      );
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
    await send.text(
      '⚠️ *Something went wrong*\n\n' +
      'We were unable to complete your booking. Please try again.\n\n' +
      'If this keeps happening, contact the clinic directly.\n\n' +
      'Reply *Hi* to try again.'
    );
    await updateSession(schema, phone, STATES.IDLE, {});
    return;
  } finally {
    client.release();
  }

  let dateLabel = ctx.appointment_date;
  try { dateLabel = format(parseISO(ctx.appointment_date), 'EEE, d MMM yyyy'); } catch {}

  // Send confirmation and post-transaction side-effects in parallel
  await Promise.allSettled([
    send.text(
      `🎉 *Appointment Confirmed!*\n\n` +
      `Your booking is all set. Here are your details:\n\n` +
      `🪪 Booking ID: *${bookingId}*\n` +
      `👨‍⚕️ Dr. ${ctx.doctor_name}\n` +
      `🏥 ${ctx.hospital_name}\n` +
      `📅 ${dateLabel}\n` +
      `⏰ ${ctx.appointment_time.slice(0, 5)}\n\n` +
      `📌 *Please save your Booking ID.* You'll need it to reschedule or cancel.\n\n` +
      `We'll remind you 24 hours before. See you then! 😊`
    ),
    notifyWaitlistForDoctor(schema, ctx.doctor_id, tenant),
    (async () => {
      if (!patientId) return;
      try {
        const patientR = await tenantQuery(schema, `SELECT email FROM patients WHERE id=$1`, [patientId]);
        const patientEmail = patientR.rows[0]?.email;
        if (!patientEmail) return;
        let dateLabel2 = ctx.appointment_date;
        try { dateLabel2 = format(parseISO(ctx.appointment_date), 'EEE, d MMM yyyy'); } catch {}
        await emailService.queueEmail('booking_confirmation', {
          toEmail: patientEmail,
          data: {
            bookingId,
            patientName: ctx.patient_name,
            doctorName: ctx.doctor_name,
            hospitalName: ctx.hospital_name,
            date: dateLabel2,
            time: ctx.appointment_time?.slice(0, 5),
            visitType: ctx.visit_type || 'in_person',
          },
        });
      } catch (emailErr) {
        logger.error('Email confirmation failed', { error: emailErr.message });
      }
    })(),
    (async () => {
      // Notify clinic admins of new booking
      try {
        const adminUsers = await tenantQuery(schema,
          `SELECT email FROM users WHERE role = 'admin' AND is_active = true LIMIT 3`);
        let dateLabel3 = ctx.appointment_date;
        try { dateLabel3 = format(parseISO(ctx.appointment_date), 'EEE, d MMM yyyy'); } catch {}
        for (const admin of adminUsers.rows) {
          await emailService.queueEmail('admin_booking_alert', {
            toEmail: admin.email,
            bookingId,
            patientName: ctx.patient_name,
            doctorName: ctx.doctor_name,
            hospitalName: ctx.hospital_name,
            date: dateLabel3,
            time: ctx.appointment_time?.slice(0, 5),
            visitType: ctx.visit_type || 'in_person',
          });
        }
      } catch (err) {
        logger.warn('Admin booking alert failed', { error: err.message });
      }
    })(),
  ]);

  await updateSession(schema, phone, STATES.IDLE, {});
  logger.info(`✅ Booking confirmed: ${bookingId}`, { phone, tenant: tenant.name });
  try { require('../../utils/metrics').increment('appointments_booked_total'); } catch (_) {}
}

module.exports = {
  startBooking,
  askVisitType,
  handleSelectHospital,
  handleSelectVisitType,
  handleSelectDept,
  handleSelectDoctor,
  handleWaitlistConfirm,
  handleSelectDate,
  handleSelectSlot,
  showConfirmation,
  completeBooking,
};
