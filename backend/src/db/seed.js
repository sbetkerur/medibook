require('dotenv').config();
const bcrypt = require('bcryptjs');
const { query, tenantQuery, pool } = require('./index');
const { createTenantSchema, runTenantMigrations } = require('./tenantMigrate');

// entrypoint.sh runs migrate → seed → start on EVERY Railway boot, and the
// admin upsert below is `ON CONFLICT DO UPDATE SET password_hash`. That means a
// hardcoded demo password is re-applied to the live database on every single
// deploy — changing it in the dashboard silently reverts on the next one. The
// demo tenant is a sales/dev fixture, so it is opt-in outside development, and
// when it IS enabled in production the password must come from the environment.
// The same "runs on every boot" property applies to every OTHER field this file
// overwrites, not just the password: the tenant name and the admin user's name
// are both editable in the dashboard, so re-applying the seed's values on each
// deploy silently reverts real edits. Those writes are now opt-in behind this
// flag, which means "put the demo fixture back to factory settings".
const IS_PROD = process.env.NODE_ENV === 'production';
const SEED_DEMO = process.env.SEED_DEMO_DATA === 'true';
const SEED_DEMO_RESET = process.env.SEED_DEMO_RESET === 'true';
const DEMO_PASSWORD = process.env.DEMO_ADMIN_PASSWORD || (IS_PROD ? null : 'Demo@123456');

async function seed() {
  if (IS_PROD && !SEED_DEMO) {
    console.log('Skipping demo seed (production; set SEED_DEMO_DATA=true to enable).');
    return;
  }
  if (!DEMO_PASSWORD) {
    throw new Error(
      'SEED_DEMO_DATA=true in production requires DEMO_ADMIN_PASSWORD to be set — ' +
      'refusing to seed the demo tenant with a hardcoded password.'
    );
  }

  console.log('Seeding Smile Dental Clinic data...\n');

  const slug   = 'demo-clinic';
  const schema = 'tenant_demo_clinic';

  // ── TENANT ───────────────────────────────────────────────────
  let tenant = (await query(`SELECT * FROM tenants WHERE slug=$1`, [slug])).rows[0];
  if (!tenant) {
    const r = await query(`
      INSERT INTO tenants (name, slug, schema_name, owner_email, plan, status)
      VALUES ('Smile Dental Clinic', $1, $2, 'demo@medibook.com', 'growth', 'active')
      RETURNING *
    `, [slug, schema]);
    tenant = r.rows[0];
    await createTenantSchema(schema);
    await runTenantMigrations(schema);
    console.log('✅ Tenant created: Smile Dental Clinic');
  } else {
    // This UPDATE used to be unconditional. entrypoint.sh runs the seed on every
    // Railway boot, so renaming the clinic in the Settings tab reverted on the
    // next deploy — and because services/bot/clinicSearch.js matches a patient's
    // typed search against the tenant NAME, patients who had learned the new name
    // stopped finding the clinic at all. The rename was a one-time migration off
    // the old non-dental demo fixture, so it is opt-in now.
    if (SEED_DEMO_RESET) {
      await query(`UPDATE tenants SET name='Smile Dental Clinic' WHERE slug=$1`, [slug]);
      console.log('✅ Tenant name reset to: Smile Dental Clinic (SEED_DEMO_RESET)');
    } else {
      console.log(`✅ Tenant exists: ${tenant.name} (name left as-is; SEED_DEMO_RESET=true restores demo defaults)`);
    }
    await runTenantMigrations(schema);
  }

  // ── ADMIN USER ────────────────────────────────────────────────
  // Insert-only by default. `ON CONFLICT DO UPDATE SET name, password_hash` here
  // re-applied the seed's display name AND DEMO_ADMIN_PASSWORD on every boot, so
  // an admin who changed either in the dashboard was reverted by the next deploy.
  // The gate at the top of this file only kept a HARDCODED password out of
  // production — it did not stop the revert.
  const hash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const adminUpsert = await tenantQuery(schema, SEED_DEMO_RESET ? `
    INSERT INTO users (email, password_hash, name, role)
    VALUES ('demo@medibook.com', $1, 'Smile Dental Admin', 'admin')
    ON CONFLICT (email) DO UPDATE SET name='Smile Dental Admin', password_hash=EXCLUDED.password_hash
  ` : `
    INSERT INTO users (email, password_hash, name, role)
    VALUES ('demo@medibook.com', $1, 'Smile Dental Admin', 'admin')
    ON CONFLICT (email) DO NOTHING
  `, [hash]);
  console.log(adminUpsert.rowCount > 0
    ? (SEED_DEMO_RESET
        ? '✅ Admin user reset to demo defaults: demo@medibook.com (SEED_DEMO_RESET)'
        : '✅ Admin user created: demo@medibook.com')
    : '✅ Admin user exists: demo@medibook.com (name/password left as-is)');

  // ── CLINICS (multi-branch dental chain) ──────────────────────
  // Branch 1: Banjara Hills (main)
  let hospital = (await tenantQuery(schema,
    `SELECT * FROM hospitals WHERE name='Smile Dental - Banjara Hills'`)).rows[0];
  if (!hospital) {
    // Rename the old single-branch record if it exists
    // Deterministic pick, and never grab the KPHB branch — renaming it would
    // orphan the KPHB lookup below and cascade into duplicate doctors.
    const old = (await tenantQuery(schema,
      `SELECT * FROM hospitals WHERE name <> 'Smile Dental - KPHB' ORDER BY created_at LIMIT 1`)).rows[0];
    if (old) {
      await tenantQuery(schema,
        `UPDATE hospitals SET name='Smile Dental - Banjara Hills', address='Banjara Hills, Road No. 10', phone='040-99887766' WHERE id=$1`,
        [old.id]);
      hospital = (await tenantQuery(schema, `SELECT * FROM hospitals WHERE id=$1`, [old.id])).rows[0];
      console.log('✅ Branch 1 updated: Smile Dental - Banjara Hills');
    } else {
      const r = await tenantQuery(schema, `
        INSERT INTO hospitals (name, address, city, phone)
        VALUES ('Smile Dental - Banjara Hills', 'Banjara Hills, Road No. 10', 'Hyderabad', '040-99887766')
        RETURNING *
      `);
      hospital = r.rows[0];
      console.log('✅ Branch 1 created: Smile Dental - Banjara Hills');
    }
  } else {
    console.log('✅ Branch 1 exists: Smile Dental - Banjara Hills');
  }

  // Branch 2: KPHB Colony
  let hospital2 = (await tenantQuery(schema,
    `SELECT * FROM hospitals WHERE name='Smile Dental - KPHB'`)).rows[0];
  if (!hospital2) {
    const r = await tenantQuery(schema, `
      INSERT INTO hospitals (name, address, city, phone)
      VALUES ('Smile Dental - KPHB', 'KPHB Colony, Phase 6, Near Metro Station', 'Hyderabad', '040-88776655')
      RETURNING *
    `);
    hospital2 = r.rows[0];
    console.log('✅ Branch 2 created: Smile Dental - KPHB');
  } else {
    console.log('✅ Branch 2 exists: Smile Dental - KPHB');
  }

  // ── DENTAL TREATMENT CATEGORIES (per branch) ─────────────────
  const deptList = [
    'General Dentistry',
    'Root Canal Treatment',
    'Orthodontics & Braces',
    'Dental Implants',
    'Cosmetic Dentistry',
    'Pediatric Dentistry',
    'Oral Surgery',
  ];
  // Branch 1 departments
  const deptIds = {};
  for (const name of deptList) {
    const ex = await tenantQuery(schema,
      `SELECT id FROM departments WHERE name=$1 AND hospital_id=$2`, [name, hospital.id]);
    if (ex.rows[0]) { deptIds[name] = ex.rows[0].id; continue; }
    const r = await tenantQuery(schema,
      `INSERT INTO departments (hospital_id, name) VALUES ($1,$2) RETURNING id`,
      [hospital.id, name]);
    deptIds[name] = r.rows[0].id;
  }
  // Branch 2 departments (subset — KPHB is a smaller branch)
  const deptList2 = ['General Dentistry', 'Root Canal Treatment', 'Orthodontics & Braces', 'Cosmetic Dentistry'];
  const deptIds2 = {};
  for (const name of deptList2) {
    const ex = await tenantQuery(schema,
      `SELECT id FROM departments WHERE name=$1 AND hospital_id=$2`, [name, hospital2.id]);
    if (ex.rows[0]) { deptIds2[name] = ex.rows[0].id; continue; }
    const r = await tenantQuery(schema,
      `INSERT INTO departments (hospital_id, name) VALUES ($1,$2) RETURNING id`,
      [hospital2.id, name]);
    deptIds2[name] = r.rows[0].id;
  }
  // Deactivate any old non-dental departments (scoped to both known branches only)
  await tenantQuery(schema,
    `UPDATE departments SET is_active=false
     WHERE hospital_id IN ($${deptList.length+1},$${deptList.length+2})
       AND name NOT IN (${deptList.map((_,i)=>`$${i+1}`).join(',')})`,
    [...deptList, hospital.id, hospital2.id]);
  console.log(`✅ ${deptList.length} dental treatment categories — Branch 1`);
  console.log(`✅ ${deptList2.length} dental treatment categories — Branch 2 (KPHB)`);

  // ── DENTISTS ──────────────────────────────────────────────────
  // branch: 1 = Banjara Hills, 2 = KPHB
  const doctorDefs = [
    { name: 'Kavitha Reddy',   spec: 'General Dentist',              qual: 'BDS',                           dept: 'General Dentistry',       fee: 300,  duration: 30, branch: 1 },
    { name: 'Arjun Sharma',    spec: 'Endodontist',                  qual: 'BDS, MDS (Endodontics)',        dept: 'Root Canal Treatment',    fee: 700,  duration: 60, branch: 1 },
    { name: 'Preethi Nair',    spec: 'Orthodontist',                 qual: 'BDS, MDS (Orthodontics)',       dept: 'Orthodontics & Braces',   fee: 600,  duration: 45, branch: 1 },
    { name: 'Rohit Malhotra',  spec: 'Implantologist',               qual: 'BDS, MDS, Fellow (Implants)',   dept: 'Dental Implants',         fee: 1000, duration: 60, branch: 1 },
    { name: 'Sneha Patil',     spec: 'Cosmetic Dentist',             qual: 'BDS, MDS (Prosthodontics)',     dept: 'Cosmetic Dentistry',      fee: 500,  duration: 45, branch: 1 },
    { name: 'Divya Rao',       spec: 'Pediatric Dentist',            qual: 'BDS, MDS (Pedodontics)',        dept: 'Pediatric Dentistry',     fee: 350,  duration: 30, branch: 1 },
    { name: 'Vinod Kumar',     spec: 'Oral & Maxillofacial Surgeon', qual: 'BDS, MDS (Oral Surgery)',       dept: 'Oral Surgery',            fee: 800,  duration: 60, branch: 1 },
    // KPHB branch dentists
    { name: 'Meghna Iyer',     spec: 'General Dentist',              qual: 'BDS',                           dept: 'General Dentistry',       fee: 300,  duration: 30, branch: 2 },
    { name: 'Suresh Babu',     spec: 'Endodontist',                  qual: 'BDS, MDS (Endodontics)',        dept: 'Root Canal Treatment',    fee: 650,  duration: 60, branch: 2 },
    { name: 'Anjali Verma',    spec: 'Cosmetic Dentist',             qual: 'BDS, MDS (Prosthodontics)',     dept: 'Cosmetic Dentistry',      fee: 500,  duration: 45, branch: 2 },
  ];

  // ── ONE-TIME CLEANUP: leftovers of the pre-dental seed ───────
  // This was `for (const name of oldNames) UPDATE doctors SET is_active=false
  // WHERE name=$1` running on EVERY boot — unscoped to hospital and to the
  // seeded doctor set. A clinic admin who added a real dentist called "Sanjay"
  // or "Priya Sharma" (the literal placeholder text in the dashboard's
  // Add-Doctor modal) had them silently deactivated by the next deploy, with no
  // audit-log entry, and they vanished from the WhatsApp bot.
  // It is a one-shot historical fixup now, narrowed four ways:
  //   1. recorded in seed_markers (table created by tenantMigrate.js) so it can
  //      never sweep a schema a second time — after this, no deploy can ever
  //      deactivate a hand-added doctor, whatever they are called;
  //   2. scoped to the two branches this seed owns, so a doctor at a branch the
  //      clinic added itself is out of range;
  //   3. names no current doctorDef uses;
  //   4. skips any doctor with appointments against their name. The one
  //      remaining historical run is the only chance this code ever gets to hit
  //      a real dentist, and a dentist the clinic actually books is exactly the
  //      one that must survive it. Leftovers of the pre-dental seed have no
  //      appointments in a live clinic's schema.
  const LEGACY_DOCTOR_MARKER = 'deactivate_legacy_doctors_v1';
  const markerDone = (await tenantQuery(schema,
    `SELECT 1 FROM seed_markers WHERE key=$1`, [LEGACY_DOCTOR_MARKER])).rowCount > 0;
  if (markerDone) {
    console.log('✅ Legacy doctor cleanup already applied — skipped');
  } else {
    const currentNames = doctorDefs.map(d => d.name);
    const legacyNames = [
      'Shashidhar','Suvarna','Sanjay','Sandeep','Sunita','Manjula','Akanksha','Gautam',
      'Priya Sharma','Rajesh Kumar','Anita Reddy','Suresh Mehta',
    ].filter(n => !currentNames.includes(n));
    const cleanup = await tenantQuery(schema, `
      UPDATE doctors d SET is_active=false
      WHERE d.name = ANY($1::text[])
        AND d.hospital_id IN ($2,$3)
        AND d.is_active=true
        AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.doctor_id = d.id)
    `, [legacyNames, hospital.id, hospital2.id]);
    await tenantQuery(schema,
      `INSERT INTO seed_markers (key) VALUES ($1) ON CONFLICT (key) DO NOTHING`,
      [LEGACY_DOCTOR_MARKER]);
    console.log(`✅ Legacy doctor cleanup (one-time): ${cleanup.rowCount} doctor(s) deactivated`);
  }

  const doctorIds = [];
  for (const d of doctorDefs) {
    const hospId   = d.branch === 2 ? hospital2.id : hospital.id;
    const deptMap  = d.branch === 2 ? deptIds2 : deptIds;
    const ex = await tenantQuery(schema,
      `SELECT id FROM doctors WHERE name=$1 AND hospital_id=$2`, [d.name, hospId]);
    if (ex.rows[0]) {
      // Re-activate if previously deactivated, update details
      await tenantQuery(schema, `
        UPDATE doctors SET
          specialization=$1, qualification=$2, department_id=$3,
          consultation_fee=$4, slot_duration_minutes=$5,
          hospital_id=$6, is_active=true
        WHERE id=$7
      `, [d.spec, d.qual, deptMap[d.dept], d.fee, d.duration, hospId, ex.rows[0].id]);
      doctorIds.push({ id: ex.rows[0].id, duration: d.duration, name: d.name, hospital_id: hospId });
    } else {
      const r = await tenantQuery(schema, `
        INSERT INTO doctors
          (hospital_id, department_id, name, specialization, qualification, consultation_fee, slot_duration_minutes)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
      `, [hospId, deptMap[d.dept], d.name, d.spec, d.qual, d.fee, d.duration]);
      doctorIds.push({ id: r.rows[0].id, duration: d.duration, name: d.name, hospital_id: hospId });
    }
  }
  console.log(`✅ ${doctorDefs.length} dentists added/updated (7 Banjara Hills + 3 KPHB):`);
  doctorDefs.forEach(d => console.log(`     [Br${d.branch}] Dr. ${d.name} — ${d.spec} (${d.duration}min, ₹${d.fee})`));

  // ── SCHEDULES: Mon–Sat 10AM–5PM with lunch 1–2PM ─────────────
  for (const doc of doctorIds) {
    // Monday–Friday: working, 10:00–17:00, lunch 13:00–14:00
    for (let dow = 1; dow <= 5; dow++) {
      await tenantQuery(schema, `
        INSERT INTO doctor_schedules (doctor_id, day_of_week, start_time, end_time, is_working, lunch_start_time, lunch_end_time)
        VALUES ($1,$2,'10:00','17:00',true,'13:00','14:00')
        ON CONFLICT (doctor_id, day_of_week) DO UPDATE SET
          start_time='10:00', end_time='17:00', is_working=true,
          lunch_start_time='13:00', lunch_end_time='14:00'
      `, [doc.id, dow]);
    }
    // Saturday: working half-day (10AM–1PM, no lunch break)
    // Explicitly nullify lunch columns so a re-run clears any previously set lunch times for Saturday.
    await tenantQuery(schema, `
      INSERT INTO doctor_schedules (doctor_id, day_of_week, start_time, end_time, is_working)
      VALUES ($1,6,'10:00','13:00',true)
      ON CONFLICT (doctor_id, day_of_week) DO UPDATE SET
        start_time='10:00', end_time='13:00', is_working=true,
        lunch_start_time=NULL, lunch_end_time=NULL
    `, [doc.id]);
  }
  console.log('✅ Schedules set (Mon–Fri 10AM–5PM lunch 1–2PM, Sat 10AM–1PM)');

  // ── TIME SLOTS: next 7 days ───────────────────────────────────
  // Clear future unbooked availability, then delegate regeneration to the
  // single source of truth (generateSlotsForDoctor) so doctor leaves, clinic
  // holidays and admin-blocked slots are honoured. Constraints on the DELETE:
  // - 'available' only: 'blocked' / blocked_by_leave slots must survive a
  //   reseed, otherwise leave days come back bookable on every deploy
  // - exclude slots referenced by appointments: a cancelled appointment keeps
  //   its slot_id while the slot returns to 'available', so deleting the slot
  //   violates the appointments.slot_id FK and aborts the seed
  // - future-only in IST: the seed runs on EVERY boot, and deleting today's
  //   rows would drop same-day availability mid-deploy, including out from
  //   under a patient part-way through booking. The generator does now produce
  //   today's remaining slots (see planDoctorSlots), and re-inserting them is
  //   harmless — ON CONFLICT (doctor_id, slot_date, start_time) DO NOTHING.
  //   The admin regen path in routes/doctors.js deliberately DOES clear today,
  //   because there a schedule actually changed and the old grid must go.
  const { generateSlotsForDoctor } = require('../jobs/slotGenerator');
  let slotCount = 0;
  for (const doc of doctorIds) {
    await tenantQuery(schema, `
      DELETE FROM time_slots
      WHERE doctor_id=$1 AND status='available'
        AND slot_date > (NOW() AT TIME ZONE 'Asia/Kolkata')::date
        AND id NOT IN (SELECT slot_id FROM appointments WHERE slot_id IS NOT NULL)
    `, [doc.id]);
    slotCount += await generateSlotsForDoctor(schema, doc.id, false, 7);
  }
  console.log(`✅ ${slotCount} time slots generated (7 days via generateSlotsForDoctor)\n`);

  // Never echo passwords into production logs — Railway retains them and they
  // are readable by anyone with project access.
  console.log(IS_PROD
    ? `─────────────────────────────────────────
 Demo tenant seeded (slug: demo-clinic).
 Credentials come from DEMO_ADMIN_PASSWORD — not printed.
─────────────────────────────────────────`
    : `─────────────────────────────────────────
 CREDENTIALS
─────────────────────────────────────────
 Super Admin:  admin@medibook.com / SuperAdmin@123
 Clinic Admin: demo@medibook.com  / ${DEMO_PASSWORD}
 Clinic Slug:  demo-clinic
─────────────────────────────────────────`);

  await pool.end();
  // generateSlotsForDoctor's public-holiday cache opens the shared Redis
  // client; its live socket keeps the event loop alive after the pool closes,
  // so the seed process never exits. entrypoint.sh runs migrate → seed → start
  // on every Railway boot — a hung seed blocks the whole deployment.
  require('../utils/redisClient').closeClient();
}

seed().then(() => {
  // Deterministic exit even if some transitively-required module still holds
  // an open handle (see Redis note above).
  process.exit(0);
}).catch(err => {
  // Use console.error here since logger may not be initialized when seed fails at startup
  process.stderr.write(`Seed failed: ${err.message}\n${err.stack || ''}\n`);
  process.exit(1);
});
