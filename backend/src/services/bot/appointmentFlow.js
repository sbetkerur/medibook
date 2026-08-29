'use strict';

const { tenantQuery, tenantTransaction } = require('../../db');
const { format, addDays, parseISO } = require('date-fns');
const { fromZonedTime, toZonedTime } = require('../../utils/dateTz');
const logger = require('../../utils/logger');
const { SLOT_LOOKAHEAD_DAYS } = require('../../utils/errors');

const IST = 'Asia/Kolkata';
const {
  STATES,
  parseChoiceNumber,
  maskPhone,
  sendConfirmButtons,
  clinicPhoneLine,
  confirmButtonIndex,
  getPatient,
  getPatients,
  updateSession,
  notifyAdminWhatsApp,
  reminder24hApplies,
  isReadOnlyDemo,
  READ_ONLY_DEMO_MESSAGE,
} = require('./utils');

async function showMyAppointments(phone, schema, tenant, send) {
  // Use getPatients (plural) to support family booking — a single phone number
  // can have multiple patient profiles (e.g. parent booking for child/spouse).
  // The old getPatient (singular) only returned the FIRST profile, so appointments
  // booked for other family members were invisible in this view.
  const patients = await getPatients(schema, phone);
  if (!patients.length) {
    await send.text('We have no appointments under this number yet.\n\nReply *Menu* and tap *Book Appointment* to make your first one.');
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
       WHERE a.patient_id = ANY($1::uuid[])
         AND (a.appointment_date + COALESCE(a.appointment_time, '23:59'::time)) >= timezone('Asia/Kolkata', NOW())
         AND a.status NOT IN ('cancelled')
       ORDER BY a.appointment_date, a.appointment_time
       LIMIT 5`,
      [patientIds]),
    tenantQuery(schema,
      `SELECT a.booking_id, a.appointment_date, a.appointment_time, a.status,
              d.name as doctor_name, p.name as patient_name
       FROM appointments a
       JOIN doctors d ON d.id=a.doctor_id
       JOIN patients p ON p.id=a.patient_id
       WHERE a.patient_id = ANY($1::uuid[])
         AND (a.appointment_date + COALESCE(a.appointment_time, '23:59'::time)) < timezone('Asia/Kolkata', NOW())
       ORDER BY a.appointment_date DESC, a.appointment_time DESC
       LIMIT 3`,
      [patientIds]),
  ]);

  if (!upcomingR.rows.length && !pastR.rows.length) {
    await send.text('You have no appointments with us yet.\n\nReply *Menu* and tap *Book Appointment* to make one.');
    return;
  }

  const statusLabel = (s) => ({ confirmed: '✅ Confirmed', completed: '🏁 Completed', cancelled: '❌ Cancelled', no_show: '⚠️ No Show' }[s] || s);

  let bodyText = '';

  if (upcomingR.rows.length) {
    const upcomingList = upcomingR.rows.map((a, i) => {
      let dt = a.appointment_date;
      try { dt = format(parseISO(a.appointment_date), 'EEE, d MMM'); } catch {}
      // Same shape as the confirmation: WHEN leads, the supporting detail sits
      // under it. Four emoji-prefixed lines per appointment read as an alert,
      // not a list — and the title is now a real header, not bold body text.
      const patientLine = multiplePatients && a.patient_name ? `\n   for ${a.patient_name}` : '';
      return `${i + 1}. *${dt} at ${(a.appointment_time || '').slice(0, 5)}*\n   Dr. ${a.doctor_name} · ${a.booking_id}${patientLine}`;
    }).join('\n\n');
    bodyText += upcomingList;
  } else {
    bodyText += 'You have no upcoming appointments.';
  }

  if (pastR.rows.length) {
    const pastList = pastR.rows.map(a => {
      let dt = a.appointment_date;
      try { dt = format(parseISO(a.appointment_date), 'd MMM yyyy'); } catch {}
      const patientSuffix = multiplePatients && a.patient_name ? ` · ${a.patient_name}` : '';
      return `• *${a.booking_id}* — Dr. ${a.doctor_name}, ${dt} — ${statusLabel(a.status)}${patientSuffix}`;
    }).join('\n');
    bodyText += `\n\n_Past visits_\n${pastList}`;
  }

  // "What would you like to do?" is deleted, not moved: the buttons below ARE
  // the question, and restating it is the filler that makes a bot sound like one.

  const buttons = upcomingR.rows.length
    ? ['🔄 Reschedule', '❌ Cancel Appointment', '🏠 Main Menu']
    : ['🏠 Main Menu'];
  await send.buttons(bodyText, buttons, {
    header: upcomingR.rows.length ? 'Your appointments' : 'Nothing booked',
    footer: 'Reply Menu to start over',
  });
  // Store only the booking ids, not the joined rows. The single consumer
  // (botEngine's MY_APPOINTMENTS branch) asks whether the list is non-empty, and
  // ctx is size-capped: five rows of doctor/hospital/patient names and dates is
  // several hundred bytes of the budget that a large clinic's _hospitals /
  // _depts / _doctors / _dates / _slots caches later need.
  await updateSession(schema, phone, STATES.MY_APPOINTMENTS,
    { _appts: upcomingR.rows.map(a => a.booking_id) });
}

/**
 * "Which one?" — the patient's upcoming CONFIRMED bookings as a TAPPABLE
 * list (radio-button style), not a code to remember and type. Each row's id
 * IS the booking id, so a tap flows straight into handleRescheduleSelect /
 * handleCancelSelect's lookup with no separate id-mapping step — unlike the
 * date/slot lists elsewhere, whose row ids are opaque and get resolved back
 * through a cache. The description carries date, doctor and (when more than
 * one booking shares the phone — family booking) the patient's name, so a
 * tap stays unambiguous.
 *
 * Re-queries rather than trusting a caller's cached ctx._appts: a clinic may
 * have cancelled or completed the booking between the My Appointments list
 * and this tap, and this is also reused by the "reschedule"/"cancel
 * appointment" shortcuts, which never showed a list at all.
 *
 * Returns true when a list was sent (caller should move to the *_SELECT
 * state), false when there was nothing to offer (caller should stay IDLE).
 */
async function sendWhichOne(phone, schema, send, ctx, header) {
  const appts = (await tenantQuery(schema,
    `SELECT a.booking_id, a.appointment_date, a.appointment_time,
            d.name AS doctor_name, p.name AS patient_name
     FROM appointments a
     JOIN doctors d ON d.id = a.doctor_id
     JOIN patients p ON p.id = a.patient_id
     WHERE p.phone=$1 AND p.deleted_at IS NULL AND a.status='confirmed'
       AND (a.appointment_date + COALESCE(a.appointment_time, '23:59'::time)) >= timezone('Asia/Kolkata', NOW())
     ORDER BY a.appointment_date, a.appointment_time
     LIMIT 5`,
    [phone])).rows;

  if (!appts.length) {
    await send.text('You have no appointments we can change right now.\n\nReply *Menu* to go back.');
    return false;
  }

  const multiplePatients = new Set(appts.map(a => a.patient_name)).size > 1;
  const rows = appts.map(a => {
    let dt = a.appointment_date;
    try { dt = format(parseISO(a.appointment_date), 'EEE, d MMM'); } catch {}
    const time = (a.appointment_time || '').slice(0, 5);
    const nameSuffix = multiplePatients && a.patient_name ? ` · ${a.patient_name}` : '';
    return { id: a.booking_id, title: a.booking_id, description: `${dt} ${time} · Dr. ${a.doctor_name}${nameSuffix}` };
  });
  await send.list('Tap the one you mean.', 'Pick a booking', [{ title: 'Your appointments', rows }],
    { header, footer: 'Reply Menu to go back' });
  // Cached in the order sent so a numbered reply ("1", "2", …) still resolves
  // when sendList degrades to its numbered-text fallback (whatsapp.js).
  ctx._select_appts = appts.map(a => a.booking_id);
  return true;
}

/**
 * Resolve a RESCHEDULE_SELECT/CANCEL_SELECT reply to a booking id.
 *
 * Three shapes, in order of trust: a tap on sendWhichOne's list (choice IS
 * the booking id already, verified against what was actually offered); the
 * numbered-text fallback sendList degrades to on failure; and free-typed
 * text — a patient who types the code straight from their confirmation
 * message without ever seeing the list, or answers the no-appointments
 * example prompt.
 */
function resolveBookingIdChoice(ctx, choice, input) {
  const cached = ctx._select_appts || [];
  const tapped = String(choice || '').trim().toUpperCase();
  if (cached.includes(tapped)) return tapped;
  const n = parseChoiceNumber(input);
  if (n >= 1 && n <= cached.length) return cached[n - 1];
  return String(input || '').trim().toUpperCase();
}

async function handleRescheduleSelect(phone, schema, tenant, send, ctx, choice, input) {
  const bookingId = resolveBookingIdChoice(ctx, choice, input);
  // Only allow the patient who owns the booking to reschedule it.
  const appt = await tenantQuery(schema,
    `SELECT a.*, d.name as doctor_name, d.slot_duration_minutes
     FROM appointments a
     JOIN doctors d ON d.id=a.doctor_id
     JOIN patients p ON p.id=a.patient_id
     WHERE a.booking_id=$1 AND a.status='confirmed' AND p.phone=$2`,
    [bookingId, phone]);
  if (!appt.rows[0]) {
    await send.text('Booking ID not found or already cancelled. Please try again.\n\nReply *Menu* to go back.');
    return;
  }
  const a = appt.rows[0];

  // Cap on how many times ONE appointment can be moved. Reschedule is cheap
  // for a patient to tap and expensive for a clinic to absorb — every move
  // holds a slot someone else could have taken while the old one goes back
  // into the pool at the last minute. Past the cap, cancel-and-rebook is a
  // deliberate, visible decision rather than another free tap.
  const { LIMITS } = require('../../utils/errors');
  if ((a.reschedule_count || 0) >= LIMITS.MAX_RESCHEDULES_PER_APPOINTMENT) {
    await send.text(
      `This appointment has already been rescheduled ${LIMITS.MAX_RESCHEDULES_PER_APPOINTMENT} times, which is the most we allow.\n\n` +
      `Please cancel it and book a fresh appointment instead — nothing has changed on this one.\n\n` +
      `Reply *My* to see it and cancel from there.`
    );
    await updateSession(schema, phone, STATES.IDLE, {});
    return;
  }

  // 2-hour minimum notice check — appointment_time is stored in IST; parse it
  // as IST before comparing to the current UTC wall-clock time.
  // Guard against null appointment_time (legacy rows) — skip the check rather
  // than producing an Invalid Date that makes hoursUntilR NaN (always falsy).
  if (a.appointment_time) {
    const nowDateR = new Date();
    const apptDateTimeR = fromZonedTime(`${a.appointment_date}T${a.appointment_time}`, IST);
    const hoursUntilR = (apptDateTimeR - nowDateR) / (1000 * 60 * 60);
    if (!isNaN(hoursUntilR) && hoursUntilR < 2 && hoursUntilR >= 0) {
      await send.text(`Appointments can only be moved up to 2 hours beforehand, and yours is closer than that.\n\nPlease call us — we can still move it for you.\n\nReply *Menu* to go back.`
        + await clinicPhoneLine(schema, a.hospital_id));
      await updateSession(schema, phone, STATES.IDLE, {});
      return;
    }
  }

  // Use IST "today" so the date range is correct during the 5.5-hour window
  // between UTC midnight and IST midnight (new Date() would give yesterday in IST).
  //
  // Starts at TODAY, not tomorrow, and does NOT exclude the appointment's own
  // date — "what about a different time, same day?" is the single most common
  // reschedule ask (mirrors the receptionist's first move on a cancel call, see
  // handleCancelConfirm). The old `slot_date != $4` filter blocked exactly
  // that, with no comment anywhere justifying it; the appointment's own slot
  // is 'booked', not 'available', so it never appears as an offered time
  // anyway, and a day with nothing ELSE free simply produces no GROUP BY row —
  // no separate zero-count check needed.
  const today = toZonedTime(new Date(), IST);
  const startStr = format(today, 'yyyy-MM-dd');
  const endStr = format(addDays(today, SLOT_LOOKAHEAD_DAYS), 'yyyy-MM-dd');

  // Scoped to the appointment's own BRANCH, and the holiday check correlated on
  // the slot's branch — a visiting consultant's slots carry the branch that
  // weekday belongs to, so a doctor-only filter offers dates at the other
  // branch and a reschedule silently relocates the patient's appointment.
  //
  // Same-day guard (slot_date > start OR (slot_date = start AND start_time >
  // now)): with the range now starting today, a same-day reschedule for an
  // appointment later today must not count today's already-elapsed slots.
  const datesResult = await tenantQuery(schema, `
    SELECT slot_date::text AS date, COUNT(*) AS slots
    FROM time_slots
    WHERE doctor_id = $1
      AND hospital_id = $4
      AND slot_date BETWEEN $2 AND $3
      AND status = 'available'
      AND (
        slot_date > $2
        OR start_time > (NOW() AT TIME ZONE 'Asia/Kolkata')::time
      )
      AND NOT EXISTS (
        SELECT 1 FROM doctor_leaves dl WHERE dl.doctor_id = $1 AND dl.leave_date = slot_date
      )
      AND NOT EXISTS (
        SELECT 1 FROM clinic_holidays ch WHERE ch.holiday_date = slot_date
          AND (ch.hospital_id IS NULL OR ch.hospital_id = time_slots.hospital_id)
      )
    GROUP BY slot_date
    ORDER BY slot_date
    LIMIT 7
  `, [a.doctor_id, startStr, endStr, a.hospital_id]);

  const dates = datesResult.rows.map(r => ({
    date: r.date,
    label: format(parseISO(r.date), 'EEE, d MMM'),
    slots: parseInt(r.slots),
  }));
  if (!dates.length) {
    await send.text(`Dr. ${a.doctor_name} has nothing free in the next ${SLOT_LOOKAHEAD_DAYS} days.\n\nPlease call us to move it. Reply *Menu* to go back.`
      + await clinicPhoneLine(schema, a.hospital_id));
    await updateSession(schema, phone, STATES.IDLE, {});
    return;
  }

  ctx.reschedule_appt_id = a.id;
  ctx.reschedule_old_slot_id = a.slot_id;
  ctx.reschedule_doctor_id = a.doctor_id;
  // Carried so the slot query below can scope to the same BRANCH. Without it a
  // visiting consultant's other-branch slots were offered as reschedule options
  // and the appointment's real address changed without anyone saying so.
  ctx.reschedule_hospital_id = a.hospital_id;
  ctx.reschedule_doctor_name = a.doctor_name;
  ctx.reschedule_booking_id = a.booking_id;
  ctx.reschedule_old_date = a.appointment_date;
  ctx.reschedule_old_time = a.appointment_time;
  ctx._reschedule_dates = dates; // cache for numeric text-fallback replies ("1", "2", …)

  const sections = [{
    title: 'Available Dates',
    // Same as the booking date list: a count on every row is noise, and only
    // matters when it is low enough to create urgency.
    rows: dates.map(d => ({
      id: d.date,
      title: d.label,
      ...(d.slots <= 3 ? { description: `Only ${d.slots} left` } : {}),
    }))
  }];
  let oldDate = a.appointment_date;
  try { oldDate = format(parseISO(a.appointment_date), 'd MMM'); } catch {}
  await send.list(
    `Currently *${oldDate} at ${(a.appointment_time || '').slice(0, 5)}* with Dr. ${a.doctor_name}.`,
    'Pick a new day', sections,
    { header: 'Move your appointment', footer: `${a.booking_id} · Reply Menu to keep it` }
  );
  await updateSession(schema, phone, STATES.RESCHEDULE_DATE, ctx);
}

async function handleRescheduleDate(phone, schema, tenant, send, ctx, choice) {
  let resolvedDate = choice;
  // Accept numeric input ("1", "2") when the list message fell back to numbered
  // text (sendList failure path says "Reply with the number of your choice").
  if (!/^\d{4}-\d{2}-\d{2}$/.test(resolvedDate)) {
    const n = parseChoiceNumber(resolvedDate);
    const cachedDates = ctx._reschedule_dates || [];
    if (n >= 1 && n <= cachedDates.length) {
      resolvedDate = cachedDates[n - 1].date;
    } else {
      await send.text('Please pick a date from the list.');
      return;
    }
  }
  // Only accept dates from the offered list — the list query excludes leaves,
  // holidays, the current date and the old appointment's date; a typed
  // arbitrary date skipped all of those checks (including past dates, whose
  // still-'available' slot rows would let the appointment move into the past).
  // Fail CLOSED when the offered-dates cache is missing (session resumed after
  // expiry) — `offeredDates.length && ...` used to accept any well-formed date
  // in exactly the case where we can't verify it against leaves/holidays.
  const offeredDates = ctx._reschedule_dates || [];
  if (!offeredDates.length || !offeredDates.some(d => d.date === resolvedDate)) {
    await send.text('That day is not on offer. Please pick one from the list, or reply *Menu* to start over.');
    return;
  }
  ctx.reschedule_new_date = resolvedDate;
  // Same same-day guard as the booking flow — the offered list starts at
  // tomorrow, but a stale row tapped after midnight can still resolve to today.
  //
  // SLOT_DAY_OPEN_SQL re-checks leaves and holidays too. The list above filtered
  // them when it was BUILT; a holiday declared after that does not edit the rows
  // cached in `_reschedule_dates`, and sessions can sit for days.
  const { SLOT_DAY_OPEN_SQL } = require('../bookingCore');
  // hospital_id is optional here only for sessions started before it was
  // carried; a null falls back to the doctor-wide behaviour rather than
  // matching nothing and dead-ending a reschedule already in progress.
  const slots = await tenantQuery(schema,
    `SELECT id, start_time, end_time FROM time_slots
     WHERE doctor_id=$1 AND slot_date=$2 AND status='available'
       AND ($3::uuid IS NULL OR hospital_id=$3)
       AND (slot_date > (NOW() AT TIME ZONE 'Asia/Kolkata')::date
            OR (slot_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
                AND start_time > (NOW() AT TIME ZONE 'Asia/Kolkata')::time))
       AND ${SLOT_DAY_OPEN_SQL}
     ORDER BY start_time`,
    [ctx.reschedule_doctor_id, resolvedDate, ctx.reschedule_hospital_id || null]);
  if (!slots.rows.length) {
    await send.text('Nothing left on that date. Please pick another.\n\nReply *Menu* to start over.');
    return;
  }
  // Cap at 10 rows — WhatsApp list messages reject more than 10 rows per section.
  const visibleRescheduleSlots = slots.rows.slice(0, 10);
  ctx._reschedule_slots = visibleRescheduleSlots;
  let dateLabel = resolvedDate;
  try { dateLabel = format(parseISO(resolvedDate), 'EEE, d MMM'); } catch {}
  const sections = [{
    title: 'Available Slots',
    rows: visibleRescheduleSlots.map(s => ({
      id: s.id,
      title: `${s.start_time.slice(0, 5)} – ${s.end_time.slice(0, 5)}`,
    }))
  }];
  await send.list(`${dateLabel} — pick whichever suits you.`, 'Pick a time', sections,
    { header: 'What time?', footer: 'Reply Menu to keep your original time' });
  await updateSession(schema, phone, STATES.RESCHEDULE_SLOT, ctx);
}

async function handleRescheduleSlot(phone, schema, tenant, send, ctx, choice, input) {
  const slots = ctx._reschedule_slots || [];
  // Numeric fallback mirrors the booking flow: when sendList degrades to
  // numbered text ("Reply with the number of your choice"), "1"/"2" must work
  // here too — without it this step dead-ended on the text-fallback path.
  const num = parseChoiceNumber(input);
  const slot = slots.find(s =>
    s.id === choice ||
    s.start_time.slice(0, 5) === input ||
    s.start_time.slice(0, 5) === choice
  ) || (num >= 1 && num <= slots.length ? slots[num - 1] : null);
  if (!slot) { await send.text('Please pick a time from the list.'); return; }
  ctx.reschedule_new_slot_id = slot.id;
  ctx.reschedule_new_time = slot.start_time;

  let oldDate = ctx.reschedule_old_date;
  let newDate = ctx.reschedule_new_date;
  try { oldDate = format(parseISO(oldDate), 'EEE, d MMM'); } catch {}
  try { newDate = format(parseISO(newDate), 'EEE, d MMM'); } catch {}

  // sendConfirmButtons, not send.buttons: this prompt moves a real appointment,
  // so the reply must be provably a tap on THESE buttons and not on any of the
  // ones still sitting in the patient's chat history (see bot/utils.js).
  // Old struck through, new in bold: the change is the message, so it leads.
  await sendConfirmButtons(send, ctx,
    `~${oldDate} at ${(ctx.reschedule_old_time || '').slice(0, 5)}~\n` +
    `*${newDate} at ${slot.start_time.slice(0, 5)}*\n\n` +
    `with Dr. ${ctx.reschedule_doctor_name}`,
    ['✅ Yes, Reschedule', '❌ No, Keep Original'],
    { header: 'Move it to here?', footer: 'Your original time is held until you confirm' }
  );
  await updateSession(schema, phone, STATES.RESCHEDULE_CONFIRM, ctx);
}

async function handleRescheduleConfirm(phone, schema, tenant, send, ctx, choice) {
  // A positional button reply we cannot attribute to the prompt above is a tap
  // on an OLD message — most often the "🔄 Reschedule" button of the My
  // Appointments card, which is also btn_0. Re-ask instead of reading it as
  // either answer; a re-render is cheap, a silently moved appointment is not.
  const btnIdx = confirmButtonIndex(ctx, choice);
  if (btnIdx === -1) {
    await sendConfirmButtons(send, ctx,
      `That looks like a tap on an older message.\n\nConfirm the change to your appointment?`,
      ['✅ Yes, Reschedule', '❌ No, Keep Original']
    );
    await updateSession(schema, phone, STATES.RESCHEDULE_CONFIRM, ctx);
    return;
  }
  // Check negative intent FIRST — replies like "no, don't reschedule" contain the
  // word "reschedule" and would otherwise match the positive pattern below.
  // btn_1/btn_0 are matched by index now, not as substrings of the raw id.
  const isNegative = btnIdx === 1 || /\bno\b|\bdon'?t\b|\bdont\b|\bkeep\b|\bnahi\b|^2$/i.test(choice);
  if (!isNegative && (btnIdx === 0 || /^(yes|reschedule|confirm)$|^1$/.test(choice))) {
    // Whole-tenant read-only guard — checked right before the commit, not
    // earlier, so browsing dates/slots up to this point still works. See
    // isReadOnlyDemo in bot/utils.js.
    if (isReadOnlyDemo(tenant)) {
      await send.text(READ_ONLY_DEMO_MESSAGE);
      await updateSession(schema, phone, STATES.IDLE, {});
      return;
    }
    // Atomic: lock appointment row + lock new slot + release old slot + update appointment
    const rescheduled = await tenantTransaction(schema, async (client) => {
      // Lock the appointment and re-check it is still confirmed — an admin may have
      // cancelled/completed it while the patient was mid-flow. Without this guard we
      // would book the new slot and rewrite a cancelled appointment's date, leaving
      // an orphaned 'booked' slot nobody owns.
      const apptCheck = await client.query(
        `SELECT id, slot_id FROM appointments WHERE id=$1 AND status='confirmed' FOR UPDATE`,
        [ctx.reschedule_appt_id]
      );
      if (!apptCheck.rows.length) return 'appt_gone';
      // Re-check the slot hasn't passed, mirroring bookingCore's lock in
      // completeBooking: the patient can sit on this confirm screen for the
      // whole 4-hour session window, and without the time predicate they could
      // move an appointment INTO the past. SLOT_DAY_OPEN_SQL is there for the
      // same reason and for the same window — a holiday or leave declared while
      // this screen was open would otherwise move them onto a closed day.
      const { SLOT_DAY_OPEN_SQL } = require('../bookingCore');
      const lock = await client.query(
        `UPDATE time_slots SET status='booked'
         WHERE id=$1 AND status='available'
           AND (slot_date > (NOW() AT TIME ZONE 'Asia/Kolkata')::date
                OR (slot_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
                    AND start_time > (NOW() AT TIME ZONE 'Asia/Kolkata')::time))
           AND ${SLOT_DAY_OPEN_SQL}
         RETURNING id`,
        [ctx.reschedule_new_slot_id]
      );
      if (!lock.rows.length) return 'slot_taken';
      // Release the slot the appointment CURRENTLY holds (fresh from the locked row),
      // not the possibly-stale one cached in session context.
      const currentSlotId = apptCheck.rows[0].slot_id || ctx.reschedule_old_slot_id;
      if (currentSlotId) {
        await client.query(
          `UPDATE time_slots SET status='available' WHERE id=$1 AND status='booked'`,
          [currentSlotId]
        );
      }
      await client.query(
        `UPDATE appointments SET
           slot_id=$1, appointment_date=$2, appointment_time=$3,
           reminder_24h_sent=false, reschedule_count=reschedule_count+1, updated_at=NOW()
         WHERE id=$4`,
        [ctx.reschedule_new_slot_id, ctx.reschedule_new_date, ctx.reschedule_new_time, ctx.reschedule_appt_id]
      );
      return 'ok';
    });
    if (rescheduled === 'appt_gone') {
      await send.text('That appointment is no longer active — the clinic may have changed or cancelled it.\n\nReply *My* to see where things stand.');
      await updateSession(schema, phone, STATES.IDLE, {});
      return;
    }
    if (rescheduled !== 'ok') {
      await send.text('Someone just took that time.\n\nReply *Menu* to pick another.');
      await updateSession(schema, phone, STATES.IDLE, {});
      return;
    }

    let newDate = ctx.reschedule_new_date;
    try { newDate = format(parseISO(newDate), 'EEE, d MMM yyyy'); } catch {}
    const willRemind = await reminder24hApplies(schema, ctx.reschedule_new_date);
    // Same shape as the booking confirmation — this replaces it in the
    // patient's chat as the message they scroll back to.
    await send.text(
      `✅ *Moved*\n\n` +
      `*${newDate}*\n` +
      `*${(ctx.reschedule_new_time || '').slice(0, 5)}* with Dr. ${ctx.reschedule_doctor_name}\n\n` +
      `Booking ID *${ctx.reschedule_booking_id}*` +
      (willRemind ? `\n\nWe'll remind you the day before.` : '')
    );
    // Masked: logs/combined.log is persistent, and the booking id already
    // identifies the appointment for anyone who needs to look it up.
    logger.info(`Rescheduled: ${ctx.reschedule_booking_id}`, { phone: maskPhone(phone), tenant: tenant.name });
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
        `New: ${newDate} at ${(ctx.reschedule_new_time || '').slice(0, 5)}`,
        { senders: send._senders }
      );
    })().catch(() => {});
  } else {
    await send.text('Kept as it was — nothing has changed.\n\nReply *Menu* for anything else.');
  }
  await updateSession(schema, phone, STATES.IDLE, {});
}

async function handleCancelSelect(phone, schema, tenant, send, ctx, choice, input) {
  const bookingId = resolveBookingIdChoice(ctx, choice, input);
  // Only allow the patient who owns the booking to cancel it.
  const appt = await tenantQuery(schema,
    `SELECT a.*, d.name as doctor_name FROM appointments a
     JOIN doctors d ON d.id=a.doctor_id
     JOIN patients p ON p.id=a.patient_id
     WHERE a.booking_id=$1 AND a.status='confirmed' AND p.phone=$2`,
    [bookingId, phone]);
  if (!appt.rows[0]) {
    await send.text('Booking ID not found or already cancelled. Please try again.\n\nReply *Menu* to go back.');
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
      await send.text(`Appointments can only be cancelled up to 2 hours beforehand, and yours is closer than that.\n\nPlease call us and let us know.\n\nReply *Menu* to go back.`
        + await clinicPhoneLine(schema, a.hospital_id));
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
    `*${cancelDateLabel} at ${(a.appointment_time || '').slice(0, 5)}* with Dr. ${a.doctor_name}\n\n` +
    `Before we cancel — what changed?`,
    ['Doctor not available', 'Schedule conflict', 'Other reason'],
    { header: 'Cancelling this one?', footer: `${a.booking_id} · Reply Menu to keep it` }
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
  // sendConfirmButtons, not send.buttons — "this cannot be undone" must only be
  // answerable by the buttons on THIS message (see bot/utils.js).
  // Moving it comes FIRST, and it is the only non-destructive option on the
  // message. When a patient rings a clinic to cancel, the receptionist says
  // "what about Thursday?" and a good share of them take Thursday — the bot
  // used to automate only the losing half of that conversation. "Schedule
  // conflict" is one of the reasons on the previous screen, which makes the
  // omission plainer still.
  await sendConfirmButtons(send, ctx,
    `*${confirmDateLabel} at ${(ctx.cancel_time || '').slice(0, 5)}* with Dr. ${ctx.cancel_doctor_name}\n\n` +
    `_${ctx.cancel_reason}_\n\n` +
    `If the time is the problem, we can move it instead — you keep your place with Dr. ${ctx.cancel_doctor_name}.`,
    ['📅 Move it instead', 'Yes, cancel it', 'No, keep it'],
    { header: 'Before you cancel', footer: `${ctx.cancel_booking_id} · Nothing changes until you tap` }
  );
  await updateSession(schema, phone, STATES.CANCEL_CONFIRM, ctx);
}

async function handleCancelConfirm(phone, schema, tenant, send, ctx, choice) {
  // A positional button reply that does not belong to the confirm prompt is a
  // stale tap — e.g. the still-live "🔄 Reschedule" (btn_0) from the My
  // Appointments card three steps back, which used to be read as "Yes, Cancel
  // It" and destroyed the booking without the patient ever answering.
  const btnIdx = confirmButtonIndex(ctx, choice);
  if (btnIdx === -1) {
    await sendConfirmButtons(send, ctx,
      `That looks like a tap on an older message.\n\n` +
      `Booking: *${ctx.cancel_booking_id}*\n\nCancelling cannot be undone. Are you sure?`,
      ['📅 Move it instead', 'Yes, cancel it', 'No, keep it']
    );
    await updateSession(schema, phone, STATES.CANCEL_CONFIRM, ctx);
    return;
  }
  // Negative intent is computed FIRST and gates everything below it, including
  // the move. "no, don't reschedule it, don't move it" contains "move" and
  // "reschedul", so testing wantsMove first sent a patient who had just asked
  // to be left alone into the date picker. Same rule as the cancel branch and
  // for the same reason: in a confirm step the negative reading always wins.
  //
  // Indices: 0 is "move it instead", 1 is "yes, cancel", 2 is "keep".
  const isNegative = btnIdx === 2 || /\bno\b|\bdon'?t\b|\bdont\b|\bkeep\b|\bnahi\b|^3$/i.test(choice);

  // The save, checked before the cancel: a patient who taps "Move it instead"
  // has said neither yes nor no to cancelling, and the reschedule flow re-reads
  // the booking from its id, so nothing is destroyed on the way through. Falls
  // back to the cancel prompt if the booking can no longer be moved (inside the
  // 2-hour window, or no free slots), which is the honest outcome rather than a
  // dead end. btn_0 is matched by verified index rather than as a substring.
  //
  // `^1$` matters when sendButtons degrades to numbered text — the very case
  // the fallback exists for. whatsapp.js renders it "1. 📅 Move it instead /
  // 2. Yes, cancel it / 3. No, keep it", and without this a patient replying
  // "1" fell through to "Still on — nothing has changed", the opposite of what
  // they picked, with nothing to tell them so.
  // The button LABELS are accepted as typed text too ("move it instead"), not
  // just the bare verb. WhatsApp keeps the card tappable but people also retype
  // what they see, and an anchored `^(move|reschedule)$` answered them with
  // "Still on — nothing has changed" — the same opposite-of-what-they-picked
  // failure the `^1$` note above describes.
  const wantsMove = !isNegative && (btnIdx === 0 || /^(move|reschedule)\b|^1$/i.test(choice));
  if (wantsMove) {
    await updateSession(schema, phone, STATES.IDLE, {});
    return handleRescheduleSelect(phone, schema, tenant, send, {}, null, ctx.cancel_booking_id);
  }

  // Same widening as wantsMove above: "yes, cancel it" is the button's own
  // label, and an anchored `^(yes|cancel)$` did not match it — so a patient who
  // typed exactly what the button said was told "Still on — nothing has
  // changed" and their appointment stayed on the book. The negative test above
  // still runs FIRST, so "no, keep it" and "yes but keep it" are unaffected.
  if (!isNegative && (btnIdx === 1 || /^(yes|cancel)\b|^2$/i.test(choice))) {
    // Whole-tenant read-only guard — checked right before the commit, not
    // earlier, so picking which booking to cancel still works. See
    // isReadOnlyDemo in bot/utils.js.
    if (isReadOnlyDemo(tenant)) {
      await send.text(READ_ONLY_DEMO_MESSAGE);
      await updateSession(schema, phone, STATES.IDLE, {});
      return;
    }
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
      await send.text('That appointment has already been cancelled or changed.\n\nReply *My* to see where things stand.');
      await updateSession(schema, phone, STATES.IDLE, {});
      return;
    }
    await send.text(
      '✅ *Cancelled*\n\n' +
      'That slot is free again, so someone else can take it.\n\n' +
      'Reply *Menu* whenever you want to book another time.'
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
        `📝 Reason: ${ctx.cancel_reason || 'Not specified'}`,
        { senders: send._senders }
      );
    })().catch(() => {});
  } else {
    await send.text('Still on — nothing has changed.\n\nReply *Menu* for anything else.');
  }
  await updateSession(schema, phone, STATES.IDLE, {});
}

module.exports = {
  showMyAppointments,
  sendWhichOne,
  handleRescheduleSelect,
  handleRescheduleDate,
  handleRescheduleSlot,
  handleRescheduleConfirm,
  handleCancelSelect,
  handleCancelReason,
  handleCancelConfirm,
};
