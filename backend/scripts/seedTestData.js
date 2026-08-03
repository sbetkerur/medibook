'use strict';
/**
 * Test fixtures: clinics across several cities, multi-branch chains, dentists,
 * schedules, slots, patients and a spread of appointment history.
 *
 * Deliberately NOT part of src/db/seed.js. That file runs on EVERY boot via
 * entrypoint.sh, so anything added there is re-applied on every deploy; this is
 * a one-off you run when you want data, and take away with --drop.
 *
 *   node scripts/seedTestData.js           # create (idempotent — re-runs skip)
 *   node scripts/seedTestData.js --drop    # remove everything it created
 *   node scripts/seedTestData.js --only=nova --redo-appointments
 *                                          # rebuild ONE clinic's appointment set
 *
 * --redo-appointments exists because a run interrupted mid-way (the Railway TCP
 * proxy drops long connections) leaves a clinic with a partial set, and the
 * "already seeded" guard then refuses to top it up — correctly, since it cannot
 * tell a partial set from a deliberate one. This clears the fixture appointments
 * for the selected clinics and rebuilds them, releasing any slots they held.
 *
 * Targets whatever DATABASE_URL points at. Everything it creates is namespaced
 * so --drop can find it again and nothing else is ever touched:
 *   - tenants by slug prefix `testclinic-`
 *   - patients (in ANY tenant, including the demo one) by phone prefix 9198000
 *
 * Appointment history writes `status` directly rather than going through the
 * APPOINTMENT_TRANSITIONS state machine: these are fixtures being fabricated in
 * the past, not a live appointment changing state. The INSERT itself still goes
 * through bookingCore.insertAppointmentWithRetry, and every future appointment
 * still locks its slot with the atomic `status='available'` guard, so the data
 * this leaves behind is consistent with what the real booking paths produce.
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { query, tenantQuery, tenantTransaction, pool } = require('../src/db');
const { createTenantSchema, runTenantMigrations } = require('../src/db/tenantMigrate');
const { insertAppointmentWithRetry } = require('../src/services/bookingCore');
const { generateSlotsForDoctor } = require('../src/jobs/slotGenerator');
const { toZonedTime } = require('../src/utils/dateTz');
const { format, subDays } = require('date-fns');

const SLUG_PREFIX = 'testclinic-';
const PHONE_PREFIX = '9198000';       // test patients, in any tenant
const DEMO_SLUG = 'demo-clinic';
const IST = 'Asia/Kolkata';
const DROP = process.argv.includes('--drop');
const REDO_APPTS = process.argv.includes('--redo-appointments');
// --only=nova, or --only=nova,pearl
const ONLY = (() => {
  const a = process.argv.find(x => x.startsWith('--only='));
  return a ? a.slice('--only='.length).split(',').map(s => s.trim()).filter(Boolean) : null;
})();

// A password is only set when one is supplied. Creating logins with a known
// password in a live database is the caller's call to make, not this script's.
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || null;

const DEPT_POOL = [
  'General Dentistry', 'Root Canal Treatment', 'Orthodontics & Braces',
  'Dental Implants', 'Cosmetic Dentistry', 'Pediatric Dentistry', 'Oral Surgery',
];

// Cities are chosen to exercise the picker: Bengaluru has TWO clinics, three
// clinics have TWO branches in one city, and Pune is deliberately NOT one of
// DEFAULT_CITIES — it proves a real city sorts ahead of the padding.
const CLINICS = [
  { key: 'aster', name: 'Aster Dental Care', city: 'Bengaluru', branches: [
    { name: 'Aster Dental - Indiranagar', address: '100 Feet Road, Indiranagar', phone: '080-40011122' },
    { name: 'Aster Dental - Whitefield', address: 'ITPL Main Road, Whitefield', phone: '080-40011133' },
  ] },
  { key: 'nova', name: 'Nova Smile Studio', city: 'Bengaluru', branches: [
    { name: 'Nova Smile - Koramangala', address: '5th Block, Koramangala', phone: '080-42200990' },
  ] },
  { key: 'pearl', name: 'Pearl Dental Hospital', city: 'Mumbai', branches: [
    { name: 'Pearl Dental - Andheri West', address: 'Lokhandwala Complex, Andheri West', phone: '022-26301100' },
    { name: 'Pearl Dental - Bandra', address: 'Linking Road, Bandra West', phone: '022-26301200' },
  ] },
  { key: 'cityline', name: 'Cityline Dental', city: 'New Delhi', branches: [
    { name: 'Cityline Dental - Connaught Place', address: 'Block N, Connaught Place', phone: '011-43550088' },
  ] },
  { key: 'coastal', name: 'Coastal Dental Clinic', city: 'Chennai', branches: [
    { name: 'Coastal Dental - T. Nagar', address: 'Usman Road, T. Nagar', phone: '044-28150077' },
  ] },
  { key: 'ganga', name: 'Ganga Dental Care', city: 'Kolkata', branches: [
    { name: 'Ganga Dental - Salt Lake', address: 'Sector V, Salt Lake City', phone: '033-40071234' },
  ] },
  { key: 'prime', name: 'Prime Dental', city: 'Pune', branches: [
    { name: 'Prime Dental - Kothrud', address: 'Paud Road, Kothrud', phone: '020-25430099' },
  ] },
];

// Three per branch, cycled — enough that a department pick has real choices.
const DOCTOR_POOL = [
  { name: 'Ananya Deshpande', spec: 'General Dentist', qual: 'BDS', dept: 'General Dentistry', fee: 350, duration: 30 },
  { name: 'Rahul Menon', spec: 'Endodontist', qual: 'BDS, MDS (Endodontics)', dept: 'Root Canal Treatment', fee: 750, duration: 60 },
  { name: 'Farah Qureshi', spec: 'Orthodontist', qual: 'BDS, MDS (Orthodontics)', dept: 'Orthodontics & Braces', fee: 650, duration: 45 },
  { name: 'Nikhil Joshi', spec: 'Implantologist', qual: 'BDS, MDS (Implants)', dept: 'Dental Implants', fee: 1100, duration: 60 },
  { name: 'Sarita Bose', spec: 'Cosmetic Dentist', qual: 'BDS, MDS (Prosthodontics)', dept: 'Cosmetic Dentistry', fee: 550, duration: 45 },
  { name: 'Imran Shaikh', spec: 'Pediatric Dentist', qual: 'BDS, MDS (Pedodontics)', dept: 'Pediatric Dentistry', fee: 400, duration: 30 },
];

const PATIENT_NAMES = [
  'Ravi Kulkarni', 'Meera Shah', 'Aditya Nair', 'Fatima Sheikh', 'Joseph Thomas',
  'Lakshmi Iyer', 'Karan Gupta', 'Neha Bansal', 'Vikram Rathore', 'Shreya Das',
  'Manish Agarwal', 'Priyanka Menon',
];

let patientSeq = 0;
const nextPhone = () => PHONE_PREFIX + String(++patientSeq).padStart(5, '0');

const createdLogins = [];

const istToday = () => toZonedTime(new Date(), IST);
const log = (...a) => console.log(...a);

// ── DROP ──────────────────────────────────────────────────────
async function dropAll() {
  log(`Removing fixtures (slug ${SLUG_PREFIX}*, patient phones ${PHONE_PREFIX}*)\n`);

  // Test patients live in real tenants too (the demo clinic), so they are
  // cleaned per-schema before the test tenants themselves are dropped.
  const all = await query(`SELECT slug, schema_name FROM tenants ORDER BY slug`);
  for (const t of all.rows) {
    if (!/^tenant_[a-z0-9_]+$/.test(t.schema_name)) continue;
    try {
      // Release any slot a fixture appointment is holding, or the rows would go
      // and leave the grid permanently 'booked'.
      await tenantQuery(t.schema_name, `
        UPDATE time_slots SET status='available'
         WHERE id IN (
           SELECT a.slot_id FROM appointments a
             JOIN patients p ON p.id = a.patient_id
            WHERE p.phone LIKE $1 AND a.slot_id IS NOT NULL)`, [PHONE_PREFIX + '%']);
      const d = await tenantQuery(t.schema_name, `
        DELETE FROM appointments WHERE patient_id IN
          (SELECT id FROM patients WHERE phone LIKE $1)`, [PHONE_PREFIX + '%']);
      const p = await tenantQuery(t.schema_name,
        `DELETE FROM patients WHERE phone LIKE $1`, [PHONE_PREFIX + '%']);
      await tenantQuery(t.schema_name,
        `DELETE FROM bot_sessions WHERE phone LIKE $1`, [PHONE_PREFIX + '%']).catch(() => {});
      await tenantQuery(t.schema_name,
        `DELETE FROM wa_messages WHERE phone LIKE $1`, [PHONE_PREFIX + '%']).catch(() => {});
      if (d.rowCount || p.rowCount) {
        log(`  ${t.slug}: removed ${d.rowCount} appointment(s), ${p.rowCount} patient(s)`);
      }
    } catch (err) {
      log(`  !! ${t.slug}: ${err.message}`);
    }
  }

  const r = await query(`SELECT slug, schema_name FROM tenants WHERE slug LIKE $1`, [SLUG_PREFIX + '%']);
  for (const t of r.rows) {
    if (/^tenant_[a-z0-9_]+$/.test(t.schema_name)) {
      await query(`DROP SCHEMA IF EXISTS ${t.schema_name} CASCADE`);
    }
    log(`  dropped tenant ${t.slug}`);
  }
  await query(`DELETE FROM tenants WHERE slug LIKE $1`, [SLUG_PREFIX + '%']);
  await query(`DELETE FROM global_bot_sessions WHERE phone LIKE $1`, [PHONE_PREFIX + '%']);
  log(`\nDone — ${r.rows.length} test clinic(s) removed.`);
}

// ── BUILD ─────────────────────────────────────────────────────
async function ensureTenant(c) {
  const slug = SLUG_PREFIX + c.key;
  const schema = 'tenant_' + slug.replace(/-/g, '_');
  const existing = (await query(`SELECT id, slug FROM tenants WHERE slug=$1`, [slug])).rows[0];
  if (existing) {
    // City may have been added after an earlier run — keep it current.
    await query(`UPDATE tenants SET city=$1, status='active' WHERE id=$2`, [c.city, existing.id]);
    await runTenantMigrations(schema);
    return { id: existing.id, slug, schema, created: false };
  }
  const r = await query(
    `INSERT INTO tenants (name, slug, schema_name, owner_email, plan, status, city)
     VALUES ($1,$2,$3,$4,'growth','active',$5) RETURNING id`,
    [c.name, slug, schema, `${slug}@example.test`, c.city]
  );
  await createTenantSchema(schema);
  await runTenantMigrations(schema);
  return { id: r.rows[0].id, slug, schema, created: true };
}

async function buildBranches(schema, c) {
  const out = [];
  for (const b of c.branches) {
    let h = (await tenantQuery(schema, `SELECT * FROM hospitals WHERE name=$1`, [b.name])).rows[0];
    if (!h) {
      h = (await tenantQuery(schema,
        `INSERT INTO hospitals (name, address, city, phone) VALUES ($1,$2,$3,$4) RETURNING *`,
        [b.name, b.address, c.city, b.phone])).rows[0];
    }
    out.push(h);
  }
  return out;
}

async function buildDoctors(schema, hospital, offset) {
  // Departments first — a doctor references one.
  const deptIds = {};
  const depts = DEPT_POOL.slice(0, 5);
  for (const name of depts) {
    let d = (await tenantQuery(schema,
      `SELECT id FROM departments WHERE name=$1 AND hospital_id=$2`, [name, hospital.id])).rows[0];
    if (!d) {
      d = (await tenantQuery(schema,
        `INSERT INTO departments (hospital_id, name) VALUES ($1,$2) RETURNING id`,
        [hospital.id, name])).rows[0];
    }
    deptIds[name] = d.id;
  }

  const docs = [];
  for (let i = 0; i < 3; i++) {
    const def = DOCTOR_POOL[(offset + i) % DOCTOR_POOL.length];
    const deptId = deptIds[def.dept] || deptIds[depts[0]];
    let d = (await tenantQuery(schema,
      `SELECT id FROM doctors WHERE name=$1 AND hospital_id=$2`, [def.name, hospital.id])).rows[0];
    if (!d) {
      d = (await tenantQuery(schema, `
        INSERT INTO doctors (hospital_id, department_id, name, specialization, qualification,
                             consultation_fee, slot_duration_minutes)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [hospital.id, deptId, def.name, def.spec, def.qual, def.fee, def.duration])).rows[0];
    }
    // Mon–Fri 10:00–17:00 (lunch 13:00–14:00), Sat 10:00–13:00 — same shape the
    // demo seed uses, so generateSlotsForDoctor produces a comparable grid.
    for (let dow = 1; dow <= 5; dow++) {
      await tenantQuery(schema, `
        INSERT INTO doctor_schedules (doctor_id, day_of_week, start_time, end_time, is_working, lunch_start_time, lunch_end_time)
        VALUES ($1,$2,'10:00','17:00',true,'13:00','14:00')
        ON CONFLICT (doctor_id, day_of_week) DO UPDATE SET
          start_time='10:00', end_time='17:00', is_working=true,
          lunch_start_time='13:00', lunch_end_time='14:00'`, [d.id, dow]);
    }
    await tenantQuery(schema, `
      INSERT INTO doctor_schedules (doctor_id, day_of_week, start_time, end_time, is_working)
      VALUES ($1,6,'10:00','13:00',true)
      ON CONFLICT (doctor_id, day_of_week) DO UPDATE SET
        start_time='10:00', end_time='13:00', is_working=true,
        lunch_start_time=NULL, lunch_end_time=NULL`, [d.id]);

    docs.push({ id: d.id, name: def.name, hospital_id: hospital.id });
  }
  return docs;
}

async function buildPatients(schema, count) {
  // Re-runs must not pile up duplicates: an earlier run that got this far
  // already created them, and the phone prefix is what identifies them.
  const existing = await tenantQuery(schema,
    `SELECT id, name, phone FROM patients WHERE phone LIKE $1 AND deleted_at IS NULL
      ORDER BY phone LIMIT $2`, [PHONE_PREFIX + '%', count]);
  if (existing.rows.length >= count) return existing.rows;

  const out = [...existing.rows];
  for (let i = out.length; i < count; i++) {
    const name = PATIENT_NAMES[i % PATIENT_NAMES.length];
    const phone = nextPhone();
    const r = await tenantQuery(schema, `
      INSERT INTO patients (phone, name, gender, email, visit_count)
      VALUES ($1,$2,$3,$4,$5) RETURNING id, name, phone`,
      [phone, name, i % 2 ? 'female' : 'male',
       `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.test`, 0]);
    out.push(r.rows[0]);
  }
  return out;
}

/** Book a real future slot, using the same atomic lock the bot uses. */
async function bookUpcoming(schema, patient, doc) {
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
       RETURNING id, slot_date, start_time`, [doc.id]);
    if (!s.rows[0]) return null;
    const slot = s.rows[0];
    const { bookingId } = await insertAppointmentWithRetry(client, {
      patientId: patient.id, doctorId: doc.id, hospitalId: doc.hospital_id,
      slotId: slot.id, appointmentDate: slot.slot_date, appointmentTime: slot.start_time,
      visitType: 'in_person', notes: 'Test fixture — upcoming',
    });
    await client.query(`UPDATE patients SET visit_count = visit_count + 1 WHERE id=$1`, [patient.id]);
    return bookingId;
  });
}

/**
 * A past appointment. slot_id is NULL on purpose: the generator only produces
 * slots from today forward, so there is no historical row to point at, and
 * inventing one would put a bookable-looking slot in the past.
 */
async function bookPast(schema, patient, doc, daysAgo, status) {
  const date = format(subDays(istToday(), daysAgo), 'yyyy-MM-dd');
  const time = ['10:00:00', '11:30:00', '14:30:00', '16:00:00'][daysAgo % 4];
  return tenantTransaction(schema, async (client) => {
    const { bookingId, row } = await insertAppointmentWithRetry(client, {
      patientId: patient.id, doctorId: doc.id, hospitalId: doc.hospital_id,
      slotId: null, appointmentDate: date, appointmentTime: time,
      visitType: 'in_person', notes: `Test fixture — ${status}`,
    });
    // Written as two statements rather than one with CASE branches over the same
    // placeholder: Postgres deduces the parameter's type from every use at once,
    // and $1 serving as both a status value and a comparison inside CASE arms
    // assigning to timestamptz/text columns fails with "inconsistent types
    // deduced for parameter $1".
    if (status === 'cancelled') {
      await client.query(
        `UPDATE appointments SET status='cancelled', cancelled_at=NOW(), cancelled_by='user',
           cancellation_reason='Test fixture', updated_at=NOW() WHERE id=$1`, [row.id]);
    } else if (status !== 'confirmed') {
      await client.query(
        `UPDATE appointments SET status=$1, updated_at=NOW() WHERE id=$2`, [status, row.id]);
    }
    if (status === 'completed') {
      await client.query(`UPDATE patients SET visit_count = visit_count + 1 WHERE id=$1`, [patient.id]);
    }
    return bookingId;
  });
}

async function buildAppointments(schema, patients, doctors, plan) {
  let made = 0, skipped = 0;
  const pick = i => doctors[i % doctors.length];

  if (REDO_APPTS) {
    // Release first: deleting an appointment that holds a slot would leave the
    // grid permanently 'booked' with nothing pointing at it.
    await tenantQuery(schema, `
      UPDATE time_slots SET status='available'
       WHERE id IN (
         SELECT a.slot_id FROM appointments a
           JOIN patients p ON p.id = a.patient_id
          WHERE p.phone LIKE $1 AND a.slot_id IS NOT NULL)`, [PHONE_PREFIX + '%']);
    const cleared = await tenantQuery(schema, `
      DELETE FROM appointments WHERE patient_id IN
        (SELECT id FROM patients WHERE phone LIKE $1)`, [PHONE_PREFIX + '%']);
    // visit_count was incremented as those were created; reset so the rebuild
    // doesn't leave patients showing visits they no longer have.
    await tenantQuery(schema,
      `UPDATE patients SET visit_count=0 WHERE phone LIKE $1`, [PHONE_PREFIX + '%']);
    if (cleared.rowCount) log(`    cleared ${cleared.rowCount} existing fixture appointment(s)`);
  } else {
    // Already populated by an earlier run — adding another full set every time
    // would quietly inflate the history and consume more real slots.
    const have = await tenantQuery(schema, `
      SELECT count(*)::int n FROM appointments a
        JOIN patients p ON p.id = a.patient_id WHERE p.phone LIKE $1`, [PHONE_PREFIX + '%']);
    if (have.rows[0].n > 0) return { made: 0, skipped: 0, existing: have.rows[0].n };
  }

  for (let i = 0; i < plan.upcoming; i++) {
    const id = await bookUpcoming(schema, patients[i % patients.length], pick(i));
    if (id) made++; else skipped++;
  }
  const past = [
    ...Array(plan.completed).fill('completed'),
    ...Array(plan.cancelled).fill('cancelled'),
    ...Array(plan.noShow).fill('no_show'),
  ];
  for (let i = 0; i < past.length; i++) {
    await bookPast(schema, patients[i % patients.length], pick(i), 2 + i * 3, past[i]);
    made++;
  }
  return { made, skipped };
}

async function seedOne(schema, c, plan, adminEmail) {
  const branches = await buildBranches(schema, c);
  let doctors = [];
  for (let i = 0; i < branches.length; i++) {
    doctors = doctors.concat(await buildDoctors(schema, branches[i], i * 3));
  }

  let slots = 0;
  for (const d of doctors) slots += await generateSlotsForDoctor(schema, d.id, false, 14);

  const patients = await buildPatients(schema, plan.patients);
  const { made, skipped, existing } = await buildAppointments(schema, patients, doctors, plan);

  if (ADMIN_PASSWORD && adminEmail) {
    // Earlier runs used admin@<key>.test. The login route validates the address
    // with Joi, whose default TLD list rejects `.test`, so those rows existed
    // and matched on bcrypt but could never get past validation — a login that
    // looks correct in the database and 400s at the door. Remove them.
    await tenantQuery(schema, `DELETE FROM users WHERE email=$1`, [`admin@${c.key}.test`]);
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    // DO UPDATE, not DO NOTHING: re-running with a different TEST_ADMIN_PASSWORD
    // should actually change it, or you get a login you cannot use and no clue
    // why. These are fixture accounts — there is no admin edit to preserve.
    await tenantQuery(schema, `
      INSERT INTO users (email, password_hash, name, role)
      VALUES ($1,$2,$3,'admin')
      ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, is_active=true`,
      [adminEmail, hash, `${c.name} Admin`]);
    createdLogins.push({ clinic: c.name, slug: SLUG_PREFIX + c.key, email: adminEmail });
  }

  log(`  ${c.name} [${c.city}] — ${branches.length} branch(es), ${doctors.length} dentists, ` +
      `${slots} slots, ${patients.length} patients, ` +
      (existing ? `${existing} appointments (already seeded)` : `${made} appointments`) +
      (skipped ? ` (${skipped} upcoming skipped: no free slot)` : ''));
}

async function build() {
  log(`Seeding test fixtures into ${process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).host : '(unknown DB)'}\n`);

  const targets = ONLY ? CLINICS.filter(c => ONLY.includes(c.key)) : CLINICS;
  if (ONLY && !targets.length) {
    log(`--only=${ONLY.join(',')} matched no clinic. Known keys: ${CLINICS.map(c => c.key).join(', ')}`);
    return;
  }

  for (const c of targets) {
    const t = await ensureTenant(c);
    // example.com, not example.test: the login route runs the address through
    // Joi, whose default TLD list accepts neither .test nor .invalid, so a
    // fixture login on one of those 400s before the password is ever checked.
    // example.com is the reserved documentation domain and validates cleanly.
    await seedOne(t.schema, c, {
      patients: 6, upcoming: 4, completed: 5, cancelled: 2, noShow: 1,
    }, `${c.key}@example.com`);
  }

  // The demo clinic is the one with a login you already have, so give its
  // dashboard, analytics and reminder crons something real to chew on.
  // Skipped under --only unless it was asked for by name.
  const wantDemo = !ONLY || ONLY.includes('demo');
  const demo = wantDemo
    ? (await query(`SELECT schema_name FROM tenants WHERE slug=$1`, [DEMO_SLUG])).rows[0]
    : null;
  if (demo) {
    log('');
    const docs = (await tenantQuery(demo.schema_name,
      `SELECT id, name, hospital_id FROM doctors WHERE is_active=true ORDER BY name`)).rows;
    if (!docs.length) {
      log('  demo-clinic: no dentists — run `npm run seed` first, skipped');
    } else {
      const patients = await buildPatients(demo.schema_name, 12);
      const { made, skipped, existing } = await buildAppointments(demo.schema_name, patients, docs, {
        upcoming: 8, completed: 12, cancelled: 3, noShow: 2,
      });
      log(`  Smile Dental Clinic (demo) — ${patients.length} patients, ` +
          (existing ? `${existing} appointments (already seeded)` : `${made} appointments`) +
          (skipped ? ` (${skipped} upcoming skipped: no free slot)` : ''));
    }
  }

  const cities = await query(
    `SELECT COALESCE(city,'(none)') AS city, count(*) AS n
       FROM tenants WHERE status='active' GROUP BY 1 ORDER BY 1`);
  log('\nActive clinics by city:');
  for (const r of cities.rows) log(`  ${r.city}: ${r.n}`);
  if (createdLogins.length) {
    log(`\nAdmin logins (password from TEST_ADMIN_PASSWORD — not printed):`);
    log('  the dashboard asks for Clinic ID, email, password');
    for (const l of createdLogins) log(`  ${l.slug.padEnd(22)} ${l.email.padEnd(22)} ${l.clinic}`);
  } else {
    log(`\nAdmin logins: skipped — set TEST_ADMIN_PASSWORD to create them`);
  }
  log('\nRemove everything with: node scripts/seedTestData.js --drop');
}

(async () => {
  try {
    if (DROP) await dropAll();
    else await build();
  } catch (err) {
    console.error('\nFAILED:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
    // Explicit: the Redis client the feature-flag and slot-generator paths open
    // keeps the event loop alive, so the process would otherwise sit there after
    // the work (or the error) was done, looking like a hang.
    process.exit(process.exitCode || 0);
  }
})();
