#!/usr/bin/env node
/**
 * Day-close ↔ per-appointment payment reconciliation — integration test.
 * ─────────────────────────────────────────────────────────────────────
 * Covers the money path CLAUDE.md flags as historically wrong: `collected_total`
 * counts ONLY fees actually MARKED paid (not every completed visit), un-marked
 * completed visits surface as `pending_count` / `fees_pending`, a `waived` fee is
 * neither collected nor pending, and `payment_method` splits into
 * `consultation_payments.by_method`. Also checks APPOINTMENT_TRANSITIONS is
 * enforced on the single-appointment PATCH route (completed is terminal).
 *
 * Self-contained HTTP test — creates its own tenant + data.
 *
 * Usage:   node tests/dayClosePayments.test.js [BACKEND_URL]
 * Needs:   backend running with DATABASE_URL set (bot/test endpoint NOT needed —
 *          bookings here go through the admin walk-in route).
 */

const BASE = (process.argv[2] || 'http://localhost:3001').replace(/\/$/, '');
const SLUG = 'dcpay-' + Date.now().toString(36);
const FEE = 300; // doctor's consultation_fee

let pass = 0, fail = 0;
let superToken, tenantToken, hospitalId, departmentId, doctorId;
let apptPaid, apptWaived, apptTerminal;

// IST "today", exactly as middleware/validate.js computes it for the walk-in guard.
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let data; try { data = await res.json(); } catch { data = {}; }
  return { status: res.status, data };
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function test(name, fn) {
  try { await fn(); console.log(`  ✅  ${name}`); pass++; }
  catch (err) { console.log(`  ❌  ${name}\n       → ${err.message}`); fail++; }
}
const dayClose = () => req('GET', `/api/admin/day-close?date=${TODAY}`, null, tenantToken);
async function bookWalkin(name, time) {
  const { status, data } = await req('POST', '/api/admin/appointments', {
    patient_phone: '9100' + Math.floor(1e6 + Math.random() * 8e6),
    patient_name: name,
    doctor_id: doctorId,
    hospital_id: hospitalId,
    appointment_date: TODAY,
    appointment_time: time,
  }, tenantToken);
  assert(status === 201, `walk-in ${name}: got ${status} ${JSON.stringify(data)}`);
  assert(data.appointment?.id, `walk-in ${name}: no appointment.id`);
  assert(data.appointment.status === 'confirmed', `walk-in ${name}: status=${data.appointment.status}`);
  return data.appointment.id;
}
const patch = (id, body) => req('PATCH', `/api/admin/appointments/${id}`, body, tenantToken);

(async () => {
  console.log(`\nDay-close payment reconciliation  (tenant ${SLUG}, date ${TODAY})\n`);

  // ── setup ────────────────────────────────────────────────────
  await test('super admin + tenant provisioned', async () => {
    const su = await req('POST', '/api/auth/superadmin/login',
      { email: 'admin@medibook.com', password: 'SuperAdmin@123' });
    assert(su.status === 200 && su.data.token, `superadmin login ${su.status}`);
    superToken = su.data.token;

    const t = await req('POST', '/api/superadmin/tenants', {
      name: 'Day Close Pay Clinic', slug: SLUG,
      owner_email: `admin@${SLUG}.com`, owner_password: 'DcPay@123456', plan: 'starter',
    }, superToken);
    assert([200, 201].includes(t.status) && t.data.tenant?.id, `create tenant ${t.status} ${JSON.stringify(t.data)}`);

    const login = await req('POST', '/api/auth/login',
      { email: `admin@${SLUG}.com`, password: 'DcPay@123456', tenant_slug: SLUG });
    assert(login.status === 200 && login.data.token, `tenant login ${login.status}`);
    tenantToken = login.data.token;
  });

  await test('hospital + department + doctor created', async () => {
    const h = await req('POST', '/api/admin/hospitals',
      { name: 'DC Branch', city: 'Test', address: '1 Test Rd', phone: '9999900000' }, tenantToken);
    assert([200, 201].includes(h.status) && h.data.hospital?.id, `hospital ${h.status}`);
    hospitalId = h.data.hospital.id;

    const d = await req('POST', '/api/admin/departments',
      { hospital_id: hospitalId, name: 'General Dentistry' }, tenantToken);
    assert([200, 201].includes(d.status) && d.data.department?.id, `department ${d.status}`);
    departmentId = d.data.department.id;

    const doc = await req('POST', '/api/admin/doctors', {
      name: 'DC Doctor', specialization: 'General', qualification: 'BDS',
      hospital_id: hospitalId, department_id: departmentId,
      consultation_fee: FEE, slot_duration_minutes: 30,
    }, tenantToken);
    assert([200, 201].includes(doc.status) && doc.data.doctor?.id, `doctor ${doc.status} ${JSON.stringify(doc.data)}`);
    doctorId = doc.data.doctor.id;
  });

  // ── baseline ─────────────────────────────────────────────────
  let base;
  await test('day-close baseline reads zero for a fresh tenant', async () => {
    const { status, data } = await dayClose();
    assert(status === 200, `day-close ${status} ${JSON.stringify(data)}`);
    assert(data.collected_total === 0, `collected_total=${data.collected_total}, expected 0`);
    assert((data.appointments?.pending_count || 0) === 0, `pending_count=${data.appointments?.pending_count}`);
    base = data;
  });

  await test('three walk-ins booked for today', async () => {
    apptPaid    = await bookWalkin('Paid Patient',    '10:00');
    apptWaived  = await bookWalkin('Waived Patient',  '10:30');
    apptTerminal = await bookWalkin('Terminal Patient', '11:00');
  });

  // ── completed-but-unmarked shows as PENDING, not collected ────
  await test('completing a visit moves it to pending_count, not collected_total', async () => {
    const r = await patch(apptPaid, { status: 'completed' });
    assert(r.status === 200, `complete ${r.status} ${JSON.stringify(r.data)}`);

    const { data } = await dayClose();
    assert(data.appointments.pending_count === 1, `pending_count=${data.appointments.pending_count}, expected 1`);
    assert(data.appointments.fees_pending === FEE, `fees_pending=${data.appointments.fees_pending}, expected ${FEE}`);
    assert(data.collected_total === 0, `collected_total=${data.collected_total}, expected still 0 (nothing marked paid)`);
  });

  // ── marking paid moves it into collected_total + by_method ────
  await test('marking paid (UPI) clears pending and adds to collected_total by method', async () => {
    const r = await patch(apptPaid, { payment_status: 'paid', payment_method: 'upi' });
    assert(r.status === 200, `pay ${r.status} ${JSON.stringify(r.data)}`);
    assert(r.data.appointment.payment_status === 'paid', `payment_status=${r.data.appointment.payment_status}`);
    assert(r.data.appointment.payment_method === 'upi', `payment_method=${r.data.appointment.payment_method}`);

    const { data } = await dayClose();
    assert(data.appointments.pending_count === 0, `pending_count=${data.appointments.pending_count}, expected 0`);
    assert(data.collected_total === FEE, `collected_total=${data.collected_total}, expected ${FEE}`);
    const upi = (data.consultation_payments.by_method || []).find(m => m.method === 'upi');
    assert(upi, `no upi row in consultation_payments.by_method: ${JSON.stringify(data.consultation_payments.by_method)}`);
    assert(Number(upi.amount) === FEE, `upi amount=${upi.amount}, expected ${FEE}`);
  });

  // ── waived is neither collected nor pending ──────────────────
  await test('a waived fee counts as neither collected nor pending', async () => {
    let r = await patch(apptWaived, { status: 'completed' });
    assert(r.status === 200, `complete ${r.status}`);
    r = await patch(apptWaived, { payment_status: 'waived' });
    assert(r.status === 200, `waive ${r.status} ${JSON.stringify(r.data)}`);

    const { data } = await dayClose();
    assert(data.appointments.waived_count === 1, `waived_count=${data.appointments.waived_count}, expected 1`);
    assert(data.appointments.pending_count === 0, `pending_count=${data.appointments.pending_count}, expected 0`);
    assert(data.collected_total === FEE, `collected_total=${data.collected_total}, expected ${FEE} (waived adds nothing)`);
  });

  // ── APPOINTMENT_TRANSITIONS enforced on the single PATCH ─────
  await test('completed is terminal — PATCH back to confirmed is rejected', async () => {
    let r = await patch(apptTerminal, { status: 'completed' });
    assert(r.status === 200, `complete ${r.status}`);
    r = await patch(apptTerminal, { status: 'confirmed' });
    assert(r.status === 400 || r.status === 409, `illegal transition returned ${r.status} ${JSON.stringify(r.data)}`);
  });

  await test('non-admin-style illegal payment_status is rejected', async () => {
    const r = await patch(apptPaid, { payment_status: 'refunded' });
    assert(r.status === 400, `bad payment_status returned ${r.status}`);
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('runner error:', e); process.exit(1); });
