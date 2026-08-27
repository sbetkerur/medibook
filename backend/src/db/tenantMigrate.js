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
        role VARCHAR(50) DEFAULT 'doctor',
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
        hospital_id UUID REFERENCES hospitals(id),
        UNIQUE(doctor_id, day_of_week, start_time)
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

      -- One-shot data fixups run by db/seed.js record themselves here. entrypoint.sh
      -- re-runs the seed on EVERY boot, so anything that mutates rows an admin can
      -- also edit (deactivating doctors, resetting names) must be gated on a marker
      -- instead of sweeping the tenant again on every deploy.
      CREATE TABLE IF NOT EXISTS seed_markers (
        key VARCHAR(100) PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
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
      -- No 2-hour reminder index: the feature and its column are both gone.
      -- runTenantMigrations drops the column from schemas that predate this.
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
    // Swallowing a RESET failure and releasing anyway returned a POISONED
    // connection to the pool: still pointing at "tenant_x", public, and with no
    // statement timeout. audit_logs, users and documents exist in both the
    // public and tenant schemas, so a later platform-level write on that slot
    // resolved the unqualified name inside a tenant's schema — cross-tenant
    // data landing in the wrong place, with the empty .catch() guaranteeing
    // nobody noticed. If the connection cannot be restored it is not fit to
    // reuse: pass the error to release() so the pool destroys it instead.
    let resetErr = null;
    try {
      await client.query('RESET statement_timeout');
      await client.query('RESET lock_timeout');
      await client.query('RESET search_path');
    } catch (err) {
      resetErr = err;
      logger.warn('Connection reset failed after tenant migration — discarding it', {
        schema: schemaName, error: err.message,
      });
    }
    client.release(resetErr || undefined);
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

    // Marker table for one-shot data fixups run by db/seed.js. Created FIRST so a
    // later block failing for one tenant can never leave the seed without it.
    await client.query(`
      CREATE TABLE IF NOT EXISTS seed_markers (
        key VARCHAR(100) PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

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

    // Two-role model: 'staff' was folded into 'doctor' (permission-identical,
    // shown as "Dentist" in the dashboard). Naturally idempotent — a no-op on
    // every boot once no 'staff' rows remain, so no seed_marker is needed. Any
    // front-desk person who books walk-ins / reschedules / cancels must be an
    // 'admin'; that was already true, as 'staff' could do none of those either.
    await client.query(`UPDATE users SET role = 'doctor' WHERE role = 'staff';`);

    // Phone format constraint: digits-only (no + prefix) to match the VARCHAR(20)
    // column width. The webhook layer strips any leading + before storage.
    //
    // This block used to DROP and re-ADD the constraint UNCONDITIONALLY on every
    // boot for every tenant, and `EXCEPTION WHEN duplicate_object` caught none of
    // the ways that actually fails:
    //   - ADD CONSTRAINT ... CHECK takes ACCESS EXCLUSIVE on patients and
    //     full-scans it to validate. With the 5s lock_timeout set above, a tenant
    //     with live traffic raises lock_not_available.
    //   - one legacy row still carrying a '+' raises check_violation.
    // Either one made client.query throw → runTenantMigrations throw → migrate.js
    // swallow it per-tenant with a console.error, so EVERY later block in this
    // file (feedback_request_sent, payment_status, doctor_hospitals,
    // reminder_confirmations, documents, email_unsubscribes …) silently never ran
    // for that tenant while the deploy still reported success.
    //
    // Now conditional, in the same shape as the idx_wa_messages_msg_id rebuild
    // below: look patients' CHECK constraints up in pg_constraint scoped to
    // current_schema() and only touch anything when none of them already carries
    // the wanted predicate. createTenantSchema declares the same predicate inline
    // on CREATE TABLE (Postgres names it patients_phone_check), so a fresh schema
    // now matches here and skips — previously it ended up with two identical
    // CHECKs, both evaluated on every patient write. If a schema somehow has both,
    // the redundant patients_phone_format is dropped (metadata-only, no scan).
    //
    // NOT VALID is deliberate, chosen over normalising the existing rows: the
    // constraint exists to keep NEW writes clean, and NOT VALID enforces it on
    // every insert/update while skipping the validating full scan — so it can
    // neither time out under lock_timeout nor fail on a pre-existing '+' row.
    // Normalising instead would mean a full UPDATE of patients on every tenant
    // during a deploy AND would still leave the validating scan in place.
    // Belt and braces: EXCEPTION WHEN OTHERS inside and .catch() outside, so a
    // failure here can never take down the rest of this file again.
    await client.query(`
      DO $$
      DECLARE
        wanted CONSTANT text := '^[0-9]{7,20}$';
        has_wanted boolean;
        has_dup    boolean;
      BEGIN
        SELECT
          bool_or(strpos(pg_get_constraintdef(c.oid), wanted) > 0),
          bool_or(c.conname = 'patients_phone_format' AND strpos(pg_get_constraintdef(c.oid), wanted) > 0)
            AND bool_or(c.conname = 'patients_phone_check' AND strpos(pg_get_constraintdef(c.oid), wanted) > 0)
        INTO has_wanted, has_dup
        FROM pg_constraint c
        JOIN pg_class     t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = current_schema()
          AND t.relname = 'patients'
          AND c.contype = 'c';

        IF NOT COALESCE(has_wanted, false) THEN
          ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_phone_format;
          ALTER TABLE patients
            ADD CONSTRAINT patients_phone_format CHECK (phone ~ '^[0-9]{7,20}$') NOT VALID;
          RAISE NOTICE 'patients_phone_format added (NOT VALID) in %', current_schema();
        ELSIF COALESCE(has_dup, false) THEN
          ALTER TABLE patients DROP CONSTRAINT patients_phone_format;
          RAISE NOTICE 'dropped duplicate patients_phone_format in %', current_schema();
        END IF;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'patients_phone_format migration skipped in %: % (%)',
          current_schema(), SQLERRM, SQLSTATE;
      END $$;
    `).catch(err => logger.warn('patients_phone_format migration skipped', { schema: schemaName, error: err.message }));

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
      -- Email index for bounce handler (UPDATE patients SET email_status WHERE email=$1)
      CREATE INDEX IF NOT EXISTS idx_patients_email ON patients(email) WHERE email IS NOT NULL;
    `);

    // Split out of the block above and caught, because it is UNIQUE over data
    // that predates it. If the legacy-shape DROP just ran and wa_messages holds
    // duplicate wa_message_ids, this throws — and migrate.js catches a tenant
    // failure per tenant and moves on, so an uncaught throw here silently
    // abandons every remaining migration block for that clinic while the deploy
    // still reports success. A deterministic failure never self-heals: the same
    // line dies on every future boot, so clinic_requests, online_bookable and
    // doctor_schedules.hospital_id would never arrive for them.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_messages_msg_id
        ON wa_messages(wa_message_id) WHERE wa_message_id IS NOT NULL;
    `).catch(err => logger.warn('idx_wa_messages_msg_id not created — duplicate wa_message_id rows present', {
      schema: schemaName, error: err.message,
    }));

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
    //
    // blocked_by_holiday is the same idea for clinic holidays. Declaring a
    // holiday used to insert a clinic_holidays row and nothing else — the slots
    // stayed 'available' forever (the nightly generator only INSERTs, it never
    // deletes), so the ONLY thing keeping them unbookable was the NOT EXISTS
    // filter in the date-LIST queries. A patient holding a date list cached
    // before the holiday was declared tapped straight past it and booked a day
    // the clinic was shut. The flag has to be separate from blocked_by_leave so
    // that deleting a holiday releases only the slots THAT holiday blocked —
    // never a doctor's leave days and never slots an admin blocked by hand.
    await client.query(`
      ALTER TABLE time_slots ADD COLUMN IF NOT EXISTS blocked_by_leave BOOLEAN DEFAULT false;
      ALTER TABLE time_slots ADD COLUMN IF NOT EXISTS blocked_by_holiday BOOLEAN DEFAULT false;
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

    // The last of the 2-hour reminder, removed as a feature in 7863f9b.
    //
    // Nothing in the application has read `reminder_2h_sent` since — not a
    // query, not a write, not the frontend — while its partial index carried a
    // predicate (status='confirmed' AND reminder_2h_sent=false) matching
    // essentially every row at insert time, so every appointment ever booked
    // paid to maintain an index no query used.
    //
    // This is a DELIBERATE, IRREVERSIBLE drop, which is the only way a column
    // should ever go. What makes it safe to take now rather than never:
    //   * production holds no clinics yet, so no real appointment carries a
    //     value here — the historical record this column existed to preserve
    //     is empty. Doing it after the first clinic onboards would be a
    //     genuine data decision; doing it now costs nothing.
    //   * `follow_up_sent` looks identical and is NOT dropped: it is still read
    //     by sendFeedbackRequests as a guard against re-asking someone who was
    //     already asked by the old post-visit cron. Similar shape, different
    //     answer — which is the whole reason to check each one rather than
    //     sweep them together.
    //
    // Dropping the column takes its index with it, so no separate DROP INDEX is
    // needed. IF EXISTS makes this a no-op on every boot after the first, and
    // the 5s lock_timeout set above means it fails fast and retries next boot
    // rather than queueing an ACCESS EXCLUSIVE request behind live readers.
    await client.query(`ALTER TABLE appointments DROP COLUMN IF EXISTS reminder_2h_sent;`)
      .catch(e => logger.warn('Could not drop reminder_2h_sent — will retry next boot', {
        schema: schemaName, error: e.message,
      }));

    // New composite indexes for reminder cron and common query patterns
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_appt_doctor_date        ON appointments(doctor_id, appointment_date);
      CREATE INDEX IF NOT EXISTS idx_appt_patient_status     ON appointments(patient_id, status, appointment_date DESC);
      CREATE INDEX IF NOT EXISTS idx_appt_reminder_24h       ON appointments(appointment_date, reminder_24h_sent) WHERE status='confirmed' AND reminder_24h_sent=false;
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

    // Multi-department doctors. In Indian dental practice a GP routinely renders
    // treatments that also have a specialist on staff (simple RCTs, extractions),
    // so "which dentists can a patient book for this treatment?" is many-to-many.
    // doctors.department_id is KEPT as the doctor's PRIMARY department — every
    // display join (receipts, reminders, analytics "by treatment") still reads it
    // and is unaffected. This table is the BOOKABLE set, and the primary is always
    // mirrored into it (see utils/doctorDepartments.js), which is what makes the
    // backfill below a no-op on every boot after the first.
    await client.query(`
      CREATE TABLE IF NOT EXISTS doctor_departments (
        doctor_id UUID REFERENCES doctors(id) ON DELETE CASCADE,
        department_id UUID REFERENCES departments(id) ON DELETE CASCADE,
        PRIMARY KEY (doctor_id, department_id)
      );
      CREATE INDEX IF NOT EXISTS idx_doctor_departments_dept ON doctor_departments(department_id);
      INSERT INTO doctor_departments (doctor_id, department_id)
        SELECT id, department_id FROM doctors WHERE department_id IS NOT NULL
        ON CONFLICT DO NOTHING;
    `);

    // The treatment an appointment was booked FOR. Previously derived from the
    // doctor's single department, which stops being true the moment a doctor sits
    // in more than one: a root canal booked with a GP would print "General
    // Dentistry" on the receipt. Booked-for wins; the doctor's primary department
    // is only the fallback for rows predating this column.
    // Recorded once in seed_markers so the backfill runs on ONE boot, not every
    // boot. The previous guard probed for `department_id IS NULL` and claimed
    // that made the scan one-shot — it did not. doctors.department_id is
    // nullable (the dashboard sends '' / null for "no department"), so any
    // tenant with a single department-less dentist keeps appointments the
    // backfill cannot fill, the probe stays true forever, and the full
    // `UPDATE … FROM doctors` join re-ran on every deploy under
    // statement_timeout = 0, updating zero rows. Harmless to the data —
    // insertAppointmentWithRetry already COALESCEs to the doctor's primary —
    // but a seq-scan join over appointments per tenant per deploy, and a
    // comment asserting a guarantee the code did not provide.
    await client.query(`
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments(id);
    `);
    // seed_markers already exists by this point — created twice above, well
    // before here, precisely so later blocks can rely on it.
    await client.query(`
      DO $mig$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM seed_markers WHERE key = 'backfill_appt_department_v1') THEN
          UPDATE appointments a SET department_id = d.department_id
          FROM doctors d
          WHERE d.id = a.doctor_id AND a.department_id IS NULL AND d.department_id IS NOT NULL;
          INSERT INTO seed_markers (key) VALUES ('backfill_appt_department_v1')
            ON CONFLICT (key) DO NOTHING;
        END IF;
      END $mig$;
    `);

    // Multi-visit treatments. A root canal is 2–3 visits, an implant is several
    // months of them — and the visits can be rendered by a different dentist than
    // the one who diagnosed (the GP refers the hard case to the endodontist on
    // staff). appointments.follow_up_appointment_id chains one visit to the next
    // but has no head, so nothing could answer "what treatment is outstanding for
    // this patient" or "what did we advise and never book" — which is where a
    // clinic's revenue actually leaks.
    //
    // Deliberately NOT stored: visit counters. visits done/booked are derived
    // from the linked appointments, so a cancelled visit can't leave the plan
    // claiming progress it doesn't have.
    await client.query(`
      CREATE TABLE IF NOT EXISTS treatment_plans (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
        hospital_id UUID REFERENCES hospitals(id),
        department_id UUID REFERENCES departments(id),
        service_id UUID REFERENCES clinic_services(id),
        origin_appointment_id UUID REFERENCES appointments(id),
        advised_by_doctor_id UUID REFERENCES doctors(id),
        treating_doctor_id UUID REFERENCES doctors(id),
        title VARCHAR(255) NOT NULL,
        tooth_ref VARCHAR(50),
        total_visits INTEGER NOT NULL DEFAULT 1 CHECK (total_visits BETWEEN 1 AND 60),
        scheduling_mode VARCHAR(10) NOT NULL DEFAULT 'patient'
          CHECK (scheduling_mode IN ('patient','clinic')),
        estimated_cost INTEGER DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'proposed'
          CHECK (status IN ('proposed','in_progress','completed','declined','cancelled')),
        notes TEXT,
        created_by_user_id UUID,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_treatment_plans_patient ON treatment_plans(patient_id);
      -- The "advised but not booked" queue reads this every time the tab opens.
      CREATE INDEX IF NOT EXISTS idx_treatment_plans_open ON treatment_plans(status)
        WHERE status IN ('proposed','in_progress');

      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS treatment_plan_id UUID REFERENCES treatment_plans(id);
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS visit_number INTEGER;
      CREATE INDEX IF NOT EXISTS idx_appt_treatment_plan ON appointments(treatment_plan_id)
        WHERE treatment_plan_id IS NOT NULL;

      -- One LIVE appointment per ordinal within a course. Cancelled visits are
      -- excluded so their number can be reused by the sitting that replaces
      -- them. Without this, nothing stopped two rows both claiming "visit 3 of
      -- 3" — which is what the count-based nextVisitNumber produced after any
      -- cancellation. The application now fills the lowest free number; this is
      -- the backstop that keeps a future writer honest.
      DO $mig$
      BEGIN
        CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_plan_visit_no
          ON appointments(treatment_plan_id, visit_number)
          WHERE treatment_plan_id IS NOT NULL
            AND visit_number IS NOT NULL
            AND status <> 'cancelled';
      EXCEPTION WHEN unique_violation THEN
        -- A tenant that already collected duplicates under the old arithmetic.
        -- Boot must not fail over a reporting label: log it and carry on; the
        -- application-side fix stops new ones, and the existing rows can be
        -- renumbered by hand.
        RAISE WARNING 'duplicate treatment plan visit_numbers present — idx_appt_plan_visit_no not created';
      END
      $mig$;

      -- The nudge cron asks the patient to book their next sitting themselves.
      -- Recorded on the plan so a patient who ignores one is asked again later
      -- but never twice in the same week, and never forever.
      ALTER TABLE treatment_plans ADD COLUMN IF NOT EXISTS last_nudge_at TIMESTAMPTZ;
      ALTER TABLE treatment_plans ADD COLUMN IF NOT EXISTS nudge_count INTEGER DEFAULT 0;
    `);

    // Visiting specialists. In Indian practice the specialist is very often a
    // visiting consultant: at this branch on Tuesdays, at another on Thursdays,
    // and frequently only on some weeks of the month.
    //
    // week_of_month expresses the second half of that. NULL or empty = every
    // week (the existing behaviour, and what every current row means). {1,3} =
    // the 1st and 3rd occurrence of that weekday in the month, which is the
    // common arrangement; alternate weeks are written {1,3,5}.
    //
    // WHICH BRANCH on a given weekday lives in doctor_hospitals, which already
    // had exactly the right shape and — until now — was written by the API and
    // read by nothing, so every slot was stamped with doctors.hospital_id.
    await client.query(`
      ALTER TABLE doctor_schedules ADD COLUMN IF NOT EXISTS week_of_month INTEGER[];
      ALTER TABLE doctors ADD COLUMN IF NOT EXISTS is_visiting BOOLEAN DEFAULT false;
    `);

    // Money against a course of treatment. Indian dental work is paid in
    // instalments across sittings — "₹2,000 today, balance next visit" — so the
    // first question an owner asks about a 3-sitting root canal is how much has
    // been collected. treatment_plans.estimated_cost alone could not answer it.
    //
    // Deliberately separate from appointments.effective_fee / payment_status,
    // which are the per-VISIT consultation fee. A course is billed as a whole
    // and paid against the plan; conflating the two would double-count revenue.
    //
    // Amount is in whole rupees (INTEGER), matching every other money column
    // here. Balance is derived, never stored — a stored balance drifts the first
    // time a payment is corrected.
    await client.query(`
      CREATE TABLE IF NOT EXISTS treatment_payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        treatment_plan_id UUID NOT NULL REFERENCES treatment_plans(id) ON DELETE CASCADE,
        appointment_id UUID REFERENCES appointments(id),
        amount INTEGER NOT NULL CHECK (amount > 0),
        method VARCHAR(20) NOT NULL DEFAULT 'cash'
          CHECK (method IN ('cash','card','upi','bank_transfer','cheque','other')),
        note TEXT,
        collected_by_user_id UUID,
        collected_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_treatment_payments_plan ON treatment_payments(treatment_plan_id);
    `);

    // Lab work. Crowns, dentures and aligners go out to a lab and come back,
    // and the next sitting cannot happen until they do — booking it purely on
    // slot availability is how a patient arrives to find their crown isn't in.
    await client.query(`
      CREATE TABLE IF NOT EXISTS lab_works (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        treatment_plan_id UUID REFERENCES treatment_plans(id) ON DELETE CASCADE,
        patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
        lab_name VARCHAR(255),
        item VARCHAR(255) NOT NULL,
        sent_date DATE,
        expected_date DATE,
        received_date DATE,
        status VARCHAR(20) NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','sent','received','fitted','cancelled')),
        cost INTEGER DEFAULT 0,
        notes TEXT,
        created_by_user_id UUID,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_lab_works_plan ON lab_works(treatment_plan_id);
      -- The "what is overdue from the lab" view, which is the only one staff open.
      CREATE INDEX IF NOT EXISTS idx_lab_works_open ON lab_works(status, expected_date)
        WHERE status IN ('pending','sent');
    `);

    // Recall / recare — the six-month check-up loop. The cheapest revenue a
    // clinic has and the one thing none of the existing crons cover: reminders
    // are for booked appointments, feedback is about a past visit, and the
    // treatment nudge only fires for a course already advised. Nothing brought
    // a healthy patient back next year.
    //
    // A table rather than a column on patients, because a patient can be due
    // for more than one thing (a routine check-up AND an implant review).
    await client.query(`
      CREATE TABLE IF NOT EXISTS patient_recalls (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        origin_appointment_id UUID REFERENCES appointments(id),
        hospital_id UUID REFERENCES hospitals(id),
        reason VARCHAR(255) NOT NULL DEFAULT 'Routine check-up',
        due_date DATE NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'due'
          CHECK (status IN ('due','booked','done','dismissed')),
        last_sent_at TIMESTAMPTZ,
        send_count INTEGER DEFAULT 0,
        booked_appointment_id UUID REFERENCES appointments(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_recalls_due ON patient_recalls(due_date) WHERE status='due';
      CREATE INDEX IF NOT EXISTS idx_recalls_patient ON patient_recalls(patient_id);
    `);

    // Same reasoning as idx_wa_messages_msg_id above: UNIQUE over pre-existing
    // rows, so it must not be able to abandon the rest of this file.
    //
    // One open recall per patient per reason: completing three visits in a
    // month must not queue three identical check-up reminders.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_recalls_one_open
        ON patient_recalls(patient_id, reason) WHERE status='due';
    `).catch(err => logger.warn('idx_recalls_one_open not created — duplicate due recalls present', {
      schema: schemaName, error: err.message,
    }));

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

    // ── A WORKING DAY IS A LIST OF SESSIONS, NOT ONE WINDOW ────
    // An Indian dentist routinely works 10–1 at one clinic and 5–9 at another
    // on the SAME day — the default arrangement for a visiting endodontist or
    // an owner with two branches. The old model could not express it:
    // doctor_schedules was UNIQUE(doctor_id, day_of_week), one window per day,
    // while doctor_hospitals was keyed per (doctor, hospital, day). Two branch
    // rows for one weekday made the LEFT JOIN return two schedule rows, and
    // planDoctorSlots took the FIRST with `.find()` — so the second branch got
    // no slots, with no error anywhere. The clinic would notice weeks later.
    //
    // A schedule row now IS a session: doctor + weekday + hours + branch.
    // `hospital_id` NULL still means the doctor's primary branch, which is
    // every doctor who is not a visiting consultant.
    await client.query(`
      ALTER TABLE doctor_schedules ADD COLUMN IF NOT EXISTS hospital_id UUID REFERENCES hospitals(id);
    `);
    // Carry the existing per-weekday branch across before the old constraint
    // goes, or the meaning of those rows is lost.
    //
    // ONE-SHOT, via seed_markers. This file has no runMigration versioning, so
    // an ungated UPDATE here ran on every boot for every tenant — and because
    // `hospital_id IS NULL` means "the doctor's primary branch" (not "unknown"),
    // it did not just backfill legacy rows: it rewrote deliberate ones. A
    // dentist with Tuesday 10-13 at a second branch and Tuesday 17-21 at their
    // primary stores (Tue,10:00,B) and (Tue,17:00,NULL); every deploy stamped
    // the evening session with B, so slots generated at the wrong branch and
    // isBlockedDay checked the wrong branch's holidays. Re-saving in the UI
    // restored NULL and the next deploy clobbered it again, with nothing
    // logged either time.
    const backfilled = await client.query(
      `SELECT 1 FROM seed_markers WHERE key='backfill_schedule_hospital_v1'`
    ).catch(() => ({ rows: [] }));
    if (!backfilled.rows.length) {
      await client.query(`
        UPDATE doctor_schedules s
           SET hospital_id = dh.hospital_id
          FROM doctor_hospitals dh
         WHERE dh.doctor_id = s.doctor_id
           AND dh.day_of_week = s.day_of_week
           AND s.hospital_id IS NULL
           -- Only on a weekday where NO session names a branch explicitly.
           --
           -- This is the load-bearing condition, not a nicety. POST
           -- /doctors/:id/schedule writes a doctor_hospitals row ONLY for a
           -- session that has an explicit hospital_id, so a Tuesday split
           -- "10-13 at branch B / 17-21 at primary (NULL)" has exactly ONE dh
           -- row — counting dh rows would call that unambiguous and stamp the
           -- deliberate NULL with B, which is the bug this gating exists to
           -- stop. If any session that day names a branch, the NULLs beside it
           -- mean "primary branch" and must be left alone. A genuinely legacy
           -- weekday (every session NULL, dh rows written by the old API) still
           -- backfills, which is all this was ever for.
           AND NOT EXISTS (
             SELECT 1 FROM doctor_schedules s2
              WHERE s2.doctor_id = s.doctor_id
                AND s2.day_of_week = s.day_of_week
                AND s2.hospital_id IS NOT NULL
           )
           -- With two branches on one legacy weekday the UPDATE ... FROM would
           -- still pick an arbitrary dh row; leave those for a human.
           AND (SELECT COUNT(*) FROM doctor_hospitals dh2
                 WHERE dh2.doctor_id = s.doctor_id
                   AND dh2.day_of_week = s.day_of_week) = 1;
      `).catch(err => logger.warn('doctor_schedules branch backfill skipped', { schema: schemaName, error: err.message }));
      await client.query(
        `INSERT INTO seed_markers (key) VALUES ('backfill_schedule_hospital_v1') ON CONFLICT DO NOTHING`
      ).catch(() => {});
    }
    // Swap UNIQUE(doctor,day) for UNIQUE(doctor,day,start_time). Dropped by
    // lookup rather than by its default name: a schema created before the
    // constraint was named this way would silently keep it and reject the
    // second session forever.
    await client.query(`
      DO $$
      DECLARE conname TEXT;
      BEGIN
        SELECT c.conname INTO conname
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE t.relname = 'doctor_schedules'
           AND n.nspname = current_schema()
           AND c.contype = 'u'
           AND (SELECT COUNT(*) FROM unnest(c.conkey)) = 2
         LIMIT 1;
        IF conname IS NOT NULL THEN
          EXECUTE format('ALTER TABLE doctor_schedules DROP CONSTRAINT %I', conname);
        END IF;
      END $$;
    `).catch(err => logger.warn('doctor_schedules unique swap skipped', { schema: schemaName, error: err.message }));
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_doctor_schedules_session
        ON doctor_schedules(doctor_id, day_of_week, start_time);
    `).catch(err => logger.warn('idx_doctor_schedules_session skipped', { schema: schemaName, error: err.message }));

    // ── REQUESTS THE BOT COULD NOT SATISFY ─────────────────────
    // Two dead ends the front desk never heard about: a patient who wanted a
    // day with no free slots, and a patient the bot simply could not help. In
    // an Indian clinic both would have phoned, and the receptionist would have
    // fitted them in — the grid is a guide, not the diary. These rows are that
    // conversation, queued for someone to work through.
    await client.query(`
      CREATE TABLE IF NOT EXISTS clinic_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        kind VARCHAR(20) NOT NULL CHECK (kind IN ('appointment','callback')),
        phone VARCHAR(20) NOT NULL,
        patient_id UUID REFERENCES patients(id) ON DELETE SET NULL,
        patient_name VARCHAR(255),
        hospital_id UUID REFERENCES hospitals(id),
        department_id UUID REFERENCES departments(id),
        doctor_id UUID REFERENCES doctors(id) ON DELETE SET NULL,
        preferred_date DATE,
        note TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'open'
          CHECK (status IN ('open','handled','closed')),
        handled_by_user_id UUID,
        handled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_clinic_requests_open
        ON clinic_requests(created_at DESC) WHERE status = 'open';
      CREATE INDEX IF NOT EXISTS idx_clinic_requests_phone ON clinic_requests(phone);
    `);
    // One open request per phone per kind. A patient who taps "ask the clinic"
    // on three different dates is one person wanting one appointment, not three
    // items on the receptionist's list.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_clinic_requests_one_open
        ON clinic_requests(phone, kind) WHERE status = 'open';
    `).catch(err => logger.warn('idx_clinic_requests_one_open skipped', { schema: schemaName, error: err.message }));

    // ── COURSES THE CLINIC SCHEDULES, NOT THE PATIENT ──────────
    // Orthodontics is 18–24 monthly adjustments over two years, and the next
    // appointment is set by the dentist at the chair ("come back in four
    // weeks") — never chosen by the patient from a slot list. Nudging them to
    // self-book a monthly adjustment is wrong for the single biggest course
    // type in an Indian practice.
    await client.query(`
      ALTER TABLE treatment_plans ADD COLUMN IF NOT EXISTS scheduling_mode VARCHAR(10)
        NOT NULL DEFAULT 'patient';
    `);
    // Both CHECKs below are applied ONLY when the wanted definition is absent.
    // They used to DROP and re-ADD unconditionally on every boot for every
    // tenant, and ADD CONSTRAINT ... CHECK takes ACCESS EXCLUSIVE on
    // treatment_plans and full-scans it to validate — the same anti-pattern the
    // patients_phone_format block above was rewritten to remove. Worse, being
    // .catch-wrapped under a 5s lock_timeout, a busy tenant could lose the
    // constraint on the DROP and silently fail the re-ADD, so the 60-visit cap
    // might never actually be in force. pg_constraint carries the compiled
    // expression, so we can ask whether it is already right.
    const ensureCheck = async (name, expr, definitionMatch) => {
      const existing = await client.query(
        `SELECT pg_get_constraintdef(c.oid) AS def
           FROM pg_constraint c
           JOIN pg_class t ON t.oid = c.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = current_schema()
            AND t.relname = 'treatment_plans'
            AND c.conname = $1`,
        [name]
      ).catch(() => ({ rows: [] }));
      if (existing.rows.length && definitionMatch.test(existing.rows[0].def)) return;
      await client.query(`
        ALTER TABLE treatment_plans DROP CONSTRAINT IF EXISTS ${name};
        ALTER TABLE treatment_plans ADD CONSTRAINT ${name} CHECK (${expr});
      `).catch(err => logger.warn(`${name} not applied`, { schema: schemaName, error: err.message }));
    };
    await ensureCheck('treatment_plans_scheduling_mode_check',
      `scheduling_mode IN ('patient','clinic')`, /'patient'.*'clinic'/s);
    // 30 visits does not cover a two-year ortho case (monthly adjustments plus
    // bonding, debond and retainer reviews). Raised rather than removed: an
    // unbounded value here is a typo that generates hundreds of appointments.
    await ensureCheck('treatment_plans_total_visits_check',
      `total_visits BETWEEN 1 AND 60`, /\b60\b/);

    // ── NOT EVERY DENTIST BELONGS ON THE PUBLIC LIST ───────────
    // "Active with a schedule" used to mean "bookable by any stranger". A
    // clinic's visiting orthodontist takes referred cases, not walk-in
    // toothache, and an owner usually wants new patients coming to them rather
    // than to whichever associate has a gap. Defaults TRUE so nothing changes
    // for an existing clinic until they decide otherwise.
    await client.query(`
      ALTER TABLE doctors ADD COLUMN IF NOT EXISTS online_bookable BOOLEAN NOT NULL DEFAULT true;
    `);

    // Which board, referral or listing actually brought the patient in. Set at
    // the desk, not asked in the bot — the booking flow is already long enough,
    // and the receptionist knows the answer better than the patient does.
    await client.query(`
      ALTER TABLE patients ADD COLUMN IF NOT EXISTS referral_source VARCHAR(50);
    `);

    // ── CONSENT ────────────────────────────────────────────────
    // Extractions and surgery need one, and it is what protects the dentist.
    // Recorded as evidence that consent WAS taken, by whom and when — not as a
    // digital signature, which is a different and much larger thing. The note
    // is where "explained risks of nerve damage, patient agreed" goes.
    await client.query(`
      ALTER TABLE treatment_plans ADD COLUMN IF NOT EXISTS consent_taken_at TIMESTAMPTZ;
      ALTER TABLE treatment_plans ADD COLUMN IF NOT EXISTS consent_taken_by UUID;
      ALTER TABLE treatment_plans ADD COLUMN IF NOT EXISTS consent_note TEXT;
    `);

    // ── RESCHEDULE CAP ───────────────────────────────────────────
    // "Reschedule" is cheap for a patient to tap and expensive for a clinic to
    // absorb — every move holds a slot someone else could have taken while the
    // old one goes back into the pool at the last minute. Capped at
    // LIMITS.MAX_RESCHEDULES_PER_APPOINTMENT (appointmentFlow.handleRescheduleSelect);
    // past that, cancel and rebook is a deliberate, visible decision rather
    // than another tap. Only the bot moves an appointment's slot/date — there
    // is no dashboard equivalent — so this counts exactly what that flow does.
    await client.query(`
      ALTER TABLE appointments ADD COLUMN IF NOT EXISTS reschedule_count INTEGER NOT NULL DEFAULT 0;
    `);

  } finally {
    // RESET BOTH. statement_timeout is per-session state and the pool sets it
    // as a connection parameter (db/index.js), so a connection released after
    // 'SET statement_timeout TO 0' keeps NO timeout for the rest of its life —
    // silently disabling the pool-starvation guard for that slot. Tenant
    // creation runs this at runtime from the super admin console.
    // Swallowing a RESET failure and releasing anyway returned a POISONED
    // connection to the pool: still pointing at "tenant_x", public, and with no
    // statement timeout. audit_logs, users and documents exist in both the
    // public and tenant schemas, so a later platform-level write on that slot
    // resolved the unqualified name inside a tenant's schema — cross-tenant
    // data landing in the wrong place, with the empty .catch() guaranteeing
    // nobody noticed. If the connection cannot be restored it is not fit to
    // reuse: pass the error to release() so the pool destroys it instead.
    let resetErr = null;
    try {
      await client.query('RESET statement_timeout');
      await client.query('RESET lock_timeout');
      await client.query('RESET search_path');
    } catch (err) {
      resetErr = err;
      logger.warn('Connection reset failed after tenant migration — discarding it', {
        schema: schemaName, error: err.message,
      });
    }
    client.release(resetErr || undefined);
  }
}

module.exports = { createTenantSchema, runTenantMigrations };
