require('dotenv').config();
const bcrypt = require('bcryptjs');
const { query, tenantQuery, pool } = require('./index');
const { createTenantSchema } = require('./tenantMigrate');
const { addDays, format } = require('date-fns');

async function seed() {
  console.log('Seeding Swalambha Hospitals data...\n');

  const slug   = 'demo-clinic';
  const schema = 'tenant_demo_clinic';

  // ── TENANT ───────────────────────────────────────────────────
  let tenant = (await query(`SELECT * FROM tenants WHERE slug=$1`, [slug])).rows[0];
  if (!tenant) {
    const r = await query(`
      INSERT INTO tenants (name, slug, schema_name, owner_email, plan, status)
      VALUES ('Swalambha Hospitals', $1, $2, 'demo@medibook.com', 'growth', 'active')
      RETURNING *
    `, [slug, schema]);
    tenant = r.rows[0];
    await createTenantSchema(schema);
    console.log('✅ Tenant created: Swalambha Hospitals');
  } else {
    await query(`UPDATE tenants SET name='Swalambha Hospitals' WHERE slug=$1`, [slug]);
    console.log('✅ Tenant name updated to: Swalambha Hospitals');
  }

  // ── ADMIN USER ────────────────────────────────────────────────
  const hash = await bcrypt.hash('Demo@123456', 12);
  await tenantQuery(schema, `
    INSERT INTO users (email, password_hash, name, role)
    VALUES ('demo@medibook.com', $1, 'Swalambha Admin', 'admin')
    ON CONFLICT (email) DO UPDATE SET name='Swalambha Admin'
  `, [hash]);

  // ── HOSPITAL ──────────────────────────────────────────────────
  let hospital = (await tenantQuery(schema, `SELECT * FROM hospitals LIMIT 1`)).rows[0];
  if (!hospital) {
    const r = await tenantQuery(schema, `
      INSERT INTO hospitals (name, address, city, phone)
      VALUES ('Swalambha Hospitals', 'Main Road, Jubilee Hills', 'Hyderabad', '040-99887766')
      RETURNING *
    `);
    hospital = r.rows[0];
    console.log('✅ Hospital created: Swalambha Hospitals');
  } else {
    await tenantQuery(schema,
      `UPDATE hospitals SET name='Swalambha Hospitals' WHERE id=$1`, [hospital.id]);
    console.log('✅ Hospital name updated to: Swalambha Hospitals');
  }

  // ── DEPARTMENTS ───────────────────────────────────────────────
  const deptList = [
    'General Medicine',
    'Cardiology',
    'Orthopedics',
    'Gynecology & Obstetrics',
    'Dermatology',
    'Pediatrics',
    'Neurology',
  ];
  const deptIds = {};
  for (const name of deptList) {
    const ex = await tenantQuery(schema, `SELECT id FROM departments WHERE name=$1`, [name]);
    if (ex.rows[0]) { deptIds[name] = ex.rows[0].id; continue; }
    const r = await tenantQuery(schema,
      `INSERT INTO departments (hospital_id, name) VALUES ($1,$2) RETURNING id`,
      [hospital.id, name]);
    deptIds[name] = r.rows[0].id;
  }
  console.log(`✅ ${deptList.length} departments ready`);

  // ── DEACTIVATE OLD DEMO DOCTORS ───────────────────────────────
  const oldNames = ['Priya Sharma', 'Rajesh Kumar', 'Anita Reddy', 'Suresh Mehta'];
  for (const name of oldNames) {
    await tenantQuery(schema,
      `UPDATE doctors SET is_active=false WHERE name=$1`, [name]);
  }

  // ── NEW DOCTORS ───────────────────────────────────────────────
  const doctorDefs = [
    { name: 'Shashidhar', spec: 'General Physician',       qual: 'MBBS, MD',                       dept: 'General Medicine',         fee: 400, duration: 30 },
    { name: 'Suvarna',    spec: 'Gynaecologist',           qual: 'MBBS, MS (OBG)',                 dept: 'Gynecology & Obstetrics',  fee: 500, duration: 30 },
    { name: 'Sanjay',     spec: 'Orthopaedic Surgeon',     qual: 'MBBS, MS (Ortho)',               dept: 'Orthopedics',              fee: 600, duration: 30 },
    { name: 'Sandeep',    spec: 'Cardiologist',             qual: 'MBBS, MD, DM (Cardiology)',      dept: 'Cardiology',               fee: 800, duration: 30 },
    { name: 'Sunita',     spec: 'Dermatologist',            qual: 'MBBS, MD (Dermatology)',         dept: 'Dermatology',              fee: 500, duration: 20 },
    { name: 'Manjula',    spec: 'Paediatrician',            qual: 'MBBS, MD (Paediatrics)',         dept: 'Pediatrics',               fee: 400, duration: 20 },
    { name: 'Akanksha',   spec: 'General Physician',        qual: 'MBBS, MD',                       dept: 'General Medicine',         fee: 400, duration: 20 },
    { name: 'Gautam',     spec: 'Neurologist',              qual: 'MBBS, MD, DM (Neurology)',       dept: 'Neurology',                fee: 800, duration: 30 },
  ];

  const doctorIds = [];
  for (const d of doctorDefs) {
    const ex = await tenantQuery(schema,
      `SELECT id FROM doctors WHERE name=$1`, [d.name]);
    if (ex.rows[0]) {
      // Re-activate if previously deactivated, update details
      await tenantQuery(schema, `
        UPDATE doctors SET
          specialization=$1, qualification=$2, department_id=$3,
          consultation_fee=$4, slot_duration_minutes=$5,
          hospital_id=$6, is_active=true
        WHERE id=$7
      `, [d.spec, d.qual, deptIds[d.dept], d.fee, d.duration, hospital.id, ex.rows[0].id]);
      doctorIds.push({ id: ex.rows[0].id, duration: d.duration, name: d.name });
    } else {
      const r = await tenantQuery(schema, `
        INSERT INTO doctors
          (hospital_id, department_id, name, specialization, qualification, consultation_fee, slot_duration_minutes)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
      `, [hospital.id, deptIds[d.dept], d.name, d.spec, d.qual, d.fee, d.duration]);
      doctorIds.push({ id: r.rows[0].id, duration: d.duration, name: d.name });
    }
  }
  console.log(`✅ ${doctorDefs.length} doctors added/updated:`);
  doctorDefs.forEach(d => console.log(`     Dr. ${d.name} — ${d.spec} (${d.duration}min, ₹${d.fee})`));

  // ── SCHEDULES: Mon–Fri 10AM–5PM with lunch 1–2PM ─────────────
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
    // Saturday: not working
    await tenantQuery(schema, `
      INSERT INTO doctor_schedules (doctor_id, day_of_week, start_time, end_time, is_working)
      VALUES ($1,6,'10:00','17:00',false)
      ON CONFLICT (doctor_id, day_of_week) DO UPDATE SET is_working=false
    `, [doc.id]);
  }
  console.log('✅ Schedules set (Mon–Fri, 10AM–5PM, lunch 1–2PM)');

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
      if (dow === 0 || dow === 6) continue; // Mon–Fri only
      const dateStr = format(date, 'yyyy-MM-dd');
      let cur = 10 * 60; // 10:00 AM
      while (cur + doc.duration <= 17 * 60) {
        // Skip lunch window (13:00–14:00)
        if (cur < LUNCH_END && cur + doc.duration > LUNCH_START) {
          cur = LUNCH_END;
          continue;
        }
        const st = `${String(Math.floor(cur / 60)).padStart(2,'0')}:${String(cur % 60).padStart(2,'0')}`;
        const et = `${String(Math.floor((cur + doc.duration) / 60)).padStart(2,'0')}:${String((cur + doc.duration) % 60).padStart(2,'0')}`;
        await tenantQuery(schema, `
          INSERT INTO time_slots (doctor_id, hospital_id, slot_date, start_time, end_time, status)
          VALUES ($1,$2,$3,$4,$5,'available')
          ON CONFLICT (doctor_id, slot_date, start_time) DO NOTHING
        `, [doc.id, hospital.id, dateStr, st, et]);
        cur += doc.duration;
        slotCount++;
      }
    }
  }
  console.log(`✅ ${slotCount} time slots generated (7 days, Mon–Fri, 10–13 + 14–17)\n`);

  console.log(`─────────────────────────────────────────
 CREDENTIALS
─────────────────────────────────────────
 Super Admin:  admin@medibook.com / SuperAdmin@123
 Clinic Admin: demo@medibook.com  / Demo@123456
 Clinic Slug:  demo-clinic
─────────────────────────────────────────`);

  await pool.end();
}

seed().catch(err => { console.error('Seed failed:', err.message); process.exit(1); });
