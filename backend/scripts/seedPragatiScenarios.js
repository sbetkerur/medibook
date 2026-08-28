'use strict';
/**
 * Clear-and-reseed for Pragati Dental Studio (slug pragati-demo, dev only —
 * prod holds no tenants at all as of writing) — the platform's own
 * public-facing trial clinic (entry code TRYMED). Real prospects poke at it
 * over WhatsApp, so its transactional data accumulates noise over time; this
 * wipes that back to nothing and rebuilds one comprehensive, realistic
 * dataset covering the scenario matrix a demo needs to show off:
 *
 *   - a SECOND branch (Whitefield) and a visiting consultant splitting days
 *     across both, on an alternate-week cadence (doctor_hospitals,
 *     week_of_month, cross-branch slot planning)
 *   - an inactive doctor (left the practice — historical only, never bookable)
 *   - every treatment-plan status: proposed-shaped in_progress (ortho, 4
 *     adjustments done, consent recorded), clinic-scheduled (implants),
 *     completed (single-visit whitening), cancelled (after 1 visit), stalled
 *     (nothing booked, >30d), and "outstanding" (a cancelled VISIT inside an
 *     otherwise live plan)
 *   - payments: full, partial, split across two, and overpaid
 *   - lab work: overdue, received, pending
 *   - recalls: due, booked (a real upcoming slot), dismissed, done
 *   - clinic requests: callback, appointment/grid-full, one already handled
 *   - appointment feedback across a spread of ratings
 *   - a consultation-fee override, and a cross-department booking (a GP
 *     rendering a treatment outside their own primary department, via
 *     doctor_departments)
 *   - edge-case patients: opted-out, dental history/allergies, soft-deleted
 *
 * STRUCTURAL additions (second branch, its departments, the visiting/
 * inactive doctors) are created ONCE, idempotently by name — re-running this
 * does not duplicate them. TRANSACTIONAL data (patients, appointments,
 * treatment courses, payments, lab work, recalls, requests, feedback) is
 * hard-cleared at the start of every run so "populate fresh" actually means
 * fresh, not "on top of whatever was already there".
 *
 *   DATABASE_URL=<dev proxy url> node scripts/seedPragatiScenarios.js
 */
require('dotenv').config();
const { query, tenantQuery, tenantTransaction, pool } = require('../src/db');
const { insertAppointmentWithRetry } = require('../src/services/bookingCore');
const { generateSlotsForDoctor } = require('../src/jobs/slotGenerator');
const { toZonedTime } = require('../src/utils/dateTz');
const { format, subDays, addDays } = require('date-fns');

const SLUG = 'pragati-demo';
const IST = 'Asia/Kolkata';
const PHONE_PREFIX = '91991'; // distinct from seedDemoScenarios.js's 91990*
let phoneSeq = 0;
const nextPhone = () => PHONE_PREFIX + String(++phoneSeq).padStart(5, '0');

const istToday = () => toZonedTime(new Date(), IST);
const log = (...a) => console.log(...a);

async function ensurePatient(schema, { name, phone, gender = 'female', extra = {} }) {
  const cols = ['phone', 'name', 'gender', 'email', 'visit_count', ...Object.keys(extra)];
  const vals = [phone, name, gender, `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.test`, 0, ...Object.values(extra)];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
  const r = await tenantQuery(schema,
    `INSERT INTO patients (${cols.join(',')}) VALUES (${placeholders}) RETURNING *`, vals);
  return r.rows[0];
}

/** A past appointment, optionally tied to a treatment plan visit. slot_id is
 * NULL — the generator only produces future slots, so there's no historical
 * row to point at. */
async function bookPastVisit(schema, { patient, doctor, hospitalId, departmentId, daysAgo, status,
                                        treatmentPlanId, visitNumber, notes, effectiveFee }) {
  const date = format(subDays(istToday(), daysAgo), 'yyyy-MM-dd');
  const time = ['09:30:00', '11:00:00', '15:00:00', '16:30:00'][daysAgo % 4];
  return tenantTransaction(schema, async (client) => {
    const { bookingId, row } = await insertAppointmentWithRetry(client, {
      patientId: patient.id, doctorId: doctor.id, hospitalId: hospitalId || doctor.hospital_id,
      slotId: null, appointmentDate: date, appointmentTime: time,
      visitType: 'in_person', notes: notes || `Scenario fixture — ${status}`,
      departmentId, treatmentPlanId, visitNumber,
    });
    if (status === 'cancelled') {
      await client.query(
        `UPDATE appointments SET status='cancelled', cancelled_at=NOW(), cancelled_by='admin',
           cancellation_reason='Scenario fixture', updated_at=NOW() WHERE id=$1`, [row.id]);
    } else if (status !== 'confirmed') {
      await client.query(`UPDATE appointments SET status=$1, updated_at=NOW() WHERE id=$2`, [status, row.id]);
    }
    if (effectiveFee) {
      await client.query(`UPDATE appointments SET effective_fee=$1 WHERE id=$2`, [effectiveFee, row.id]);
    }
    if (status === 'completed') {
      await client.query(`UPDATE patients SET visit_count = visit_count + 1 WHERE id=$1`, [patient.id]);
    }
    return { bookingId, id: row.id };
  });
}

/** A real future slot, locked the same way the bot books one. */
async function bookUpcoming(schema, { patient, doctor, hospitalId, departmentId, notes }) {
  return tenantTransaction(schema, async (client) => {
    const s = await client.query(`
      UPDATE time_slots SET status='booked'
       WHERE id = (
         SELECT id FROM time_slots
          WHERE doctor_id=$1 AND status='available'
            AND slot_date > (NOW() AT TIME ZONE 'Asia/Kolkata')::date
          ORDER BY slot_date, start_time
          LIMIT 1 FOR UPDATE SKIP LOCKED)
         AND status='available'
       RETURNING id, slot_date, start_time, hospital_id`, [doctor.id]);
    if (!s.rows[0]) return null;
    const slot = s.rows[0];
    const { bookingId, row } = await insertAppointmentWithRetry(client, {
      patientId: patient.id, doctorId: doctor.id, hospitalId: hospitalId || slot.hospital_id || doctor.hospital_id,
      slotId: slot.id, appointmentDate: slot.slot_date, appointmentTime: slot.start_time,
      visitType: 'in_person', notes: notes || 'Scenario fixture — upcoming',
      departmentId,
    });
    return { bookingId, id: row.id, slotDate: slot.slot_date, slotTime: slot.start_time };
  });
}

async function main() {
  const dbHost = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).host : '(unknown)';
  log(`Seeding Pragati Dental Studio scenarios into ${dbHost}\n`);

  const t = (await query(`SELECT id, schema_name FROM tenants WHERE slug=$1`, [SLUG])).rows[0];
  if (!t) { log(`No tenant with slug ${SLUG} found — aborting.`); return; }
  const schema = t.schema_name;

  const admin = (await tenantQuery(schema, `SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1`)).rows[0];
  if (!admin) { log('No admin user found — aborting.'); return; }

  // ── 0. CLEAR every transactional table. Structural setup (hospitals,
  //    departments, doctors, schedules, generated slots) is left alone. ────
  log('Clearing existing transactional data...');
  await tenantQuery(schema, `DELETE FROM appointment_feedback`);
  await tenantQuery(schema, `DELETE FROM treatment_payments`);
  await tenantQuery(schema, `DELETE FROM lab_works`);
  await tenantQuery(schema, `DELETE FROM patient_recalls`);
  await tenantQuery(schema, `DELETE FROM clinic_requests`);
  // Release any slot an existing appointment was holding before deleting it —
  // matters on a re-run against a tenant that has since taken real bookings.
  await tenantQuery(schema, `
    UPDATE time_slots SET status='available'
     WHERE status='booked' AND id IN (SELECT slot_id FROM appointments WHERE slot_id IS NOT NULL)`);
  await tenantQuery(schema, `DELETE FROM appointments`);
  await tenantQuery(schema, `DELETE FROM treatment_plans`);
  await tenantQuery(schema, `DELETE FROM patients`);
  log('  cleared: appointment_feedback, treatment_payments, lab_works, patient_recalls, clinic_requests, appointments, treatment_plans, patients\n');

  // ── STRUCTURE (idempotent — created once, by name) ──────────────────────
  const hospitals = (await tenantQuery(schema, `SELECT * FROM hospitals ORDER BY created_at`)).rows;
  const indiranagar = hospitals.find(h => h.name === 'Pragati Dental Studio');
  if (!indiranagar) { log('Primary branch "Pragati Dental Studio" not found — aborting.'); return; }

  let whitefield = hospitals.find(h => h.name.includes('Whitefield'));
  if (!whitefield) {
    const r = await tenantQuery(schema, `
      INSERT INTO hospitals (name, address, city, phone, is_active)
      VALUES ('Pragati Dental Studio — Whitefield', 'Ground Floor, ITPL Main Road, Whitefield', 'Bengaluru', '+91 7795676143', true)
      RETURNING *`);
    whitefield = r.rows[0];
    log(`  + branch "Pragati Dental Studio — Whitefield"`);
  }

  const depts = (await tenantQuery(schema, `SELECT * FROM departments`)).rows;
  const dept = (hospitalId, name) => depts.find(d => d.hospital_id === hospitalId && d.name === name);
  async function ensureDept(hospitalId, name) {
    let d = dept(hospitalId, name);
    if (d) return d;
    const r = await tenantQuery(schema,
      `INSERT INTO departments (hospital_id, name) VALUES ($1,$2) RETURNING *`, [hospitalId, name]);
    depts.push(r.rows[0]);
    return r.rows[0];
  }
  const implantsDept = await ensureDept(indiranagar.id, 'Dental Implants');
  const oralSurgeryDept = await ensureDept(indiranagar.id, 'Oral Surgery');
  const oralSurgeryDeptWF = await ensureDept(whitefield.id, 'Oral Surgery');
  log(`  + departments: Dental Implants, Oral Surgery (both branches)`);

  const doctors = (await tenantQuery(schema, `SELECT * FROM doctors`)).rows;
  const doc = name => doctors.find(d => d.name === name);
  const ananya = doc('Ananya Rao');   // General Dentist
  const vikram = doc('Vikram Shetty'); // Endodontist
  const nisha = doc('Nisha Menon');   // Orthodontist
  if (!ananya || !vikram || !nisha) { log('Expected doctors not found — aborting.'); return; }

  // Visiting consultant: primary at Indiranagar (Oral Surgery), also sits at
  // Whitefield every 2nd & 4th Tuesday. Exercises doctor_hospitals,
  // week_of_month cadence and the multi-branch slot planner.
  let rakesh = doc('Rakesh Iyer');
  if (!rakesh) {
    const r = await tenantQuery(schema, `
      INSERT INTO doctors (hospital_id, department_id, name, specialization, qualification,
                           consultation_fee, slot_duration_minutes, is_active, online_bookable, is_visiting)
      VALUES ($1,$2,'Rakesh Iyer','Oral Surgeon','BDS, MDS (Oral & Maxillofacial Surgery)',900,45,true,true,true)
      RETURNING *`, [indiranagar.id, oralSurgeryDept.id]);
    rakesh = r.rows[0];
    doctors.push(rakesh);
    log(`  + doctor Rakesh Iyer (visiting: primary Indiranagar, Tue @ Whitefield on weeks 2 & 4)`);
  }
  await tenantQuery(schema, `
    INSERT INTO doctor_departments (doctor_id, department_id) VALUES ($1,$2),($1,$3)
    ON CONFLICT DO NOTHING`, [rakesh.id, oralSurgeryDept.id, oralSurgeryDeptWF.id]);
  for (const dow of [1, 3, 5]) { // Mon/Wed/Fri at the primary branch (NULL = primary)
    await tenantQuery(schema, `
      INSERT INTO doctor_schedules (doctor_id, day_of_week, start_time, end_time, is_working, lunch_start_time, lunch_end_time, hospital_id)
      VALUES ($1,$2,'10:00','17:00',true,'13:00','14:00',NULL)
      ON CONFLICT (doctor_id, day_of_week, start_time) DO UPDATE SET end_time='17:00', is_working=true`,
      [rakesh.id, dow]);
  }
  await tenantQuery(schema, `
    INSERT INTO doctor_schedules (doctor_id, day_of_week, start_time, end_time, is_working, hospital_id, week_of_month)
    VALUES ($1,2,'10:00','17:00',true,$2,'{2,4}')
    ON CONFLICT (doctor_id, day_of_week, start_time) DO UPDATE SET hospital_id=$2, week_of_month='{2,4}'`,
    [rakesh.id, whitefield.id]);
  await tenantQuery(schema, `
    INSERT INTO doctor_hospitals (doctor_id, hospital_id, day_of_week, start_time, end_time)
    VALUES ($1,$2,2,'10:00','17:00') ON CONFLICT DO NOTHING`, [rakesh.id, whitefield.id]);
  const rakeshSlots = await generateSlotsForDoctor(schema, rakesh.id, false, 30);
  log(`    ${rakeshSlots} slots generated for Rakesh Iyer (30-day window, to catch an alternate Tuesday)`);

  // Inactive doctor — left the practice. Must not appear in any active/
  // bookable list, but stays for historical appointment display.
  let suresh = doc('Suresh Kumar (Inactive)');
  if (!suresh) {
    const r = await tenantQuery(schema, `
      INSERT INTO doctors (hospital_id, department_id, name, specialization, qualification,
                           consultation_fee, slot_duration_minutes, is_active, online_bookable)
      VALUES ($1,$2,'Suresh Kumar (Inactive)','General Dentist','BDS',300,30,false,true)
      RETURNING *`, [indiranagar.id, dept(indiranagar.id, 'General Dentistry').id]);
    suresh = r.rows[0];
    log(`  + doctor Suresh Kumar — is_active=false (left the practice, no schedule/slots)`);
  }
  log('');

  // ── EDGE-CASE PATIENTS ───────────────────────────────────────────────────
  const optedOut = await ensurePatient(schema, { name: 'Kavya Reddy', phone: nextPhone(), extra: { opted_out: true } });
  const historyPatient = await ensurePatient(schema, {
    name: 'Rohan Desai', phone: nextPhone(), gender: 'male',
    extra: { dental_history: JSON.stringify({ allergies: ['latex'], notes: 'Anxious patient; prefers detailed explanation before procedures' }) },
  });
  const deletedPatient = await ensurePatient(schema, { name: 'Old Record (Deleted)', phone: nextPhone() });
  await tenantQuery(schema, `UPDATE patients SET deleted_at=NOW() WHERE id=$1`, [deletedPatient.id]);
  log(`  + patients: opted-out (${optedOut.phone}), dental-history (${historyPatient.phone}), soft-deleted (${deletedPatient.phone})`);

  // ── TREATMENT PLANS — one per state/edge case ───────────────────────────
  const orthoPatient = await ensurePatient(schema, { name: 'Meera Iyengar', phone: nextPhone() });
  const stalledPatient = await ensurePatient(schema, { name: 'Arvind Nair', phone: nextPhone(), gender: 'male' });
  const completedPatient = await ensurePatient(schema, { name: 'Divya Kulkarni', phone: nextPhone() });
  const cancelledPatient = await ensurePatient(schema, { name: 'Naveen Gowda', phone: nextPhone(), gender: 'male' });
  const outstandingPatient = await ensurePatient(schema, { name: 'Shalini Bhat', phone: nextPhone() });
  const implantPatient = await ensurePatient(schema, { name: 'Ramesh Pillai', phone: nextPhone(), gender: 'male' });

  async function ensurePlan(title, patient, fields) {
    const cols = ['patient_id', 'hospital_id', 'department_id', 'advised_by_doctor_id', 'treating_doctor_id',
      'title', 'total_visits', 'scheduling_mode', 'estimated_cost', 'status', 'created_by_user_id', ...Object.keys(fields.extra || {})];
    const vals = [patient.id, fields.hospitalId, fields.departmentId, fields.doctorId, fields.doctorId,
      title, fields.totalVisits, fields.schedulingMode || 'patient', fields.estimatedCost, fields.status, admin.id,
      ...Object.values(fields.extra || {})];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
    const r = await tenantQuery(schema,
      `INSERT INTO treatment_plans (${cols.join(',')}) VALUES (${placeholders}) RETURNING *`, vals);
    return r.rows[0];
  }

  // Real orthodontic course, 4 monthly adjustments done, in_progress, consent recorded.
  const orthoPlan = await ensurePlan('Braces — upper & lower', orthoPatient, {
    hospitalId: indiranagar.id, departmentId: dept(indiranagar.id, 'Orthodontics & Braces').id, doctorId: nisha.id,
    totalVisits: 20, estimatedCost: 48000, status: 'in_progress',
    extra: { consent_taken_at: 'NOW()', consent_taken_by: admin.id, consent_note: 'Cost, duration and monthly-visit cadence explained; consent given by patient.' },
  });
  for (let i = 0; i < 4; i++) {
    await bookPastVisit(schema, {
      patient: orthoPatient, doctor: nisha, hospitalId: indiranagar.id, departmentId: orthoPlan.department_id,
      daysAgo: 35 + (3 - i) * 30, status: 'completed', treatmentPlanId: orthoPlan.id, visitNumber: i + 1,
      notes: `Adjustment ${i + 1} of 20`,
    });
  }
  log(`  + treatment plan "Braces — upper & lower" (Meera Iyengar) — in_progress, 4/20 done, consent recorded, last sitting >30d ago (due a nudge)`);

  // Non-ortho CLINIC-scheduled implant course — excluded from the patient
  // bot's treatment list and from the ordinary nudge cadence.
  const implantPlan = await ensurePlan('Implant — #36 with bone graft', implantPatient, {
    hospitalId: indiranagar.id, departmentId: implantsDept.id, doctorId: rakesh.id,
    totalVisits: 3, schedulingMode: 'clinic', estimatedCost: 65000, status: 'in_progress',
  });
  await bookPastVisit(schema, {
    patient: implantPatient, doctor: rakesh, hospitalId: indiranagar.id, departmentId: implantPlan.department_id,
    daysAgo: 10, status: 'completed', treatmentPlanId: implantPlan.id, visitNumber: 1, notes: 'Implant placement',
  });
  log(`  + treatment plan "Implant — #36 with bone graft" (Ramesh Pillai) — scheduling_mode=clinic, 1/3 done`);

  // Single-visit course completed same sitting.
  const completedPlan = await ensurePlan('Teeth whitening', completedPatient, {
    hospitalId: indiranagar.id, departmentId: dept(indiranagar.id, 'Cosmetic Dentistry').id, doctorId: ananya.id,
    totalVisits: 1, estimatedCost: 7500, status: 'completed',
  });
  await bookPastVisit(schema, {
    patient: completedPatient, doctor: ananya, hospitalId: indiranagar.id, departmentId: completedPlan.department_id,
    daysAgo: 6, status: 'completed', treatmentPlanId: completedPlan.id, visitNumber: 1, notes: 'Whitening — single sitting',
  });
  log(`  + treatment plan "Teeth whitening" (Divya Kulkarni) — completed, fully paid below`);

  // Whole course cancelled after 1 visit — terminal, must not reopen.
  const cancelledPlan = await ensurePlan('Full mouth rehabilitation', cancelledPatient, {
    hospitalId: indiranagar.id, departmentId: dept(indiranagar.id, 'General Dentistry').id, doctorId: ananya.id,
    totalVisits: 6, estimatedCost: 85000, status: 'cancelled',
  });
  await bookPastVisit(schema, {
    patient: cancelledPatient, doctor: ananya, hospitalId: indiranagar.id, departmentId: cancelledPlan.department_id,
    daysAgo: 45, status: 'completed', treatmentPlanId: cancelledPlan.id, visitNumber: 1, notes: 'Scaling — visit 1 of 6',
  });
  log(`  + treatment plan "Full mouth rehabilitation" (Naveen Gowda) — cancelled after visit 1, patient declined`);

  // STALLED: work started, nothing booked, last sitting >30 days ago.
  const stalledPlan = await ensurePlan('Root canal — upper left 6', stalledPatient, {
    hospitalId: indiranagar.id, departmentId: dept(indiranagar.id, 'Root Canal Treatment').id, doctorId: vikram.id,
    totalVisits: 3, estimatedCost: 13000, status: 'in_progress',
  });
  await bookPastVisit(schema, {
    patient: stalledPatient, doctor: vikram, hospitalId: indiranagar.id, departmentId: stalledPlan.department_id,
    daysAgo: 40, status: 'completed', treatmentPlanId: stalledPlan.id, visitNumber: 1, notes: 'RCT — access & cleaning, visit 1 of 3',
  });
  log(`  + treatment plan "Root canal — upper left 6" (Arvind Nair) — stalled, ₹4333 outstanding of ₹13000`);

  // OUTSTANDING inside a live plan: visit 2 was booked then cancelled.
  const outstandingPlan = await ensurePlan('Root canal — lower right 7', outstandingPatient, {
    hospitalId: indiranagar.id, departmentId: dept(indiranagar.id, 'Root Canal Treatment').id, doctorId: vikram.id,
    totalVisits: 3, estimatedCost: 13000, status: 'in_progress',
  });
  await bookPastVisit(schema, {
    patient: outstandingPatient, doctor: vikram, hospitalId: indiranagar.id, departmentId: outstandingPlan.department_id,
    daysAgo: 15, status: 'completed', treatmentPlanId: outstandingPlan.id, visitNumber: 1, notes: 'RCT — access & cleaning, visit 1 of 3',
  });
  await bookPastVisit(schema, {
    patient: outstandingPatient, doctor: vikram, hospitalId: indiranagar.id, departmentId: outstandingPlan.department_id,
    daysAgo: 5, status: 'cancelled', treatmentPlanId: outstandingPlan.id, visitNumber: 2, notes: 'RCT — obturation, visit 2 of 3 (patient cancelled)',
  });
  log(`  + treatment plan "Root canal — lower right 7" (Shalini Bhat) — visit 2 cancelled, back on the outstanding queue`);

  // ── PAYMENTS — full, partial, split, overpaid ───────────────────────────
  async function addPayment(planId, amount, method, note) {
    await tenantQuery(schema, `
      INSERT INTO treatment_payments (treatment_plan_id, amount, method, note, collected_by_user_id)
      VALUES ($1,$2,$3,$4,$5)`, [planId, amount, method, note, admin.id]);
  }
  await addPayment(completedPlan.id, 7500, 'upi', 'Scenario: paid in full');
  await addPayment(stalledPlan.id, 4333, 'cash', 'Scenario: part payment, balance outstanding');
  await addPayment(orthoPlan.id, 15000, 'card', 'Scenario: bonding + first two adjustments');
  await addPayment(orthoPlan.id, 4000, 'upi', 'Scenario: adjustment fee');
  await addPayment(cancelledPlan.id, 18000, 'cash', 'Scenario: paid before cancelling — refund pending (overpaid vs revised scope)');
  log(`  + treatment_payments: full (whitening), partial (root canal), split (braces), overpaid (cancelled course)`);

  // ── LAB WORK — overdue, received, pending ───────────────────────────────
  async function addLab(planId, patientId, item, status, extra = {}) {
    const cols = ['treatment_plan_id', 'patient_id', 'lab_name', 'item', 'status', 'created_by_user_id', ...Object.keys(extra)];
    const vals = [planId, patientId, 'Bengaluru Dental Lab', item, status, admin.id, ...Object.values(extra)];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
    await tenantQuery(schema, `INSERT INTO lab_works (${cols.join(',')}) VALUES (${placeholders})`, vals);
  }
  const overdue = format(subDays(istToday(), 3), 'yyyy-MM-dd');
  const soon = format(addDays(istToday(), 4), 'yyyy-MM-dd');
  await addLab(implantPlan.id, implantPatient.id, 'Titanium implant crown — #36', 'sent', { sent_date: subDays(istToday(), 10).toISOString().slice(0, 10), expected_date: overdue });
  await addLab(implantPlan.id, implantPatient.id, 'Surgical guide — #36', 'received', { sent_date: subDays(istToday(), 20).toISOString().slice(0, 10), expected_date: subDays(istToday(), 6).toISOString().slice(0, 10), received_date: subDays(istToday(), 5).toISOString().slice(0, 10) });
  await addLab(orthoPlan.id, orthoPatient.id, 'Retainer (post-debond)', 'pending', { expected_date: soon });
  log(`  + lab_works: overdue (sent, past expected date), received, pending`);

  // ── RECALLS — due, booked, dismissed, done ──────────────────────────────
  const recallDuePatient = await ensurePatient(schema, { name: 'Pooja Shenoy', phone: nextPhone() });
  const recallBookedPatient = await ensurePatient(schema, { name: 'Manish Bhandari', phone: nextPhone(), gender: 'male' });
  const recallDismissedPatient = await ensurePatient(schema, { name: 'Fatima Sheikh', phone: nextPhone() });
  const recallDonePatient = await ensurePatient(schema, { name: 'Ganesh Prasad', phone: nextPhone(), gender: 'male' });

  async function addRecall(patient, status, dueDaysOffset, extra = {}) {
    const dueDate = format(addDays(istToday(), dueDaysOffset), 'yyyy-MM-dd');
    const cols = ['patient_id', 'hospital_id', 'reason', 'due_date', 'status', ...Object.keys(extra)];
    const vals = [patient.id, indiranagar.id, 'Routine 6-month check-up', dueDate, status, ...Object.values(extra)];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
    const r = await tenantQuery(schema, `INSERT INTO patient_recalls (${cols.join(',')}) VALUES (${placeholders}) RETURNING *`, vals);
    return r.rows[0];
  }
  await addRecall(recallDuePatient, 'due', -3);
  const rb = await addRecall(recallBookedPatient, 'booked', -1);
  const booked = await bookUpcoming(schema, { patient: recallBookedPatient, doctor: ananya, hospitalId: indiranagar.id, notes: 'Recall visit' });
  if (booked) await tenantQuery(schema, `UPDATE patient_recalls SET booked_appointment_id=$1 WHERE id=$2`, [booked.id, rb.id]);
  await addRecall(recallDismissedPatient, 'dismissed', -20, { send_count: 3, last_sent_at: subDays(istToday(), 20).toISOString() });
  await addRecall(recallDonePatient, 'done', -60);
  log(`  + patient_recalls: due, booked (with a real upcoming slot), dismissed, done`);

  // ── CLINIC REQUESTS — callback, appointment (grid full), one handled ───
  const callbackPatient = await ensurePatient(schema, { name: 'Suresh Rao', phone: nextPhone(), gender: 'male' });
  const requestPatient = await ensurePatient(schema, { name: 'Anjali Kamath', phone: nextPhone() });
  const handledPatient = await ensurePatient(schema, { name: 'Farooq Ahmed', phone: nextPhone(), gender: 'male' });

  async function addRequest(kind, patient, status, fields = {}) {
    const cols = ['kind', 'phone', 'patient_id', 'patient_name', 'status', ...Object.keys(fields)];
    const vals = [kind, patient.phone, patient.id, patient.name, status, ...Object.values(fields)];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
    const r = await tenantQuery(schema, `INSERT INTO clinic_requests (${cols.join(',')}) VALUES (${placeholders}) RETURNING *`, vals);
    return r.rows[0];
  }
  await addRequest('callback', callbackPatient, 'open');
  await addRequest('appointment', requestPatient, 'open', {
    hospital_id: indiranagar.id, department_id: dept(indiranagar.id, 'Orthodontics & Braces').id, doctor_id: nisha.id,
    preferred_date: format(addDays(istToday(), 2), 'yyyy-MM-dd'), note: 'Wanted Dr. Nisha Menon, that day was fully booked',
  });
  const handled = await addRequest('callback', handledPatient, 'open');
  await tenantQuery(schema,
    `UPDATE clinic_requests SET status='handled', handled_by_user_id=$1, handled_at=NOW() WHERE id=$2`,
    [admin.id, handled.id]);
  log(`  + clinic_requests: callback (open), appointment/grid-full (open), callback (already handled)`);

  // ── FEEDBACK — mix of ratings on real completed visits ─────────────────
  const recentCompleted = (await tenantQuery(schema,
    `SELECT id, patient_id FROM appointments WHERE status='completed' ORDER BY appointment_date DESC LIMIT 4`)).rows;
  const ratings = [5, 4, 2, 5];
  const comments = [
    'Dr. was very gentle, no pain at all. Highly recommend!',
    'Good experience, slight wait time.',
    'Had to wait almost 40 minutes past my slot. Treatment itself was fine.',
    'Excellent service, clean clinic, friendly staff.',
  ];
  for (let i = 0; i < recentCompleted.length; i++) {
    const a = recentCompleted[i];
    await tenantQuery(schema, `
      INSERT INTO appointment_feedback (appointment_id, patient_id, rating, comment)
      VALUES ($1,$2,$3,$4)`, [a.id, a.patient_id, ratings[i], comments[i]]);
  }
  log(`  + appointment_feedback on ${recentCompleted.length} recent completed visits (ratings 5,4,2,5)`);

  // ── FEE OVERRIDE — consultation fee waived/discounted at the desk ──────
  const feeAppt = recentCompleted[0];
  if (feeAppt) {
    await tenantQuery(schema, `UPDATE appointments SET effective_fee=200 WHERE id=$1`, [feeAppt.id]);
    log(`  + effective_fee override (₹200, discounted from list price) on one completed visit`);
  }

  // ── CROSS-DEPARTMENT booking: a GP rendering a treatment outside their
  //    own primary department, via the many-to-many join. ─────────────────
  await tenantQuery(schema, `
    INSERT INTO doctor_departments (doctor_id, department_id) VALUES ($1,$2)
    ON CONFLICT DO NOTHING`, [ananya.id, oralSurgeryDept.id]);
  const crossDeptPatient = await ensurePatient(schema, { name: 'Vinod Chandra', phone: nextPhone(), gender: 'male' });
  await bookPastVisit(schema, {
    patient: crossDeptPatient, doctor: ananya, hospitalId: indiranagar.id,
    departmentId: oralSurgeryDept.id, daysAgo: 4, status: 'completed',
    notes: 'Scenario fixture — cross-department booking (simple extraction)',
  });
  log(`  + cross-department visit: Ananya Rao (General Dentistry) booked FOR Oral Surgery`);

  // ── Book the visiting consultant's alternate-Tuesday slot ──────────────
  const visitingPatient = await ensurePatient(schema, { name: 'Imtiaz Pasha', phone: nextPhone(), gender: 'male' });
  const bookedVisiting = await bookUpcoming(schema, {
    patient: visitingPatient, doctor: rakesh, departmentId: oralSurgeryDeptWF.id,
    notes: 'Scenario fixture — booked with the visiting consultant',
  });
  if (bookedVisiting) {
    log(`  + upcoming visit with Rakesh Iyer (visiting consultant) on ${bookedVisiting.slotDate} ${bookedVisiting.slotTime}`);
  } else {
    log(`  ! no free slot found yet for Rakesh Iyer within the 30-day window — run again after the next alternate Tuesday generates`);
  }

  log('\nDone. Summary:');
  const counts = {};
  for (const tbl of ['hospitals', 'departments', 'patients', 'doctors', 'appointments', 'treatment_plans',
                      'treatment_payments', 'lab_works', 'patient_recalls', 'clinic_requests',
                      'appointment_feedback', 'doctor_hospitals']) {
    counts[tbl] = (await tenantQuery(schema, `SELECT count(*)::int n FROM ${tbl}`)).rows[0].n;
  }
  for (const [k, v] of Object.entries(counts)) log(`  ${k}: ${v}`);
}

(async () => {
  try {
    await main();
  } catch (err) {
    console.error('\nFAILED:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
    process.exit(process.exitCode || 0);
  }
})();
