const { pool, validateSchemaName } = require('./index');
const logger = require('../utils/logger');

async function createTenantSchema(schemaName) {
  validateSchemaName(schemaName);
  const client = await pool.connect();
  try {
    // Migration DDL (index builds on large tables) can legitimately exceed the
    // pool's 10s app-query statement_timeout — lift it for this session only.
    await client.query('SET statement_timeout TO 0');
    // ALTER TABLE ... ADD COLUMN IF NOT EXISTS takes ACCESS EXCLUSIVE BEFORE it
    // evaluates IF NOT EXISTS, so these run on every boot even when every column
    // already exists. With no lock_timeout and an unlimited statement_timeout, a
    // rolling deploy could queue behind a live read on appointments — and a
    // QUEUED ACCESS EXCLUSIVE request blocks every later reader, turning a stuck
    // deploy into a booking outage on the still-serving old container. Fail fast
    // instead: entrypoint.sh aborts, the old container keeps serving, and the
    // deploy can be retried off-peak.
    await client.query("SET lock_timeout TO '5s'");
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await client.query(`SET search_path TO "${schemaName}", public`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'staff',
        is_active BOOLEAN DEFAULT true,
        notify_phone VARCHAR(20),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS hospitals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        address TEXT,
        city VARCHAR(100),
        phone VARCHAR(20),
        is_active BOOLEAN DEFAULT true,
        deleted_at TIMESTAMPTZ DEFAULT NULL,
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
        phone VARCHAR(20) NOT NULL CHECK (phone ~ '^[0-9]{7,20}$'),
        name VARCHAR(255),
        date_of_birth DATE,
        gender VARCHAR(20),
        email VARCHAR(255),
        visit_count INTEGER DEFAULT 0,
        dental_history JSONB DEFAULT '{}',
        opted_out BOOLEAN DEFAULT false,
        deleted_at TIMESTAMPTZ DEFAULT NULL,
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

      CREATE TABLE IF NOT EXISTS clinic_services (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        hospital_id UUID REFERENCES hospitals(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        category VARCHAR(100),
        duration_minutes INTEGER DEFAULT 30,
        price INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS clinic_holidays (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        hospital_id UUID REFERENCES hospitals(id) ON DELETE CASCADE,
        holiday_date DATE NOT NULL,
        name VARCHAR(255) NOT NULL,
        created_by_user_id UUID,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(hospital_id, holiday_date)
      );
      CREATE INDEX IF NOT EXISTS idx_holidays_date ON clinic_holidays(holiday_date);
      CREATE INDEX IF NOT EXISTS idx_services_hospital ON clinic_services(hospital_id, is_active);

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

      -- Enhancement 6: Patient documents / prescriptions
      CREATE TABLE IF NOT EXISTS documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
        appointment_id UUID REFERENCES appointments(id) ON DELETE SET NULL,
        file_name VARCHAR(255) NOT NULL,
        file_type VARCHAR(100),
        file_size_bytes INTEGER,
        file_data TEXT NOT NULL,
        uploaded_by_user_id UUID,
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_documents_patient ON documents(patient_id, created_at DESC);

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
      CREATE INDEX IF NOT EXISTS idx_feedback_appointment ON appointment_feedback(appointment_id);
      -- Existing performance indexes
      CREATE INDEX IF NOT EXISTS idx_appt_status_date ON appointments(status, appointment_date DESC);
      CREATE INDEX IF NOT EXISTS idx_appt_created_at ON appointments(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_bot_sessions_activity ON bot_sessions(last_activity);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_doctor_leaves_doctor ON doctor_leaves(doctor_id, leave_date);
      -- Composite indexes for common query patterns
      CREATE INDEX IF NOT EXISTS idx_appt_doctor_date ON appointments(doctor_id, appointment_date);
      CREATE INDEX IF NOT EXISTS idx_appt_patient_status ON appointments(patient_id, status, appointment_date DESC);
      CREATE INDEX IF NOT EXISTS idx_appt_reminder_24h ON appointments(appointment_date, reminder_24h_sent) WHERE status='confirmed' AND reminder_24h_sent=false;
      CREATE INDEX IF NOT EXISTS idx_appt_reminder_2h ON appointments(appointment_date, appointment_time, reminder_2h_sent) WHERE status='confirmed' AND reminder_2h_sent=false;
      CREATE INDEX IF NOT EXISTS idx_slots_doctor_date_status ON time_slots(doctor_id, slot_date, status);
      -- Hospital-scoped indexes (Today's Schedule + slot listing)
      CREATE INDEX IF NOT EXISTS idx_appt_hospital_date ON appointments(hospital_id, appointment_date DESC);
      CREATE INDEX IF NOT EXISTS idx_patients_created ON patients(created_at DESC);
      -- Filtered (partial) indexes for soft-delete columns — O(1) lookups on active records
      CREATE INDEX IF NOT EXISTS idx_hospitals_active ON hospitals(id) WHERE is_active=true AND deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_patients_active ON patients(created_at DESC) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_doctors_active ON doctors(id) WHERE is_active=true;
      -- Email index for bounce handler (UPDATE patients SET email_status WHERE email=$1)
      CREATE INDEX IF NOT EXISTS idx_patients_email ON patients(email) WHERE email IS NOT NULL;
    `);

    // Append-only trigger for tenant-schema audit_logs
    await client.query(`
      CREATE OR REPLACE FUNCTION prevent_tenant_audit_mutation()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'audit_logs is append-only and cannot be modified or deleted';
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgname = 'audit_logs_immutable'
            AND tgrelid = (current_schema() || '.audit_logs')::regclass
        ) THEN
          CREATE TRIGGER audit_logs_immutable
          BEFORE UPDATE OR DELETE ON audit_logs
          FOR EACH ROW EXECUTE FUNCTION prevent_tenant_audit_mutation();
        END IF;
      END $$;
    `).catch(() => {});

    console.log(`✅ Schema "${schemaName}" created successfully`);
  } finally {
    // RESET BOTH. statement_timeout is per-session state and the pool sets it
    // as a connection parameter (db/index.js), so a connection released after
    // 'SET statement_timeout TO 0' keeps NO timeout for the rest of its life —
    // silently disabling the pool-starvation guard for that slot. Tenant
    // creation runs this at runtime from the super admin console.
    await client.query('RESET statement_timeout').catch(() => {});
    await client.query('RESET lock_timeout').catch(() => {});
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
  validateSchemaName(schemaName);
  const client = await pool.connect();
  try {
    // Same rationale as createTenantSchema: DDL may exceed the app's 10s cap.
    await client.query('SET statement_timeout TO 0');
    // ALTER TABLE ... ADD COLUMN IF NOT EXISTS takes ACCESS EXCLUSIVE BEFORE it
    // evaluates IF NOT EXISTS, so these run on every boot even when every column
    // already exists. With no lock_timeout and an unlimited statement_timeout, a
    // rolling deploy could queue behind a live read on appointments — and a
    // QUEUED ACCESS EXCLUSIVE request blocks every later reader, turning a stuck
    // deploy into a booking outage on the still-serving old container. Fail fast
    // instead: entrypoint.sh aborts, the old container keeps serving, and the
    // deploy can be retried off-peak.
    await client.query("SET lock_timeout TO '5s'");
    await client.query(`SET search_path TO "${schemaName}", public`);

    // Add new columns to appointments (idempotent)
    await client.query(`
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancelled_by_user_id UUID;
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS note_category VARCHAR(50) DEFAULT 'general';
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancelled_by VARCHAR(20) DEFAULT 'user';
    `);

    // Rename medical_history → dental_history (idempotent)
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'patients'
            AND column_name = 'medical_history'
        ) THEN
          ALTER TABLE patients RENAME COLUMN medical_history TO dental_history;
        END IF;
      END $$;
      ALTER TABLE patients ADD COLUMN IF NOT EXISTS dental_history JSONB DEFAULT '{}';
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

    // Add notify_phone to users table for existing tenants
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_phone VARCHAR(20);
    `);

    // Fix phone format constraint: digits-only (no + prefix) to match VARCHAR(20) column width.
    // The webhook layer strips any leading + before storage, so + is never present in DB.
    await client.query(`
      DO $$ BEGIN
        -- Drop old constraint if it exists (old regex allowed + prefix which can exceed VARCHAR(20))
        ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_phone_format;
        ALTER TABLE patients
          ADD CONSTRAINT patients_phone_format CHECK (phone ~ '^[0-9]{7,20}$');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    // Add new indexes (idempotent)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_appt_status_date ON appointments(status, appointment_date DESC);
      CREATE INDEX IF NOT EXISTS idx_appt_created_at ON appointments(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_bot_sessions_activity ON bot_sessions(last_activity);
      CREATE INDEX IF NOT EXISTS idx_wa_messages_phone ON wa_messages(phone);
      -- Rebuild idx_wa_messages_msg_id ONLY if it still has the legacy shape
      -- (non-partial or non-unique). An unconditional DROP+CREATE here ran on
      -- every boot for every tenant, taking an ACCESS EXCLUSIVE lock on
      -- wa_messages and — once the table grew past what the rebuild could do
      -- inside a statement timeout — aborting the rest of this migration file.
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = 'idx_wa_messages_msg_id'
            AND n.nspname = current_schema()
            AND (i.indpred IS NULL OR NOT i.indisunique)
        ) THEN
          DROP INDEX idx_wa_messages_msg_id;
        END IF;
      END $$;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_messages_msg_id ON wa_messages(wa_message_id) WHERE wa_message_id IS NOT NULL;
      -- Email index for bounce handler (UPDATE patients SET email_status WHERE email=$1)
      CREATE INDEX IF NOT EXISTS idx_patients_email ON patients(email) WHERE email IS NOT NULL;
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

    // Service catalog and holiday tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS clinic_services (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        hospital_id UUID REFERENCES hospitals(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        category VARCHAR(100),
        duration_minutes INTEGER DEFAULT 30,
        price INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS clinic_holidays (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        hospital_id UUID REFERENCES hospitals(id) ON DELETE CASCADE,
        holiday_date DATE NOT NULL,
        name VARCHAR(255) NOT NULL,
        created_by_user_id UUID,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(hospital_id, holiday_date)
      );
      CREATE INDEX IF NOT EXISTS idx_holidays_date ON clinic_holidays(holiday_date);
      CREATE INDEX IF NOT EXISTS idx_services_hospital ON clinic_services(hospital_id, is_active);
    `);

    // Add lunch_start_time and lunch_end_time to doctor_schedules if missing
    await client.query(`
      ALTER TABLE doctor_schedules ADD COLUMN IF NOT EXISTS lunch_start_time TIME DEFAULT NULL;
      ALTER TABLE doctor_schedules ADD COLUMN IF NOT EXISTS lunch_end_time TIME DEFAULT NULL;
    `);

    // Track WHY a slot is blocked: slots blocked automatically by a doctor leave
    // are marked so that deleting the leave only un-blocks those slots and never
    // releases slots an admin blocked manually for another reason.
    await client.query(`
      ALTER TABLE time_slots ADD COLUMN IF NOT EXISTS blocked_by_leave BOOLEAN DEFAULT false;
    `);

    // Soft-delete columns for hospitals and patients
    await client.query(`
      ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
      ALTER TABLE patients  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
      ALTER TABLE patients  ADD COLUMN IF NOT EXISTS opted_out   BOOLEAN DEFAULT false;
    `);

    // Allow multiple patients per phone (family booking support).
    // Drop any unique constraint / index on patients.phone so a parent can book
    // for a child, spouse, or other family member from the same number.
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'patients_phone_key'
            AND conrelid = (current_schema() || '.patients')::regclass
        ) THEN
          ALTER TABLE patients DROP CONSTRAINT patients_phone_key;
        END IF;
      END $$;
      DROP INDEX IF EXISTS idx_patients_phone_active;
    `);

    // New composite indexes for reminder cron and common query patterns
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_appt_doctor_date        ON appointments(doctor_id, appointment_date);
      CREATE INDEX IF NOT EXISTS idx_appt_patient_status     ON appointments(patient_id, status, appointment_date DESC);
      CREATE INDEX IF NOT EXISTS idx_appt_reminder_24h       ON appointments(appointment_date, reminder_24h_sent) WHERE status='confirmed' AND reminder_24h_sent=false;
      CREATE INDEX IF NOT EXISTS idx_appt_reminder_2h        ON appointments(appointment_date, appointment_time, reminder_2h_sent) WHERE status='confirmed' AND reminder_2h_sent=false;
      CREATE INDEX IF NOT EXISTS idx_slots_doctor_date_status ON time_slots(doctor_id, slot_date, status);
      CREATE INDEX IF NOT EXISTS idx_appt_hospital_date       ON appointments(hospital_id, appointment_date DESC);
      CREATE INDEX IF NOT EXISTS idx_patients_created         ON patients(created_at DESC);
      -- Filtered (partial) indexes for soft-delete columns
      CREATE INDEX IF NOT EXISTS idx_hospitals_active ON hospitals(id) WHERE is_active=true AND deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_patients_active  ON patients(created_at DESC) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_doctors_active   ON doctors(id) WHERE is_active=true;
    `);

    // Audit log immutability trigger (idempotent)
    await client.query(`
      CREATE OR REPLACE FUNCTION prevent_tenant_audit_mutation()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'audit_logs is append-only and cannot be modified or deleted';
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgname = 'audit_logs_immutable'
            AND tgrelid = (current_schema() || '.audit_logs')::regclass
        ) THEN
          CREATE TRIGGER audit_logs_immutable
          BEFORE UPDATE OR DELETE ON audit_logs
          FOR EACH ROW EXECUTE FUNCTION prevent_tenant_audit_mutation();
        END IF;
      END $$;
    `).catch(() => {});

    // Add unique constraint on appointment_feedback to prevent duplicate feedback
    // per appointment. Deduplicate first (keep the newest row) — a pre-constraint
    // tenant can hold duplicates, and without the DELETE the ALTER fails on every
    // boot while the bot's ON CONFLICT (appointment_id) insert errors at runtime.
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'uq_feedback_appointment'
            AND conrelid = 'appointment_feedback'::regclass
        ) THEN
          DELETE FROM appointment_feedback f1
          USING appointment_feedback f2
          WHERE f1.created_at < f2.created_at
            AND f1.appointment_id = f2.appointment_id;
          ALTER TABLE appointment_feedback ADD CONSTRAINT uq_feedback_appointment UNIQUE (appointment_id);
        END IF;
      END $$;
    `).catch((e) => console.error(`uq_feedback_appointment migration failed for ${schemaName}: ${e.message}`));

    // Enhancement 6: documents table for patient prescriptions/reports
    await client.query(`
      CREATE TABLE IF NOT EXISTS documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
        appointment_id UUID REFERENCES appointments(id) ON DELETE SET NULL,
        file_name VARCHAR(255) NOT NULL,
        file_type VARCHAR(100),
        file_size_bytes INTEGER,
        file_data TEXT NOT NULL,
        uploaded_by_user_id UUID,
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_documents_patient ON documents(patient_id, created_at DESC);
    `);

    // Email templates (admin-editable)
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_templates (
        id VARCHAR(100) PRIMARY KEY,
        subject TEXT NOT NULL,
        html_body TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        updated_by UUID
      );
    `);

    // Email unsubscribe tokens
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_unsubscribes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
        token VARCHAR(64) UNIQUE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        unsubscribed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_email_unsub_token ON email_unsubscribes(token);
      CREATE INDEX IF NOT EXISTS idx_email_unsub_patient ON email_unsubscribes(patient_id);
    `);

    // WhatsApp message status tracking
    await client.query(`
      ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS status VARCHAR(20);
      ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ;
      ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS reaction VARCHAR(20);
    `);

    // Group session capacity on time_slots
    await client.query(`
      ALTER TABLE time_slots ADD COLUMN IF NOT EXISTS max_capacity INTEGER DEFAULT 1;
      ALTER TABLE time_slots ADD COLUMN IF NOT EXISTS booked_count INTEGER DEFAULT 0;
    `);

    // Appointment enhancements for follow-up, SMS, pricing
    await client.query(`
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS follow_up_appointment_id UUID REFERENCES appointments(id);
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS follow_up_days INTEGER;
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS sms_fallback_sent BOOLEAN DEFAULT false;
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS follow_up_sent BOOLEAN DEFAULT false;
      -- Marks that a feedback REQUEST was sent (distinct from appointment_feedback,
      -- which only exists once a patient actually replies). Without it the daily
      -- feedback job had no way to resume: it took LIMIT n from a window fixed to
      -- "yesterday", so everyone past the limit was never contacted at all.
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS feedback_request_sent BOOLEAN DEFAULT false;
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS effective_fee INTEGER DEFAULT 0;
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) DEFAULT 'pending';
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_collected_at TIMESTAMPTZ;
    `);

    // Patient cohort tracking
    await client.query(`
      ALTER TABLE patients ADD COLUMN IF NOT EXISTS first_appointment_date DATE;
      ALTER TABLE patients ADD COLUMN IF NOT EXISTS patient_type VARCHAR(20) DEFAULT 'new';
      ALTER TABLE patients ADD COLUMN IF NOT EXISTS email_status VARCHAR(20) DEFAULT 'valid';
    `);

    // Doctor dynamic pricing and no-show score
    await client.query(`
      ALTER TABLE doctors ADD COLUMN IF NOT EXISTS pricing_rules JSONB DEFAULT '{}';
      ALTER TABLE doctors ADD COLUMN IF NOT EXISTS no_show_score NUMERIC(4,2) DEFAULT 0;
    `);

    // Multi-location doctor support
    await client.query(`
      CREATE TABLE IF NOT EXISTS doctor_hospitals (
        doctor_id UUID REFERENCES doctors(id) ON DELETE CASCADE,
        hospital_id UUID REFERENCES hospitals(id) ON DELETE CASCADE,
        day_of_week INTEGER CHECK (day_of_week BETWEEN 0 AND 6),
        start_time TIME,
        end_time TIME,
        PRIMARY KEY (doctor_id, hospital_id, day_of_week)
      );
      CREATE INDEX IF NOT EXISTS idx_doctor_hospitals_doctor ON doctor_hospitals(doctor_id);
      CREATE INDEX IF NOT EXISTS idx_doctor_hospitals_hospital ON doctor_hospitals(hospital_id);
    `);

    // Reminder confirmations (patient YES/NO replies)
    await client.query(`
      CREATE TABLE IF NOT EXISTS reminder_confirmations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        appointment_id UUID REFERENCES appointments(id) ON DELETE CASCADE UNIQUE,
        phone VARCHAR(20) NOT NULL,
        response VARCHAR(10),
        responded_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_reminder_conf_appt ON reminder_confirmations(appointment_id);
      CREATE INDEX IF NOT EXISTS idx_reminder_conf_phone ON reminder_confirmations(phone);
    `);

    // Backfill UNIQUE constraint on appointment_id for existing reminder_confirmations tables
    // (tables created before the UNIQUE was added). ON CONFLICT (appointment_id) requires it.
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'reminder_confirmations_appointment_id_key'
            AND conrelid = 'reminder_confirmations'::regclass
        ) THEN
          DELETE FROM reminder_confirmations rc1
          USING reminder_confirmations rc2
          WHERE rc1.created_at < rc2.created_at
            AND rc1.appointment_id = rc2.appointment_id;
          ALTER TABLE reminder_confirmations
            ADD CONSTRAINT reminder_confirmations_appointment_id_key UNIQUE (appointment_id);
        END IF;
      END $$;
    `).catch(() => {});

    // Department pre-visit checklist
    await client.query(`
      ALTER TABLE departments ADD COLUMN IF NOT EXISTS pre_visit_checklist TEXT;
    `);

    // New analytics indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_appt_patient_created ON appointments(patient_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_appt_followup_sent ON appointments(appointment_date, follow_up_sent) WHERE status='confirmed' AND follow_up_sent=false;
    `);

    // Feature 21: Link users to doctor records
    await client.query(`
      ALTER TABLE doctors ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_doctors_user_id ON doctors(user_id) WHERE user_id IS NOT NULL;
    `);

    // Defense-in-depth against the follow-up TOCTOU race (POST /appointments/:id/followup):
    // the route now re-checks follow_up_appointment_id under a row lock, but this
    // partial unique index guards every write path against two follow-ups ever
    // pointing back at the same original appointment. Best-effort: if a tenant
    // somehow already has duplicate follow_up_appointment_id values, index
    // creation fails and is skipped rather than blocking every future boot.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_followup_unique
        ON appointments(follow_up_appointment_id) WHERE follow_up_appointment_id IS NOT NULL;
    `).catch(err => logger.warn('Could not create idx_appt_followup_unique (likely pre-existing duplicate data)', { schema: schemaName, error: err.message }));

  } finally {
    // RESET BOTH. statement_timeout is per-session state and the pool sets it
    // as a connection parameter (db/index.js), so a connection released after
    // 'SET statement_timeout TO 0' keeps NO timeout for the rest of its life —
    // silently disabling the pool-starvation guard for that slot. Tenant
    // creation runs this at runtime from the super admin console.
    await client.query('RESET statement_timeout').catch(() => {});
    await client.query('RESET lock_timeout').catch(() => {});
    await client.query('RESET search_path').catch(() => {});
    client.release();
  }
}

module.exports = { createTenantSchema, runTenantMigrations };
