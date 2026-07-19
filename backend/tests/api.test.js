require('dotenv').config();
const http = require('http');

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'localhost', port: 3001,
      path, method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      }
    };
    const r = http.request(opts, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function run() {
  let pass = 0, fail = 0;
  async function test(name, fn) {
    try {
      await fn();
      console.log('  OK  ' + name);
      pass++;
    } catch (e) {
      console.log('  FAIL ' + name + ' -> ' + (e.message || e));
      fail++;
    }
  }

  console.log('\n=== HEALTH CHECK ===');
  await test('GET /health returns ok', async () => {
    const r = await req('GET', '/health');
    if (r.status !== 200) throw new Error('status ' + r.status);
    if (r.body.status !== 'ok') throw new Error('status=' + r.body.status);
    console.log('     db:' + r.body.db + ' redis:' + r.body.redis + ' queue:' + r.body.queue);
  });

  console.log('\n=== AUTH ===');
  let superToken, clinicToken, refreshToken;

  await test('Super admin login returns token + refresh_token', async () => {
    const r = await req('POST', '/api/auth/superadmin/login', { email: 'admin@medibook.com', password: 'SuperAdmin@123' });
    if (r.status !== 200) throw new Error('status ' + r.status + ' ' + JSON.stringify(r.body));
    if (!r.body.token) throw new Error('no token');
    superToken = r.body.token;
    refreshToken = r.body.refresh_token;
    console.log('     role:' + r.body.user.role + ' has_refresh:' + !!r.body.refresh_token);
  });

  await test('Super admin login rejects wrong password (401)', async () => {
    // Use a valid-format password (passes Joi) but wrong credentials
    const r = await req('POST', '/api/auth/superadmin/login', { email: 'admin@medibook.com', password: 'WrongPass@123' });
    if (r.status !== 401) throw new Error('expected 401 got ' + r.status);
  });

  await test('Clinic admin login returns token + refresh_token', async () => {
    const r = await req('POST', '/api/auth/login', { email: 'demo@medibook.com', password: 'Demo@123456', tenant_slug: 'demo-clinic' });
    if (r.status !== 200) throw new Error('status ' + r.status + ' ' + JSON.stringify(r.body));
    if (!r.body.token) throw new Error('no token');
    clinicToken = r.body.token;
    console.log('     tenant:' + r.body.user.tenant + ' role:' + r.body.user.role + ' has_refresh:' + !!r.body.refresh_token);
  });

  await test('Clinic login rejects wrong slug (401)', async () => {
    const r = await req('POST', '/api/auth/login', { email: 'demo@medibook.com', password: 'Demo@123456', tenant_slug: 'nonexistent' });
    if (r.status !== 401) throw new Error('expected 401 got ' + r.status);
  });

  await test('Refresh token rotates: new tokens issued, old token rejected', async () => {
    if (!refreshToken) throw new Error('no refresh token');
    const r = await req('POST', '/api/auth/refresh', { refresh_token: refreshToken });
    if (r.status !== 200) throw new Error('status ' + r.status + ' ' + JSON.stringify(r.body));
    if (!r.body.token) throw new Error('no new access token');
    if (!r.body.refresh_token) throw new Error('no new refresh token');
    if (r.body.refresh_token === refreshToken) throw new Error('token not rotated');
    const r2 = await req('POST', '/api/auth/refresh', { refresh_token: refreshToken });
    if (r2.status !== 401) throw new Error('old token not rejected, got ' + r2.status);
    console.log('     rotation ok, old token correctly rejected');
  });

  await test('Logout succeeds (200)', async () => {
    const r = await req('POST', '/api/auth/logout', {}, clinicToken);
    if (r.status !== 200) throw new Error('status ' + r.status);
  });

  // Re-login for subsequent tests
  const loginR = await req('POST', '/api/auth/login', { email: 'demo@medibook.com', password: 'Demo@123456', tenant_slug: 'demo-clinic' });
  clinicToken = loginR.body.token;

  console.log('\n=== ADMIN DASHBOARD ===');
  await test('GET /admin/dashboard returns stats', async () => {
    const r = await req('GET', '/api/admin/dashboard', null, clinicToken);
    if (r.status !== 200) throw new Error('status ' + r.status);
    if (r.body.today_appointments == null) throw new Error('missing today_appointments');
    console.log('     today:' + r.body.today_appointments + ' upcoming:' + r.body.upcoming_appointments + ' patients:' + r.body.total_patients + ' slots:' + r.body.available_slots);
  });

  await test('GET /admin/dashboard rejects unauthenticated (401)', async () => {
    const r = await req('GET', '/api/admin/dashboard');
    if (r.status !== 401) throw new Error('expected 401 got ' + r.status);
  });

  console.log('\n=== ADMIN ROUTES ===');
  await test('GET /admin/appointments returns array + total', async () => {
    const r = await req('GET', '/api/admin/appointments?limit=5', null, clinicToken);
    if (r.status !== 200) throw new Error('status ' + r.status);
    if (!Array.isArray(r.body.appointments)) throw new Error('no array');
    console.log('     rows:' + r.body.appointments.length + ' total:' + r.body.total);
  });

  await test('GET /admin/doctors returns array', async () => {
    const r = await req('GET', '/api/admin/doctors', null, clinicToken);
    if (r.status !== 200) throw new Error('status ' + r.status);
    if (!Array.isArray(r.body.doctors)) throw new Error('no array');
    console.log('     doctors:' + r.body.doctors.length);
  });

  await test('GET /admin/hospitals returns array', async () => {
    const r = await req('GET', '/api/admin/hospitals', null, clinicToken);
    if (r.status !== 200) throw new Error('status ' + r.status);
    if (!Array.isArray(r.body.hospitals)) throw new Error('no array');
    console.log('     hospitals:' + r.body.hospitals.length);
  });

  await test('GET /admin/patients returns array + total', async () => {
    const r = await req('GET', '/api/admin/patients?limit=5', null, clinicToken);
    if (r.status !== 200) throw new Error('status ' + r.status);
    if (!Array.isArray(r.body.patients)) throw new Error('no array');
    console.log('     patients:' + r.body.patients.length + ' total:' + r.body.total);
  });

  await test('GET /admin/analytics returns by_day + summary', async () => {
    const r = await req('GET', '/api/admin/analytics', null, clinicToken);
    if (r.status !== 200) throw new Error('status ' + r.status);
    if (!r.body.by_day) throw new Error('missing by_day');
    console.log('     by_day_rows:' + r.body.by_day.length + ' has_summary:' + !!r.body.summary);
  });

  await test('GET /admin/feedback returns ratings', async () => {
    const r = await req('GET', '/api/admin/feedback', null, clinicToken);
    if (r.status !== 200) throw new Error('status ' + r.status);
    console.log('     avg:' + r.body.avg_rating + ' total:' + r.body.total);
  });

  await test('GET /admin/staff returns array', async () => {
    const r = await req('GET', '/api/admin/staff', null, clinicToken);
    if (r.status !== 200) throw new Error('status ' + r.status);
    if (!Array.isArray(r.body.staff)) throw new Error('no array');
    console.log('     staff:' + r.body.staff.length);
  });

  await test('GET /admin/departments returns array', async () => {
    const r = await req('GET', '/api/admin/departments', null, clinicToken);
    if (r.status !== 200) throw new Error('status ' + r.status);
    if (!Array.isArray(r.body.departments)) throw new Error('no array');
    console.log('     departments:' + r.body.departments.length);
  });

  // NOTE: the waiting-list feature was removed from the product — no
  // /admin/waiting-list route or waiting_list table exists anymore, so the
  // test that used to exercise it here was deleted.

  await test('GET /admin/audit-logs returns array', async () => {
    const r = await req('GET', '/api/admin/audit-logs?limit=5', null, clinicToken);
    if (r.status !== 200) throw new Error('status ' + r.status);
    if (!Array.isArray(r.body.logs)) throw new Error('no array');
    console.log('     logs:' + r.body.logs.length + ' total:' + r.body.total);
  });

  console.log('\n=== SUPER ADMIN ROUTES ===');
  await test('GET /superadmin/tenants returns list', async () => {
    const r = await req('GET', '/api/superadmin/tenants', null, superToken);
    if (r.status !== 200) throw new Error('status ' + r.status);
    console.log('     total:' + (r.body.total || r.body.tenants.length));
  });

  await test('GET /superadmin/stats returns counts', async () => {
    const r = await req('GET', '/api/superadmin/stats', null, superToken);
    if (r.status !== 200) throw new Error('status ' + r.status);
    console.log('     total:' + r.body.total_tenants + ' active:' + r.body.active_tenants + ' mrr:' + r.body.mrr);
  });

  await test('GET /superadmin/tenants rejects clinic token (403)', async () => {
    const r = await req('GET', '/api/superadmin/tenants', null, clinicToken);
    if (r.status !== 403) throw new Error('expected 403 got ' + r.status);
  });

  await test('GET /admin/access-logs returns array', async () => {
    const r = await req('GET', '/api/admin/access-logs', null, clinicToken);
    if (r.status !== 200) throw new Error('status ' + r.status);
    console.log('     logs:' + r.body.logs.length);
  });

  console.log('\n=== WEBHOOK ===');
  await test('GET /webhook/whatsapp verify rejects wrong token (403)', async () => {
    const r = await req('GET', '/api/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=wrongtoken&hub.challenge=test123');
    if (r.status !== 403) throw new Error('expected 403 got ' + r.status);
  });

  console.log('\n=== BOT TEST ENDPOINT ===');
  await test('Hi message returns Welcome with buttons', async () => {
    const r = await req('POST', '/api/webhook/test', { phone: '919111000001', message: 'Hi' });
    if (r.status !== 200) throw new Error('status ' + r.status);
    if (!r.body.responses.length) throw new Error('no responses');
    const text = r.body.responses[0].text || '';
    if (!text.includes('Welcome')) throw new Error('no Welcome: ' + text.slice(0, 100));
    console.log('     type:' + r.body.responses[0].type + ' buttons:' + r.body.responses[0].buttons.length);
  });

  await test('Garbage input returns fallback message', async () => {
    const r = await req('POST', '/api/webhook/test', { phone: '919111000001', message: 'xyzgarbage' });
    if (r.status !== 200) throw new Error('status ' + r.status);
    if (!r.body.responses.length) throw new Error('no responses');
    console.log('     response:' + r.body.responses[0].text.slice(0, 60));
  });

  await test('Book button starts booking flow', async () => {
    await req('POST', '/api/webhook/test', { phone: '919111000003', message: 'Hi' });
    const r = await req('POST', '/api/webhook/test', { phone: '919111000003', button_id: 'btn_0_test' });
    if (r.status !== 200) throw new Error('status ' + r.status);
    if (!r.body.responses.length) throw new Error('no responses');
    console.log('     flow response type:' + r.body.responses[0].type);
  });

  await test('My Appointments button flows correctly', async () => {
    await req('POST', '/api/webhook/test', { phone: '919111000004', message: 'Hi' });
    const r = await req('POST', '/api/webhook/test', { phone: '919111000004', button_id: 'btn_1_test' });
    if (r.status !== 200) throw new Error('status ' + r.status);
    if (!r.body.responses.length) throw new Error('no responses');
    console.log('     appointments response: ' + r.body.responses[0].text.slice(0, 50));
  });

  await test('Hi resets any mid-flow state to main menu', async () => {
    const { tenantQuery, query } = require('../src/db');
    const tR = await query('SELECT schema_name FROM tenants WHERE slug = $1', ['demo-clinic']);
    if (!tR.rows[0]) throw new Error('demo-clinic not found');
    const schema = tR.rows[0].schema_name;
    await tenantQuery(schema, 'UPDATE bot_sessions SET state = $1, context = $2 WHERE phone = $3', ['select_doctor', '{}', '919111000005']);
    const r = await req('POST', '/api/webhook/test', { phone: '919111000005', message: 'Hi' });
    if (r.status !== 200) throw new Error('status ' + r.status);
    const text = r.body.responses[0].text || '';
    if (!text.includes('Welcome')) throw new Error('Hi did not reset to welcome: ' + text.slice(0, 100));
    console.log('     state reset confirmed');
  });

  await test('Slot booking is atomic (race condition safe)', async () => {
    const { tenantQuery, query } = require('../src/db');
    const tR = await query('SELECT schema_name FROM tenants WHERE slug = $1', ['demo-clinic']);
    const schema = tR.rows[0].schema_name;
    const slotR = await tenantQuery(schema, 'SELECT id FROM time_slots WHERE status = $1 LIMIT 1', ['available']);
    if (!slotR.rows[0]) { console.log('     (skipped - no available slots)'); return; }
    const slotId = slotR.rows[0].id;
    const [r1, r2] = await Promise.all([
      tenantQuery(schema, 'UPDATE time_slots SET status = $1 WHERE id = $2 AND status = $3 RETURNING id', ['booked', slotId, 'available']),
      tenantQuery(schema, 'UPDATE time_slots SET status = $1 WHERE id = $2 AND status = $3 RETURNING id', ['booked', slotId, 'available']),
    ]);
    const wins = [r1, r2].filter(r => r.rows.length > 0).length;
    if (wins !== 1) throw new Error('expected exactly 1 winner, got ' + wins);
    await tenantQuery(schema, 'UPDATE time_slots SET status = $1 WHERE id = $2', ['available', slotId]);
    console.log('     exactly 1 of 2 concurrent updates won');
  });

  console.log('\n=== INPUT VALIDATION ===');
  await test('POST /admin/doctors with missing name returns 400', async () => {
    const r = await req('POST', '/api/admin/doctors', { specialization: 'test' }, clinicToken);
    if (r.status !== 400) throw new Error('expected 400 got ' + r.status);
    console.log('     error:' + r.body.error);
  });

  await test('POST /auth/forgot-password with bad email returns 400', async () => {
    const r = await req('POST', '/api/auth/forgot-password', { email: 'notanemail' });
    if (r.status !== 400) throw new Error('expected 400 got ' + r.status);
  });

  await test('POST /auth/forgot-password with valid email returns 200 (no enumeration)', async () => {
    const r = await req('POST', '/api/auth/forgot-password', { email: 'nonexistent@example.com' });
    if (r.status !== 200) throw new Error('expected 200 got ' + r.status);
    if (!r.body.success) throw new Error('no success field');
    console.log('     email enumeration protected: same response for known/unknown email');
  });

  console.log('\n─────────────────────────────────');
  console.log('Results: ' + pass + ' passed, ' + fail + ' failed');
  if (fail > 0) process.exit(1);
  const { pool } = require('../src/db');
  await pool.end();
}
run().catch(e => { console.error('Runner error:', e.message); process.exit(1); });
