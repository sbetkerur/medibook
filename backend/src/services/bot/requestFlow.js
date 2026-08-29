'use strict';
/**
 * The two ways a patient can reach the clinic when the bot cannot help them.
 *
 * An Indian dental practice does not run a fixed grid. The receptionist tells
 * four people to come at five, the dentist runs late, and it evens out — the
 * diary is a guide, not a contract. So a bot that answers "no slots available"
 * is refusing a patient the clinic would happily have seen, and the clinic
 * never learns it happened.
 *
 * Both paths end in a `clinic_requests` row and a WhatsApp alert to the admins.
 * Neither promises a time: the point is to hand the patient to a human, which
 * is what they would have done themselves by phoning.
 *
 *  - `appointment` — "the day you want is full, shall we fit you in?"
 *  - `callback`    — "have someone call me", from the main menu or a dead end.
 */
const { tenantQuery } = require('../../db');
const logger = require('../../utils/logger');
const { STATES, updateSession, getPatient, notifyAdminWhatsApp, maskPhone, clinicPhoneLine, isReadOnlyDemo, READ_ONLY_DEMO_MESSAGE } = require('./utils');

// Button ids are matched on the message TEXT as well, because wa.sendButtons
// mints opaque ids and the numbered text fallback (used when an interactive
// send fails) carries only the label.
const REQUEST_RE = /(fit me in|ask the clinic|request an appointment|call me back|callback|call me)/i;

/**
 * Record a request and tell the clinic.
 *
 * `ON CONFLICT DO UPDATE` against the one-open-per-phone-per-kind index: a
 * patient who taps this on three different dates is one person wanting one
 * appointment, not three items on the receptionist's list. The newest details
 * win, so the note reflects what they last asked for.
 */
async function recordRequest(schema, tenant, phone, kind, details = {}, send = null) {
  const patient = await getPatient(schema, phone).catch(() => null);
  try {
    await tenantQuery(schema, `
      INSERT INTO clinic_requests
        (kind, phone, patient_id, patient_name, hospital_id, department_id, doctor_id, preferred_date, note)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (phone, kind) WHERE status='open'
      DO UPDATE SET
        patient_id    = EXCLUDED.patient_id,
        patient_name  = EXCLUDED.patient_name,
        hospital_id   = EXCLUDED.hospital_id,
        department_id = EXCLUDED.department_id,
        doctor_id     = EXCLUDED.doctor_id,
        preferred_date= EXCLUDED.preferred_date,
        note          = EXCLUDED.note,
        created_at    = NOW()
    `, [kind, phone, patient?.id || null, details.patientName || patient?.name || null,
        details.hospitalId || null, details.departmentId || null, details.doctorId || null,
        details.preferredDate || null, details.note || null]);
  } catch (err) {
    // A failure here must not swallow the patient's message — they still get
    // the reply below, and the clinic still gets the WhatsApp alert.
    logger.error('Could not record clinic request', { kind, phone: maskPhone(phone), error: err.message });
  }

  const who = details.patientName || patient?.name || phone;
  const lines = kind === 'callback'
    ? [`📞 *Callback requested*`, `${who} · ${phone}`]
    : [`📋 *Appointment request*`, `${who} · ${phone}`,
       details.doctorName ? `Dr. ${details.doctorName}` : null,
       details.departmentName || null,
       details.preferredDate ? `Wanted: ${details.preferredDate}` : null,
       `Their preferred day had nothing free.`];
  await notifyAdminWhatsApp(schema, tenant,
    [...lines.filter(Boolean), '', 'Open the dashboard to clear it.'].join('\n'),
    { senders: send?._senders });
}

/**
 * Offer the way out. Called wherever the grid dead-ends, and from the menu.
 * `lead` is the reason, so the patient is not asked out of nowhere.
 */
async function offerRequest(send, lead) {
  await send.buttons(
    `${lead}\n\nWould you like us to call you and sort it out?`,
    ['📞 Yes, call me', '🏠 Main Menu'],
    { header: 'We can still help', footer: 'A person will ring you back' }
  );
}

async function handleCallbackRequest(phone, schema, tenant, send, ctx = {}) {
  // Whole-tenant read-only guard — recordRequest below also fires a REAL
  // WhatsApp alert to the clinic's own admin phone, which must never happen
  // for a public demo visitor. See isReadOnlyDemo in bot/utils.js.
  if (isReadOnlyDemo(tenant)) {
    await send.text(READ_ONLY_DEMO_MESSAGE);
    await updateSession(schema, phone, STATES.IDLE, {});
    return;
  }
  await recordRequest(schema, tenant, phone, 'callback', {
    note: ctx.request_note || null,
    hospitalId: ctx.hospital_id || null,
    departmentId: ctx.department_id && ctx.department_id !== 'general_consult' ? ctx.department_id : null,
    doctorId: ctx.doctor_id || null,
    departmentName: ctx.department_name || null,
    doctorName: ctx.doctor_name || null,
  }, send);
  await send.text(
    `Done — we have your number and someone from the clinic will ring you.\n\n` +
    `If it is urgent, please call us instead.` + await clinicPhoneLine(schema, ctx.hospital_id)
  );
  await updateSession(schema, phone, STATES.IDLE, {});
}

/**
 * "The day you wanted is full — shall we fit you in?" Carries whatever the
 * patient had already chosen, so the receptionist rings back knowing which
 * dentist and treatment they were after rather than starting from nothing.
 */
async function handleAppointmentRequest(phone, schema, tenant, send, ctx = {}) {
  // Whole-tenant read-only guard — same reasoning as handleCallbackRequest
  // above: recordRequest also fires a real WhatsApp alert to clinic staff.
  if (isReadOnlyDemo(tenant)) {
    await send.text(READ_ONLY_DEMO_MESSAGE);
    await updateSession(schema, phone, STATES.IDLE, {});
    return;
  }
  await recordRequest(schema, tenant, phone, 'appointment', {
    hospitalId: ctx.hospital_id || null,
    departmentId: ctx.department_id && ctx.department_id !== 'general_consult' ? ctx.department_id : null,
    doctorId: ctx.doctor_id || null,
    departmentName: ctx.department_name || null,
    doctorName: ctx.doctor_name || null,
    preferredDate: ctx.request_preferred_date || null,
    note: ctx.request_note || null,
  }, send);
  await send.text(
    `Thank you — the clinic has your request and will call you to find a time.\n\n` +
    `We often fit people in sooner than the online diary shows.` +
    await clinicPhoneLine(schema, ctx.hospital_id)
  );
  await updateSession(schema, phone, STATES.IDLE, {});
}

module.exports = {
  REQUEST_RE,
  recordRequest,
  offerRequest,
  handleCallbackRequest,
  handleAppointmentRequest,
};
