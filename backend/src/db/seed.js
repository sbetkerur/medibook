require('dotenv').config();
const bcrypt = require('bcryptjs');
const { query, tenantQuery, pool } = require('./index');
const { createTenantSchema } = require('./tenantMigrate');
const { addDays, format } = require('date-fns');

async function seed() {
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
    console.log('✅ Tenant created: Smile Dental Clinic');
  } else {
    await query(`UPDATE tenants SET name='Smile Dental Clinic' WHERE slug=$1`, [slug]);
    console.log('✅ Tenant name updated to: Smile Dental Clinic');
  }

  // ── ADMIN USER ────────────────────────────────────────────────
  const hash = await bcrypt.hash('Demo@123456', 12);
  await tenantQuery(schema, `
    INSERT INTO users (email, password_hash, name, role)
    VALUES ('demo@medibook.com', $1, 'Smile Dental Admin', 'admin')
    ON CONFLICT (email) DO UPDATE SET name='Smile Dental Admin'
  `, [hash]);

  // ── CLINICS (multi-branch dental chain) ──────────────────────
  // Branch 1: Banjara Hills (main)
  let hospital = (await tenantQuery(schema,
    `SELECT * FROM hospitals WHERE name='Smile Dental - Banjara Hills'`)).rows[0];
  if (!hospital) {
    // Rename the old single-branch record if it exists
    const old = (await tenantQuery(schema, `SELECT * FROM hospitals LIMIT 1`)).rows[0];
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
  // Deactivate any old non-dental departments
  await tenantQuery(schema,
    `UPDATE departments SET is_active=false WHERE name NOT IN (${deptList.map((_,i)=>`$${i+1}`).join(',')})`,
    deptList);
  console.log(`✅ ${deptList.length} dental treatment categories — Branch 1`);
  console.log(`✅ ${deptList2.length} dental treatment categories — Branch 2 (KPHB)`);

  // ── DEACTIVATE OLD NON-DENTAL DOCTORS ────────────────────────
  const oldNames = [
    'Shashidhar','Suvarna','Sanjay','Sandeep','Sunita','Manjula','Akanksha','Gautam',
    'Priya Sharma','Rajesh Kumar','Anita Reddy','Suresh Mehta',
  ];
  for (const name of oldNames) {
    await tenantQuery(schema, `UPDATE doctors SET is_active=false WHERE name=$1`, [name]);
  }

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
    await tenantQuery(schema, `
      INSERT INTO doctor_schedules (doctor_id, day_of_week, start_time, end_time, is_working)
      VALUES ($1,6,'10:00','13:00',true)
      ON CONFLICT (doctor_id, day_of_week) DO UPDATE SET
        start_time='10:00', end_time='13:00', is_working=true
    `, [doc.id]);
  }
  console.log('✅ Schedules set (Mon–Fri 10AM–5PM lunch 1–2PM, Sat 10AM–1PM)');

  // ── TIME SLOTS: next 7 days ───────────────────────────────────
  // Clear existing available slots before regenerating
  for (const doc of doctorIds) {
    await tenantQuery(schema,
      `DELETE FROM time_slots WHERE doctor_id=$1 AND status IN ('available','blocked') AND slot_date >= CURRENT_DATE`,
      [doc.id]);
  }

  let slotCount = 0;
  const today = new Date();
  const LUNCH_START = 13 * 60; // 13:00 in minutes
  const LUNCH_END   = 14 * 60; // 14:00 in minutes

  for (const doc of doctorIds) {
    for (let i = 1; i <= 7; i++) {
      const date = addDays(today, i);
      const dow  = date.getDay();
      if (dow === 0) continue; // Skip Sunday only (Saturday is half-day)
      const dateStr = format(date, 'yyyy-MM-dd');
      // Saturday ends at 13:00 (no lunch break); Mon–Fri ends at 17:00
      const endTime = dow === 6 ? 13 * 60 : 17 * 60;
      let cur = 10 * 60; // 10:00 AM
      while (cur + doc.duration <= endTime) {
        // Skip lunch window on Mon–Fri only (13:00–14:00)
        if (dow !== 6 && cur < LUNCH_END && cur + doc.duration > LUNCH_START) {
          cur = LUNCH_END;
          continue;
        }
        const st = `${String(Math.floor(cur / 60)).padStart(2,'0')}:${String(cur % 60).padStart(2,'0')}`;
        const et = `${String(Math.floor((cur + doc.duration) / 60)).padStart(2,'0')}:${String((cur + doc.duration) % 60).padStart(2,'0')}`;
        await tenantQuery(schema, `
          INSERT INTO time_slots (doctor_id, hospital_id, slot_date, start_time, end_time, status)
          VALUES ($1,$2,$3,$4,$5,'available')
          ON CONFLICT (doctor_id, slot_date, start_time) DO NOTHING
        `, [doc.id, doc.hospital_id, dateStr, st, et]);
        cur += doc.duration;
        slotCount++;
      }
    }
  }
  console.log(`✅ ${slotCount} time slots generated (7 days, Mon–Fri 10–13+14–17, Sat 10–13)\n`);

  console.log(`─────────────────────────────────────────
 CREDENTIALS
─────────────────────────────────────────
 Super Admin:  admin@medibook.com / SuperAdmin@123
 Clinic Admin: demo@medibook.com  / Demo@123456
 Clinic Slug:  demo-clinic
─────────────────────────────────────────`);

  await pool.end();
}

seed().catch(err => {
  // Use console.error here since logger may not be initialized when seed fails at startup
  process.stderr.write(`Seed failed: ${err.message}\n${err.stack || ''}\n`);
  process.exit(1);
});
