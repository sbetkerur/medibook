#!/usr/bin/env node
/**
 * MediBook Deployment Smoke Test
 * ─────────────────────────────────────────────────────────────
 * Self-contained HTTP test — no local DB required.
 * Creates its own tenant + data, runs the full bot booking &
 * cancellation flow, then reports pass/fail.
 *
 * Usage:
 *   node tests/smoke.test.js [BACKEND_URL]
 *
 * Examples:
 *   node tests/smoke.test.js                                         # localhost
 *   node tests/smoke.test.js https://medibook-backend-xxx.railway.app
 *
 * Requirements:
 *   • Backend must be running with DATABASE_URL set
 *   • Set ENABLE_TEST_ENDPOINT=true on the backend to enable bot flow tests
 *   • Node 18+ (uses built-in fetch)
 */

const BASE = (process.argv[2] || 'http://localhost:3001').replace(/\/$/, '');
const TEST_PHONE = '919000099901';
const SLUG      = 'smoke-' + Date.now().toString(36);

let pass = 0, fail = 0, skipped = 0;
let superToken, tenantToken;
let hospitalId, departmentId, doctorId;
let bookingId;

// ── HELPERS ───────────────────────────────────────────────────
async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data;
    try { data = await res.json(); } catch { data = {}; }
    return { status: res.status, data };
  } catch (err) {
    throw new Error(`Network error calling ${method} ${path}: ${err.message}`);
  }
}

async function bot(message, button_id) {
  return req('POST', '/api/webhook/test', { phone: TEST_PHONE, message, button_id, tenant_slug: SLUG });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅  ${name}`);
    pass++;
    return true;
  } catch (err) {
    console.log(`  ❌  ${name}`);
    console.log(`       → ${err.message}`);
    fail++;
    return false;
  }
}

function skip(name, reason) {
  console.log(`  ⏭   ${name} (skipped: ${reason})`);
  skipped++;
}

// Find the next non-Sunday date as YYYY-MM-DD
function nextWeekday() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ── TEST SECTIONS ─────────────────────────────────────────────
async function testInfrastructure() {
  console.log('\n── 1. Infrastructure ───────────────────────────');

  await test('Health endpoint returns 200', async () => {
    const { status, data } = await req('GET', '/health');
    assert(status === 200, `Got ${status}`);
    assert(data.status === 'ok', `status=${data.status}`);
  });

  await test('Database is reachable (health check)', async () => {
    const { data } = await req('GET', '/health');
    assert(data.status === 'ok', 'DB check failed — status not ok');
  });

  await test('Unknown route returns 404', async () => {
    const { status } = await req('GET', '/api/no-such-route-xyz');
    assert(status === 404, `Expected 404, got ${status}`);
  });
}

async function testAuth() {
  console.log('\n── 2. Authentication ───────────────────────────');

  const ok = await test('Super admin login succeeds', async () => {
    const { status, data } = await req('POST', '/api/auth/superadmin/login', {
      email: 'admin@medibook.com',
      password: 'SuperAdmin@123',
    });
    assert(status === 200, `Got ${status}: ${JSON.stringify(data)}`);
    assert(data.token, 'No token in response');
    assert(data.user?.role === 'super_admin', `Wrong role: ${data.user?.role}`);
    superToken = data.token;
  });

  await test('Wrong password returns 401', async () => {
    const { status } = await req('POST', '/api/auth/superadmin/login', {
      email: 'admin@medibook.com',
      password: 'wrongpassword123',
    });
    assert(status === 401, `Expected 401, got ${status}`);
  });

  await test('Protected route without token returns 401', async () => {
    const { status } = await req('GET', '/api/admin/dashboard');
    assert(status === 401, `Expected 401, got ${status}`);
  });

  return ok;
}

async function testTenantSetup() {
  console.log('\n── 3. Tenant Setup ─────────────────────────────');

  let tenantCreated = false;
  await test('Create test tenant via super admin', async () => {
    const { status, data } = await req('POST', '/api/superadmin/tenants', {
      name: 'Smoke Test Clinic',
      slug: SLUG,
      owner_email: `admin@${SLUG}.com`,
      owner_password: 'Smoke@123456',
      plan: 'starter',
    }, superToken);
    assert(status === 200 || status === 201, `Got ${status}: ${JSON.stringify(data)}`);
    assert(data.tenant?.id, 'No tenant.id in response');
    tenantCreated = true;
  });

  await test('Tenant admin login succeeds', async () => {
    const { status, data } = await req('POST', '/api/auth/login', {
      email: `admin@${SLUG}.com`,
      password: 'Smoke@123456',
      tenant_slug: SLUG,
    });
    assert(status === 200, `Got ${status}: ${JSON.stringify(data)}`);
    assert(data.token, 'No token');
    tenantToken = data.token;
  });

  await test('Dashboard returns stats for new tenant', async () => {
    const { status, data } = await req('GET', '/api/admin/dashboard', null, tenantToken);
    assert(status === 200, `Got ${status}: ${JSON.stringify(data)}`);
    assert(typeof data.today_appointments === 'number', 'Missing today_appointments');
    assert(typeof data.total_patients === 'number', 'Missing total_patients');
    assert(typeof data.available_slots === 'number', 'Missing available_slots');
  });

  return tenantCreated;
}

async function testDataSetup() {
  console.log('\n── 4. Data Setup ───────────────────────────────');

  await test('Create hospital', async () => {
    const { status, data } = await req('POST', '/api/admin/hospitals', {
      name: 'Smoke Test Hospital',
      city: 'Test City',
      address: '1 Smoke Street',
      phone: '9999900000',
    }, tenantToken);
    assert(status === 200 || status === 201, `Got ${status}: ${JSON.stringify(data)}`);
    assert(data.hospital?.id, 'No hospital.id');
    hospitalId = data.hospital.id;
  });

  await test('Create department', async () => {
    const { status, data } = await req('POST', '/api/admin/departments', {
      hospital_id: hospitalId,
      name: 'General Medicine',
    }, tenantToken);
    assert(status === 200 || status === 201, `Got ${status}: ${JSON.stringify(data)}`);
    assert(data.department?.id, 'No department.id');
    departmentId = data.department.id;
  });

  await test('Create doctor', async () => {
    const { status, data } = await req('POST', '/api/admin/doctors', {
      name: 'Smoke Doctor',
      specialization: 'General Physician',
      qualification: 'MBBS',
      hospital_id: hospitalId,
      department_id: departmentId,
      consultation_fee: 300,
      slot_duration_minutes: 30,
    }, tenantToken);
    assert(status === 200 || status === 201, `Got ${status}: ${JSON.stringify(data)}`);
    assert(data.doctor?.id, 'No doctor.id');
    doctorId = data.doctor.id;
  });

  await test('Set doctor schedule (Mon–Sat, 09:00–17:00)', async () => {
    const schedules = [1, 2, 3, 4, 5, 6].map(day => ({
      day_of_week: day, start_time: '09:00', end_time: '17:00', is_working: true,
    }));
    const { status, data } = await req(
      'POST', `/api/admin/doctors/${doctorId}/schedule`, { schedules }, tenantToken
    );
    assert(status === 200, `Got ${status}: ${JSON.stringify(data)}`);
  });

  await test('Generate slots (7 days)', async () => {
    const { status, data } = await req('POST', '/api/admin/slots/generate', {
      doctor_id: doctorId, days: 7,
    }, tenantToken);
    assert(status === 200, `Got ${status}: ${JSON.stringify(data)}`);
    assert(data.generated > 0, `No slots generated (${JSON.stringify(data)})`);
    console.log(`       → ${data.generated} slots created`);
  });
}

async function testBotFlow() {
  console.log('\n── 5. Bot Flow ─────────────────────────────────');

  // Check test endpoint is available
  const probe = await req('POST', '/api/webhook/test', { phone: TEST_PHONE, message: 'Hi' });
  if (probe.status === 404) {
    skip('All bot flow tests', 'ENABLE_TEST_ENDPOINT=true not set on backend');
    return;
  }

  // ── GREETING ─────────────────────────────────────────────────
  await test('Greeting returns welcome message with Book button', async () => {
    const { status, data } = await bot('Hi');
    assert(status === 200, `Got ${status}`);
    const r = data.responses;
    assert(Array.isArray(r) && r.length > 0, 'No responses');
    const welcome = r.find(m => m.text?.includes('Welcome'));
    assert(welcome, `No Welcome message. Got: ${JSON.stringify(r)}`);
    assert(
      welcome.buttons?.some(b => b.includes('Book')),
      `No Book button. Buttons: ${JSON.stringify(welcome.buttons)}`
    );
  });

  // ── BOOKING FLOW ──────────────────────────────────────────────
  await test('Selecting Book starts booking flow', async () => {
    // Re-send Hi to ensure main_menu state, then select Book
    await bot('Hi');
    const { data } = await bot('Book Appointment');
    const r = data.responses;
    assert(r?.length > 0, 'No response after Book Appointment');
    const hasProgress = r.some(m =>
      m.text?.includes('Visit') || m.text?.includes('Hospital') ||
      m.text?.includes('Location') || m.text?.includes('Specialty')
    );
    assert(hasProgress, `Expected booking step. Got: ${JSON.stringify(r)}`);
  });

  await test('Selecting In-Person visit type shows departments', async () => {
    const { data } = await bot('In-Person Visit');
    const r = data.responses;
    assert(r?.length > 0, 'No response');
    const hasDept = r.some(m =>
      m.text?.includes('Specialty') || m.text?.includes('General') ||
      m.text?.includes('department') || m.sections
    );
    assert(hasDept, `Expected department list. Got: ${JSON.stringify(r)}`);
  });

  await test('Selecting department shows doctors', async () => {
    const { data } = await bot('General Medicine');
    const r = data.responses;
    assert(r?.length > 0, 'No response');
    const hasDoc = r.some(m =>
      m.text?.includes('Doctor') || m.text?.includes('Smoke') || m.sections
    );
    assert(hasDoc, `Expected doctor list. Got: ${JSON.stringify(r)}`);
  });

  await test('Selecting doctor shows available dates', async () => {
    const { data } = await bot('Smoke Doctor');
    const r = data.responses;
    assert(r?.length > 0, 'No response');
    const hasDate = r.some(m => m.text?.includes('Date') || m.sections);
    assert(hasDate, `Expected date list. Got: ${JSON.stringify(r)}`);
  });

  const date = nextWeekday();
  await test(`Selecting date (${date}) shows time slots`, async () => {
    const { data } = await bot(date);
    const r = data.responses;
    assert(r?.length > 0, 'No response');
    const hasSlot = r.some(m => m.text?.includes('Slot') || m.text?.includes('Time') || m.sections);
    assert(hasSlot, `Expected slot list. Got: ${JSON.stringify(r)}`);
  });

  await test('Selecting time slot (09:00) proceeds to patient details', async () => {
    const { data } = await bot('09:00');
    const r = data.responses;
    assert(r?.length > 0, 'No response');
    const hasNext = r.some(m =>
      m.text?.includes('Name') || m.text?.includes('Booking Summary') ||
      m.text?.includes('Confirm')
    );
    assert(hasNext, `Expected name prompt or confirmation. Got: ${JSON.stringify(r)}`);
  });

  await test('Entering patient name proceeds to DOB', async () => {
    const { data } = await bot('Test Patient');
    const r = data.responses;
    assert(r?.length > 0, 'No response');
    // Could be DOB prompt (new patient) or confirmation (returning patient)
    const hasNext = r.some(m =>
      m.text?.includes('Birth') || m.text?.includes('DD/MM') ||
      m.text?.includes('Booking Summary') || m.text?.includes('Confirm') ||
      m.text?.includes('Gender')
    );
    assert(hasNext, `Expected DOB or next step. Got: ${JSON.stringify(r)}`);
  });

  await test('Entering DOB (15/08/1990) proceeds to gender', async () => {
    const { data } = await bot('15/08/1990');
    const r = data.responses;
    assert(r?.length > 0, 'No response');
    const hasNext = r.some(m =>
      m.text?.includes('Gender') || m.buttons?.includes('Male') ||
      m.text?.includes('Booking Summary') || m.text?.includes('Confirm')
    );
    assert(hasNext, `Expected gender or confirmation. Got: ${JSON.stringify(r)}`);
  });

  await test('Selecting gender shows booking summary', async () => {
    const { data } = await bot('Male');
    const r = data.responses;
    assert(r?.length > 0, 'No response');
    const hasSummary = r.some(m =>
      m.text?.includes('Booking Summary') || m.text?.includes('Confirm') ||
      m.text?.includes('Doctor')
    );
    assert(hasSummary, `Expected booking summary. Got: ${JSON.stringify(r)}`);
  });

  await test('Confirming booking creates appointment with Booking ID', async () => {
    const { data } = await bot('Yes');
    const r = data.responses;
    assert(r?.length > 0, 'No response');
    const confirmed = r.find(m => m.text?.includes('Confirmed') || m.text?.includes('Booking ID'));
    assert(confirmed, `Expected confirmation. Got: ${JSON.stringify(r)}`);
    const match = confirmed.text.match(/MB[A-Z0-9]+/);
    assert(match, `No booking ID in: ${confirmed.text}`);
    bookingId = match[0];
    console.log(`       → Booking ID: ${bookingId}`);
  });

  // ── MY APPOINTMENTS ───────────────────────────────────────────
  await test('My Appointments shows the booked appointment', async () => {
    await bot('Hi');
    const { data } = await bot('My Appointments');
    const r = data.responses;
    assert(r?.length > 0, 'No response');
    const hasList = r.some(m => m.text?.includes('Upcoming') || m.text?.includes('MB'));
    assert(hasList, `Expected appointments. Got: ${JSON.stringify(r)}`);
  });

  // ── CANCELLATION FLOW ─────────────────────────────────────────
  if (bookingId) {
    await test('Cancel flow prompts for Booking ID', async () => {
      const { data } = await bot('Cancel');
      const r = data.responses;
      assert(r?.length > 0, 'No response');
      const hasPrompt = r.some(m => m.text?.includes('Booking ID') || m.text?.includes('cancel'));
      assert(hasPrompt, `Expected booking ID prompt. Got: ${JSON.stringify(r)}`);
    });

    await test('Entering Booking ID shows cancel confirmation', async () => {
      const { data } = await bot(bookingId);
      const r = data.responses;
      assert(r?.length > 0, 'No response');
      const hasConfirm = r.some(m => m.text?.includes(bookingId) || m.text?.includes('Cancel'));
      assert(hasConfirm, `Expected cancel confirm. Got: ${JSON.stringify(r)}`);
    });

    await test('Confirming cancellation cancels the appointment', async () => {
      const { data } = await bot('Yes, Cancel');
      const r = data.responses;
      assert(r?.length > 0, 'No response');
      const cancelled = r.some(m =>
        m.text?.toLowerCase().includes('cancelled') ||
        m.text?.toLowerCase().includes('canceled')
      );
      assert(cancelled, `Expected cancellation message. Got: ${JSON.stringify(r)}`);
    });
  } else {
    skip('Cancel flow', 'no booking ID captured from previous step');
  }

  // ── EDGE CASES ────────────────────────────────────────────────
  await test('Hi resets conversation from any state', async () => {
    await bot('xyzgarbage_notacommand');
    const { data } = await bot('Hi');
    const r = data.responses;
    assert(r?.length > 0, 'No response to Hi');
    assert(r.some(m => m.text?.includes('Welcome')), `Hi did not reset to welcome. Got: ${JSON.stringify(r)}`);
  });

  await test('Unknown input returns fallback (not a crash)', async () => {
    await bot('Hi');
    const { status, data } = await bot('zzz_no_match_xyz_999_abc');
    assert(status === 200, `Got ${status}`);
    assert(data.responses?.length > 0, 'Bot crashed or gave no response to garbage input');
  });
}

// ── MAIN ──────────────────────────────────────────────────────
async function run() {
  console.log('\n🧪  MediBook Deployment Smoke Test');
  console.log(`    Target: ${BASE}`);
  console.log(`    Tenant: ${SLUG}`);

  await testInfrastructure();
  const authOk = await testAuth();
  if (!authOk) {
    console.log('\n⛔  Super admin login failed — aborting (DB or JWT misconfiguration).');
    process.exit(1);
  }

  const tenantOk = await testTenantSetup();
  if (!tenantOk) {
    console.log('\n⛔  Tenant setup failed — skipping data and bot flow tests.');
  } else {
    await testDataSetup();
    await testBotFlow();
  }

  // ── SUMMARY ──────────────────────────────────────────────────
  const total = pass + fail;
  console.log(`\n${'─'.repeat(48)}`);
  console.log(`  Passed:  ${pass}/${total}`);
  if (fail)    console.log(`  Failed:  ${fail}`);
  if (skipped) console.log(`  Skipped: ${skipped}`);

  if (fail === 0) {
    console.log('\n🎉  All tests passed — deployment is healthy!\n');
  } else {
    console.log('\n⚠️   Some tests failed — check output above.\n');
    process.exit(1);
  }
}

run().catch(err => {
  console.error('\n💥  Fatal:', err.message);
  process.exit(1);
});
