'use strict';
/**
 * Scenario dataset for the shareable READ-ONLY demo tenant
 * (`pragati-demo` / "Pragati Dental Studio", entry code TRYMED).
 *
 * `ensureDemoTenant()` in migrate.js builds the STRUCTURE — one branch, four
 * departments, three dentists, their schedules, an admin user and 14 days of
 * slots. This file builds the LIFE inside it: patients, appointments across
 * every status, treatment plans in every state, payments, lab work, recalls,
 * feedback and front-desk requests — so a prospect who opens any dashboard tab,
 * report or chart sees something real instead of an empty state.
 *
 * It runs on every boot right after `ensureDemoTenant()` (migrate.js), gated by
 * DEMO_SEED_DATA (default on) and DEMO_TENANT. It CLEARS the demo tenant's
 * transactional rows and rebuilds them — a true reset, so the dates stay
 * relative to "now" and a stray visitor interaction never accumulates. The demo
 * is `read_only`, so nothing but this ever writes to it.
 *
 * Standalone: `node src/db/demoData.js`
 */
const { query, tenantTransaction } = require('./index');
const { toZonedTime } = require('../utils/dateTz');
const { genBookingId } = require('../services/bot/utils');
const { encryptJSON } = require('../utils/encryption');
const { format, addDays } = require('date-fns');

const DEMO_SLUG = 'pragati-demo';
const DEMO_SCHEMA = 'tenant_pragati_demo';
const CLINIC_NAME = 'Pragati Dental Studio';

// ── date helpers — everything relative to "today" in IST ──────────────────────
const BASE = toZonedTime(new Date(), 'Asia/Kolkata');
const dstr = (n) => format(addDays(BASE, n), 'yyyy-MM-dd');           // date, N days from today
const ago = (n) => new Date(Date.now() - n * 86400000).toISOString(); // timestamptz, N days back (neg = future)

// Unroutable phone prefix — dev rewrites real numbers to 9100… and the
// WhatsApp allowlist blocks the rest; a demo fixture must never carry a real one.
const P = (n) => '91000' + String(100000 + n).slice(1); // 91000NNNNN, 10 digits

async function seedDemoData() {
  if (process.env.DEMO_TENANT === 'false' || process.env.DEMO_SEED_DATA === 'false') {
    console.log('⏭  Demo scenario data skipped (DEMO_TENANT/DEMO_SEED_DATA=false)');
    return;
  }

  const tenant = (await query(`SELECT id FROM tenants WHERE slug=$1`, [DEMO_SLUG])).rows[0];
  if (!tenant) {
    console.log('⏭  Demo scenario data skipped — pragati-demo tenant not found');
    return;
  }

  // Structure ids (built by ensureDemoTenant). If any are missing the fixture
  // can't be placed — log and bail rather than half-populate.
  const branchRow = (await q(`SELECT id FROM hospitals WHERE name=$1`, [CLINIC_NAME])).rows[0];
  if (!branchRow) { console.log('⏭  Demo scenario data skipped — demo branch not found'); return; }
  const BRANCH = branchRow.id;
  const depts = mapBy((await q(`SELECT id, name FROM departments WHERE hospital_id=$1`, [BRANCH])).rows);
  const docs = mapBy((await q(`SELECT id, name FROM doctors WHERE hospital_id=$1`, [BRANCH])).rows);
  const GD = depts['General Dentistry'], RCT = depts['Root Canal Treatment'];
  const ORTHO = depts['Orthodontics & Braces'], COSM = depts['Cosmetic Dentistry'];
  const ANANYA = docs['Ananya Rao'], VIKRAM = docs['Vikram Shetty'], NISHA = docs['Nisha Menon'];
  if (!ANANYA || !VIKRAM || !NISHA || !GD || !RCT) {
    console.log('⏭  Demo scenario data skipped — demo dentists/departments not found');
    return;
  }

  const adminUser = (await q(`SELECT id FROM users WHERE email='demo@pragatisolutions.com'`)).rows[0];
  const ADMIN = adminUser ? adminUser.id : null;

  await tenantTransaction(DEMO_SCHEMA, async (c) => {
    // ── CLEAR (child → parent; explicit so it's FK-safe whatever ON DELETE says) ──
    for (const t of [
      'appointment_feedback', 'treatment_payments', 'lab_works', 'patient_recalls',
      'clinic_requests', 'reminder_confirmations', 'bot_sessions', 'wa_messages',
    ]) await c.query(`DELETE FROM ${t}`);
    await c.query(`UPDATE appointments SET treatment_plan_id=NULL, follow_up_appointment_id=NULL`);
    await c.query(`UPDATE treatment_plans SET origin_appointment_id=NULL`);
    await c.query(`DELETE FROM appointments`);
    await c.query(`DELETE FROM treatment_plans`);
    await c.query(`DELETE FROM patients`);
    await c.query(`UPDATE time_slots SET status='available' WHERE status='booked'`);

    // ── local insert helpers (bound to this txn client) ──────────────────────
    const completed = []; // { id, patientId, doctorId } — fed to feedback below

    const mkPatient = async (p) => {
      const dh = p.history ? JSON.stringify(encryptJSON(p.history)) : null;
      const r = await c.query(`
        INSERT INTO patients
          (phone, name, date_of_birth, gender, email, visit_count, dental_history,
           opted_out, patient_type, referral_source, first_appointment_date, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::jsonb, '{}'::jsonb),
                $8,$9,$10,$11,$12,$12)
        RETURNING id`,
        [p.phone, p.name, p.dob || null, p.gender || null, p.email || null,
         p.visits || 1, dh, !!p.optedOut,
         (p.visits || 1) > 1 ? 'returning' : 'new', p.source ?? null,
         p.firstVisit || null, ago(p.joinedDaysAgo ?? 120)]);
      return r.rows[0].id;
    };

    const takeSlot = async (doctorId, date, preferTime) => {
      const r = await c.query(`
        SELECT id, start_time::text AS start_time FROM time_slots
        WHERE doctor_id=$1 AND slot_date=$2 AND status='available'
        ORDER BY (start_time = $3::time) DESC, start_time
        LIMIT 1`, [doctorId, date, preferTime || '11:00']);
      if (!r.rows[0]) return { slotId: null, time: preferTime || '11:00' };
      await c.query(`UPDATE time_slots SET status='booked' WHERE id=$1`, [r.rows[0].id]);
      return { slotId: r.rows[0].id, time: r.rows[0].start_time.slice(0, 5) };
    };

    const mkAppt = async (a) => {
      let slotId = null, time = a.time || '11:00';
      if (a.bookSlot) ({ slotId, time } = await takeSlot(a.doctorId, a.date, a.time));
      const createdDaysAgo = a.createdDaysAgo ?? (a.daysAgo != null ? a.daysAgo + 2 : 2);
      const paidTs = a.paymentStatus === 'paid'
        ? ago(a.daysAgo != null && a.daysAgo > 0 ? a.daysAgo : 0) : null;
      const cancelledTs = a.status === 'cancelled'
        ? ago(a.daysAgo != null && a.daysAgo > 0 ? a.daysAgo : 0) : null;
      const r = await c.query(`
        INSERT INTO appointments
          (booking_id, patient_id, doctor_id, hospital_id, slot_id, appointment_date,
           appointment_time, status, visit_type, department_id, treatment_plan_id,
           visit_number, effective_fee, payment_status, payment_method, payment_collected_at,
           notes, cancellation_reason, cancelled_by, cancelled_by_user_id, cancelled_at,
           reminder_24h_sent, feedback_request_sent, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$24)
        RETURNING id`,
        [genBookingId(), a.patientId, a.doctorId, BRANCH, slotId, a.date, time,
         a.status, a.visitType || 'in_person', a.deptId || null, a.planId || null,
         a.visitNumber || null, a.effectiveFee ?? 0, a.paymentStatus || 'pending',
         a.paymentMethod || null, paidTs, a.notes || null,
         a.status === 'cancelled' ? (a.cancelReason || 'Something came up') : null,
         a.status === 'cancelled' ? 'user' : null,
         a.status === 'cancelled' ? ADMIN : null, cancelledTs,
         !!a.reminderSent, !!a.feedbackRequestSent, ago(createdDaysAgo)]);
      const id = r.rows[0].id;
      if (a.status === 'completed') completed.push({ id, patientId: a.patientId, doctorId: a.doctorId });
      // The 24h-reminder cron inserts a row when it sends, then fills `response`
      // when the patient replies — so "sent, no reply" is a row with a NULL
      // response, which is what drives schedule.pdf's "CALL — no reply".
      if (a.reminderSent && a.phone) {
        await c.query(`
          INSERT INTO reminder_confirmations (appointment_id, phone, response, responded_at)
          VALUES ($1,$2,$3,$4)`,
          [id, a.phone, a.reminderReply ?? null, a.reminderReply ? ago(0.2) : null]);
      }
      return id;
    };

    const mkPlan = async (pl) => {
      const r = await c.query(`
        INSERT INTO treatment_plans
          (patient_id, hospital_id, department_id, advised_by_doctor_id, treating_doctor_id,
           title, tooth_ref, total_visits, scheduling_mode, estimated_cost, status, notes,
           created_by_user_id, consent_taken_at, consent_taken_by, consent_note,
           created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)
        RETURNING id`,
        [pl.patientId, BRANCH, pl.deptId || null, pl.advisedBy, pl.treatingBy || pl.advisedBy,
         pl.title, pl.tooth || null, pl.totalVisits, pl.mode || 'patient',
         pl.estimatedCost || 0, pl.status, pl.notes || null, ADMIN,
         pl.consent ? ago(pl.advisedDaysAgo || 20) : null,
         pl.consent ? ADMIN : null,          // consent_taken_by is a user UUID
         pl.consent || null, ago(pl.advisedDaysAgo ?? 20)]);
      return r.rows[0].id;
    };

    const mkPayment = (planId, amount, method, daysAgo, note) =>
      c.query(`
        INSERT INTO treatment_payments (treatment_plan_id, amount, method, note, collected_by_user_id, collected_at, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$6)`,
        [planId, amount, method, note || null, ADMIN, ago(daysAgo)]);

    const mkLab = (lw) =>
      c.query(`
        INSERT INTO lab_works
          (treatment_plan_id, patient_id, lab_name, item, sent_date, expected_date,
           received_date, status, cost, notes, created_by_user_id, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
        [lw.planId || null, lw.patientId || null, lw.lab || 'Precision Dental Lab',
         lw.item, lw.sent || null, lw.expected || null, lw.received || null,
         lw.status, lw.cost || 0, lw.notes || null, ADMIN, ago(lw.createdDaysAgo ?? 15)]);

    const mkRecall = (rc) =>
      c.query(`
        INSERT INTO patient_recalls
          (patient_id, hospital_id, reason, due_date, status, last_sent_at, send_count,
           booked_appointment_id, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
        [rc.patientId, BRANCH, rc.reason || 'Routine check-up', rc.due, rc.status,
         rc.sendCount ? ago(rc.lastSentDaysAgo ?? 7) : null, rc.sendCount || 0,
         rc.bookedApptId || null, ago(rc.createdDaysAgo ?? 190)]);

    const mkRequest = (rq) =>
      c.query(`
        INSERT INTO clinic_requests
          (kind, phone, patient_id, patient_name, hospital_id, department_id, doctor_id,
           preferred_date, note, status, handled_by_user_id, handled_at, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [rq.kind, rq.phone, rq.patientId || null, rq.patientName, BRANCH,
         rq.deptId || null, rq.doctorId || null, rq.preferredDate || null, rq.note || null,
         rq.status || 'open', rq.status === 'handled' ? ADMIN : null,
         rq.status === 'handled' ? ago(1) : null, ago(rq.createdDaysAgo ?? 2)]);

    // ── PATIENTS ────────────────────────────────────────────────────────────
    const patients = [
      { key: 'rohan', name: 'Rohan Gupta', phone: P(1), gender: 'male', dob: '1985-03-12',
        visits: 4, source: 'returning', joinedDaysAgo: 400,
        history: { blood_type: 'O+', allergies: ['Penicillin'], chronic_conditions: ['Hypertension'], medications: ['Amlodipine 5mg'] } },
      { key: 'priya', name: 'Priya Nair', phone: P(2), gender: 'female', dob: '1994-07-22', visits: 1, source: 'google', joinedDaysAgo: 18 },
      { key: 'arjun', name: 'Arjun Reddy', phone: P(3), gender: 'male', dob: '1979-11-02', visits: 2, source: 'friend', joinedDaysAgo: 60 },
      { key: 'sneha', name: 'Sneha Iyer', phone: P(4), gender: 'female', dob: '1990-01-30', visits: 3, source: 'doctor_referral', joinedDaysAgo: 120 },
      { key: 'karthik', name: 'Karthik Menon', phone: P(5), gender: 'male', dob: '2001-05-19', visits: 1, source: 'social', joinedDaysAgo: 9 },
      { key: 'deepika', name: 'Deepika Rao', phone: P(6), gender: 'female', dob: '1972-09-08', visits: 5, source: 'returning', joinedDaysAgo: 700 },
      { key: 'vivek', name: 'Vivek Sharma', phone: P(7), gender: 'male', dob: '1996-12-14', visits: 1, source: 'walk_past', joinedDaysAgo: 25 },
      { key: 'ananyaK', name: 'Ananya Krishnan', phone: P(8), gender: 'female', dob: '1988-04-27', visits: 2, source: null, joinedDaysAgo: 210 },
      { key: 'ravi', name: 'Ravi Kumar', phone: P(9), gender: 'male', dob: '1983-08-03', visits: 1, source: 'other', joinedDaysAgo: 40 },
      { key: 'meera', name: 'Meera Joshi', phone: P(10), gender: 'female', dob: '1965-02-11', visits: 6, source: 'returning', joinedDaysAgo: 900,
        history: { blood_type: 'B+', allergies: [], chronic_conditions: ['Type 2 Diabetes'], medications: ['Metformin 500mg'] } },
      { key: 'sanjay', name: 'Sanjay Patel', phone: P(11), gender: 'male', dob: '1991-06-25', visits: 1, source: 'google', optedOut: true, joinedDaysAgo: 150 },
      { key: 'lakshmi', name: 'Lakshmi Nair', phone: P(12), gender: 'female', dob: '1987-10-17', visits: 2, source: 'walk_past', joinedDaysAgo: 80 },
      { key: 'aditya', name: 'Aditya Nair', phone: P(12), gender: 'male', dob: '2015-03-09', visits: 1, source: 'walk_past', joinedDaysAgo: 30 }, // child, shares phone
      { key: 'pooja', name: 'Pooja Desai', phone: P(14), gender: 'female', dob: '1998-01-05', visits: 3, source: 'social', joinedDaysAgo: 260 },
      { key: 'nikhil', name: 'Nikhil Rao', phone: P(15), gender: 'male', dob: '1993-09-21', visits: 1, source: 'google', joinedDaysAgo: 14 },
      { key: 'kavya', name: 'Kavya Reddy', phone: P(16), gender: 'female', dob: '2004-11-29', visits: 4, source: 'returning', joinedDaysAgo: 300 },
    ];
    const pid = {};
    for (const p of patients) pid[p.key] = await mkPatient(p);
    const phoneOf = (k) => patients.find((p) => p.key === k).phone;

    // ── TODAY ───────────────────────────────────────────────────────────────
    const T = dstr(0);
    await mkAppt({ patientId: pid.priya, doctorId: ANANYA, deptId: GD, date: T, time: '15:30', status: 'confirmed', bookSlot: true });
    await mkAppt({ patientId: pid.nikhil, doctorId: VIKRAM, deptId: RCT, date: T, time: '16:00', status: 'confirmed', bookSlot: true });
    await mkAppt({ patientId: pid.karthik, doctorId: ANANYA, deptId: GD, date: T, time: '17:00', status: 'confirmed', bookSlot: true });
    await mkAppt({ patientId: pid.ravi, doctorId: ANANYA, deptId: GD, date: T, time: '10:30', status: 'completed', daysAgo: 0, paymentStatus: 'paid', paymentMethod: 'upi' });
    await mkAppt({ patientId: pid.ananyaK, doctorId: VIKRAM, deptId: RCT, date: T, time: '11:00', status: 'completed', daysAgo: 0, paymentStatus: 'pending' });
    await mkAppt({ patientId: pid.vivek, doctorId: NISHA, deptId: ORTHO, date: T, time: '12:00', status: 'no_show', daysAgo: 0 });
    await mkAppt({ patientId: pid.pooja, doctorId: ANANYA, deptId: GD, date: T, time: '13:00', status: 'cancelled', daysAgo: 0, cancelReason: 'Patient unwell' });
    // walk-in, no slot, paid cash, fee waived (took treatment)
    await mkAppt({ patientId: pid.lakshmi, doctorId: ANANYA, deptId: GD, date: T, time: '11:45', status: 'completed', daysAgo: 0, effectiveFee: 0, paymentStatus: 'waived', notes: 'Walk-in — fee waived, started treatment plan' });

    // ── TOMORROW — the confirmation call-list ───────────────────────────────
    const TM = dstr(1);
    await mkAppt({ patientId: pid.rohan, doctorId: ANANYA, deptId: GD, date: TM, time: '10:00', status: 'confirmed', bookSlot: true, reminderSent: true, reminderReply: 'yes', phone: phoneOf('rohan') });
    await mkAppt({ patientId: pid.deepika, doctorId: VIKRAM, deptId: RCT, date: TM, time: '11:00', status: 'confirmed', bookSlot: true, reminderSent: true, reminderReply: 'yes', phone: phoneOf('deepika') });
    await mkAppt({ patientId: pid.sneha, doctorId: ANANYA, deptId: GD, date: TM, time: '12:00', status: 'confirmed', bookSlot: true, reminderSent: true, reminderReply: 'no', phone: phoneOf('sneha') });
    await mkAppt({ patientId: pid.arjun, doctorId: VIKRAM, deptId: RCT, date: TM, time: '15:00', status: 'confirmed', bookSlot: true, reminderSent: true, phone: phoneOf('arjun') });
    await mkAppt({ patientId: pid.kavya, doctorId: NISHA, deptId: ORTHO, date: TM, time: '16:00', status: 'confirmed', bookSlot: true, reminderSent: true, phone: phoneOf('kavya') });

    // ── THIS WEEK / NEXT WEEK ──────────────────────────────────────────────
    await mkAppt({ patientId: pid.ananyaK, doctorId: NISHA, deptId: COSM, date: dstr(3), time: '14:30', status: 'confirmed', bookSlot: true });
    await mkAppt({ patientId: pid.ravi, doctorId: VIKRAM, deptId: RCT, date: dstr(4), time: '10:30', status: 'confirmed', bookSlot: true });
    await mkAppt({ patientId: pid.nikhil, doctorId: ANANYA, deptId: GD, date: dstr(6), time: '11:30', status: 'confirmed', bookSlot: true });
    await mkAppt({ patientId: pid.priya, doctorId: VIKRAM, deptId: RCT, date: dstr(9), time: '16:00', status: 'confirmed', bookSlot: true });
    await mkAppt({ patientId: pid.vivek, doctorId: ANANYA, deptId: GD, date: dstr(12), time: '12:30', status: 'confirmed', bookSlot: true });

    // ── PAST (analytics history) ──────────────────────────────────────────
    const past = [
      { k: 'rohan', doc: ANANYA, dep: GD, d: 3, st: 'completed', pay: 'paid', m: 'cash' },
      { k: 'deepika', doc: VIKRAM, dep: RCT, d: 4, st: 'completed', pay: 'paid', m: 'upi' },
      { k: 'arjun', doc: VIKRAM, dep: RCT, d: 5, st: 'completed', pay: 'pending' },
      { k: 'meera', doc: ANANYA, dep: GD, d: 6, st: 'completed', pay: 'paid', m: 'card' },
      { k: 'sneha', doc: ANANYA, dep: GD, d: 7, st: 'no_show' },
      { k: 'karthik', doc: NISHA, dep: ORTHO, d: 8, st: 'completed', pay: 'waived', fee: 0 },
      { k: 'ananyaK', doc: VIKRAM, dep: RCT, d: 10, st: 'completed', pay: 'paid', m: 'upi' },
      { k: 'ravi', doc: ANANYA, dep: GD, d: 11, st: 'cancelled', reason: 'Schedule clash' },
      { k: 'nikhil', doc: ANANYA, dep: GD, d: 13, st: 'completed', pay: 'paid', m: 'cash' },
      { k: 'pooja', doc: NISHA, dep: ORTHO, d: 15, st: 'completed', pay: 'paid', m: 'upi', video: true },
      { k: 'lakshmi', doc: ANANYA, dep: GD, d: 18, st: 'completed', pay: 'paid', m: 'cash' },
      { k: 'aditya', doc: ANANYA, dep: GD, d: 18, st: 'completed', pay: 'paid', m: 'cash', fee: 200 }, // child, negotiated fee
      { k: 'rohan', doc: VIKRAM, dep: RCT, d: 22, st: 'completed', pay: 'paid', m: 'card' },
      { k: 'deepika', doc: VIKRAM, dep: RCT, d: 26, st: 'completed', pay: 'paid', m: 'bank_transfer' },
      { k: 'meera', doc: ANANYA, dep: GD, d: 30, st: 'completed', pay: 'paid', m: 'upi' },
      { k: 'sneha', doc: ANANYA, dep: GD, d: 34, st: 'completed', pay: 'paid', m: 'cash' },
      { k: 'arjun', doc: VIKRAM, dep: RCT, d: 38, st: 'completed', pay: 'paid', m: 'upi' },
      { k: 'kavya', doc: NISHA, dep: ORTHO, d: 42, st: 'completed', pay: 'paid', m: 'card' },
      { k: 'nikhil', doc: ANANYA, dep: GD, d: 48, st: 'no_show' },
      { k: 'deepika', doc: ANANYA, dep: GD, d: 55, st: 'completed', pay: 'paid', m: 'cash' },
    ];
    for (const x of past) {
      await mkAppt({
        patientId: pid[x.k], doctorId: x.doc, deptId: x.dep, date: dstr(-x.d), time: '11:00',
        status: x.st, daysAgo: x.d, paymentStatus: x.pay, paymentMethod: x.m,
        effectiveFee: x.fee ?? 0, visitType: x.video ? 'video' : 'in_person',
        cancelReason: x.reason, feedbackRequestSent: x.st === 'completed',
      });
    }

    // ── TREATMENT PLANS — one of every state ──────────────────────────────
    // 1. proposed, nothing booked (Priya) — advised-not-booked worklist / funnel "advised"
    await mkPlan({ patientId: pid.priya, deptId: RCT, advisedBy: VIKRAM, title: 'Root canal — tooth 26',
      tooth: '26', totalVisits: 2, estimatedCost: 8000, status: 'proposed', advisedDaysAgo: 6,
      notes: 'Deep caries, pulp involvement. RCT advised over two visits.' });
    // 2. proposed, older, nothing booked (Karthik)
    await mkPlan({ patientId: pid.karthik, deptId: GD, advisedBy: ANANYA, title: 'Composite fillings ×3',
      totalVisits: 1, estimatedCost: 4500, status: 'proposed', advisedDaysAgo: 12 });

    // 3. in_progress, on track — root canal, 2 of 3 done, next booked, partial paid, consent
    const rc = await mkPlan({ patientId: pid.rohan, deptId: RCT, advisedBy: ANANYA, treatingBy: VIKRAM,
      title: 'Root canal — tooth 36', tooth: '36', totalVisits: 3, estimatedCost: 12000,
      status: 'in_progress', advisedDaysAgo: 20, consent: 'Explained RCT procedure, alternatives (extraction) and risks (post-op pain, possible retreatment). Patient consented.', consentByName: 'Vikram Shetty' });
    await mkAppt({ patientId: pid.rohan, doctorId: VIKRAM, deptId: RCT, date: dstr(-14), status: 'completed', daysAgo: 14, planId: rc, visitNumber: 1, paymentStatus: 'paid', paymentMethod: 'upi' });
    await mkAppt({ patientId: pid.rohan, doctorId: VIKRAM, deptId: RCT, date: dstr(-6), status: 'completed', daysAgo: 6, planId: rc, visitNumber: 2, paymentStatus: 'waived' });
    await mkAppt({ patientId: pid.rohan, doctorId: VIKRAM, deptId: RCT, date: dstr(3), time: '15:00', status: 'confirmed', bookSlot: true, planId: rc, visitNumber: 3 });
    await mkPayment(rc, 3000, 'upi', 14, 'Visit 1');
    await mkPayment(rc, 2000, 'cash', 6, 'Visit 2 part-payment');

    // 4. in_progress, STALLED — last visit 45d ago, nothing booked, balance owed
    const st = await mkPlan({ patientId: pid.sneha, deptId: GD, advisedBy: ANANYA, title: 'Crown — tooth 46',
      tooth: '46', totalVisits: 2, estimatedCost: 15000, status: 'in_progress', advisedDaysAgo: 50 });
    await mkAppt({ patientId: pid.sneha, doctorId: ANANYA, deptId: GD, date: dstr(-45), status: 'completed', daysAgo: 45, planId: st, visitNumber: 1, paymentStatus: 'paid', paymentMethod: 'card' });
    await mkPayment(st, 3000, 'card', 45, 'Crown prep — advance');

    // 5. completed, fully paid
    const cp = await mkPlan({ patientId: pid.deepika, deptId: RCT, advisedBy: VIKRAM, title: 'Root canal + crown — tooth 16',
      tooth: '16', totalVisits: 3, estimatedCost: 18000, status: 'completed', advisedDaysAgo: 44 });
    for (const [i, d] of [[1, 40], [2, 30], [3, 20]]) {
      await mkAppt({ patientId: pid.deepika, doctorId: VIKRAM, deptId: RCT, date: dstr(-d), status: 'completed', daysAgo: d, planId: cp, visitNumber: i, paymentStatus: 'paid', paymentMethod: 'upi' });
    }
    await mkPayment(cp, 10000, 'upi', 40, 'RCT');
    await mkPayment(cp, 8000, 'card', 20, 'Crown fit');

    // 6. completed, OVERPAID (stale estimate)
    const op = await mkPlan({ patientId: pid.meera, deptId: GD, advisedBy: ANANYA, title: 'Extraction + bridge — 24-26',
      totalVisits: 2, estimatedCost: 20000, status: 'completed', advisedDaysAgo: 36,
      consent: 'Surgical extraction of 25 explained with risks (dry socket, nerve involvement low risk). Consented.' });
    await mkAppt({ patientId: pid.meera, doctorId: ANANYA, deptId: GD, date: dstr(-32), status: 'completed', daysAgo: 32, planId: op, visitNumber: 1, paymentStatus: 'paid', paymentMethod: 'cash' });
    await mkAppt({ patientId: pid.meera, doctorId: ANANYA, deptId: GD, date: dstr(-16), status: 'completed', daysAgo: 16, planId: op, visitNumber: 2, paymentStatus: 'paid', paymentMethod: 'upi' });
    await mkPayment(op, 12000, 'cash', 32, 'Extraction + bridge advance');
    await mkPayment(op, 10000, 'upi', 16, 'Bridge fit — final (revised metal work)');

    // 7. declined
    await mkPlan({ patientId: pid.vivek, deptId: COSM, advisedBy: NISHA, title: 'Teeth whitening (in-office)',
      totalVisits: 1, estimatedCost: 6000, status: 'declined', advisedDaysAgo: 20, notes: 'Patient will consider later.' });

    // 8. cancelled after one completed visit (work goes back on the queue)
    const cx = await mkPlan({ patientId: pid.pooja, deptId: ORTHO, advisedBy: NISHA, title: 'Metal braces — full',
      totalVisits: 18, estimatedCost: 40000, status: 'cancelled', advisedDaysAgo: 60, notes: 'Patient relocated — course discontinued.' });
    await mkAppt({ patientId: pid.pooja, doctorId: NISHA, deptId: ORTHO, date: dstr(-55), status: 'completed', daysAgo: 55, planId: cx, visitNumber: 1, paymentStatus: 'paid', paymentMethod: 'upi' });
    await mkPayment(cx, 8000, 'upi', 55, 'Bonding + first adjustment');

    // 9. orthodontic course in progress — long, monthly cadence
    const ortho = await mkPlan({ patientId: pid.kavya, deptId: ORTHO, advisedBy: NISHA, title: 'Ceramic braces — full arch',
      totalVisits: 20, estimatedCost: 55000, status: 'in_progress', advisedDaysAgo: 150,
      consent: 'Orthodontic treatment plan, duration (~20 months), extractions if needed, and retention discussed. Consented.', consentByName: 'Nisha Menon' });
    for (const [i, d] of [[1, 140], [2, 110], [3, 80], [4, 42]]) {
      await mkAppt({ patientId: pid.kavya, doctorId: NISHA, deptId: ORTHO, date: dstr(-d), status: 'completed', daysAgo: d, planId: ortho, visitNumber: i, paymentStatus: 'paid', paymentMethod: 'card' });
    }
    await mkAppt({ patientId: pid.kavya, doctorId: NISHA, deptId: ORTHO, date: dstr(10), time: '16:00', status: 'confirmed', bookSlot: true, planId: ortho, visitNumber: 5 });
    await mkPayment(ortho, 20000, 'card', 140, 'Bonding + records');
    await mkPayment(ortho, 5000, 'upi', 80, 'Adjustment instalment');

    // 10. implant course in progress — lab work attached
    const impl = await mkPlan({ patientId: pid.arjun, deptId: RCT, advisedBy: VIKRAM, title: 'Single implant — tooth 45',
      tooth: '45', totalVisits: 5, estimatedCost: 35000, status: 'in_progress', advisedDaysAgo: 40,
      consent: 'Implant placement, healing period (~3 months), sinus proximity assessed, risks explained. Consented.', consentByName: 'Vikram Shetty' });
    await mkAppt({ patientId: pid.arjun, doctorId: VIKRAM, deptId: RCT, date: dstr(-38), status: 'completed', daysAgo: 38, planId: impl, visitNumber: 1, paymentStatus: 'paid', paymentMethod: 'bank_transfer' });
    await mkAppt({ patientId: pid.arjun, doctorId: VIKRAM, deptId: RCT, date: dstr(-10), status: 'completed', daysAgo: 10, planId: impl, visitNumber: 2, paymentStatus: 'paid', paymentMethod: 'upi' });
    await mkAppt({ patientId: pid.arjun, doctorId: VIKRAM, deptId: RCT, date: dstr(7), time: '10:30', status: 'confirmed', bookSlot: true, planId: impl, visitNumber: 3 });
    await mkPayment(impl, 12000, 'bank_transfer', 38, 'Implant fixture');

    // ── LAB WORKS — every status ─────────────────────────────────────────
    await mkLab({ planId: impl, patientId: pid.arjun, item: 'Implant crown — 45 (zirconia)', status: 'pending', expected: dstr(9), cost: 9000, createdDaysAgo: 8 });
    await mkLab({ planId: cp, patientId: pid.deepika, item: 'Zirconia crown — 16', status: 'sent', sent: dstr(-8), expected: dstr(4), cost: 7000, lab: 'Apex Ceramics', createdDaysAgo: 8 });
    await mkLab({ planId: st, patientId: pid.sneha, item: 'PFM crown — 46', status: 'sent', sent: dstr(-22), expected: dstr(-5), cost: 6000, notes: 'Chased lab twice — overdue.', createdDaysAgo: 22 });
    await mkLab({ planId: cp, patientId: pid.deepika, item: 'Post & core — 16', status: 'received', sent: dstr(-30), expected: dstr(-24), received: dstr(-23), cost: 2500, createdDaysAgo: 30 });
    await mkLab({ planId: op, patientId: pid.meera, item: 'Fixed bridge — 24-26', status: 'fitted', sent: dstr(-40), expected: dstr(-30), received: dstr(-28), cost: 11000, lab: 'Apex Ceramics', createdDaysAgo: 40 });
    await mkLab({ planId: cx, patientId: pid.pooja, item: 'Retainer (upper)', status: 'cancelled', notes: 'Course discontinued before impressions.', createdDaysAgo: 50 });

    // ── RECALLS — every status ──────────────────────────────────────────
    await mkRecall({ patientId: pid.rohan, due: dstr(-5), status: 'due', sendCount: 2, lastSentDaysAgo: 6 }); // overdue, nudged, no booking
    await mkRecall({ patientId: pid.deepika, due: dstr(10), status: 'due', sendCount: 0 });
    await mkRecall({ patientId: pid.priya, due: dstr(22), status: 'due', reason: 'Post-RCT review', sendCount: 1, lastSentDaysAgo: 2 });
    await mkRecall({ patientId: pid.meera, due: dstr(-40), status: 'done' });
    await mkRecall({ patientId: pid.sanjay, due: dstr(5), status: 'dismissed' }); // opted out
    // one 'booked' recall pointing at a real future appointment
    const kavyaNext = (await c.query(
      `SELECT id FROM appointments WHERE patient_id=$1 AND status='confirmed' ORDER BY appointment_date LIMIT 1`, [pid.kavya])).rows[0];
    await mkRecall({ patientId: pid.kavya, due: dstr(-2), status: 'booked', bookedApptId: kavyaNext ? kavyaNext.id : null });

    // ── FEEDBACK — spread of ratings, keyed per patient (family included) ──
    const RATINGS = [5, 5, 4, 5, 3, 4, 5, 2, 4, 5, 1, 4];
    const COMMENTS = [
      'Dr. Vikram was very gentle, no pain at all.', null,
      'Short wait, in and out quickly.', 'Lovely staff, explained everything.',
      null, 'Reception was a bit slow but treatment was good.',
      'Best dental experience I have had.', 'Felt rushed. Expected more explanation.',
      null, 'My daughter was nervous and they were so patient with her.',
      'Waited 40 minutes past my slot.', null,
    ];
    // ensure both family members get their own feedback rows
    const orderedCompleted = [
      ...completed.filter((x) => x.patientId === pid.lakshmi).slice(0, 1),
      ...completed.filter((x) => x.patientId === pid.aditya).slice(0, 1),
      ...completed.filter((x) => x.patientId !== pid.lakshmi && x.patientId !== pid.aditya),
    ];
    for (let i = 0; i < Math.min(RATINGS.length, orderedCompleted.length); i++) {
      const a = orderedCompleted[i];
      await c.query(
        `INSERT INTO appointment_feedback (appointment_id, patient_id, rating, comment, created_at)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (appointment_id) DO NOTHING`,
        [a.id, a.patientId, RATINGS[i], COMMENTS[i], ago(3 + i)]);
    }

    // ── FRONT-DESK REQUESTS ────────────────────────────────────────────
    await mkRequest({ kind: 'callback', phone: phoneOf('ravi'), patientId: pid.ravi, patientName: 'Ravi Kumar',
      note: 'Wants to discuss cost of implant before booking.', status: 'open', createdDaysAgo: 1 });
    await mkRequest({ kind: 'appointment', phone: phoneOf('nikhil'), patientId: pid.nikhil, patientName: 'Nikhil Rao',
      deptId: RCT, doctorId: VIKRAM, preferredDate: dstr(2), note: 'Dr. Vikram fully booked that day — patient asked to be squeezed in.', status: 'open', createdDaysAgo: 1 });
    await mkRequest({ kind: 'callback', phone: phoneOf('sanjay'), patientName: 'Sanjay Patel',
      note: 'Called about a filling that fell out. Front desk booked him in.', status: 'handled', createdDaysAgo: 3 });

    // ── A LITTLE CONVERSATION HISTORY ─────────────────────────────────
    const waRows = [
      ['in', 'text', 'Hi'],
      ['out', 'text', 'Welcome to Pragati Dental Studio 🦷\nHow can we help?'],
      ['in', 'interactive', 'Book an appointment'],
      ['out', 'text', 'Which treatment is it for?'],
      ['in', 'text', 'Root canal'],
      ['out', 'text', 'With Dr. Vikram Shetty, open times tomorrow: 11:00, 15:00'],
      ['out', 'admin_alert', 'Pragati Dental Studio · New booking · Priya Nair · Root canal · tomorrow 11:00'],
    ];
    for (let i = 0; i < waRows.length; i++) {
      const [dir, type, content] = waRows[i];
      await c.query(
        `INSERT INTO wa_messages (phone, direction, message_type, content, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [type === 'admin_alert' ? P(99) : phoneOf('priya'),
         dir, type, content, ago(1 - i * 0.01)]);
    }

    // ── DOCTOR FLAG: visiting orthodontist ───────────────────────────
    await c.query(`UPDATE doctors SET is_visiting=true WHERE id=$1`, [NISHA]);
  });

  // ── TENANT SETTINGS — make the newest features read as "on" ──────────────
  await query(
    `UPDATE tenants
        SET settings = COALESCE(settings, '{}'::jsonb)
                       || jsonb_build_object(
                            'google_review_url', 'https://g.page/r/pragati-dental-studio/review',
                            'doctor_daily_schedule_enabled', true,
                            'noshow_block_threshold', 3)
      WHERE slug = $1`,
    [DEMO_SLUG]);

  const n = await countRows();
  console.log(`✅ Demo scenario data rebuilt for ${CLINIC_NAME}: `
    + `${n.patients} patients · ${n.appointments} appointments · ${n.treatment_plans} plans · `
    + `${n.treatment_payments} payments · ${n.lab_works} lab items · ${n.patient_recalls} recalls · `
    + `${n.appointment_feedback} feedback · ${n.clinic_requests} requests`);
}

// ── small helpers ───────────────────────────────────────────────────────────
function q(sql, params) { return require('./index').tenantQuery(DEMO_SCHEMA, sql, params); }
function mapBy(rows) { const m = {}; for (const r of rows) m[r.name] = r.id; return m; }
async function countRows() {
  const r = await q(`
    SELECT
      (SELECT COUNT(*) FROM patients)            AS patients,
      (SELECT COUNT(*) FROM appointments)        AS appointments,
      (SELECT COUNT(*) FROM treatment_plans)     AS treatment_plans,
      (SELECT COUNT(*) FROM treatment_payments)  AS treatment_payments,
      (SELECT COUNT(*) FROM lab_works)           AS lab_works,
      (SELECT COUNT(*) FROM patient_recalls)     AS patient_recalls,
      (SELECT COUNT(*) FROM appointment_feedback) AS appointment_feedback,
      (SELECT COUNT(*) FROM clinic_requests)     AS clinic_requests`);
  return r.rows[0];
}

module.exports = { seedDemoData };

if (require.main === module) {
  seedDemoData()
    .then(() => { console.log('done'); process.exit(0); })
    .catch((err) => { console.error('demoData failed:', err); process.exit(1); });
}
