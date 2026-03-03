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
        phone VARCHAR(20) UNIQUE NOT NULL CHECK (phone ~ '^[+]?[0-9]{7,20}$'),
        name VARCHAR(255),
        date_of_birth DATE,
        gender VARCHAR(20),
        email VARCHAR(255),
        visit_count INTEGER DEFAULT 0,
        medical_history JSONB DEFAULT '{}',
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
        cancelled_by VARCHAR(20) DEFAULT 'user' CHECK (cancelled_by IN ('user','admin','bot')),
        cancelled_by_user_id UUID,
        cancelled_at TIMESTAMPTZ,
        visit_type VARCHAR(50) DEFAULT 'in_person',
        note_category VARCHAR(50) DEFAULT 'general',
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

      CREATE TABLE IF NOT EXISTS waiting_list (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        patient_id UUID REFERENCES patients(id),
        doctor_id UUID REFERENCES doctors(id),
        hospital_id UUID REFERENCES hospitals(id),
        requested_date DATE,
        notified BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS appointment_feedback (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        appointment_id UUID REFERENCES appointments(id),
        patient_id UUID REFERENCES patients(id),
        rating INTEGER CHECK (rating BETWEEN 1 AND 5),
        comment TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS doctor_leaves (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        doctor_id UUID REFERENCES doctors(id) ON DELETE CASCADE,
        leave_date DATE NOT NULL,
        reason TEXT,
        created_by_user_id UUID,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(doctor_id, leave_date)
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_id UUID,
        actor_role VARCHAR(50),
        action VARCHAR(100) NOT NULL,
        resource_type VARCHAR(100),
        resource_id TEXT,
        old_values JSONB,
        new_values JSONB,
        ip_address VARCHAR(45),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Core indexes
      CREATE INDEX IF NOT EXISTS idx_slots_date_status ON time_slots(slot_date, status);
      CREATE INDEX IF NOT EXISTS idx_slots_doctor ON time_slots(doctor_id);
      CREATE INDEX IF NOT EXISTS idx_appt_date ON appointments(appointment_date);
      CREATE INDEX IF NOT EXISTS idx_appt_status ON appointments(status);
      CREATE INDEX IF NOT EXISTS idx_appt_patient ON appointments(patient_id);
      CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone);
      CREATE INDEX IF NOT EXISTS idx_bot_sessions_phone ON bot_sessions(phone);
      CREATE INDEX IF NOT EXISTS idx_wa_messages_phone ON wa_messages(phone);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_messages_msg_id ON wa_messages(wa_message_id) WHERE wa_message_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_waiting_list_doctor ON waiting_list(doctor_id, notified);
      CREATE INDEX IF NOT EXISTS idx_waiting_list_created_at ON waiting_list(created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_feedback_appointment ON appointment_feedback(appointment_id);
      -- New performance indexes
      CREATE INDEX IF NOT EXISTS idx_appt_status_date ON appointments(status, appointment_date DESC);
      CREATE INDEX IF NOT EXISTS idx_appt_created_at ON appointments(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_bot_sessions_activity ON bot_sessions(last_activity);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_doctor_leaves_doctor ON doctor_leaves(doctor_id, leave_date);
    `);

    console.log(`✅ Schema "${schemaName}" created successfully`);
  } finally {
    await client.query('RESET search_path').catch(() => {});
    client.release();
  }
}

/**
 * Apply incremental migrations to an existing tenant schema.
 * All statements are idempotent (ALTER … IF NOT EXISTS, CREATE … IF NOT EXISTS).
 * Called by migrate.js for every existing tenant.
 */
async function runTenantMigrations(schemaName) {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO "${schemaName}", public`);

    // Add new columns to appointments (idempotent)
    await client.query(`
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancelled_by_user_id UUID;
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS note_category VARCHAR(50) DEFAULT 'general';
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancelled_by VARCHAR(20) DEFAULT 'user';
    `);

    // Add medical_history to patients
    await client.query(`
      ALTER TABLE patients ADD COLUMN IF NOT EXISTS medical_history JSONB DEFAULT '{}';
    `);

    // Create doctor_leaves table
    await client.query(`
      CREATE TABLE IF NOT EXISTS doctor_leaves (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        doctor_id UUID REFERENCES doctors(id) ON DELETE CASCADE,
        leave_date DATE NOT NULL,
        reason TEXT,
        created_by_user_id UUID,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(doctor_id, leave_date)
      );
      CREATE INDEX IF NOT EXISTS idx_doctor_leaves_doctor ON doctor_leaves(doctor_id, leave_date);
    `);

    // Add phone format constraint to patients (idempotent)
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE patients
          ADD CONSTRAINT patients_phone_format CHECK (phone ~ '^[+]?[0-9]{7,20}$');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    // Add new indexes (idempotent)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_appt_status_date ON appointments(status, appointment_date DESC);
      CREATE INDEX IF NOT EXISTS idx_appt_created_at ON appointments(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_bot_sessions_activity ON bot_sessions(last_activity);
      CREATE INDEX IF NOT EXISTS idx_waiting_list_created_at ON waiting_list(created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_wa_messages_phone ON wa_messages(phone);
      DROP INDEX IF EXISTS idx_wa_messages_msg_id;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_messages_msg_id ON wa_messages(wa_message_id) WHERE wa_message_id IS NOT NULL;
    `);

    // Create audit_logs table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_id UUID,
        actor_role VARCHAR(50),
        action VARCHAR(100) NOT NULL,
        resource_type VARCHAR(100),
        resource_id TEXT,
        old_values JSONB,
        new_values JSONB,
        ip_address VARCHAR(45),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, created_at DESC);
    `);

    // Add lunch_start_time and lunch_end_time to doctor_schedules if missing
    await client.query(`
      ALTER TABLE doctor_schedules ADD COLUMN IF NOT EXISTS lunch_start_time TIME DEFAULT NULL;
      ALTER TABLE doctor_schedules ADD COLUMN IF NOT EXISTS lunch_end_time TIME DEFAULT NULL;
    `);

  } finally {
    await client.query('RESET search_path').catch(() => {});
    client.release();
  }
}

module.exports = { createTenantSchema, runTenantMigrations };
