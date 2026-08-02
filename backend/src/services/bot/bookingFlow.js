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
  fuzzyFind,
  parseChoiceNumber,
  maskPhone,
  sendConfirmButtons,
  getPatient,
  getPatients,
  updateSession,
  logMessage,
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
    return showDepartments(phone, schema, tenant, send, ctx);
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

  const numChoice = parseChoiceNumber(input);
  const words = (input || '').toLowerCase().split(/\s+/).filter(Boolean);

  const h =
    // 1. Exact UUID match from a list-reply
    hospitalRows.find(r => r.id === choice) ||
    // 2. Button-index match (btn_0, btn_1, btn_2 from buttons widget)
    (/^btn_(\d+)/i.test(choice)
      ? hospitalRows[parseInt(choice.match(/^btn_(\d+)/i)[1], 10)]
      : null) ||
    // 3. Numeric selection ("1", "2", …) — MUST come before name matching.
    //    Branch names commonly contain digits ("Smile Dental - Road No. 2"), so
    //    a substring check ran first turned "2" (meaning branch 2, as the
    //    numbered text fallback instructs) into a match on branch 1.
    (!isNaN(numChoice) && numChoice >= 1 && numChoice <= hospitalRows.length ? hospitalRows[numChoice - 1] : null) ||
    // 4. All typed words present in name ("smile banjara" → "Smile Dental - Banjara Hills")
    (words.length > 1 && hospitalRows.find(r => words.every(w => (r.name || '').toLowerCase().includes(w)))) ||
    // 5. Exact / unique-substring / fuzzy match. fuzzyFind rather than a raw
    //    .includes(): the latter had no length floor, so a single character
    //    selected whichever branch happened to be first.
    fuzzyFind(hospitalRows, input);

  if (!h) {
    // Re-prompt rather than cancelling — user may have mistyped
    await send.text('❓ Branch not found. Please select from the list below:');
    return _sendBranchPicker(phone, schema, tenant, send, ctx, hospitalRows);
  }

  ctx.hospital_id = h.id;
  ctx.hospital_name = h.name;
  return showDepartments(phone, schema, tenant, send, ctx);
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
async function showDepartments(phone, schema, tenant, send, ctx) {
  ctx.visit_type = 'in_person';
  ctx.visit_label = '🦷 In-Clinic Visit';

  const depts = await tenantQuery(schema,
    `SELECT DISTINCT d.id, d.name FROM departments d
     JOIN doctors doc ON doc.department_id=d.id
     WHERE d.hospital_id=$1 AND d.is_active=true AND doc.is_active=true
     ORDER BY d.name`, [ctx.hospital_id]);

  if (!depts.rows.length) {
    await send.text('No treatments available right now. Please contact the clinic directly.\n\nReply *Menu* to start over.');
    await updateSession(schema, phone, STATES.IDLE, {});
    return;
  }

  ctx._depts = depts.rows;

  // Smart-intent shortcut: if detectIntent() recognised a treatment in the
  // user's free text (e.g. "book root canal"), skip the treatment picker and
  // jump straight to dentist selection for that department.
  if (ctx.department_hint) {
    const hinted = fuzzyFind(depts.rows, ctx.department_hint);
    delete ctx.department_hint; // one-shot — never reuse on later messages
    if (hinted) {
      return handleSelectDept(phone, schema, tenant, send, ctx, hinted.id, hinted.name);
    }
  }

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
  const deptNumChoice = parseChoiceNumber(input);
  const dept = depts.find(d => d.id === choice) || fuzzyFind(depts, input)
    || (deptNumChoice >= 1 && deptNumChoice <= depts.length ? depts[deptNumChoice - 1] : null);
  if (!dept) {
    // Same reasoning as dentist selection: an unrecognised or ambiguous reply
    // should re-ask, not discard the booking.
    if (depts.length) {
      await send.list(
        `❓ I couldn't tell which treatment you meant.\n\nPlease pick one from the list:`,
        'View Treatments',
        [{ title: 'Treatments', rows: depts.map(d => ({ id: d.id, title: d.name })) }]
      );
      await updateSession(schema, phone, STATES.SELECT_DEPARTMENT, ctx);
      return;
    }
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
    await send.text(`No dentists available for ${dept.name}.\n\nReply *Menu* to choose another treatment.`);
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
  const docNumChoice = parseChoiceNumber(input);
  const doc = doctors.find(d => d.id === choice) || fuzzyFind(doctors, cleanInput)
    || (docNumChoice >= 1 && docNumChoice <= doctors.length ? doctors[docNumChoice - 1] : null);
  if (!doc) {
    // fuzzyFind deliberately returns null when input is too short or matches
    // more than one dentist, rather than guessing by list order. Re-prompt —
    // throwing the patient back to the main menu made an ambiguous reply cost
    // them the whole booking flow.
    if (doctors.length) {
      await send.list(
        `❓ I couldn't tell which dentist you meant.\n\nPlease pick one from the list:`,
        'View Dentists',
        [{ title: 'Dentists', rows: doctors.map(d => ({
          id: d.id,
          title: `Dr. ${d.name}`,
          description: [d.qualification, d.consultation_fee ? '₹' + d.consultation_fee : ''].filter(Boolean).join(' • '),
        })) }]
      );
      await updateSession(schema, phone, STATES.SELECT_DOCTOR, ctx);
      return;
    }
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
        `Dr. ${doc.name} has no available slots in the next ${SLOT_LOOKAHEAD_DAYS} days, and there are no other dentists available for ${deptLabel} right now.\n\nPlease try again later or contact the clinic directly.\n\nReply *Menu* to go back to the main menu.`
      );
      await updateSession(schema, phone, STATES.IDLE, {});
    }
    return;
  }

  // Cache BEFORE the date_hint shortcut below. handleSelectDate fails closed
  // when _dates is empty (it will not accept a date that was never offered), so
  // calling it with an unpopulated cache made it reject the date this function
  // had just computed — and it returns without updateSession, so the session
  // stayed in select_doctor with date_hint still stored. Every subsequent
  // dentist tap re-entered the same dead end with no list to pick from.
  ctx._dates = dates; // cache for numeric fallback selection

  // Smart-intent shortcut: if detectIntent() recognised a date in the user's
  // free text ("tomorrow", "friday", …) and that date has open slots, skip the
  // date picker and show the time slots directly.
  if (ctx.date_hint) {
    const hintedDate = dates.find(d => d.date === ctx.date_hint);
    delete ctx.date_hint; // one-shot — never reuse on later messages
    if (hintedDate) {
      return handleSelectDate(phone, schema, tenant, send, ctx, hintedDate.date);
    }
    // Hint did not match an offered date — fall through to the picker below.
    // The session write there also persists the date_hint deletion, so the
    // patient is not stuck repeating a hint that can never resolve.
  }

  const sections = [{
    title: 'Available Dates',
    rows: dates.map(d => ({ id: d.date, title: d.label, description: `${d.slots} slots available` }))
  }];
  await send.list(`📅 *Select Date*\n\nAvailable dates for Dr. ${doc.name}:`, 'Choose Date', sections);
  await updateSession(schema, phone, STATES.SELECT_DATE, ctx);
}

// Re-render the offered dates after an answer we could not resolve.
//
// Unrecognised input at this step used to send "❌ Booking cancelled." and wipe
// the context — so typing "tomorrow" at the date list cost the patient the whole
// booking. handleSelectDept and handleSelectDoctor already made the opposite
// call ("should re-ask, not discard the booking"); this matches them.
async function _repromptDates(phone, schema, send, ctx, lead) {
  const cachedDates = ctx._dates || [];
  if (cachedDates.length) {
    await send.list(
      `${lead}\n\nPlease pick a date from the list:`,
      'Choose Date',
      [{ title: 'Available Dates', rows: cachedDates.map(d => ({
        id: d.date, title: d.label, description: `${d.slots} slots available`,
      })) }]
    );
  } else {
    // No cache to re-offer (session resumed after expiry, or a context write was
    // lost). Still don't cancel — "Menu" restarts the picker from the top.
    await send.text(`${lead}\n\nI've lost track of the dates I offered. Reply *Menu* to start again.`);
  }
  await updateSession(schema, phone, STATES.SELECT_DATE, ctx);
}

async function handleSelectDate(phone, schema, tenant, send, ctx, choice) {
  const cachedDates = ctx._dates || [];
  let resolvedDate = choice;
  // Accept numeric input ("1", "2") when list fell back to text
  if (!/^\d{4}-\d{2}-\d{2}$/.test(resolvedDate)) {
    const n = parseChoiceNumber(resolvedDate);
    if (n >= 1 && n <= cachedDates.length) {
      resolvedDate = cachedDates[n - 1].date;
    } else {
      return _repromptDates(phone, schema, send, ctx,
        `❓ I couldn't tell which date you meant.`);
    }
  }
  // Only accept dates from the offered list. The list query excludes doctor
  // leaves and clinic holidays, so a typed arbitrary date skipped those checks
  // entirely and could book a slot on a day the clinic is closed.
  //
  // This check does NOT cover a stale list row tapped after a holiday was
  // declared — the row was legitimately offered, so it is in `_dates` and passes
  // here. Sessions have no TTL and the cleanup cron only purges non-idle ones
  // after 7 days, so that list can be a week old. The re-check on the slot query
  // below (and again on completeBooking's lock) is what closes that hole.
  //
  // Fail CLOSED when the cache is missing (session resumed after expiry, or a
  // context write was lost): `cachedDates.length && ...` used to let any
  // well-formed YYYY-MM-DD through in exactly the situation where we have no
  // idea whether that date is open.
  if (!cachedDates.length || !cachedDates.some(d => d.date === resolvedDate)) {
    return _repromptDates(phone, schema, send, ctx, 'That date is not available.');
  }
  ctx.appointment_date = resolvedDate;

  // Past-slot guard must be a single AND-ed same-day test. The old form
  //   (slot_date > today OR start_time > now::time)
  // is true for ANY past date whose start_time happens to be later in the day
  // than the current clock time, so past slots were offered and then rejected
  // by completeBooking's lock with a misleading "someone just booked that slot".
  //
  // SLOT_DAY_OPEN_SQL re-checks leaves and holidays against the date the patient
  // actually chose. The date list this came from was filtered when it was BUILT;
  // a holiday declared since then does not retroactively edit the cached rows.
  const { SLOT_DAY_OPEN_SQL } = require('../bookingCore');
  const slots = await tenantQuery(schema,
    `SELECT id, start_time, end_time FROM time_slots
     WHERE doctor_id=$1 AND slot_date=$2 AND status='available'
       AND (slot_date > (NOW() AT TIME ZONE 'Asia/Kolkata')::date
            OR (slot_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
                AND start_time > (NOW() AT TIME ZONE 'Asia/Kolkata')::time))
       AND ${SLOT_DAY_OPEN_SQL}
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
      await send.text(`No slots available on that date.\n\n📅 *Next available dates for Dr. ${ctx.doctor_name}:*\n${suggestions}\n\nReply *Menu* to go back and choose a date.`);
    } else {
      await send.text('No slots left for that date. Please select another date.\n\nReply *Menu* to start over.');
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
  const num = parseChoiceNumber(input);
  const slot = slots.find(s => s.id === choice)                             // list reply (ID)
    || slots.find(s => s.start_time.slice(0, 5) === choice || s.start_time.slice(0, 5) === input) // time match (typed or button title)
    || (!isNaN(num) && num >= 1 && num <= slots.length ? slots[num - 1] : null); // typed number
  if (!slot) {
    // Re-ask, don't discard. "10 am" or "morning" typed at the time list used to
    // send "❌ Booking cancelled." and wipe the context — six steps of work lost
    // to one unrecognised word, unlike every other picker in this flow.
    let dateLabel = ctx.appointment_date;
    try { dateLabel = format(parseISO(ctx.appointment_date), 'EEE, d MMM'); } catch {}
    if (slots.length) {
      await send.list(
        `❓ I couldn't tell which time you meant.\n\nPlease pick a slot on ${dateLabel}:`,
        'Choose Time',
        [{ title: `Slots on ${dateLabel}`.slice(0, 24), rows: slots.map(s => ({
          id: s.id, title: `${s.start_time.slice(0, 5)} – ${s.end_time.slice(0, 5)}`,
        })) }]
      );
    } else {
      // Nothing cached to re-offer (session resumed after expiry, or a lost
      // context write) — still not a reason to throw the booking away.
      await send.text(`❓ I've lost track of the times I offered. Reply *Menu* to pick a slot again.`);
    }
    await updateSession(schema, phone, STATES.SELECT_SLOT, ctx);
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

  // Match by patient ID (list reply) or by name.
  // Strict digits only: parseInt('3c1b…') === 3, so a stale list-reply UUID used
  // to resolve to an arbitrary person in this list.
  const typedName = input.replace(/^👤\s*/, '').trim();
  const numChoice = parseChoiceNumber(typedName);
  const selected =
    patients.find(p => p.id === choice) ||
    patients.find(p => (p.name || '').toLowerCase() === typedName.toLowerCase()) ||
    (!isNaN(numChoice) && numChoice >= 1 && numChoice <= patients.length ? patients[numChoice - 1] : null) ||
    // fuzzyFind, not a raw .includes(): family profiles routinely share a
    // surname, and "nita" matches both "Sunita" and "Anita". Booking the wrong
    // family member is worse than asking again, so ambiguity must return null.
    fuzzyFind(patients, typedName);

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

  // sendConfirmButtons binds btn_0/btn_1 to THIS message: a stale "✅ Confirm"
  // tap from an abandoned earlier booking must not book this one (botEngine's
  // CONFIRM_BOOKING branch checks the binding).
  await sendConfirmButtons(send, ctx, summary, ['✅ Confirm', '❌ Cancel']);
  await updateSessionFn(schema, phone, STATES.CONFIRM_BOOKING, ctx);
}

async function completeBooking(phone, schema, tenant, send, ctx) {
  const { LIMITS } = require('../../utils/errors');
  const { insertAppointmentWithRetry, checkMonthlyQuota, SLOT_DAY_OPEN_SQL } = require('../bookingCore');

  // Guard: validate schema name before using it in a raw SET LOCAL command.
  // tenantQuery/tenantTransaction enforce this internally; since completeBooking
  // uses pool.connect() directly for a custom transaction, we must check here too.
  if (!schema || !/^tenant_[a-z0-9_]+$/.test(schema)) {
    logger.error(`completeBooking: invalid schema name "${schema}", aborting booking`);
    await send.text('Something went wrong with your booking. Please try again.\n\nReply *Menu* to start over.');
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
      await send.text(`⚠️ You've made ${LIMITS.MAX_BOOKINGS_PER_HOUR} bookings in the last hour. Please wait before booking again.\n\nReply *Menu* for the main menu.`);
      await updateSession(schema, phone, STATES.IDLE, {});
      return;
    }
  } catch (_) {} // rate limit check is non-fatal

  // Plan quota: block bookings once the clinic's monthly allowance is used up
  const quota = await checkMonthlyQuota(tenant);
  if (!quota.allowed) {
    logger.warn('Monthly appointment quota reached — booking blocked', {
      tenant: tenant.slug, used: quota.used, limit: quota.limit,
    });
    await send.text(
      '⚠️ *Online booking temporarily unavailable*\n\n' +
      'This clinic cannot accept more online bookings right now. ' +
      'Please call the clinic directly to book your appointment.\n\n' +
      'Reply *Menu* for the main menu.'
    );
    await updateSession(schema, phone, STATES.IDLE, {});
    return;
  }

  // Single transaction: patient upsert + slot lock + appointment insert (that
  // order is load-bearing — see the lock-ordering note inside).
  const client = await pool.connect();
  let bookingId;
  let patientId = ctx.patient_id;

  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO "${schema}", public`);

    // Patient row FIRST, slot SECOND — and it must stay that order.
    //
    // The admin walk-in route (POST /appointments) has always taken the patient
    // row before the slot. This function used to take them the other way round,
    // so a bot booking and a walk-in racing on the same patient + same slot each
    // held the lock the other was waiting on: Postgres aborted one with 40P01
    // and the patient saw "Something went wrong with your booking". Both paths
    // now go patients → time_slots → appointments; the appointments-last leg was
    // already consistent everywhere.
    //
    // Nothing leaks if the slot lock below then fails: this INSERT/UPDATE is in
    // the same transaction, and every failure path from here on ROLLBACKs before
    // returning, so the patient row and the visit_count bump are undone together.
    // (`patientId` is left pointing at a row that no longer exists after such a
    // rollback — every one of those paths returns immediately and never uses it.)
    //
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

    // Atomic slot lock. The time predicate re-checks that the slot hasn't
    // passed — a patient can sit on the confirm screen for hours (4h session
    // window) and previously could confirm a slot whose start time had gone by.
    //
    // SLOT_DAY_OPEN_SQL is the last line of defence for a day the clinic closed
    // mid-flow: the date list, the slot list and this confirm screen can all
    // predate the holiday/leave being declared. Failing here costs the patient a
    // re-pick; not failing here books them into a locked clinic.
    const slotUpdate = await client.query(
      `UPDATE time_slots SET status='booked'
       WHERE id=$1 AND status='available'
         AND (slot_date > (NOW() AT TIME ZONE 'Asia/Kolkata')::date
              OR (slot_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
                  AND start_time > (NOW() AT TIME ZONE 'Asia/Kolkata')::time))
         AND ${SLOT_DAY_OPEN_SQL}
       RETURNING id`,
      [ctx.slot_id]);

    if (!slotUpdate.rows.length) {
      // Idempotency check — before we tell the patient "someone else booked
      // it", check whether it was actually THEM. If a prior run of this exact
      // job already committed (transaction succeeded but the process died or
      // the session-reset write failed before the job could be marked done),
      // BullMQ retries with the same stale CONFIRM_BOOKING context and lands
      // back here. The slot is correctly no longer 'available' — but it's our
      // own earlier commit, not a stranger's. Look for a confirmed appointment
      // on this exact slot for this exact phone (must run BEFORE the ROLLBACK
      // below, since search_path is only set for the life of this transaction).
      const existing = await client.query(
        `SELECT a.booking_id FROM appointments a
         JOIN patients p ON p.id = a.patient_id
         WHERE a.slot_id = $1 AND a.status = 'confirmed' AND p.phone = $2
         ORDER BY a.created_at DESC LIMIT 1`,
        [ctx.slot_id, phone]
      );
      // Why the lock failed changes what we should say. A holiday/leave declared
      // while the patient sat on the confirm screen is not a race — telling them
      // "someone just booked that slot" sends them back to pick another time on
      // a day that no longer has any. Checked after the idempotency lookup: an
      // already-committed booking stands regardless of a later closure.
      const dayClosed = existing.rows.length ? { rows: [] } : await client.query(
        `SELECT 1 FROM time_slots WHERE id=$1 AND NOT (${SLOT_DAY_OPEN_SQL}) LIMIT 1`,
        [ctx.slot_id]);
      await client.query('ROLLBACK');
      if (existing.rows.length) {
        await send.text(
          `✅ *Booking Already Confirmed*\n\n` +
          `Looks like this appointment is already booked — no action needed!\n\n` +
          `🪪 Booking ID: *${existing.rows[0].booking_id}*\n\n` +
          `Reply *Menu* for the main menu, or *My Appointments* to view details.`
        );
        await updateSession(schema, phone, STATES.IDLE, {});
        return;
      }
      await send.text(dayClosed.rows.length
        ? '⚠️ *That day is no longer open*\n\n' +
          'The clinic has since closed that date. Please pick another day.\n\n' +
          'Reply *Menu* to go back to the menu.'
        : '⚠️ *Slot no longer available*\n\n' +
          'Someone just booked that slot. Please choose a different time.\n\n' +
          'Reply *Menu* to go back to the menu.'
      );
      await updateSession(schema, phone, STATES.IDLE, {});
      return;
    }

    // Insert with booking-ID collision retry (shared with walk-in/follow-up routes)
    ({ bookingId } = await insertAppointmentWithRetry(client, {
      patientId,
      doctorId: ctx.doctor_id,
      hospitalId: ctx.hospital_id,
      slotId: ctx.slot_id,
      appointmentDate: ctx.appointment_date,
      appointmentTime: ctx.appointment_time,
      visitType: ctx.visit_type || 'in_person',
      notes: ctx.chief_complaint || null,
    }));

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Booking transaction failed', { error: err.message });
    await send.text(
      '⚠️ *Something went wrong*\n\n' +
      'We were unable to complete your booking. Please try again.\n\n' +
      'If this keeps happening, contact the clinic directly.\n\n' +
      'Reply *Menu* to try again.'
    );
    await updateSession(schema, phone, STATES.IDLE, {});
    return;
  } finally {
    client.release();
  }

  // Reset the session to IDLE as the very next statement after commit — this
  // shrinks the window in which a crash (or a failed write here) could leave
  // the session stuck in CONFIRM_BOOKING with stale context, which would make
  // a BullMQ retry re-enter completeBooking for an already-booked slot (see
  // the idempotency check above, which exists precisely to handle that case
  // if this write is ever missed). Wrapped in try/catch so a failure here
  // never prevents the confirmation message below from reaching the patient —
  // the booking itself already committed successfully.
  try {
    await updateSession(schema, phone, STATES.IDLE, {});
  } catch (err) {
    logger.warn('Post-booking session reset failed — will be retried on the patient\'s next message', { phone, error: err.message });
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
        const waMessageId = await wa.sendBookingConfirmationTemplate(phone, {
          bookingId, doctorName: ctx.doctor_name, hospitalName: ctx.hospital_name,
          date: dateLabel, time: (ctx.appointment_time || '').slice(0, 5),
        }, null, null);
        // Log the template send too. This path bypasses the `send.*` helpers in
        // botEngine, which are what normally write to wa_messages — so on the
        // happy path the clinic's message history was missing exactly the
        // message patients ask about most. Carry Meta's id so its delivery
        // receipts have a row to attach to.
        await logMessage(schema, phone, 'out', 'template', confirmationText, waMessageId);
      } catch {
        // Template not approved or Meta error — fall back to session text message
        // (send.text logs to wa_messages itself).
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
          }
        }
        // notifyAdminWhatsApp fans out to every admin with a notify_phone itself,
        // so it must be called ONCE — calling it inside the per-admin loop above
        // sent each admin N copies of the same alert (N admins → N² messages).
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
      } catch (err) {
        logger.warn('Admin booking alert failed', { error: err.message });
      }
    })(),
  ]);

  // Session was already reset to IDLE immediately after commit, above.
  // Masked — logs/combined.log is persistent in production, and the booking id
  // is the identifier anyone reading this line actually needs.
  logger.info(`✅ Booking confirmed: ${bookingId}`, { phone: maskPhone(phone), tenant: tenant.name });
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
