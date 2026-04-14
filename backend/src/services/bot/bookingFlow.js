'use strict';

const { tenantQuery, pool } = require('../../db');
const { format, addDays, parseISO } = require('date-fns');
const { toZonedTime } = require('../../utils/dateTz');
const logger = require('../../utils/logger');

const IST = 'Asia/Kolkata';
const emailService = require('../email');
const wa = require('../whatsapp');
const { SLOT_LOOKAHEAD_DAYS } = require('../../utils/errors');
const {
  STATES,
  genBookingId,
  fuzzyFind,
  getPatient,
  getPatients,
  updateSession,
  notifyAdminWhatsApp,
} = require('./utils');

async function startBooking(phone, schema, tenant, send, ctx) {
  const hospitals = await tenantQuery(schema,
    `SELECT id, name, city FROM hospitals WHERE is_active=true ORDER BY name`);

  if (!hospitals.rows.length) {
    await send.text('No clinics available right now. Please try again later.');
    await updateSession(schema, phone, STATES.IDLE, {});
    return;
  }

  if (hospitals.rows.length === 1) {
    ctx.hospital_id = hospitals.rows[0].id;
    ctx.hospital_name = hospitals.rows[0].name;
    return showDepartments(phone, schema, send, ctx);
  }

  // Multiple branches — show interactive list/buttons so the user taps, not types
  ctx._hospitals = hospitals.rows;

  const prompt = `🏥 *Select a Branch*\n\nWhich ${tenant.name} branch would you like to visit?`;

  if (hospitals.rows.length <= 3) {
    await send.buttons(prompt, hospitals.rows.map(h => h.name.slice(0, 20)));
  } else {
    const sections = [{
      title: 'Our Branches',
      rows: hospitals.rows.map(h => ({
        id: h.id,
        title: h.name.slice(0, 24),
        description: (h.city || '').slice(0, 72),
      })),
    }];
    await send.list(prompt, 'View Branches', sections);
  }
  await updateSession(schema, phone, STATES.SELECT_HOSPITAL, ctx);
}

async function handleSelectHospital(phone, schema, tenant, send, ctx, choice, input) {
  let hospitalRows = ctx._hospitals;
  if (!hospitalRows || !hospitalRows.length) {
    const r = await tenantQuery(schema, `SELECT id, name, city FROM hospitals WHERE is_active=true ORDER BY name`);
    hospitalRows = r.rows;
    ctx._hospitals = hospitalRows;
  }

  // If the user tapped a stale main-menu button while already in SELECT_HOSPITAL,
  // re-send the branch picker rather than trying to match button titles as clinic names.
  if (/book appointment|my appointments|check status/i.test(input)) {
    return _sendBranchPicker(phone, schema, tenant, send, ctx, hospitalRows);
  }

  const numChoice = parseInt(input, 10);
  const words = (input || '').toLowerCase().split(/\s+/).filter(Boolean);

  const h =
    // 1. Exact UUID match from a list-reply
    hospitalRows.find(r => r.id === choice) ||
    // 2. Button-index match (btn_0, btn_1, btn_2 from buttons widget)
    (/^btn_(\d+)/i.test(choice)
      ? hospitalRows[parseInt(choice.match(/^btn_(\d+)/i)[1], 10)]
      : null) ||
    // 3. Case-insensitive substring of the name
    (input && hospitalRows.find(r => (r.name || '').toLowerCase().includes(input.toLowerCase()))) ||
    // 4. All typed words present in name ("smile banjara" → "Smile Dental - Banjara Hills")
    (words.length > 1 && hospitalRows.find(r => words.every(w => (r.name || '').toLowerCase().includes(w)))) ||
    // 5. Levenshtein fuzzy match
    fuzzyFind(hospitalRows, input) ||
    // 6. Numeric selection ("1", "2", …)
    (!isNaN(numChoice) && numChoice >= 1 && numChoice <= hospitalRows.length ? hospitalRows[numChoice - 1] : null);

  if (!h) {
    // Re-prompt rather than cancelling — user may have mistyped
    await send.text('❓ Branch not found. Please select from the list below:');
    return _sendBranchPicker(phone, schema, tenant, send, ctx, hospitalRows);
  }

  ctx.hospital_id = h.id;
  ctx.hospital_name = h.name;
  return showDepartments(phone, schema, send, ctx);
}

// Helper: render the branch picker (buttons or list depending on count)
async function _sendBranchPicker(phone, schema, tenant, send, ctx, hospitalRows) {
  const prompt = `🏥 *Select a Branch*\n\nWhich ${tenant.name} branch would you like to visit?`;
  if (hospitalRows.length <= 3) {
    await send.buttons(prompt, hospitalRows.map(h => h.name.slice(0, 20)));
  } else {
    const sections = [{
      title: 'Our Branches',
      rows: hospitalRows.map(h => ({
        id: h.id,
        title: h.name.slice(0, 24),
        description: (h.city || '').slice(0, 72),
      })),
    }];
    await send.list(prompt, 'View Branches', sections);
  }
  await updateSession(schema, phone, STATES.SELECT_HOSPITAL, ctx);
}

// Dental is always in-person — skip the visit type question and go straight to treatments.
async function showDepartments(phone, schema, send, ctx) {
  ctx.visit_type = 'in_person';
  ctx.visit_label = '🦷 In-Clinic Visit';

  const depts = await tenantQuery(schema,
    `SELECT DISTINCT d.id, d.name FROM departments d
     JOIN doctors doc ON doc.department_id=d.id
     WHERE d.hospital_id=$1 AND d.is_active=true AND doc.is_active=true
     ORDER BY d.name`, [ctx.hospital_id]);

  if (!depts.rows.length) {
    await send.text('No treatments available right now. Please contact the clinic directly.\n\nReply *Hi* to start over.');
    await updateSession(schema, phone, STATES.IDLE, {});
    return;
  }

  ctx._depts = depts.rows;

  if (depts.rows.length <= 3) {
    await send.buttons('🦷 *Select Treatment*\n\nWhat dental treatment do you need?',
      depts.rows.map(d => d.name));
  } else {
    const sections = [{ title: 'Treatments', rows: depts.rows.map(d => ({ id: d.id, title: d.name })) }];
    await send.list('🦷 *Select Treatment*\n\nWhat dental treatment do you need?', 'View Treatments', sections);
  }
  await updateSession(schema, phone, STATES.SELECT_DEPARTMENT, ctx);
}

async function handleSelectDept(phone, schema, tenant, send, ctx, choice, input) {
  let depts = ctx._depts || [];
  // Re-fetch from DB if cache is missing (e.g. session resumed after expiry).
  // Without this, a stale empty _depts leaves the user permanently stuck.
  if (!depts.length && ctx.hospital_id) {
    const r = await tenantQuery(schema,
      `SELECT DISTINCT d.id, d.name FROM departments d
       JOIN doctors doc ON doc.department_id=d.id
       WHERE d.hospital_id=$1 AND d.is_active=true AND doc.is_active=true
       ORDER BY d.name`, [ctx.hospital_id]);
    depts = r.rows;
    ctx._depts = depts;
  }
  const deptNumChoice = parseInt(input);
  const dept = depts.find(d => d.id === choice) || fuzzyFind(depts, input)
    || (deptNumChoice >= 1 && deptNumChoice <= depts.length ? depts[deptNumChoice - 1] : null);
  if (!dept) {
    await send.buttons('❌ Booking cancelled.\n\nWhat would you like to do?',
      ['📅 Book Appointment', '🗓 My Appointments', '📋 Check Status']);
    await updateSession(schema, phone, STATES.MAIN_MENU, {});
    return;
  }

  ctx.department_id = dept.id;
  ctx.department_name = dept.name;

  const doctors = await tenantQuery(schema,
    `SELECT id, name, qualification, consultation_fee FROM doctors
     WHERE department_id=$1 AND hospital_id=$2 AND is_active=true ORDER BY name`,
    [dept.id, ctx.hospital_id]);

  if (!doctors.rows.length) {
    await send.text(`No dentists available for ${dept.name}.\n\nReply *Hi* to choose another treatment.`);
    return;
  }

  ctx._doctors = doctors.rows;

  // Treatment-specific advisory note
  const treatmentNotes = {
    'Root Canal Treatment':    'ℹ️ Root canal treatment typically requires *2–3 visits*. Please plan accordingly.',
    'Dental Implants':         'ℹ️ Implant treatment is a *multi-stage process* spanning several months.',
    'Orthodontics & Braces':   'ℹ️ This is an initial *braces/aligner consultation*. Treatment duration is assessed at first visit.',
    'Oral Surgery':            'ℹ️ Please avoid eating or drinking *4 hours before* oral surgery procedures.',
    'Cosmetic Dentistry':      'ℹ️ Cosmetic procedures may require *multiple visits* for best results.',
    'Pediatric Dentistry':     'ℹ️ A parent or guardian must be present for patients under 18.',
  };
  const note = treatmentNotes[dept.name];
  if (note) await send.text(note);

  if (doctors.rows.length <= 3) {
    await send.buttons(`🦷 *Select Dentist*\n\nAvailable ${dept.name} dentists:`,
      doctors.rows.map(d => `Dr. ${d.name}`));
  } else {
    const sections = [{
      title: `${dept.name} Dentists`,
      rows: doctors.rows.map(d => ({
        id: d.id,
        title: `Dr. ${d.name}`,
        description: [d.qualification, d.consultation_fee ? '₹' + d.consultation_fee : ''].filter(Boolean).join(' • ')
      }))
    }];
    await send.list(`🦷 *Select Dentist*`, 'View Dentists', sections);
  }
  await updateSession(schema, phone, STATES.SELECT_DOCTOR, ctx);
}

async function handleSelectDoctor(phone, schema, tenant, send, ctx, choice, input) {
  const doctors = ctx._doctors || [];
  const cleanInput = input.toLowerCase().replace(/^dr\.?\s*/i, '').trim();
  const docNumChoice = parseInt(input);
  const doc = doctors.find(d => d.id === choice) || fuzzyFind(doctors, cleanInput)
    || (docNumChoice >= 1 && docNumChoice <= doctors.length ? doctors[docNumChoice - 1] : null);
  if (!doc) {
    await send.buttons('❌ Booking cancelled.\n\nWhat would you like to do?',
      ['📅 Book Appointment', '🗓 My Appointments', '📋 Check Status']);
    await updateSession(schema, phone, STATES.MAIN_MENU, {});
    return;
  }

  ctx.doctor_id = doc.id;
  ctx.doctor_name = doc.name;

  // Single query for all available dates (avoids N+1 per-day COUNT loops).
  // Use IST "today" — servers run in UTC so new Date() can be a day behind IST
  // for the 5.5 hours after IST midnight, which would exclude today's slots.
  const nowInIST = toZonedTime(new Date(), IST);
  const todayStr = format(nowInIST, 'yyyy-MM-dd');
  const endStr = format(addDays(nowInIST, SLOT_LOOKAHEAD_DAYS), 'yyyy-MM-dd');

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
      AND NOT EXISTS (
        SELECT 1 FROM clinic_holidays ch
        WHERE ch.holiday_date = slot_date AND (ch.hospital_id = $4 OR ch.hospital_id IS NULL)
      )
    GROUP BY slot_date
    ORDER BY slot_date
    LIMIT 7
  `, [doc.id, todayStr, endStr, ctx.hospital_id]);

  const dates = datesResult.rows.map(r => ({
    date: r.date,
    label: r.date === todayStr ? `Today (${format(nowInIST, 'd MMM')})` : format(parseISO(r.date), 'EEE, d MMM'),
    slots: parseInt(r.slots),
  }));

  if (!dates.length) {
    // Offer other dentists in the same department so the user doesn't have to
    // restart the entire booking flow just to try a different doctor.
    const otherDoctors = doctors.filter(d => d.id !== doc.id);
    if (otherDoctors.length > 0) {
      await send.text(`Dr. ${doc.name} has no available slots in the next ${SLOT_LOOKAHEAD_DAYS} days. Here are other dentists available for ${ctx.department_name}:`);
      if (otherDoctors.length <= 3) {
        await send.buttons('🦷 *Select Dentist*', otherDoctors.map(d => `Dr. ${d.name}`));
      } else {
        const sections = [{
          title: `${ctx.department_name} Dentists`,
          rows: otherDoctors.map(d => ({
            id: d.id,
            title: `Dr. ${d.name}`,
            description: [d.qualification, d.consultation_fee ? '₹' + d.consultation_fee : ''].filter(Boolean).join(' • ')
          })),
        }];
        await send.list('🦷 *Select Dentist*', 'View Dentists', sections);
      }
      await updateSession(schema, phone, STATES.SELECT_DOCTOR, { ...ctx, _doctors: otherDoctors });
    } else {
      // No other doctors in this department — guide user back to menu
      const deptLabel = ctx.department_name || 'this specialty';
      await send.text(
        `Dr. ${doc.name} has no available slots in the next ${SLOT_LOOKAHEAD_DAYS} days, and there are no other dentists available for ${deptLabel} right now.\n\nPlease try again later or contact the clinic directly.\n\nReply *Hi* to go back to the main menu.`
      );
      await updateSession(schema, phone, STATES.IDLE, {});
    }
    return;
  }

  const sections = [{
    title: 'Available Dates',
    rows: dates.map(d => ({ id: d.date, title: d.label, description: `${d.slots} slots available` }))
  }];
  ctx._dates = dates; // cache for numeric fallback selection
  await send.list(`📅 *Select Date*\n\nAvailable dates for Dr. ${doc.name}:`, 'Choose Date', sections);
  await updateSession(schema, phone, STATES.SELECT_DATE, ctx);
}

async function handleSelectDate(phone, schema, tenant, send, ctx, choice) {
  let resolvedDate = choice;
  // Accept numeric input ("1", "2") when list fell back to text
  if (!/^\d{4}-\d{2}-\d{2}$/.test(resolvedDate)) {
    const n = parseInt(resolvedDate);
    const cachedDates = ctx._dates || [];
    if (n >= 1 && n <= cachedDates.length) {
      resolvedDate = cachedDates[n - 1].date;
    } else {
      await send.buttons('❌ Booking cancelled.\n\nWhat would you like to do?',
        ['📅 Book Appointment', '🗓 My Appointments', '📋 Check Status']);
      await updateSession(schema, phone, STATES.MAIN_MENU, {});
      return;
    }
  }
  ctx.appointment_date = resolvedDate;

  const slots = await tenantQuery(schema,
    `SELECT id, start_time, end_time FROM time_slots
     WHERE doctor_id=$1 AND slot_date=$2 AND status='available'
       AND (slot_date > (NOW() AT TIME ZONE 'Asia/Kolkata')::date
            OR start_time > (NOW() AT TIME ZONE 'Asia/Kolkata')::time)
     ORDER BY start_time`,
    [ctx.doctor_id, resolvedDate]);

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
        AND NOT EXISTS (
          SELECT 1 FROM clinic_holidays ch WHERE ch.holiday_date = slot_date AND (ch.hospital_id = $3 OR ch.hospital_id IS NULL)
        )
      GROUP BY slot_date
      ORDER BY slot_date
      LIMIT 3
    `, [ctx.doctor_id, resolvedDate, ctx.hospital_id]);

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

  // WhatsApp list messages are capped at 10 rows per section.
  // Slice here so we never hit the API limit; store only the shown slots in
  // _slots so that numeric text-fallback replies ("1", "2", …) resolve correctly.
  const visibleSlots = slots.rows.slice(0, 10);
  ctx._slots = visibleSlots;

  let dateLabel = resolvedDate;
  try { dateLabel = format(parseISO(resolvedDate), 'EEE, d MMM'); } catch {}

  const sections = [{
    title: `Slots on ${dateLabel}`.slice(0, 24),
    rows: visibleSlots.map(s => ({
      id: s.id,
      title: `${s.start_time.slice(0, 5)} – ${s.end_time.slice(0, 5)}`,
    })),
  }];
  await send.list(`⏰ *Select Time*\n\nAvailable slots on ${dateLabel}:`, 'Choose Time', sections);
  await updateSession(schema, phone, STATES.SELECT_SLOT, ctx);
}

async function handleSelectSlot(phone, schema, tenant, send, ctx, choice, input) {
  const slots = ctx._slots || [];
  const num = parseInt(input, 10);
  const slot = slots.find(s => s.id === choice)                             // list reply (ID)
    || slots.find(s => s.start_time.slice(0, 5) === choice || s.start_time.slice(0, 5) === input) // time match (typed or button title)
    || (!isNaN(num) && num >= 1 && num <= slots.length ? slots[num - 1] : null); // typed number
  if (!slot) {
    await send.buttons('❌ Booking cancelled.\n\nWhat would you like to do?',
      ['📅 Book Appointment', '🗓 My Appointments', '📋 Check Status']);
    await updateSession(schema, phone, STATES.MAIN_MENU, {});
    return;
  }

  ctx.slot_id = slot.id;
  ctx.appointment_time = slot.start_time;

  const patients = await getPatients(schema, phone);
  if (patients.length === 0) {
    // No profiles yet — collect new patient details
    await send.text('👤 *Patient Name*\n\nPlease enter the full name of the patient:');
    await updateSession(schema, phone, STATES.COLLECT_NAME, ctx);
    return;
  }

  // One or more profiles — let the user pick or add a new person
  ctx._patients = patients;
  if (patients.length === 1) {
    await send.buttons(
      `👤 *Who is this appointment for?*`,
      [`👤 ${patients[0].name}`, '➕ Add new person']
    );
  } else {
    const sections = [{
      title: 'Family Members',
      rows: [
        ...patients.map(p => ({ id: p.id, title: p.name, description: p.gender || '' })),
        { id: 'new_patient', title: '➕ Add new person', description: 'Book for someone else' },
      ],
    }];
    await send.list('👨‍👩‍👧 *Who is this appointment for?*\n\nSelect a family member or add a new person:', 'Select Patient', sections);
  }
  await updateSession(schema, phone, STATES.SELECT_PATIENT, ctx);
}

async function handleSelectPatient(phone, schema, send, ctx, choice, input) {
  const patients = ctx._patients || [];

  // "Add new person" — via list reply ID, button title, or typed text
  if (
    choice === 'new_patient' ||
    /^➕|^add new|^new person|^new$/i.test(input) ||
    /^btn_1/i.test(choice)
  ) {
    await send.text('👤 *New Patient Name*\n\nPlease enter the full name of the person being booked:');
    await updateSession(schema, phone, STATES.COLLECT_NAME, ctx);
    return;
  }

  // Match by patient ID (list reply) or by name
  const numChoice = parseInt(input, 10);
  const selected =
    patients.find(p => p.id === choice) ||
    patients.find(p => (p.name || '').toLowerCase() === input.toLowerCase()) ||
    patients.find(p => (p.name || '').toLowerCase().includes(input.toLowerCase().replace(/^👤\s*/, ''))) ||
    (!isNaN(numChoice) && numChoice >= 1 && numChoice <= patients.length ? patients[numChoice - 1] : null);

  if (!selected) {
    await send.text('Please select a person from the options, or tap *Add new person*.');
    return;
  }

  ctx.patient_id = selected.id;
  ctx.patient_name = selected.name;
  return askChiefComplaint(phone, schema, send, ctx);
}

async function askChiefComplaint(phone, schema, send, ctx) {
  await send.buttons(
    '🦷 *Reason for Visit*\n\nWhat brings you in today?',
    ['🚨 Pain / Emergency', '🔍 Checkup / Cleaning', '✨ Cosmetic / Other']
  );
  await updateSession(schema, phone, STATES.COLLECT_CHIEF_COMPLAINT, ctx);
}

async function handleChiefComplaint(phone, schema, send, ctx, choice, input, updateSessionFn) {
  const complaintMap = { btn_0: '🚨 Pain/Emergency', btn_1: '🔍 Checkup/Cleaning', btn_2: '✨ Cosmetic/Other' };
  const matchedKey = Object.keys(complaintMap).find(k =>
    (choice || '').startsWith(k + '_') || choice === k
  );
  ctx.chief_complaint = matchedKey ? complaintMap[matchedKey] : (input || null);
  return showConfirmation(phone, schema, send, ctx, updateSessionFn);
}

async function showConfirmation(phone, schema, send, ctx, updateSessionFn) {
  let dateLabel = ctx.appointment_date;
  try { dateLabel = format(parseISO(ctx.appointment_date), 'EEEE, d MMMM yyyy'); } catch {}
  const time = ctx.appointment_time?.slice(0, 5);

  // Fetch consultation fee if we have a doctor ID
  let feeText = '';
  if (ctx.doctor_id && ctx.hospital_name) {
    try {
      const feeR = await tenantQuery(schema,
        `SELECT consultation_fee FROM doctors WHERE id=$1`, [ctx.doctor_id]);
      const fee = feeR.rows[0]?.consultation_fee;
      if (fee > 0) feeText = `\n💰 Consultation Fee: ₹${fee}`;
    } catch (_) {}
  }

  const complaintLine = ctx.chief_complaint ? `\n📝 *Reason:* ${ctx.chief_complaint}` : '';
  const summary =
    `📋 *Please review your booking*\n\n` +
    `🦷 *Clinic:* ${ctx.hospital_name}\n` +
    `🏷 *Treatment:* ${ctx.department_name}\n` +
    `👨‍⚕️ *Dentist:* Dr. ${ctx.doctor_name}\n` +
    `📅 *Date:* ${dateLabel}\n` +
    `⏰ *Time:* ${time}` +
    feeText +
    complaintLine +
    `\n👤 *Patient:* ${ctx.patient_name}\n\n` +
    `Tap *Confirm* to book your appointment.`;

  await send.buttons(summary, ['✅ Confirm', '❌ Cancel']);
  await updateSessionFn(schema, phone, STATES.CONFIRM_BOOKING, ctx);
}

async function completeBooking(phone, schema, tenant, send, ctx) {
  const { LIMITS } = require('../../utils/errors');

  // Guard: validate schema name before using it in a raw SET LOCAL command.
  // tenantQuery/tenantTransaction enforce this internally; since completeBooking
  // uses pool.connect() directly for a custom transaction, we must check here too.
  if (!schema || !/^tenant_[a-z0-9_]+$/.test(schema)) {
    logger.error(`completeBooking: invalid schema name "${schema}", aborting booking`);
    await send.text('Something went wrong with your booking. Please try again.\n\nReply *Hi* to start over.');
    return;
  }

  // Phone rate limit: max N confirmed bookings per hour (prevents bot flooding)
  try {
    const recentR = await tenantQuery(schema,
      `SELECT COUNT(*) FROM appointments a
       JOIN patients p ON p.id=a.patient_id
       WHERE p.phone=$1 AND a.status='confirmed' AND a.created_at >= NOW() - INTERVAL '1 hour'`,
      [phone]);
    if (parseInt(recentR.rows[0].count) >= LIMITS.MAX_BOOKINGS_PER_HOUR) {
      await send.text(`⚠️ You've made ${LIMITS.MAX_BOOKINGS_PER_HOUR} bookings in the last hour. Please wait before booking again.\n\nReply *Hi* for the main menu.`);
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

    // Insert new patient or increment visit count for existing one.
    // Phone is no longer unique (family booking) so we use a plain INSERT for new profiles.
    if (!patientId) {
      const pr = await client.query(
        `INSERT INTO patients (phone, name, date_of_birth, gender, email, visit_count)
         VALUES ($1,$2,$3,$4,$5,1)
         RETURNING id`,
        [phone, ctx.patient_name, ctx.patient_dob || null, ctx.patient_gender || null, ctx.patient_email || null]);
      patientId = pr.rows[0].id;
    } else {
      await client.query(
        `UPDATE patients SET visit_count=visit_count+1, updated_at=NOW() WHERE id=$1`, [patientId]);
    }

    // Retry up to 3 times on booking_id collision (unique constraint violation)
    let insertAttempts = 0;
    while (true) {
      bookingId = genBookingId();
      try {
        await client.query(
          `INSERT INTO appointments
           (booking_id, patient_id, doctor_id, hospital_id, slot_id, appointment_date, appointment_time, visit_type, status, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'confirmed',$9)`,
          [bookingId, patientId, ctx.doctor_id, ctx.hospital_id, ctx.slot_id,
           ctx.appointment_date, ctx.appointment_time, ctx.visit_type || 'in_person',
           ctx.chief_complaint || null]);
        break; // success
      } catch (insertErr) {
        // 23505 = unique_violation in PostgreSQL
        if (insertErr.code === '23505' && insertErr.constraint?.includes('booking_id') && ++insertAttempts < 4) {
          logger.warn('booking_id collision, retrying', { attempt: insertAttempts });
          continue;
        }
        throw insertErr; // re-throw if not a booking_id collision or max retries exceeded
      }
    }

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

  // Send confirmation and post-transaction side-effects in parallel.
  const confirmationText =
    `🎉 *Appointment Confirmed!*\n\n` +
    `🪪 Booking ID: *${bookingId}*\n` +
    `👨‍⚕️ Dr. ${ctx.doctor_name}\n` +
    `🦷 ${ctx.hospital_name}\n` +
    `📅 ${dateLabel} at ${(ctx.appointment_time || '').slice(0, 5)}\n\n` +
    `🦷 *Before your visit:*\n` +
    `• Arrive 10 minutes early\n` +
    `• Bring any previous dental X-rays or records\n` +
    `• Inform us of any medications or allergies\n` +
    `• Avoid eating 1 hour before the appointment\n\n` +
    `📌 Save your Booking ID to reschedule or cancel.\n` +
    `We'll send you a reminder 24 hours before. See you then! 😊`;

  await Promise.allSettled([
    // Enhancement 12: try approved WhatsApp template first (works outside 24h session window);
    // fall back to regular session message if template is not approved yet.
    (async () => {
      // Shared phone — use global META_* env vars (null → fallback)
      try {
        await wa.sendBookingConfirmationTemplate(phone, {
          bookingId, doctorName: ctx.doctor_name, hospitalName: ctx.hospital_name,
          date: dateLabel, time: (ctx.appointment_time || '').slice(0, 5),
        }, null, null);
      } catch {
        // Template not approved or Meta error — fall back to session text message
        await send.text(confirmationText);
      }
    })(),
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
            patientId,
            schemaName: schema,
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
          `SELECT email, notify_phone FROM users WHERE role = 'admin' AND is_active = true LIMIT 3`);
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
          if (admin.notify_phone) {
            try {
              const { sendAdminBookingAlertSMS } = require('../sms');
              await sendAdminBookingAlertSMS(admin.notify_phone, {
                bookingId,
                patientName: ctx.patient_name,
                doctorName: ctx.doctor_name,
                hospitalName: ctx.hospital_name,
                date: dateLabel3,
                time: ctx.appointment_time?.slice(0, 5),
              });
            } catch (smsErr) {
              logger.warn('Admin SMS alert failed', { error: smsErr.message });
            }
            try {
              await notifyAdminWhatsApp(schema, tenant,
                `🆕 *New Appointment Booked*\n\n` +
                `Booking: *${bookingId}*\n` +
                `Patient: ${ctx.patient_name || phone} · ${phone}\n` +
                `Dr. ${ctx.doctor_name}\n` +
                `📅 ${dateLabel3} at ${(ctx.appointment_time || '').slice(0, 5)}\n` +
                `🦷 ${ctx.hospital_name}\n` +
                `Type: ${ctx.visit_type === 'video' ? 'Video Consultation' : 'In-Clinic'}`
              );
            } catch (waErr) {
              logger.warn('Admin WhatsApp booking alert failed', { error: waErr.message });
            }
          }
        }
      } catch (err) {
        logger.warn('Admin booking alert failed', { error: err.message });
      }
    })(),
  ]);

  await updateSession(schema, phone, STATES.IDLE, {});
  logger.info(`✅ Booking confirmed: ${bookingId}`, { phone, tenant: tenant.name });
  try { require('../../utils/metrics').increment('appointments_booked_total'); } catch (_) {}

  // Publish SSE event so dashboard updates in real-time without polling
  try {
    const { publish } = require('../../routes/events');
    publish(tenant.id, {
      type: 'new_booking',
      payload: {
        bookingId,
        patientName: ctx.patient_name,
        doctorName: ctx.doctor_name,
        hospitalName: ctx.hospital_name,
        date: ctx.appointment_date,
        time: (ctx.appointment_time || '').slice(0, 5),
      },
    }).catch(() => {});
  } catch (_) {}
}

module.exports = {
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
};
