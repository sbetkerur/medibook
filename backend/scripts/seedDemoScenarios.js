'use strict';
/**
 * Scenario coverage for the demo-clinic tenant (Smile Dental Clinic) —
 * everything the base seed + seedTestData.js don't already exercise:
 * a visiting consultant on a week-of-month cadence, an inactive doctor,
 * every treatment-plan state (proposed/in_progress/completed/declined/
 * cancelled, including a cancelled VISIT inside a live plan — the
 * "outstanding" case), lab work, recalls (due/booked/dismissed/done),
 * clinic requests (callback + appointment, one already handled),
 * appointment feedback, an effective_fee override, opted-out and
 * soft-deleted patients.
 *
 * One-off, like seedTestData.js — not run on boot. Idempotent: every
 * insert is guarded by a "does this already exist" check keyed on a
 * name/title/phone unique to this script, so re-running tops up rather
 * than duplicating.
 *
 *   DATABASE_URL=<dev proxy url> node scripts/seedDemoScenarios.js
 */
require('dotenv').config();
const { query, tenantQuery, tenantTransaction, pool } = require('../src/db');
const { insertAppointmentWithRetry } = require('../src/services/bookingCore');
const { generateSlotsForDoctor } = require('../src/jobs/slotGenerator');
const { toZonedTime } = require('../src/utils/dateTz');
const { format, subDays, addDays } = require('date-fns');

const DEMO_SLUG = 'demo-clinic';
const IST = 'Asia/Kolkata';
const PHONE_PREFIX = '91990'; // scenario patients — distinct from seedTestData.js's 9198000*
let phoneSeq = 0;
const nextPhone = () => PHONE_PREFIX + String(++phoneSeq).padStart(5, '0');

const istToday = () => toZonedTime(new Date(), IST);
const log = (...a) => console.log(...a);

async function ensurePatient(schema, { name, phone, gender = 'female', extra = {} }) {
  const existing = (await tenantQuery(schema, `SELECT * FROM patients WHERE phone=$1`, [phone])).rows[0];
  if (existing) return existing;
  const cols = ['phone', 'name', 'gender', 'email', 'visit_count', ...Object.keys(extra)];
  const vals = [phone, name, gender, `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.test`, 0, ...Object.values(extra)];
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
  const r = await tenantQuery(schema,
    `INSERT INTO patients (${cols.join(',')}) VALUES (${placeholders}) RETURNING *`, vals);
  return r.rows[0];
}

/** A past appointment, optionally tied to a treatment plan visit. slot_id is
 * NULL — same reasoning as seedTestData.js: the generator only produces
 * future slots, so there's no historical row to point at. */
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
async function bookUpcoming(schema, { patient, doctor, hospitalId, departmentId, treatmentPlanId, visitNumber, notes }) {
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
      departmentId, treatmentPlanId, visitNumber,
    });
    return { bookingId, id: row.id, slotDate: slot.slot_date, slotTime: slot.start_time };
  });
}

async function main() {
  const dbHost = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).host : '(unknown)';
  log(`Seeding demo-clinic scenarios into ${dbHost}\n`);

  const t = (await query(`SELECT id, schema_name FROM tenants WHERE slug=$1`, [DEMO_SLUG])).rows[0];
  if (!t) { log(`No tenant with slug ${DEMO_SLUG} found — aborting.`); return; }
  const schema = t.schema_name;

  const admin = (await tenantQuery(schema, `SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1`)).rows[0];
  const hospitals = (await tenantQuery(schema, `SELECT * FROM hospitals ORDER BY name`)).rows;
  const banjara = hospitals.find(h => h.name.includes('Banjara'));
  const kphb = hospitals.find(h => h.name.includes('KPHB'));
  const depts = (await tenantQuery(schema, `SELECT * FROM departments`)).rows;
  const dept = (hospitalId, name) => depts.find(d => d.hospital_id === hospitalId && d.name === name);
  const doctors = (await tenantQuery(schema, `SELECT * FROM doctors`)).rows;
  const doc = name => doctors.find(d => d.name === name);

  // ── 1. Visiting consultant: primary at Banjara (Orthodontics), also sits
  //    at KPHB every 2nd & 4th Tuesday. Exercises doctor_hospitals,
  //    week_of_month cadence and the multi-branch slot planner. ────────────
  let kiran = doc('Kiran Bhat');
  if (!kiran) {
    const r = await tenantQuery(schema, `
      INSERT INTO doctors (hospital_id, department_id, name, specialization, qualification,
                           consultation_fee, slot_duration_minutes, is_active, online_bookable, is_visiting)
      VALUES ($1,$2,'Kiran Bhat','Orthodontist','BDS, MDS (Orthodontics)',600,45,true,true,true)
      RETURNING *`, [banjara.id, dept(banjara.id, 'Orthodontics & Braces').id]);
    kiran = r.rows[0];
    doctors.push(kiran);
    log(`  + doctor Kiran Bhat (visiting: primary Banjara Hills, Tue @ KPHB on weeks 2 & 4)`);
  }
  await tenantQuery(schema, `
    INSERT INTO doctor_departments (doctor_id, department_id) VALUES ($1,$2),($1,$3)
    ON CONFLICT DO NOTHING`,
    [kiran.id, dept(banjara.id, 'Orthodontics & Braces').id, dept(kphb.id, 'Orthodontics & Braces').id]);
  // Mon/Wed/Fri at the primary branch (hospital_id NULL = primary, per the
  // doctor_hospitals fallback rule).
  for (const dow of [1, 3, 5]) {
    await tenantQuery(schema, `
      INSERT INTO doctor_schedules (doctor_id, day_of_week, start_time, end_time, is_working, lunch_start_time, lunch_end_time, hospital_id)
      VALUES ($1,$2,'10:00','17:00',true,'13:00','14:00',NULL)
      ON CONFLICT (doctor_id, day_of_week, start_time) DO UPDATE SET end_time='17:00', is_working=true`,
      [kiran.id, dow]);
  }
  // Tuesday at KPHB, alternate weeks only.
  await tenantQuery(schema, `
    INSERT INTO doctor_schedules (doctor_id, day_of_week, start_time, end_time, is_working, hospital_id, week_of_month)
    VALUES ($1,2,'10:00','17:00',true,$2,'{2,4}')
    ON CONFLICT (doctor_id, day_of_week, start_time) DO UPDATE SET hospital_id=$2, week_of_month='{2,4}'`,
    [kiran.id, kphb.id]);
  await tenantQuery(schema, `
    INSERT INTO doctor_hospitals (doctor_id, hospital_id, day_of_week, start_time, end_time)
    VALUES ($1,$2,2,'10:00','17:00') ON CONFLICT DO NOTHING`, [kiran.id, kphb.id]);
  const kiranSlots = await generateSlotsForDoctor(schema, kiran.id, false, 30);
  log(`    ${kiranSlots} slots generated (30-day window, to catch an alternate Tuesday)`);

  // ── 2. Inactive doctor — left the practice. Must not appear in any
  //    active/bookable list, but stays for historical appointment display. ──
  let ramesh = doc('Ramesh Iyer (Inactive)');
  if (!ramesh) {
    const r = await tenantQuery(schema, `
      INSERT INTO doctors (hospital_id, department_id, name, specialization, qualification,
                           consultation_fee, slot_duration_minutes, is_active, online_bookable)
      VALUES ($1,$2,'Ramesh Iyer (Inactive)','General Dentist','BDS',300,30,false,true)
      RETURNING *`, [banjara.id, dept(banjara.id, 'General Dentistry').id]);
    ramesh = r.rows[0];
    log(`  + doctor Ramesh Iyer — is_active=false (left the practice, no schedule/slots)`);
  }

  // ── 3. Edge-case patients ────────────────────────────────────────────────
  const optedOut = await ensurePatient(schema, { name: 'Geeta Rani', phone: nextPhone(), extra: { opted_out: true } });
  const historyPatient = await ensurePatient(schema, {
    name: 'Manoj Trivedi', phone: nextPhone(), gender: 'male',
    extra: { dental_history: JSON.stringify({ allergies: ['penicillin'], notes: 'Sensitive to cold; prefers evening slots' }) },
  });
  const deletedPatient = await ensurePatient(schema, { name: 'Old Record (Deleted)', phone: nextPhone() });
  await tenantQuery(schema, `UPDATE patients SET deleted_at=NOW() WHERE id=$1 AND deleted_at IS NULL`, [deletedPatient.id]);
  log(`  + patients: opted-out (${optedOut.phone}), dental-history (${historyPatient.phone}), soft-deleted (${deletedPatient.phone})`);

  // ── 4. Treatment plans — one per state/edge case ────────────────────────
  const orthoPatient = await ensurePatient(schema, { name: 'Ayesha Khan', phone: nextPhone() });
  const stalledPatient = await ensurePatient(schema, { name: 'Vikram Solanki', phone: nextPhone(), gender: 'male' });
  const completedPatient = await ensurePatient(schema, { name: 'Ritu Malhotra', phone: nextPhone() });
  const cancelledPatient = await ensurePatient(schema, { name: 'Farhan Ali', phone: nextPhone(), gender: 'male' });
  const outstandingPatient = await ensurePatient(schema, { name: 'Om Prakash', phone: nextPhone(), gender: 'male' });
  const labPatient = await ensurePatient(schema, { name: 'Deepa Nathan', phone: nextPhone() });

  async function ensurePlan(title, patient, fields) {
    const existing = (await tenantQuery(schema,
      `SELECT * FROM treatment_plans WHERE title=$1 AND patient_id=$2`, [title, patient.id])).rows[0];
    if (existing) return existing;
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

  // 4a. Real orthodontic course (department name matches isOrthodonticDepartment),
  //     4 monthly adjustments done, in_progress, consent recorded.
  const preethi = doc('Preethi Nair');
  const orthoPlan = await ensurePlan('Braces — upper & lower', orthoPatient, {
    hospitalId: banjara.id, departmentId: dept(banjara.id, 'Orthodontics & Braces').id, doctorId: preethi.id,
    totalVisits: 20, estimatedCost: 45000, status: 'in_progress',
    extra: { consent_taken_at: 'NOW()', consent_taken_by: admin.id, consent_note: 'Cost, duration and monthly-visit cadence explained; consent given by patient.' },
  });
  if (orthoPlan.status === 'proposed') { /* already inserted as in_progress above when new */ }
  const orthoVisits = (await tenantQuery(schema, `SELECT count(*)::int n FROM appointments WHERE treatment_plan_id=$1`, [orthoPlan.id])).rows[0].n;
  if (orthoVisits === 0) {
    for (let i = 0; i < 4; i++) {
      await bookPastVisit(schema, {
        patient: orthoPatient, doctor: preethi, hospitalId: banjara.id, departmentId: orthoPlan.department_id,
        daysAgo: 35 + (3 - i) * 30, status: 'completed', treatmentPlanId: orthoPlan.id, visitNumber: i + 1,
        notes: `Adjustment ${i + 1} of 20`,
      });
    }
    log(`  + treatment plan "Braces — upper & lower" (Ayesha Khan) — in_progress, 4/20 done, consent recorded, last sitting >30d ago (due a nudge)`);
  }

  // 4b. Non-ortho CLINIC-scheduled course — excluded from the patient bot's
  //     treatment list and from the ordinary nudge cadence.
  const rohit = doc('Rohit Malhotra');
  const clinicPlan = await ensurePlan('Post-implant review course', labPatient, {
    hospitalId: banjara.id, departmentId: dept(banjara.id, 'Dental Implants').id, doctorId: rohit.id,
    totalVisits: 3, schedulingMode: 'clinic', estimatedCost: 60000, status: 'in_progress',
  });
  const clinicVisits = (await tenantQuery(schema, `SELECT count(*)::int n FROM appointments WHERE treatment_plan_id=$1`, [clinicPlan.id])).rows[0].n;
  if (clinicVisits === 0) {
    await bookPastVisit(schema, {
      patient: labPatient, doctor: rohit, hospitalId: banjara.id, departmentId: clinicPlan.department_id,
      daysAgo: 10, status: 'completed', treatmentPlanId: clinicPlan.id, visitNumber: 1, notes: 'Implant placement',
    });
    log(`  + treatment plan "Post-implant review course" (Deepa Nathan) — scheduling_mode=clinic, 1/3 done`);
  }

  // 4c. Single-visit course completed same sitting (proposed -> completed).
  const sneha = doc('Sneha Patil');
  const completedPlan = await ensurePlan('Teeth whitening', completedPatient, {
    hospitalId: banjara.id, departmentId: dept(banjara.id, 'Cosmetic Dentistry').id, doctorId: sneha.id,
    totalVisits: 1, estimatedCost: 8000, status: 'completed',
  });
  const cpVisits = (await tenantQuery(schema, `SELECT count(*)::int n FROM appointments WHERE treatment_plan_id=$1`, [completedPlan.id])).rows[0].n;
  if (cpVisits === 0) {
    await bookPastVisit(schema, {
      patient: completedPatient, doctor: sneha, hospitalId: banjara.id, departmentId: completedPlan.department_id,
      daysAgo: 6, status: 'completed', treatmentPlanId: completedPlan.id, visitNumber: 1, notes: 'Whitening — single sitting',
    });
    log(`  + treatment plan "Teeth whitening" (Ritu Malhotra) — completed, fully paid below`);
  }

  // 4d. Whole course cancelled after 1 visit — terminal, must not reopen.
  const kavitha = doc('Kavitha Reddy');
  const cancelledPlan = await ensurePlan('Full mouth rehabilitation', cancelledPatient, {
    hospitalId: banjara.id, departmentId: dept(banjara.id, 'General Dentistry').id, doctorId: kavitha.id,
    totalVisits: 6, estimatedCost: 90000, status: 'cancelled',
  });
  const clVisits = (await tenantQuery(schema, `SELECT count(*)::int n FROM appointments WHERE treatment_plan_id=$1`, [cancelledPlan.id])).rows[0].n;
  if (clVisits === 0) {
    await bookPastVisit(schema, {
      patient: cancelledPatient, doctor: kavitha, hospitalId: banjara.id, departmentId: cancelledPlan.department_id,
      daysAgo: 45, status: 'completed', treatmentPlanId: cancelledPlan.id, visitNumber: 1, notes: 'Scaling — visit 1 of 6',
    });
    log(`  + treatment plan "Full mouth rehabilitation" (Farhan Ali) — cancelled after visit 1, patient declined`);
  }

  // 4e. STALLED: work started, nothing booked, last sitting >30 days ago.
  const arjun = doc('Arjun Sharma');
  const stalledPlan = await ensurePlan('Root canal — upper right 6', stalledPatient, {
    hospitalId: banjara.id, departmentId: dept(banjara.id, 'Root Canal Treatment').id, doctorId: arjun.id,
    totalVisits: 3, estimatedCost: 12000, status: 'in_progress',
  });
  const stVisits = (await tenantQuery(schema, `SELECT count(*)::int n FROM appointments WHERE treatment_plan_id=$1`, [stalledPlan.id])).rows[0].n;
  if (stVisits === 0) {
    await bookPastVisit(schema, {
      patient: stalledPatient, doctor: arjun, hospitalId: banjara.id, departmentId: stalledPlan.department_id,
      daysAgo: 40, status: 'completed', treatmentPlanId: stalledPlan.id, visitNumber: 1, notes: 'RCT — access & cleaning, visit 1 of 3',
    });
    log(`  + treatment plan "Root canal — upper right 6" (Vikram Solanki) — stalled, ₹4000 outstanding of ₹12000`);
  }

  // 4f. OUTSTANDING inside a live plan: visit 2 was booked then cancelled —
  //     work is not complete and nothing is on the calendar for it.
  const outstandingPlan = await ensurePlan('Root canal — lower left 7', outstandingPatient, {
    hospitalId: banjara.id, departmentId: dept(banjara.id, 'Root Canal Treatment').id, doctorId: arjun.id,
    totalVisits: 3, estimatedCost: 12000, status: 'in_progress',
  });
  const osVisits = (await tenantQuery(schema, `SELECT count(*)::int n FROM appointments WHERE treatment_plan_id=$1`, [outstandingPlan.id])).rows[0].n;
  if (osVisits === 0) {
    await bookPastVisit(schema, {
      patient: outstandingPatient, doctor: arjun, hospitalId: banjara.id, departmentId: outstandingPlan.department_id,
      daysAgo: 15, status: 'completed', treatmentPlanId: outstandingPlan.id, visitNumber: 1, notes: 'RCT — access & cleaning, visit 1 of 3',
    });
    await bookPastVisit(schema, {
      patient: outstandingPatient, doctor: arjun, hospitalId: banjara.id, departmentId: outstandingPlan.department_id,
      daysAgo: 5, status: 'cancelled', treatmentPlanId: outstandingPlan.id, visitNumber: 2, notes: 'RCT — obturation, visit 2 of 3 (patient cancelled)',
    });
    log(`  + treatment plan "Root canal — lower left 7" (Om Prakash) — visit 2 cancelled, back on the outstanding queue`);
  }

  // ── 5. Payments — full, partial, overpaid ───────────────────────────────
  async function ensurePayment(planId, amount, method, note) {
    const existing = (await tenantQuery(schema,
      `SELECT 1 FROM treatment_payments WHERE treatment_plan_id=$1 AND note=$2`, [planId, note])).rows[0];
    if (existing) return;
    await tenantQuery(schema, `
      INSERT INTO treatment_payments (treatment_plan_id, amount, method, note, collected_by_user_id)
      VALUES ($1,$2,$3,$4,$5)`, [planId, amount, method, note, admin.id]);
  }
  await ensurePayment(completedPlan.id, 8000, 'upi', 'Scenario: paid in full');
  await ensurePayment(stalledPlan.id, 4000, 'cash', 'Scenario: part payment, balance outstanding');
  await ensurePayment(orthoPlan.id, 12000, 'card', 'Scenario: bonding + first two adjustments');
  await ensurePayment(orthoPlan.id, 3000, 'upi', 'Scenario: adjustment fee');
  await ensurePayment(cancelledPlan.id, 15000, 'cash', 'Scenario: paid before cancelling — refund pending (overpaid vs revised scope)');
  log(`  + treatment_payments: full (whitening), partial (root canal), split (braces), overpaid (cancelled course)`);

  // ── 6. Lab work — pending, sent, received/fitted, overdue ──────────────
  async function ensureLab(planId, patientId, item, status, extra = {}) {
    const existing = (await tenantQuery(schema,
      `SELECT 1 FROM lab_works WHERE treatment_plan_id=$1 AND item=$2`, [planId, item])).rows[0];
    if (existing) return;
    const cols = ['treatment_plan_id', 'patient_id', 'lab_name', 'item', 'status', 'created_by_user_id', ...Object.keys(extra)];
    const vals = [planId, patientId, 'Hyderabad Dental Lab', item, status, admin.id, ...Object.values(extra)];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
    await tenantQuery(schema, `INSERT INTO lab_works (${cols.join(',')}) VALUES (${placeholders})`, vals);
  }
  const today = format(istToday(), 'yyyy-MM-dd');
  const overdue = format(subDays(istToday(), 3), 'yyyy-MM-dd');
  const soon = format(addDays(istToday(), 4), 'yyyy-MM-dd');
  await ensureLab(clinicPlan.id, labPatient.id, 'Zirconia crown — #46', 'sent', { sent_date: subDays(istToday(), 10).toISOString().slice(0, 10), expected_date: overdue });
  await ensureLab(clinicPlan.id, labPatient.id, 'Custom abutment — #46', 'received', { sent_date: subDays(istToday(), 20).toISOString().slice(0, 10), expected_date: subDays(istToday(), 6).toISOString().slice(0, 10), received_date: subDays(istToday(), 5).toISOString().slice(0, 10) });
  await ensureLab(orthoPlan.id, orthoPatient.id, 'Retainer (post-debond)', 'pending', { expected_date: soon });
  log(`  + lab_works: overdue (sent, past expected date), received, pending`);

  // ── 7. Recalls — due, booked, dismissed, done ───────────────────────────
  const recallDuePatient = await ensurePatient(schema, { name: 'Suman Verma', phone: nextPhone() });
  const recallBookedPatient = await ensurePatient(schema, { name: 'Anil Kapadia', phone: nextPhone(), gender: 'male' });
  const recallDismissedPatient = await ensurePatient(schema, { name: 'Zoya Ahmed', phone: nextPhone() });
  const recallDonePatient = await ensurePatient(schema, { name: 'Harish Chandra', phone: nextPhone(), gender: 'male' });

  async function ensureRecall(patient, status, dueDaysOffset, extra = {}) {
    const existing = (await tenantQuery(schema, `SELECT * FROM patient_recalls WHERE patient_id=$1`, [patient.id])).rows[0];
    if (existing) return existing;
    const dueDate = format(addDays(istToday(), dueDaysOffset), 'yyyy-MM-dd');
    const cols = ['patient_id', 'hospital_id', 'reason', 'due_date', 'status', ...Object.keys(extra)];
    const vals = [patient.id, banjara.id, 'Routine 6-month check-up', dueDate, status, ...Object.values(extra)];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
    const r = await tenantQuery(schema, `INSERT INTO patient_recalls (${cols.join(',')}) VALUES (${placeholders}) RETURNING *`, vals);
    return r.rows[0];
  }
  await ensureRecall(recallDuePatient, 'due', -3);
  const rb = await ensureRecall(recallBookedPatient, 'booked', -1);
  if (!rb.booked_appointment_id) {
    const meghna = doc('Meghna Iyer');
    const booked = await bookUpcoming(schema, { patient: recallBookedPatient, doctor: meghna, hospitalId: kphb.id, notes: 'Recall visit' });
    if (booked) {
      await tenantQuery(schema, `UPDATE patient_recalls SET booked_appointment_id=$1 WHERE id=$2`, [booked.id, rb.id]);
    }
  }
  await ensureRecall(recallDismissedPatient, 'dismissed', -20, { send_count: 3, last_sent_at: subDays(istToday(), 20).toISOString() });
  await ensureRecall(recallDonePatient, 'done', -60);
  log(`  + patient_recalls: due, booked (with a real upcoming slot), dismissed, done`);

  // ── 8. Clinic requests — callback, appointment (grid full), one handled ─
  const callbackPatient = await ensurePatient(schema, { name: 'Rakesh Yadav', phone: nextPhone(), gender: 'male' });
  const requestPatient = await ensurePatient(schema, { name: 'Sunita Joshi', phone: nextPhone() });
  const handledPatient = await ensurePatient(schema, { name: 'Iqbal Mirza', phone: nextPhone(), gender: 'male' });

  async function ensureRequest(kind, patient, status, fields = {}) {
    const existing = (await tenantQuery(schema, `SELECT * FROM clinic_requests WHERE phone=$1 AND kind=$2`, [patient.phone, kind])).rows[0];
    if (existing) return existing;
    const cols = ['kind', 'phone', 'patient_id', 'patient_name', 'status', ...Object.keys(fields)];
    const vals = [kind, patient.phone, patient.id, patient.name, status, ...Object.values(fields)];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
    const r = await tenantQuery(schema, `INSERT INTO clinic_requests (${cols.join(',')}) VALUES (${placeholders}) RETURNING *`, vals);
    return r.rows[0];
  }
  await ensureRequest('callback', callbackPatient, 'open');
  await ensureRequest('appointment', requestPatient, 'open', {
    hospital_id: banjara.id, department_id: dept(banjara.id, 'Orthodontics & Braces').id, doctor_id: preethi.id,
    preferred_date: format(addDays(istToday(), 2), 'yyyy-MM-dd'), note: 'Wanted Dr. Preethi Nair, that day was fully booked',
  });
  const handled = await ensureRequest('callback', handledPatient, 'open');
  if (handled.status === 'open') {
    await tenantQuery(schema,
      `UPDATE clinic_requests SET status='handled', handled_by_user_id=$1, handled_at=NOW() WHERE id=$2`,
      [admin.id, handled.id]);
  }
  log(`  + clinic_requests: callback (open), appointment/grid-full (open), callback (already handled)`);

  // ── 9. Appointment feedback — mix of ratings on real completed visits ──
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
    const existing = (await tenantQuery(schema, `SELECT 1 FROM appointment_feedback WHERE appointment_id=$1`, [a.id])).rows[0];
    if (existing) continue;
    await tenantQuery(schema, `
      INSERT INTO appointment_feedback (appointment_id, patient_id, rating, comment)
      VALUES ($1,$2,$3,$4)`, [a.id, a.patient_id, ratings[i], comments[i]]);
  }
  log(`  + appointment_feedback on ${recentCompleted.length} recent completed visits (ratings 5,4,2,5)`);

  // ── 10. Fee override — consultation fee waived/discounted at the desk ──
  const feeAppt = recentCompleted[0];
  if (feeAppt) {
    await tenantQuery(schema, `UPDATE appointments SET effective_fee=200 WHERE id=$1 AND (effective_fee IS NULL OR effective_fee=0)`, [feeAppt.id]);
    log(`  + effective_fee override (₹200, discounted from list price) on one completed visit`);
  }

  // ── 11. GENERAL_CONSULT-shaped visit: booked with a GP for a treatment
  //     outside their own primary department, via the many-to-many join —
  //     e.g. Kavitha Reddy (General Dentistry) seeing a simple extraction
  //     booked under Oral Surgery. Exercises doctor_departments + the
  //     COALESCE(a.department_id, d.department_id) display join. ──────────
  await tenantQuery(schema, `
    INSERT INTO doctor_departments (doctor_id, department_id) VALUES ($1,$2)
    ON CONFLICT DO NOTHING`, [kavitha.id, dept(banjara.id, 'Oral Surgery').id]);
  const crossDeptPatient = await ensurePatient(schema, { name: 'Prakash Menon', phone: nextPhone(), gender: 'male' });
  const cdExisting = (await tenantQuery(schema,
    `SELECT 1 FROM appointments WHERE notes=$1`, ['Scenario fixture — cross-department booking'])).rows[0];
  if (!cdExisting) {
    await bookPastVisit(schema, {
      patient: crossDeptPatient, doctor: kavitha, hospitalId: banjara.id,
      departmentId: dept(banjara.id, 'Oral Surgery').id, daysAgo: 4, status: 'completed',
      notes: 'Scenario fixture — cross-department booking',
    });
    log(`  + cross-department visit: Kavitha Reddy (General Dentistry) booked FOR Oral Surgery`);
  }

  // ── 12. Book the visiting consultant's alternate-Tuesday slot ──────────
  const visitingPatient = await ensurePatient(schema, { name: 'Imran Sheikh', phone: nextPhone(), gender: 'male' });
  const vExisting = (await tenantQuery(schema,
    `SELECT 1 FROM appointments WHERE patient_id=$1 AND doctor_id=$2`, [visitingPatient.id, kiran.id])).rows[0];
  if (!vExisting) {
    const booked = await bookUpcoming(schema, {
      patient: visitingPatient, doctor: kiran, departmentId: dept(kiran.hospital_id === banjara.id ? kphb.id : banjara.id, 'Orthodontics & Braces')?.id,
      notes: 'Scenario fixture — booked with the visiting consultant',
    });
    if (booked) {
      log(`  + upcoming visit with Kiran Bhat (visiting consultant) on ${booked.slotDate} ${booked.slotTime}`);
    } else {
      log(`  ! no free slot found yet for Kiran Bhat within the 30-day window — run again after the next alternate Tuesday generates`);
    }
  }

  log('\nDone. Summary:');
  const counts = {};
  for (const tbl of ['patients', 'doctors', 'treatment_plans', 'treatment_payments', 'lab_works', 'patient_recalls', 'clinic_requests', 'appointment_feedback', 'doctor_hospitals']) {
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
