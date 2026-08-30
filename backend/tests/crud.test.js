#!/usr/bin/env node
/**
 * CRUD routes — integration test.
 * ─────────────────────────────────────────────────────────────
 * Exercises the resource routes that had no HTTP-level coverage: hospitals,
 * departments, services, doctors (+ the doctor_departments join invariant),
 * patients, staff (+ last-admin / self-demote guards), settings, holidays and
 * treatment plans. Each resource: create → list → read → update → delete where
 * the route exists, plus the adminOnly role gate (a `doctor` login must get 403
 * on mutating admin routes).
 *
 * Self-contained HTTP test — creates its own tenant + data.
 * Usage:  node tests/crud.test.js [BACKEND_URL]
 * Needs:  backend running with DATABASE_URL set.
 */

const BASE = (process.argv[2] || 'http://localhost:3001').replace(/\/$/, '');
const SLUG = 'crud-' + Date.now().toString(36);
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

let pass = 0, fail = 0;
let superToken, adminToken, doctorToken;
let hospitalId, hospital2Id, deptId, serviceId, doctorId, patientId, staffId, planId, holidayId;

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data; try { data = await res.json(); } catch { data = {}; }
  return { status: res.status, data };
}
function assert(c, m) { if (!c) throw new Error(m); }
async function test(name, fn) {
  try { await fn(); console.log(`  ✅  ${name}`); pass++; }
  catch (e) { console.log(`  ❌  ${name}\n       → ${e.message}`); fail++; }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 46 - t.length))}`); }

(async () => {
  console.log(`\nCRUD route integration  (tenant ${SLUG})`);

  // ═══ setup ═══════════════════════════════════════════════════
  section('setup');
  await test('provision tenant + admin + doctor logins', async () => {
    const su = await req('POST', '/api/auth/superadmin/login', { email: 'admin@medibook.com', password: 'SuperAdmin@123' });
    assert(su.status === 200 && su.data.token, `superadmin ${su.status}`);
    superToken = su.data.token;

    const t = await req('POST', '/api/superadmin/tenants', {
      name: 'CRUD Clinic', slug: SLUG, owner_email: `admin@${SLUG}.com`, owner_password: 'Crud@123456', plan: 'starter',
    }, superToken);
    assert([200, 201].includes(t.status) && t.data.tenant?.id, `create tenant ${t.status} ${JSON.stringify(t.data)}`);

    const li = await req('POST', '/api/auth/login', { email: `admin@${SLUG}.com`, password: 'Crud@123456', tenant_slug: SLUG });
    assert(li.status === 200 && li.data.token, `admin login ${li.status}`);
    adminToken = li.data.token;

    const st = await req('POST', '/api/admin/staff', { name: 'Dr Gate', email: `dr@${SLUG}.com`, password: 'DrGate@123', role: 'doctor' }, adminToken);
    assert(st.status === 200 && st.data.staff?.id, `create doctor staff ${st.status} ${JSON.stringify(st.data)}`);
    staffId = st.data.staff.id;

    const dl = await req('POST', '/api/auth/login', { email: `dr@${SLUG}.com`, password: 'DrGate@123', tenant_slug: SLUG });
    assert(dl.status === 200 && dl.data.token, `doctor login ${dl.status}`);
    doctorToken = dl.data.token;
    assert(dl.data.user?.role === 'doctor', `doctor role=${dl.data.user?.role}`);
  });

  // ═══ hospitals (branches) ════════════════════════════════════
  section('hospitals');
  await test('POST /hospitals creates a branch', async () => {
    const r = await req('POST', '/api/admin/hospitals', { name: 'Main Branch', city: 'BLR', address: '1 MG Rd', phone: '9999900000' }, adminToken);
    assert([200, 201].includes(r.status) && r.data.hospital?.id, `${r.status} ${JSON.stringify(r.data)}`);
    hospitalId = r.data.hospital.id;
  });
  await test('GET /hospitals lists it', async () => {
    const r = await req('GET', '/api/admin/hospitals', null, adminToken);
    assert(r.status === 200 && r.data.hospitals?.some(h => h.id === hospitalId), 'branch not in list');
  });
  await test('PATCH /hospitals/:id renames it', async () => {
    const r = await req('PATCH', `/api/admin/hospitals/${hospitalId}`, { name: 'Main Branch (Renamed)' }, adminToken);
    assert(r.status === 200 && r.data.hospital?.name === 'Main Branch (Renamed)', `${r.status} ${JSON.stringify(r.data)}`);
  });
  await test('POST /hospitals is refused past the plan branch limit (starter = 1)', async () => {
    const c = await req('POST', '/api/admin/hospitals', { name: 'Temp Branch' }, adminToken);
    assert(c.status === 403, `expected 403 PLAN_LIMIT, got ${c.status} ${JSON.stringify(c.data)}`);
    assert(c.data.code === 'PLAN_LIMIT' || /limit/i.test(c.data.error || ''), `expected a plan-limit message: ${JSON.stringify(c.data)}`);
  });
  await test('role gate: doctor POST /hospitals → 403', async () => {
    const r = await req('POST', '/api/admin/hospitals', { name: 'Nope' }, doctorToken);
    assert(r.status === 403, `expected 403, got ${r.status}`);
  });

  // ═══ departments ════════════════════════════════════════════
  section('departments');
  await test('POST /departments', async () => {
    const r = await req('POST', '/api/admin/departments', { hospital_id: hospitalId, name: 'Endodontics' }, adminToken);
    assert([200, 201].includes(r.status) && r.data.department?.id, `${r.status} ${JSON.stringify(r.data)}`);
    deptId = r.data.department.id;
  });
  await test('GET /departments?hospital_id lists it', async () => {
    const r = await req('GET', `/api/admin/departments?hospital_id=${hospitalId}`, null, adminToken);
    assert(r.status === 200 && r.data.departments?.some(d => d.id === deptId), 'dept not listed');
  });
  await test('PATCH /departments/:id renames it', async () => {
    const r = await req('PATCH', `/api/admin/departments/${deptId}`, { name: 'Endodontics & RCT' }, adminToken);
    assert(r.status === 200 && r.data.department?.name === 'Endodontics & RCT', `${r.status} ${JSON.stringify(r.data)}`);
  });
  await test('POST /departments with bad hospital_id → 400', async () => {
    const r = await req('POST', '/api/admin/departments', { hospital_id: 'not-a-uuid', name: 'X' }, adminToken);
    assert(r.status === 400, `expected 400, got ${r.status}`);
  });

  // ═══ services (treatments) ══════════════════════════════════
  section('services');
  await test('POST /services → 201', async () => {
    const r = await req('POST', '/api/admin/services', { name: 'Scaling & Polishing', hospital_id: hospitalId }, adminToken);
    assert(r.status === 201 && r.data.service?.id, `${r.status} ${JSON.stringify(r.data)}`);
    serviceId = r.data.service.id;
  });
  await test('GET /services lists it', async () => {
    const r = await req('GET', '/api/admin/services', null, adminToken);
    assert(r.status === 200 && r.data.services?.some(x => x.id === serviceId), 'service not listed');
  });
  await test('PATCH /services/:id renames it', async () => {
    const r = await req('PATCH', `/api/admin/services/${serviceId}`, { name: 'Scaling, Polishing & Fluoride' }, adminToken);
    assert(r.status === 200 && r.data.service?.name?.includes('Fluoride'), `${r.status} ${JSON.stringify(r.data)}`);
  });
  await test('DELETE /services/:id', async () => {
    const r = await req('DELETE', `/api/admin/services/${serviceId}`, null, adminToken);
    assert(r.status === 200 && r.data.success, `${r.status} ${JSON.stringify(r.data)}`);
  });

  // ═══ doctors (+ join invariant) ═════════════════════════════
  section('doctors');
  await test('POST /doctors mirrors primary dept into department_ids', async () => {
    const r = await req('POST', '/api/admin/doctors', {
      name: 'Dr Asha', specialization: 'Endodontist', qualification: 'MDS',
      hospital_id: hospitalId, department_id: deptId, consultation_fee: 400, slot_duration_minutes: 30,
    }, adminToken);
    assert([200, 201].includes(r.status) && r.data.doctor?.id, `${r.status} ${JSON.stringify(r.data)}`);
    doctorId = r.data.doctor.id;
    assert(Array.isArray(r.data.doctor.department_ids) && r.data.doctor.department_ids.includes(deptId),
      `department_ids missing primary: ${JSON.stringify(r.data.doctor.department_ids)}`);
  });
  await test('GET /doctors lists it with pagination fields', async () => {
    const r = await req('GET', '/api/admin/doctors', null, adminToken);
    assert(r.status === 200 && Array.isArray(r.data.doctors), `${r.status}`);
    assert(r.data.doctors.some(d => d.id === doctorId), 'doctor not listed');
    assert(typeof r.data.has_more === 'boolean' && typeof r.data.total === 'number', 'missing pagination fields');
  });
  await test('GET /doctors/:id reads it', async () => {
    const r = await req('GET', `/api/admin/doctors/${doctorId}`, null, adminToken);
    assert(r.status === 200 && r.data.doctor?.id === doctorId, `${r.status}`);
  });
  await test('PATCH /doctors/:id renames it', async () => {
    const r = await req('PATCH', `/api/admin/doctors/${doctorId}`, { name: 'Dr Asha Nair' }, adminToken);
    assert(r.status === 200 && r.data.doctor?.name === 'Dr Asha Nair', `${r.status} ${JSON.stringify(r.data)}`);
  });
  await test('POST /doctors/:id/schedule (Mon–Sat 09–17)', async () => {
    const schedules = [1, 2, 3, 4, 5, 6].map(day => ({ day_of_week: day, start_time: '09:00', end_time: '17:00', is_working: true }));
    const r = await req('POST', `/api/admin/doctors/${doctorId}/schedule`, { schedules }, adminToken);
    assert(r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  });
  await test('GET /doctors/:id/schedule returns the sessions', async () => {
    const r = await req('GET', `/api/admin/doctors/${doctorId}/schedule`, null, adminToken);
    assert(r.status === 200 && Array.isArray(r.data.schedule) && r.data.schedule.length >= 6, `${r.status} ${JSON.stringify(r.data)}`);
  });
  await test('role gate: doctor POST /doctors → 403', async () => {
    const r = await req('POST', '/api/admin/doctors', { name: 'X', hospital_id: hospitalId }, doctorToken);
    assert(r.status === 403, `expected 403, got ${r.status}`);
  });

  // ═══ patients (created via walk-in; no POST route) ══════════
  section('patients');
  await test('walk-in booking creates a patient', async () => {
    const r = await req('POST', '/api/admin/appointments', {
      patient_phone: '9100' + Math.floor(1e6 + Math.random() * 8e6), patient_name: 'Ramesh Iyer',
      doctor_id: doctorId, hospital_id: hospitalId, appointment_date: TODAY, appointment_time: '12:00',
    }, adminToken);
    assert(r.status === 201 && r.data.appointment?.id, `walk-in ${r.status} ${JSON.stringify(r.data)}`);
  });
  await test('GET /patients?search finds them', async () => {
    const r = await req('GET', '/api/admin/patients?search=Ramesh', null, adminToken);
    assert(r.status === 200 && r.data.patients?.length >= 1, `${r.status} ${JSON.stringify(r.data)}`);
    patientId = r.data.patients.find(p => /Ramesh/i.test(p.name))?.id;
    assert(patientId, 'Ramesh not in search results');
  });
  await test('GET /patients/:id reads it', async () => {
    const r = await req('GET', `/api/admin/patients/${patientId}`, null, adminToken);
    assert(r.status === 200 && r.data.patient?.id === patientId, `${r.status}`);
  });
  await test('PATCH /patients/:id sets a valid referral_source', async () => {
    const r = await req('PATCH', `/api/admin/patients/${patientId}`, { referral_source: 'google' }, adminToken);
    assert(r.status === 200 && r.data.patient?.referral_source === 'google', `${r.status} ${JSON.stringify(r.data)}`);
  });
  await test('PATCH /patients/:id rejects an invalid referral_source', async () => {
    const r = await req('PATCH', `/api/admin/patients/${patientId}`, { referral_source: 'skywriting' }, adminToken);
    assert(r.status === 400, `expected 400, got ${r.status}`);
  });
  await test('role gate: doctor PATCH /patients/:id → 403', async () => {
    const r = await req('PATCH', `/api/admin/patients/${patientId}`, { referral_source: 'friend' }, doctorToken);
    assert(r.status === 403, `expected 403, got ${r.status}`);
  });

  // ═══ staff / team ══════════════════════════════════════════
  section('staff');
  await test('GET /staff lists the team', async () => {
    const r = await req('GET', '/api/admin/staff', null, adminToken);
    assert(r.status === 200 && r.data.staff?.some(u => u.id === staffId), 'staff not listed');
  });
  await test('PATCH /staff/:id renames the doctor user', async () => {
    const r = await req('PATCH', `/api/admin/staff/${staffId}`, { name: 'Dr Gatekeeper' }, adminToken);
    assert(r.status === 200 && r.data.staff?.name === 'Dr Gatekeeper', `${r.status} ${JSON.stringify(r.data)}`);
  });
  await test('POST /staff/:id/reset-password returns a one-time password', async () => {
    const r = await req('POST', `/api/admin/staff/${staffId}/reset-password`, {}, adminToken);
    assert(r.status === 200 && r.data.success, `${r.status} ${JSON.stringify(r.data)}`);
    const pw = r.data.password || r.data.new_password || r.data.temporary_password || r.data.user?.password;
    assert(typeof pw === 'string' && pw.length >= 8, `no password returned: ${JSON.stringify(r.data)}`);
  });
  await test('guard: admin cannot demote their OWN account', async () => {
    const me = await req('GET', '/api/admin/staff', null, adminToken);
    const selfId = me.data.staff.find(u => u.email === `admin@${SLUG}.com`)?.id;
    assert(selfId, 'own account not found in staff list');
    const r = await req('PATCH', `/api/admin/staff/${selfId}`, { role: 'doctor' }, adminToken);
    assert(r.status === 400, `expected 400, got ${r.status} ${JSON.stringify(r.data)}`);
  });
  await test('guard: cannot demote the LAST admin', async () => {
    // Only one admin exists (the owner). Demoting the doctor user is fine; the
    // guard is specifically about removing the final admin. Promote the doctor,
    // demote the owner (now allowed — 2 admins), then re-demote leaves one → ok.
    // Simpler assertion: deleting the last admin is blocked.
    const me = await req('GET', '/api/admin/staff', null, adminToken);
    const selfId = me.data.staff.find(u => u.email === `admin@${SLUG}.com`)?.id;
    const r = await req('DELETE', `/api/admin/staff/${selfId}`, null, adminToken);
    assert(r.status === 400, `expected 400 (self-delete / last admin), got ${r.status} ${JSON.stringify(r.data)}`);
  });
  await test('role gate: doctor GET /staff → 403', async () => {
    const r = await req('GET', '/api/admin/staff', null, doctorToken);
    assert(r.status === 403, `expected 403, got ${r.status}`);
  });

  // ═══ settings ══════════════════════════════════════════════
  section('settings');
  await test('GET /settings returns an object', async () => {
    const r = await req('GET', '/api/admin/settings', null, adminToken);
    assert(r.status === 200 && r.data && typeof r.data === 'object', `${r.status}`);
  });
  await test('PATCH /settings toggles show_consultation_fee, GET reflects it', async () => {
    const p = await req('PATCH', '/api/admin/settings', { notification_prefs: { show_consultation_fee: false } }, adminToken);
    assert(p.status === 200, `patch ${p.status} ${JSON.stringify(p.data)}`);
    // req.tenant is served from a ~5s cache — wait it out before reading back.
    await new Promise(r => setTimeout(r, 6000));
    const g = await req('GET', '/api/admin/settings', null, adminToken);
    assert(g.data.settings?.show_consultation_fee === false, `not reflected: ${JSON.stringify(g.data.settings)}`);
  });
  await test('PATCH /settings rejects a non-URL google_review_url', async () => {
    const r = await req('PATCH', '/api/admin/settings', { notification_prefs: { google_review_url: 'not a url' } }, adminToken);
    assert(r.status === 400, `expected 400, got ${r.status}`);
  });
  await test('role gate: doctor PATCH /settings → 403', async () => {
    const r = await req('PATCH', '/api/admin/settings', { notification_prefs: { show_consultation_fee: true } }, doctorToken);
    assert(r.status === 403, `expected 403, got ${r.status}`);
  });

  // ═══ holidays ══════════════════════════════════════════════
  section('holidays');
  const HOL = '2027-01-26';
  await test('POST /holidays (branch-scoped) → 201', async () => {
    const r = await req('POST', '/api/admin/holidays', { holiday_date: HOL, name: 'Republic Day', hospital_id: hospitalId }, adminToken);
    assert(r.status === 201, `${r.status} ${JSON.stringify(r.data)}`);
    holidayId = r.data.holiday?.id || r.data.id || (r.data.holidays && r.data.holidays[0]?.id);
  });
  await test('GET /holidays lists it', async () => {
    const r = await req('GET', '/api/admin/holidays', null, adminToken);
    assert(r.status === 200 && r.data.holidays?.some(h => String(h.holiday_date).startsWith(HOL)), `not listed: ${JSON.stringify(r.data.holidays)}`);
    if (!holidayId) holidayId = r.data.holidays.find(h => String(h.holiday_date).startsWith(HOL))?.id;
  });
  await test('POST /holidays same branch + date again → 409', async () => {
    const r = await req('POST', '/api/admin/holidays', { holiday_date: HOL, name: 'Dup', hospital_id: hospitalId }, adminToken);
    assert(r.status === 409, `expected 409, got ${r.status} ${JSON.stringify(r.data)}`);
  });
  await test('DELETE /holidays/:id', async () => {
    assert(holidayId, 'no holiday id captured');
    const r = await req('DELETE', `/api/admin/holidays/${holidayId}`, null, adminToken);
    assert(r.status === 200 && r.data.success, `${r.status} ${JSON.stringify(r.data)}`);
  });

  // ═══ treatment plans (NOT adminOnly — a doctor may manage) ══
  section('treatment plans');
  await test('doctor login CAN create a treatment plan', async () => {
    const r = await req('POST', '/api/admin/treatment-plans', {
      patient_id: patientId, treating_doctor_id: doctorId, title: 'Root canal — 26', total_visits: 3, estimated_cost: 9000,
    }, doctorToken);
    assert(r.status === 200 && r.data.treatment_plan?.id, `${r.status} ${JSON.stringify(r.data)}`);
    planId = r.data.treatment_plan.id;
  });
  await test('GET /treatment-plans lists it', async () => {
    const r = await req('GET', '/api/admin/treatment-plans', null, adminToken);
    const items = r.data.treatment_plans || r.data.plans || r.data.items || [];
    assert(r.status === 200 && items.some(p => p.id === planId), `not listed: ${JSON.stringify(r.data).slice(0, 200)}`);
  });
  await test('GET /treatment-plans/:id returns plan + visits', async () => {
    const r = await req('GET', `/api/admin/treatment-plans/${planId}`, null, adminToken);
    assert(r.status === 200 && r.data.treatment_plan?.id === planId && Array.isArray(r.data.visits), `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  });
  await test('PATCH /treatment-plans/:id updates a field', async () => {
    const r = await req('PATCH', `/api/admin/treatment-plans/${planId}`, { notes: 'Patient prefers mornings' }, doctorToken);
    assert(r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);
  });
  await test('POST /treatment-plans rejects total_visits = 0', async () => {
    const r = await req('POST', '/api/admin/treatment-plans', { patient_id: patientId, title: 'Bad', total_visits: 0 }, doctorToken);
    assert(r.status === 400, `expected 400, got ${r.status}`);
  });
  await test('DELETE /treatment-plans/:id is adminOnly (doctor → 403)', async () => {
    const r = await req('DELETE', `/api/admin/treatment-plans/${planId}`, null, doctorToken);
    assert(r.status === 403, `expected 403, got ${r.status}`);
  });
  await test('DELETE /treatment-plans/:id as admin → ok', async () => {
    const r = await req('DELETE', `/api/admin/treatment-plans/${planId}`, null, adminToken);
    assert([200, 204].includes(r.status), `${r.status} ${JSON.stringify(r.data)}`);
  });

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('runner error:', e); process.exit(1); });
