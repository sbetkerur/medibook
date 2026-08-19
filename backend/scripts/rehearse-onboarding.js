/**
 * ONBOARDING REHEARSAL — run against DEV.
 *
 * Production has zero clinics, so every step of onboarding the first one is a
 * path nothing has exercised since the environments split. This walks the whole
 * thing through the real HTTP APIs (not the database), then proves the finished
 * clinic is reachable by a patient through PRODUCTION's webhook — which is the
 * part that actually decides whether a clinic can be sold.
 */
const { execSync } = require('child_process');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const DEV_API = 'https://backend-dev-cef3.up.railway.app';
const PROD_WEBHOOK = 'https://api.pragatisolutions.com/api/webhook/whatsapp';
const ROOT = __dirname + '/../..';

const SLUG = 'rehearsal-dental';
const SUPER_EMAIL = 'admin@medibook.com';
const SUPER_PW = 'Rehearse@2026!';
const OWNER_EMAIL = 'owner@rehearsaldental.in';
const OWNER_PW = 'Rehearse@2026!';
const PATIENT = '910000000077';

function V(service, env) {
  const o = execSync(`railway variables --service ${service} --environment ${env} --kv`,
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const m = {}; o.split(/\r?\n/).forEach(l => { const i = l.indexOf('='); if (i > 0) m[l.slice(0, i)] = l.slice(i + 1).trim(); });
  return m;
}

// Refuses to run anywhere but dev. This resets a super-admin password and
// creates/destroys a tenant — safe against a disposable environment, never
// against one with real clinics in it.
function assertDev(devUrl, prodUrl) {
  if (!devUrl) throw new Error('no dev DATABASE_PUBLIC_URL');
  if (devUrl === prodUrl) throw new Error('REFUSING: dev and production point at the same database');
  if (DEV_API.includes('api.pragatisolutions.com')) throw new Error('REFUSING: DEV_API points at production');
}
const step = (n, s) => console.log(`\n${n}. ${s}`);
const ok = s => console.log('   ✓ ' + s);
const bad = s => { console.log('   ✗ ' + s); process.exitCode = 1; };

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(DEV_API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

(async () => {
  const devPg = V('Postgres', 'dev');
  const prodBackend = V('backend', 'production');
  assertDev(devPg.DATABASE_PUBLIC_URL, V('Postgres', 'production').DATABASE_PUBLIC_URL);
  const pool = new Pool({ connectionString: devPg.DATABASE_PUBLIC_URL, ssl: { rejectUnauthorized: false } });

  // ── 0. clean slate ────────────────────────────────────────────────────
  step(0, 'Clearing any previous rehearsal');
  const prev = await pool.query(`SELECT schema_name FROM tenants WHERE slug=$1`, [SLUG]);
  for (const r of prev.rows) await pool.query(`DROP SCHEMA IF EXISTS "${r.schema_name}" CASCADE`);
  await pool.query(`DELETE FROM global_bot_sessions WHERE phone=$1`, [PATIENT]);
  await pool.query(`DELETE FROM tenants WHERE slug=$1`, [SLUG]);
  ok('clean');

  // The super admin row was copied from production and its password is unknown;
  // migrate's seed is ON CONFLICT DO NOTHING so it cannot be re-set by env var.
  await pool.query(`UPDATE super_admins SET password_hash=$1 WHERE email=$2`,
    [await bcrypt.hash(SUPER_PW, 12), SUPER_EMAIL]);
  ok('dev super-admin password set for the rehearsal');

  // ── 1. platform: create the clinic ────────────────────────────────────
  step(1, 'Super admin logs in and creates the clinic');
  const login = await api('/api/auth/superadmin/login', {
    method: 'POST', body: { email: SUPER_EMAIL, password: SUPER_PW },
  });
  const superToken = login.json?.token || login.json?.accessToken;
  if (!superToken) return bad(`superadmin login failed: ${login.status} ${JSON.stringify(login.json).slice(0, 160)}`);
  ok('super admin authenticated');

  const created = await api('/api/superadmin/tenants', {
    method: 'POST', token: superToken,
    body: {
      name: 'Rehearsal Dental', slug: SLUG,
      owner_email: OWNER_EMAIL, owner_password: OWNER_PW,
      owner_name: 'Rehearsal Owner', plan: 'starter', city: 'Bengaluru',
    },
  });
  if (created.status >= 300) return bad(`create tenant: ${created.status} ${JSON.stringify(created.json).slice(0, 200)}`);
  ok('tenant created via POST /superadmin/tenants');

  const t = (await pool.query(
    `SELECT id, schema_name, entry_code, plan, status FROM tenants WHERE slug=$1`, [SLUG])).rows[0];
  if (!t) return bad('tenant row missing');
  if (!t.entry_code) return bad('NO ENTRY CODE MINTED — the clinic would be unreachable');
  ok(`entry code minted: ${t.entry_code}  (plan ${t.plan}, ${t.status})`);

  const schemaOk = await pool.query(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name=$1`, [t.schema_name]);
  schemaOk.rowCount ? ok(`schema created: ${t.schema_name}`) : bad('schema NOT created');

  const admin = await pool.query(`SELECT email, role FROM "${t.schema_name}".users`);
  admin.rowCount ? ok(`clinic admin user: ${admin.rows[0].email} (${admin.rows[0].role})`)
                 : bad('no clinic admin user created');

  // ── 2. the clinic sets itself up ──────────────────────────────────────
  step(2, 'Clinic owner logs in and configures the practice');
  const ol = await api('/api/auth/login', { method: 'POST', body: { email: OWNER_EMAIL, password: OWNER_PW, tenant_slug: SLUG } });
  const ownerToken = ol.json?.token || ol.json?.accessToken;
  if (!ownerToken) return bad(`owner login failed: ${ol.status} ${JSON.stringify(ol.json).slice(0, 200)}`);
  ok('clinic owner authenticated');

  const hosp = await api('/api/admin/hospitals', {
    method: 'POST', token: ownerToken,
    body: { name: 'Rehearsal Dental — Indiranagar', address: '100 Feet Road, Indiranagar', city: 'Bengaluru', phone: '+91 8012345678' },
  });
  const hospitalId = hosp.json?.hospital?.id || hosp.json?.id;
  hospitalId ? ok('branch created') : bad(`branch: ${hosp.status} ${JSON.stringify(hosp.json).slice(0, 200)}`);
  if (!hospitalId) return;

  const dept = await api('/api/admin/departments', {
    method: 'POST', token: ownerToken,
    body: { hospital_id: hospitalId, name: 'General Dentistry' },
  });
  const deptId = dept.json?.department?.id || dept.json?.id;
  deptId ? ok('treatment category created') : bad(`department: ${dept.status} ${JSON.stringify(dept.json).slice(0, 200)}`);
  if (!deptId) return;

  const doc = await api('/api/admin/doctors', {
    method: 'POST', token: ownerToken,
    body: {
      hospital_id: hospitalId, department_id: deptId, name: 'Meera Krishnan',
      specialization: 'General Dentist', qualification: 'BDS',
      consultation_fee: 350, slot_duration_minutes: 30,
    },
  });
  const doctorId = doc.json?.doctor?.id || doc.json?.id;
  doctorId ? ok('dentist created') : bad(`doctor: ${doc.status} ${JSON.stringify(doc.json).slice(0, 200)}`);
  if (!doctorId) return;

  // The invariant that decides whether the bot can list this dentist at all.
  const dd = await pool.query(
    `SELECT count(*)::int c FROM "${t.schema_name}".doctor_departments WHERE doctor_id=$1`, [doctorId]);
  dd.rows[0].c ? ok(`doctor_departments written (${dd.rows[0].c}) — dentist is bookable over WhatsApp`)
               : bad('doctor_departments EMPTY — dentist would be invisible in the bot');

  const sched = await api(`/api/admin/doctors/${doctorId}/schedule`, {
    method: 'POST', token: ownerToken,
    body: {
      schedules: [1, 2, 3, 4, 5, 6].map(d => ({
        day_of_week: d, start_time: '10:00', end_time: '18:00', is_working: true,
        lunch_start_time: '14:00', lunch_end_time: '15:00',
      })),
    },
  });
  sched.status < 300 ? ok('working week saved') : bad(`schedule: ${sched.status} ${JSON.stringify(sched.json).slice(0, 200)}`);

  await new Promise(r => setTimeout(r, 4000));
  const slots = await pool.query(
    `SELECT count(*)::int c FROM "${t.schema_name}".time_slots WHERE status='available'`);
  slots.rows[0].c ? ok(`${slots.rows[0].c} bookable slots generated`)
                  : bad('NO SLOTS — patients would see no availability');

  // ── 3. the patient path, through PRODUCTION ───────────────────────────
  step(3, `Patient scans the QR — code ${t.entry_code} sent to PRODUCTION's webhook`);
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'rehearsal', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '917795676142', phone_number_id: prodBackend.META_PHONE_NUMBER_ID },
      contacts: [{ profile: { name: 'Rehearsal Patient' }, wa_id: PATIENT }],
      messages: [{ from: PATIENT, id: 'wamid.reh-' + Date.now(),
        timestamp: String(Math.floor(Date.now() / 1000)), type: 'text',
        text: { body: '#' + t.entry_code } }],
    }}]}],
  });
  const sig = 'sha256=' + crypto.createHmac('sha256', prodBackend.META_APP_SECRET).update(body).digest('hex');
  const wh = await fetch(PROD_WEBHOOK, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig }, body,
  });
  ok(`production ACKed ${wh.status}`);
  await new Promise(r => setTimeout(r, 9000));

  const sess = await pool.query(
    `SELECT t.name FROM global_bot_sessions g JOIN tenants t ON t.id=g.tenant_id WHERE g.phone=$1`, [PATIENT]);
  sess.rowCount && sess.rows[0].name === 'Rehearsal Dental'
    ? ok(`routed to dev and attached to "${sess.rows[0].name}" — the new clinic is reachable`)
    : bad(`not attached to the new clinic (got ${JSON.stringify(sess.rows)})`);

  console.log('\n' + (process.exitCode ? 'REHEARSAL FAILED — see ✗ above' : 'REHEARSAL PASSED end to end'));
  await pool.end();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
