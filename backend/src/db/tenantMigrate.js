const { pool } = require('./index');

async function createTenantSchema(schemaName) {
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await client.query(`SET search_path TO "${schemaName}"`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'staff',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS hospitals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        address TEXT,
        city VARCHAR(100),
        phone VARCHAR(20),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS departments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        hospital_id UUID REFERENCES hospitals(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        is_active BOOLEAN DEFAULT true
      );

      CREATE TABLE IF NOT EXISTS doctors (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        hospital_id UUID REFERENCES hospitals(id) ON DELETE CASCADE,
        department_id UUID REFERENCES departments(id),
        name VARCHAR(255) NOT NULL,
        specialization VARCHAR(255),
        qualification VARCHAR(255),
        consultation_fee INTEGER DEFAULT 0,
        slot_duration_minutes INTEGER DEFAULT 30,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS doctor_schedules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        doctor_id UUID REFERENCES doctors(id) ON DELETE CASCADE,
        day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        is_working BOOLEAN DEFAULT true,
        lunch_start_time TIME DEFAULT NULL,
        lunch_end_time   TIME DEFAULT NULL,
        UNIQUE(doctor_id, day_of_week)
      );

      CREATE TABLE IF NOT EXISTS time_slots (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        doctor_id UUID REFERENCES doctors(id) ON DELETE CASCADE,
        hospital_id UUID REFERENCES hospitals(id),
        slot_date DATE NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        status VARCHAR(20) DEFAULT 'available' CHECK (status IN ('available','booked','blocked','expired')),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(doctor_id, slot_date, start_time)
      );

      CREATE TABLE IF NOT EXISTS patients (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone VARCHAR(20) UNIQUE NOT NULL,
        name VARCHAR(255),
        date_of_birth DATE,
        gender VARCHAR(20),
        email VARCHAR(255),
        visit_count INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS appointments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        booking_id VARCHAR(20) UNIQUE NOT NULL,
        patient_id UUID REFERENCES patients(id),
        doctor_id UUID REFERENCES doctors(id),
        hospital_id UUID REFERENCES hospitals(id),
        slot_id UUID REFERENCES time_slots(id),
        appointment_date DATE NOT NULL,
        appointment_time TIME NOT NULL,
        status VARCHAR(50) DEFAULT 'confirmed' CHECK (status IN ('confirmed','completed','cancelled','no_show')),
        cancellation_reason TEXT,
        visit_type VARCHAR(50) DEFAULT 'in_person',
        notes TEXT,
        reminder_24h_sent BOOLEAN DEFAULT false,
        reminder_2h_sent BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS bot_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone VARCHAR(20) NOT NULL,
        state VARCHAR(100) DEFAULT 'idle',
        context JSONB DEFAULT '{}',
        last_activity TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(phone)
      );

      CREATE TABLE IF NOT EXISTS wa_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone VARCHAR(20) NOT NULL,
        direction VARCHAR(10) NOT NULL CHECK (direction IN ('in','out')),
        message_type VARCHAR(50),
        content TEXT,
        wa_message_id VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_slots_date_status ON time_slots(slot_date, status);
      CREATE INDEX IF NOT EXISTS idx_slots_doctor ON time_slots(doctor_id);
      CREATE INDEX IF NOT EXISTS idx_appt_date ON appointments(appointment_date);
      CREATE INDEX IF NOT EXISTS idx_appt_status ON appointments(status);
      CREATE INDEX IF NOT EXISTS idx_appt_patient ON appointments(patient_id);
      CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone);
      CREATE INDEX IF NOT EXISTS idx_bot_sessions_phone ON bot_sessions(phone);
    `);

    console.log(`✅ Schema "${schemaName}" created successfully`);
  } finally {
    await client.query('RESET search_path').catch(() => {});
    client.release();
  }
}

module.exports = { createTenantSchema };
