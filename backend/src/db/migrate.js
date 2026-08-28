require('dotenv').config();
const { pool } = require('./index');
const bcrypt = require('bcryptjs');

async function runMigration(client, version, name, sqlFn) {
  // Ensure schema_migrations table exists first
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  const exists = await client.query(
    `SELECT 1 FROM schema_migrations WHERE version = $1`, [version]);
  if (exists.rows.length > 0) {
    console.log(`  ⏭  Migration ${version} (${name}) already applied`);
    return;
  }
  // Run the migration body and its version record atomically. Without this, a
  // deploy killed mid-migration leaves data-mutating migrations (e.g. 18's
  // in-place token hashing) half-applied and unrecorded, so the next boot
  // re-runs them on already-migrated rows.
  await client.query('BEGIN');
  try {
    await sqlFn();
    await client.query(
      `INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`, [version, name]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
  console.log(`  ✅ Migration ${version}: ${name}`);
}

// ── THE PUBLIC DEMO CLINIC ───────────────────────────────────────────────
// A dentist reached through a professional directory cannot be sent a link, an
// image or an attachment, so the only thing left to carry the pitch is the
// product itself: they message a six-character code to the shared number and
// are booking an appointment seconds later. That needs a real clinic on the
// other end of the code, live in production, permanently.
//
// It cannot live in seed.js. That file is gated on SEED_DEMO_DATA, which
// production sets to false precisely so a sales fixture can never overwrite a
// real clinic's name, fees or admin password on every deploy. So it lives here,
// where production data fix-ups belong — but it inherits exactly the same
// discipline, and the rule it follows is CREATE-ONLY:
//
//   * nothing below ever UPDATEs a name, fee, schedule or department. Whoever
//     tunes this clinic to demo better keeps their edits, because the next
//     deploy has no opinion about them. That is the regression seed.js was
//     rewritten to stop, and re-introducing it here would be the same bug in a
//     new file.
//   * the only two fields repaired on an existing tenant are the ones that make
//     it REACHABLE — status and entry_code. A demo nobody can reach is not a
//     demo, and both of those are ours rather than an operator's.
//   * slots are topped up on every boot. They are the one thing that genuinely
//     expires, and the insert is ON CONFLICT (doctor_id, slot_date, start_time)
//     DO NOTHING, so re-running costs nothing and repairs a demo whose grid ran
//     dry because the nightly cron was wedged.
//
// Set DEMO_TENANT=false to skip it (a private staging copy, or a test database
// that should hold nothing but its own fixtures).
const DEMO_SLUG        = 'pragati-demo';
const DEMO_SCHEMA      = 'tenant_pragati_demo';
const DEMO_CLINIC_NAME = 'Pragati Dental Studio';
// Every character is in the entry-code alphabet (utils/entryCode.js), which
// excludes 0/O, 1/I/L and U — that is what rules out the obvious candidates
// DENTAL, SMILES and TRYNOW. Fixed rather than generated: it is printed in
// outreach that cannot be edited once sent, so it has to survive every deploy.
const DEMO_ENTRY_CODE  = 'TRYMED';
// Matches SLOT_LOOKAHEAD_DAYS, so the date picker is full rather than showing
// the two or three days a shorter window would leave.
const DEMO_SLOT_DAYS   = 14;

// Every department here is the primary or the secondary of a dentist below.
// A treatment with nobody behind it is a dead end in the picker — the patient
// chooses it and gets an empty dentist list — so the two lists are kept in step
// deliberately. Add a department here without adding someone who renders it and
// the demo breaks in the one place a prospect is looking.
const DEMO_DEPARTMENTS = [
  'General Dentistry',
  'Root Canal Treatment',
  'Orthodontics & Braces',
  'Cosmetic Dentistry',
];

// `also` is the rest of the bookable set (doctor_departments); `dept` is the
// primary. The general dentist carries root canals because that is how Indian
// practices actually run — the GP does the simple ones and refers the hard
// cases to the endodontist on staff.
const DEMO_DOCTORS = [
  { name: 'Ananya Rao',    spec: 'General Dentist', qual: 'BDS',
    dept: 'General Dentistry',     also: ['Root Canal Treatment'], fee: 300, duration: 30 },
  { name: 'Vikram Shetty', spec: 'Endodontist',     qual: 'BDS, MDS (Endodontics)',
    dept: 'Root Canal Treatment',  also: [],                       fee: 700, duration: 45 },
  { name: 'Nisha Menon',   spec: 'Orthodontist',    qual: 'BDS, MDS (Orthodontics)',
    dept: 'Orthodontics & Braces', also: ['Cosmetic Dentistry'],   fee: 600, duration: 45 },
];

async function ensureDemoTenant() {
  if (process.env.DEMO_TENANT === 'false') {
    console.log('⏭  Demo clinic skipped (DEMO_TENANT=false)');
    return;
  }

  const { query, tenantQuery } = require('./index');
  const { createTenantSchema, runTenantMigrations } = require('./tenantMigrate');
  const { CURRENT_TERMS_VERSION } = require('../config/terms');

  // The demo login is meant to be shared with anyone evaluating the product, so
  // it runs READ-ONLY: every /api/admin write 403s (middleware/auth.js
  // `enforceReadOnlyTenant`). Set DEMO_READ_ONLY=false to hand-edit the fixture,
  // restart, edit, then restart with it back on. The flag is re-asserted on
  // every boot so a stray edit while it was off does not leave it writable.
  const demoReadOnly = process.env.DEMO_READ_ONLY !== 'false';

  let tenant = (await query(
    `SELECT id FROM tenants WHERE slug=$1`, [DEMO_SLUG])).rows[0];

  if (!tenant) {
    // billing_monthly = 0, not NULL. Every revenue read is
    // COALESCE(t.billing_monthly, p.price_monthly), so leaving it NULL would
    // book this fixture as ₹1,799 of MRR in the super-admin dashboard and in
    // every report built on top of it. A demo clinic that inflates the one
    // number the business is judged by is worse than no demo clinic.
    //
    // 'professional' rather than 'starter' because three dentists is one more
    // than Starter allows. A demo tenant sitting over its own plan cap is
    // exactly the fixture that teaches the wrong rule.
    tenant = (await query(`
      INSERT INTO tenants
        (name, slug, schema_name, owner_email, plan, status, city, entry_code, billing_monthly, read_only)
      VALUES ($1, $2, $3, 'contactus@pragatisolutions.com', 'professional', 'active',
              'Bengaluru', $4, 0, $5)
      RETURNING id
    `, [DEMO_CLINIC_NAME, DEMO_SLUG, DEMO_SCHEMA, DEMO_ENTRY_CODE, demoReadOnly])).rows[0];
    await createTenantSchema(DEMO_SCHEMA);
    await runTenantMigrations(DEMO_SCHEMA);
    console.log(`✅ Demo clinic created: ${DEMO_CLINIC_NAME} (code ${DEMO_ENTRY_CODE})`);
  } else {
    // Repaired only when actually wrong, and only these three. A deactivated
    // tenant detaches every patient session that reaches it, and a drifted
    // entry code means the code already printed in outreach answers "that code
    // didn't match a clinic" — which reads to the reader as a broken product.
    // The collision catch matters: if a real clinic ever holds this code, the
    // unique index refuses the update and the demo yields rather than the boot
    // failing. Everything else this fixture owns is left exactly as found.
    await query(
      `UPDATE tenants SET status='active' WHERE id=$1 AND status<>'active'`, [tenant.id]);
    await query(
      `UPDATE tenants SET entry_code=$2 WHERE id=$1 AND entry_code IS DISTINCT FROM $2`,
      [tenant.id, DEMO_ENTRY_CODE]
    ).catch(err => console.warn(`⚠️  Demo entry code not applied: ${err.message}`));
    // Re-assert the read-only flag every boot so DEMO_READ_ONLY is the single
    // source of truth: flip the env, restart, and the demo locks or unlocks.
    await query(
      `UPDATE tenants SET read_only=$2 WHERE id=$1 AND read_only IS DISTINCT FROM $2`,
      [tenant.id, demoReadOnly]);
  }

  // Pre-accept the ToS/DPA for this fixture. It is our own demo clinic, not a
  // customer — and while read-only, the blocking TermsGate could not be cleared
  // (POST /admin/terms/accept 403s), which would trap every visitor on the
  // legal modal. Idempotent, and re-runs on a terms-version bump.
  await query(`
    UPDATE tenants
       SET terms_accepted_at = COALESCE(terms_accepted_at, NOW()),
           terms_version     = $2,
           terms_accepted_by = COALESCE(terms_accepted_by, 'Demo clinic (auto-accepted)')
     WHERE id = $1
       AND (terms_version IS DISTINCT FROM $2 OR terms_accepted_at IS NULL)
  `, [tenant.id, CURRENT_TERMS_VERSION]);

  // ── BRANCH ──────────────────────────────────────────────────────────────
  // One branch on purpose: the bot skips the "which branch?" step entirely when
  // a clinic has only one, and every step removed is a step a dentist
  // evaluating this in sixty seconds does not have to sit through.
  //
  // The phone number is Pragati's own, deliberately. The bot hands out the
  // branch number wherever it tells a patient to call — the emergency reply
  // most of all, where it is the only useful instruction — so a prospect
  // prodding at the demo reaches a human instead of a placeholder.
  let branch = (await tenantQuery(DEMO_SCHEMA,
    `SELECT id FROM hospitals WHERE name=$1`, [DEMO_CLINIC_NAME])).rows[0];
  if (!branch) {
    branch = (await tenantQuery(DEMO_SCHEMA, `
      INSERT INTO hospitals (name, address, city, phone)
      VALUES ($1, $2, 'Bengaluru', $3) RETURNING id
    `, [DEMO_CLINIC_NAME, '2nd Floor, 100 Feet Road, Indiranagar', '+91 7795676142'])).rows[0];
  }

  // ── DEPARTMENTS (per branch) ────────────────────────────────────────────
  const deptIds = {};
  for (const name of DEMO_DEPARTMENTS) {
    const found = (await tenantQuery(DEMO_SCHEMA,
      `SELECT id FROM departments WHERE name=$1 AND hospital_id=$2`,
      [name, branch.id])).rows[0];
    deptIds[name] = found
      ? found.id
      : (await tenantQuery(DEMO_SCHEMA,
          `INSERT INTO departments (hospital_id, name) VALUES ($1,$2) RETURNING id`,
          [branch.id, name])).rows[0].id;
  }

  // ── DENTISTS ────────────────────────────────────────────────────────────
  const doctorIds = [];
  for (const d of DEMO_DOCTORS) {
    const existing = (await tenantQuery(DEMO_SCHEMA,
      `SELECT id FROM doctors WHERE name=$1 AND hospital_id=$2`,
      [d.name, branch.id])).rows[0];
    if (existing) { doctorIds.push(existing.id); continue; }

    const created = (await tenantQuery(DEMO_SCHEMA, `
      INSERT INTO doctors
        (hospital_id, department_id, name, specialization, qualification,
         consultation_fee, slot_duration_minutes)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id
    `, [branch.id, deptIds[d.dept], d.name, d.spec, d.qual, d.fee, d.duration])).rows[0];
    doctorIds.push(created.id);

    // The bookable set, written in the same pass that creates the doctor. The
    // primary is listed explicitly rather than left to the backfill in
    // tenantMigrate: the bot lists dentists through doctor_departments ONLY, so
    // a doctor created without these rows is unbookable over WhatsApp until the
    // next restart — and the whole point of this fixture is that it works the
    // first time someone tries it.
    for (const deptName of [d.dept, ...d.also]) {
      if (!deptIds[deptName]) continue;
      await tenantQuery(DEMO_SCHEMA,
        `INSERT INTO doctor_departments (doctor_id, department_id)
         VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [created.id, deptIds[deptName]]);
    }

    // Mon–Sat, generous hours so the grid is never thin. Written only for a
    // dentist this block just created: a re-run must never DELETE and re-insert
    // the way a true reset does, or a session someone added to make the demo
    // more convincing disappears on the next deploy.
    //
    // hospital_id is left NULL on every row. planDoctorSlots falls back to
    // doctors.hospital_id (`sched.hospitalId || doc.hospital_id`), which is
    // correct for a resident dentist at a single-branch clinic — and it means
    // no doctor_hospitals rows are needed either.
    for (let dow = 1; dow <= 5; dow++) {
      await tenantQuery(DEMO_SCHEMA, `
        INSERT INTO doctor_schedules
          (doctor_id, day_of_week, start_time, end_time, is_working,
           lunch_start_time, lunch_end_time)
        VALUES ($1,$2,'10:00','19:00',true,'14:00','15:00')
        ON CONFLICT (doctor_id, day_of_week, start_time) DO NOTHING
      `, [created.id, dow]);
    }
    await tenantQuery(DEMO_SCHEMA, `
      INSERT INTO doctor_schedules
        (doctor_id, day_of_week, start_time, end_time, is_working)
      VALUES ($1,6,'10:00','14:00',true)
      ON CONFLICT (doctor_id, day_of_week, start_time) DO NOTHING
    `, [created.id]);
  }

  // ── DASHBOARD LOGIN ─────────────────────────────────────────────────────
  // Optional: the WhatsApp demo — the only part the outreach depends on — needs
  // no user at all. This exists so the dashboard can be shown on a call.
  //
  // Insert-only, and the password is never logged. Without DEMO_ADMIN_PASSWORD
  // the row is still created, with a random password nobody knows, because a
  // user that EXISTS can be given a known password through the audited
  // super-admin reset (POST /superadmin/tenants/:id/users/:userId/reset-password)
  // whereas a user that does not exist cannot. Printing a generated password
  // here instead would put it in Railway's retained logs forever.
  const adminPassword = process.env.DEMO_ADMIN_PASSWORD
    || require('crypto').randomBytes(24).toString('base64url');
  const adminRow = await tenantQuery(DEMO_SCHEMA, `
    INSERT INTO users (email, password_hash, name, role, notify_phone)
    VALUES ('demo@pragatisolutions.com', $1, 'Demo Clinic Admin', 'admin', $2)
    ON CONFLICT (email) DO NOTHING
  `, [await bcrypt.hash(adminPassword, 12), process.env.DEMO_NOTIFY_PHONE || null]);
  if (adminRow.rowCount > 0 && !process.env.DEMO_ADMIN_PASSWORD) {
    console.log('ℹ️  Demo dashboard user created with a random password — set one via '
      + 'the super-admin reset endpoint, or set DEMO_ADMIN_PASSWORD and recreate.');
  }

  // ── SLOTS ───────────────────────────────────────────────────────────────
  // Topped up every boot, never cleared. The DELETE that seed.js runs first is
  // right for a fixture being reset and wrong here: it would drop availability
  // out from under anyone mid-booking, and this clinic is deliberately exposed
  // to strangers who may be part-way through the flow as a deploy lands.
  const { generateSlotsForDoctor } = require('../jobs/slotGenerator');
  let slots = 0;
  for (const id of doctorIds) {
    slots += await generateSlotsForDoctor(DEMO_SCHEMA, id, false, DEMO_SLOT_DAYS);
  }
  // `slots` is what generateSlotsForDoctor PLANNED, not what it inserted — the
  // insert is ON CONFLICT DO NOTHING, so on a steady-state boot this number is
  // the size of the grid rather than a count of new rows. Worded to say so.
  console.log(`✅ Demo clinic ready: ${DEMO_DOCTORS.length} dentists, `
    + `${slots} slot(s) across ${DEMO_SLOT_DAYS} days, code ${DEMO_ENTRY_CODE}`);
}

async function migrate() {
  const client = await pool.connect();
  try {
    // The pool sets statement_timeout=10s in the startup packet (db/index.js)
    // so a runaway bot query can't starve it. Migrations are the one workload
    // that legitimately exceeds it, and inheriting it here broke two things:
    //
    //  - pg_advisory_lock below BLOCKS while another replica migrates, and was
    //    cancelled at 10s with 57014. The lock exists precisely to serialise
    //    concurrent boots, so the loser exited non-zero under entrypoint.sh's
    //    `set -e` and Railway could burn all its restart retries.
    //  - the ADD COLUMN / ALTER blocks take ACCESS EXCLUSIVE on `tenants`, the
    //    table every inbound request reads to resolve a clinic.
    //
    // lock_timeout bounds the second: better to fail one boot fast than to
    // queue an ACCESS EXCLUSIVE that stalls every reader behind it. Mirrors
    // what tenantMigrate.js already does per tenant schema.
    await client.query(`SET statement_timeout TO 0`);
    await client.query(`SET lock_timeout TO '5s'`);

    // Serialize migrations across concurrently booting instances — two
    // containers interleaving a data-mutating migration (e.g. 18's token
    // hashing) would double-apply it before either records the version.
    await client.query(`SELECT pg_advisory_lock(824619001)`);
    console.log('Running migrations...');

    // ── PUBLIC SCHEMA — platform-level tables ──────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(100) UNIQUE NOT NULL,
        schema_name VARCHAR(100) UNIQUE NOT NULL,
        plan VARCHAR(50) DEFAULT 'starter',
        status VARCHAR(50) DEFAULT 'active',
        owner_email VARCHAR(255) NOT NULL,
        settings JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS plans (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        max_doctors INTEGER DEFAULT 5,
        max_appointments_per_month INTEGER DEFAULT 500,
        price_monthly INTEGER DEFAULT 0,
        features JSONB DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS super_admins (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug);
      CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) NOT NULL,
        tenant_id UUID,
        token VARCHAR(255) UNIQUE NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS token_blacklist (
        jti VARCHAR(255) PRIMARY KEY,
        expires_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pwd_reset_token ON password_resets(token);
      CREATE INDEX IF NOT EXISTS idx_token_bl_expires ON token_blacklist(expires_at);
    `);

    // ── TENANTS: add new columns for suspension & onboarding ──────
    await client.query(`
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS suspension_reason TEXT;
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT false;
    `);

    // ── TENANTS: read-only flag ──────────────────────────────────
    // A whole-tenant switch that makes every /api/admin write 403 regardless of
    // role (middleware/auth.js `enforceReadOnlyTenant`). Built for the shareable
    // demo clinic: hand the login to anyone, and no visitor can change the data
    // the next visitor sees. NOT a per-user permission — the two roles stay
    // binary (see CLAUDE.md). `ensureDemoTenant` sets it for `pragati-demo`.
    await client.query(`
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS read_only BOOLEAN NOT NULL DEFAULT false;
    `);

    // ── PER-BRANCH PRICING SUPPORT ────────────────────────────
    // plans.max_branches  — how many `hospitals` rows a tier allows. NULL is
    //   unlimited, matching max_doctors. Professional is the per-branch tier,
    //   so it is the only one that may hold more than one.
    // tenants.billing_monthly — the NEGOTIATED monthly rupee amount for this
    //   clinic, overriding the tier's list price. It exists because
    //   Professional is quoted per branch with a discount worked out per deal:
    //   3 branches at ₹3,799 less 15% is a number no formula in this codebase
    //   can derive, and a branch count is not even reachable from a
    //   public-schema join (hospitals lives in the tenant's schema). Storing
    //   the agreed figure keeps MRR exact for every clinic, discounted or not.
    //   NULL means "bill the list price", which is right for Starter/Growth.
    await client.query(`
      ALTER TABLE plans   ADD COLUMN IF NOT EXISTS max_branches    INTEGER;
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_monthly INTEGER;
    `);

    // ── TENANTS: city ─────────────────────────────────────────
    // A real column, not settings->>'city': the bot looks clinics up by city at
    // first contact, and a JSONB key can't be indexed case-insensitively without
    // an expression index over the extracted text anyway. The UPDATE is a
    // one-time backfill of any hand-written settings.city so the column becomes
    // the single source of truth rather than orphaning that value; it is scoped
    // to `city IS NULL` so re-running migrate on every boot never overwrites an
    // edit made through the super admin API.
    await client.query(`
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS city VARCHAR(100);
      CREATE INDEX IF NOT EXISTS idx_tenants_city ON tenants(lower(city));
      UPDATE tenants SET city = settings->>'city' WHERE city IS NULL AND settings->>'city' IS NOT NULL;
    `);

    // NOTE: global_bot_sessions.pending_hospital_id is added by VERSION 25,
    // below. It cannot live here: this block runs unconditionally on every
    // boot, but the table itself is created by version 16 several hundred
    // lines further down, so on a FRESH database the ALTER hit
    // "42P01 relation global_bot_sessions does not exist", migrate() exited 1,
    // and `set -e` in entrypoint.sh aborted the container before seed and
    // before index.js — with the public schema truncated at this point. Any
    // DDL that depends on a versioned table must itself be versioned.

    // ── ADMIN ACCESS LOGS ─────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_access_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID,
        email VARCHAR(255),
        tenant_id UUID,
        event VARCHAR(50) NOT NULL,
        ip_address VARCHAR(45),
        user_agent TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_access_logs_email ON admin_access_logs(email);
      CREATE INDEX IF NOT EXISTS idx_access_logs_tenant ON admin_access_logs(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_access_logs_created ON admin_access_logs(created_at DESC);
    `);

    // ── PUBLIC AUDIT LOG ───────────────────────────────────────
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
      CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, resource_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
    `);

    // ── CRON JOB TRACKING ──────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        job_name VARCHAR(100) PRIMARY KEY,
        last_run_at TIMESTAMPTZ,
        last_status VARCHAR(50),
        last_error TEXT
      );

      -- Every job that writes its outcome back to this table needs a row here,
      -- or the UPDATE matches zero rows and fails SILENTLY: /health's
      -- cron_alerts query can then never report that job as failing. 'recalls'
      -- and 'treatment_nudges' were missing, so the two crons whose whole
      -- purpose is unattended revenue recovery were also the two nobody would
      -- have noticed dying.
      INSERT INTO cron_jobs (job_name) VALUES
        ('slot_generator'),
        ('reminders'),
        ('feedback'),
        ('backup'),
        ('weekly_backup'),
        ('weekly_digest'),
        ('webhook_retry'),
        ('recalls'),
        ('treatment_nudges'),
        ('billing_dunning')
      ON CONFLICT (job_name) DO NOTHING;
    `);

    // ── FAILED WEBHOOKS (Retry Queue) ─────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS failed_webhooks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone VARCHAR(20) NOT NULL,
        tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
        text TEXT,
        button_id TEXT,
        message_type VARCHAR(50) DEFAULT 'text',
        error_message TEXT,
        attempts INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 3,
        last_attempt_at TIMESTAMPTZ,
        next_retry_at TIMESTAMPTZ DEFAULT NOW(),
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','processing','succeeded','failed')),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_failed_webhooks_status ON failed_webhooks(status, next_retry_at);
      CREATE INDEX IF NOT EXISTS idx_failed_webhooks_tenant ON failed_webhooks(tenant_id);
    `);

    // ── EMAIL SENT LOG (deduplication) ────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_sent_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        content_hash VARCHAR(64) NOT NULL,
        sent_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_email_sent_log_hash ON email_sent_log(content_hash);
      CREATE INDEX IF NOT EXISTS idx_email_sent_log_sent ON email_sent_log(sent_at DESC);
    `);

    // ── REFRESH TOKENS ────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        user_role VARCHAR(50) NOT NULL,
        tenant_id UUID,
        token VARCHAR(255) UNIQUE NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used BOOLEAN DEFAULT false,
        -- When it was redeemed. Reuse detection needs this to separate a
        -- replayed stolen token from two of the user's own tabs racing; see
        -- migration 28 and routes/auth.js.
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token);
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id, used, expires_at);
    `);

    // ── PUBLIC AUDIT LOG IMMUTABILITY ─────────────────────────
    // Prevents admins from deleting/modifying audit records to cover their tracks
    await client.query(`
      CREATE OR REPLACE FUNCTION prevent_audit_mutation()
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
            AND tgrelid = 'public.audit_logs'::regclass
        ) THEN
          CREATE TRIGGER audit_logs_immutable
          BEFORE UPDATE OR DELETE ON audit_logs
          FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
        END IF;
      END $$;
    `).catch(() => {}); // Non-fatal if audit_logs doesn't exist yet on first run

    // ── TENANT STATS CACHE ────────────────────────────────────
    await runMigration(client, 5, 'tenant_stats_cache', async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS tenant_stats_cache (
          tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
          -- IST, not CURRENT_DATE: servers run UTC, so between 00:00 and 05:30
          -- IST a bare CURRENT_DATE stamps the cache row with YESTERDAY's date
          -- and the day's first writes land on the wrong key.
          stat_date DATE NOT NULL DEFAULT (NOW() AT TIME ZONE 'Asia/Kolkata')::date,
          appointments_today INTEGER DEFAULT 0,
          appointments_month INTEGER DEFAULT 0,
          patients_total INTEGER DEFAULT 0,
          active_slots INTEGER DEFAULT 0,
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (tenant_id, stat_date)
        );
        CREATE INDEX IF NOT EXISTS idx_tenant_stats_date ON tenant_stats_cache(stat_date DESC);
      `);
    });

    // ── PLAN CHANGES (Enhancement 13: Billing Dashboard) ─────
    await runMigration(client, 6, 'plan_changes', async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS plan_changes (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
          old_plan VARCHAR(50),
          new_plan VARCHAR(50) NOT NULL,
          changed_by UUID,
          changed_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_plan_changes_tenant ON plan_changes(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_plan_changes_changed_at ON plan_changes(changed_at DESC);
      `);
    });

    // ── SEED PLANS ────────────────────────────────────────────
    // TWO tiers, no free tier: the entry plan is paid (₹799). Trials are an
    // operational choice (put them on Starter and don't invoice for a month),
    // NOT a ₹0 row — a permanent free tier covering two dentists would cover
    // most of the market outright and stop single-chair clinics ever
    // converting.
    //
    // Priced on DENTIST COUNT and BRANCH COUNT, never on appointment volume
    // (max_appointments_per_month is NULL on both tiers) — a clinic is never
    // told "you have run out of bookings this month", which is a terrible
    // message to send a business that is paying you to take bookings.
    //
    //   Starter      ₹799  — 2 dentists, 1 branch. The single-chair practice
    //                        that makes up most of the market.
    //   Professional ₹1799 — unlimited dentists, unlimited branches. Anything
    //                        bigger. Priced PER BRANCH (see below).
    //
    // A third dentist or a second location moves a clinic to Professional;
    // those are the only two upgrade triggers, and both are rarer than
    // crossing a volume ceiling would be. Expansion revenue is therefore thin
    // and growth is mostly new-logo — a deliberate trade for a sell that fits
    // on one line.
    //
    // ⚠️ Professional's price_monthly is the FIRST branch only. Every
    // ADDITIONAL branch is billed at ₹1,799 less a discount agreed per deal,
    // applied PER ADDED BRANCH — not as a discount on the whole invoice:
    //
    //     monthly = 1799 + (branches - 1) × 1799 × (1 - discount)
    //
    //     e.g. 3 branches at 20% off additional branches:
    //          1799 + 2 × 1799 × 0.80 = 1799 + 2878 = ₹4,677
    //
    // That figure is not computed here. The discount is per-contract, and
    // `hospitals` lives in the tenant's own schema, so a branch count is not
    // reachable from a public-schema join at all. The agreed total is stored
    // on `tenants.billing_monthly`, and every revenue read is
    // COALESCE(t.billing_monthly, p.price_monthly). A single-branch
    // Professional tenant therefore needs no override — price_monthly is
    // already exact. Set billing_monthly the moment a SECOND branch is added,
    // or MRR keeps reporting one branch, and re-set it on every branch added
    // after that.
    //
    // NULL means UNLIMITED, and every reader already agrees on that:
    //   bookingCore.checkMonthlyQuota  → limit null → allowed (now always)
    //   doctors.js POST / CSV import   → planLimit null → no doctor cap
    //   superadmin /tenants/:id/quota  → reports 0%, never suggests an upgrade
    // Hence NULL rather than the old 999 / 99999 sentinels, which every
    // consumer had to special-case. checkMonthlyQuota is left wired up but
    // dormant: it costs one indexed lookup and is the seam to re-introduce
    // volume pricing without touching the booking paths.
    //
    // DO UPDATE, not DO NOTHING: this file is the single source of truth for
    // pricing (there is no admin UI that edits `plans`), and migrate re-runs on
    // every deploy, so changing a price here is the whole deployment step. The
    // trade-off is that hand-edits made directly in the database are reverted
    // on the next boot — change prices here, not in psql.
    await client.query(`
      INSERT INTO plans (id, name, max_doctors, max_appointments_per_month, max_branches, price_monthly) VALUES
        ('starter',      'Starter',      2,    NULL, 1,    799),
        ('professional', 'Professional', NULL, NULL, NULL, 1799)
      ON CONFLICT (id) DO UPDATE SET
        name                       = EXCLUDED.name,
        max_doctors                = EXCLUDED.max_doctors,
        max_appointments_per_month = EXCLUDED.max_appointments_per_month,
        max_branches               = EXCLUDED.max_branches,
        price_monthly              = EXCLUDED.price_monthly;
    `);

    // ── SEED SUPER ADMIN ──────────────────────────────────────
    // ON CONFLICT DO NOTHING, so this only ever fires on a fresh database and
    // never overwrites an existing password. On a fresh PRODUCTION database
    // though, a hardcoded default would create a publicly-documented login to
    // the super admin console, so there it must come from the environment.
    const superEmail = process.env.SUPER_ADMIN_EMAIL || 'admin@medibook.com';
    const superPassword = process.env.SUPER_ADMIN_PASSWORD ||
      (process.env.NODE_ENV === 'production' ? null : 'SuperAdmin@123');

    if (superPassword) {
      const hash = await bcrypt.hash(superPassword, 12);
      await client.query(`
        INSERT INTO super_admins (email, password_hash, name)
        VALUES ($1, $2, 'Super Admin')
        ON CONFLICT (email) DO NOTHING;
      `, [superEmail, hash]);
    } else {
      console.warn(
        '⚠️  No super admin seeded — set SUPER_ADMIN_PASSWORD (and optionally ' +
        'SUPER_ADMIN_EMAIL) to bootstrap one in production.'
      );
    }

    // Version 7: Feature flags tables
    await runMigration(client, 7, 'feature_flags', async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS feature_flags (
          key VARCHAR(100) PRIMARY KEY,
          description TEXT,
          default_value BOOLEAN DEFAULT false
        );
        CREATE TABLE IF NOT EXISTS tenant_feature_flags (
          tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
          flag_key VARCHAR(100) REFERENCES feature_flags(key) ON DELETE CASCADE,
          enabled BOOLEAN NOT NULL,
          PRIMARY KEY (tenant_id, flag_key)
        );
        -- Only flags with an actual reader in the codebase. Three more were
        -- seeded here originally (sms_fallback_enabled, google_sheets_export,
        -- post_appointment_followup); nothing ever called isEnabled() for any
        -- of them, so they were toggles that did nothing — see migration 27,
        -- which removes them from databases that already have them.
        INSERT INTO feature_flags (key, description, default_value) VALUES
          ('voice_transcription_enabled', 'Transcribe audio messages via Whisper', false),
          ('skip_public_holidays', 'Skip Indian public holidays in slot generation', false)
        ON CONFLICT (key) DO NOTHING;
      `);
    });

    // Version 8: IP allowlist for tenant admin logins
    await runMigration(client, 8, 'tenant_ip_allowlist', async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS tenant_ip_allowlist (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
          cidr VARCHAR(50) NOT NULL,
          label VARCHAR(100),
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_ip_allowlist_tenant ON tenant_ip_allowlist(tenant_id);
      `);
    });

    // Version 9: IP abuse blocking
    await runMigration(client, 9, 'rate_limit_blocks', async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS rate_limit_blocks (
          ip VARCHAR(45) PRIMARY KEY,
          blocked_until TIMESTAMPTZ NOT NULL,
          reason TEXT,
          offense_count INTEGER DEFAULT 1,
          blocked_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_rate_blocks_until ON rate_limit_blocks(blocked_until);
      `);
    });

    // Version 10: Quota alerts (track 80% warning emails)
    await runMigration(client, 10, 'quota_alerts', async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS quota_alerts (
          tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
          alert_type VARCHAR(50) NOT NULL,
          sent_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (tenant_id, alert_type)
        );
      `);
    });

    // Version 11: Sanitized payload on failed_webhooks
    await runMigration(client, 11, 'failed_webhooks_payload', async () => {
      await client.query(`
        ALTER TABLE failed_webhooks ADD COLUMN IF NOT EXISTS sanitized_payload JSONB;
      `);
    });

    // Version 12: Email open tracking on email_sent_log
    await runMigration(client, 12, 'email_open_tracking', async () => {
      await client.query(`
        ALTER TABLE email_sent_log ADD COLUMN IF NOT EXISTS open_count INTEGER DEFAULT 0;
        ALTER TABLE email_sent_log ADD COLUMN IF NOT EXISTS to_email VARCHAR(255);
        ALTER TABLE email_sent_log ADD COLUMN IF NOT EXISTS template_id VARCHAR(100);
      `);
    });

    // Version 13: Correlation ID on audit_logs
    await runMigration(client, 13, 'audit_logs_correlation_id', async () => {
      await client.query(`
        ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(64);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_correlation ON audit_logs(correlation_id) WHERE correlation_id IS NOT NULL;
      `);
    });

    // Version 14: Tenant onboarding tracking flag
    await runMigration(client, 14, 'tenant_upgrade_prompt', async () => {
      await client.query(`
        ALTER TABLE tenants ADD COLUMN IF NOT EXISTS upgrade_prompt BOOLEAN DEFAULT false;
      `);
    });

    // Version 15: Backup log
    await runMigration(client, 15, 'backup_log', async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS backup_log (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          started_at TIMESTAMPTZ DEFAULT NOW(),
          completed_at TIMESTAMPTZ,
          status VARCHAR(20) DEFAULT 'running' CHECK (status IN ('running','success','failed')),
          file_path TEXT,
          size_bytes BIGINT,
          duration_ms INTEGER,
          error_message TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_backup_log_started ON backup_log(started_at DESC);
      `);
    });

    // Version 17: Drop obsolete per-tenant WA credential columns (now global via env vars)
    await runMigration(client, 17, 'drop_per_tenant_wa_columns', async () => {
      await client.query(`
        ALTER TABLE tenants DROP COLUMN IF EXISTS wa_phone_number_id;
        ALTER TABLE tenants DROP COLUMN IF EXISTS wa_access_token_enc;
        ALTER TABLE tenants DROP COLUMN IF EXISTS wa_webhook_verify_token;
        DROP INDEX IF EXISTS idx_tenants_wa_phone;
      `);
    });

    // Version 16: Global bot sessions — shared WhatsApp number routing
    // Maps patient phone → tenant so all tenants can share a single WA number.
    await runMigration(client, 16, 'global_bot_sessions', async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS global_bot_sessions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          phone VARCHAR(20) UNIQUE NOT NULL,
          tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
          state VARCHAR(50) DEFAULT 'select_tenant',
          last_activity TIMESTAMPTZ DEFAULT NOW(),
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_global_sessions_phone ON global_bot_sessions(phone);
        CREATE INDEX IF NOT EXISTS idx_global_sessions_tenant ON global_bot_sessions(tenant_id);
      `);
    });

    // Version 18: Hash pre-existing plaintext refresh/reset tokens in place.
    // routes/auth.js now stores AND looks up tokens hash-only; rows written
    // before hashing would otherwise stop working (forced re-login for every
    // user). Runs exactly once (versioned), so it never double-hashes — the
    // only exception is a dev DB that already ran the hashing code before this
    // migration existed; those few sessions just require one re-login.
    await runMigration(client, 18, 'hash_plaintext_tokens', async () => {
      const { createHash } = require('crypto');
      const sha256 = (v) => createHash('sha256').update(v).digest('hex');
      for (const table of ['refresh_tokens', 'password_resets']) {
        const r = await client.query(
          `SELECT id, token FROM ${table} WHERE used=false AND expires_at > NOW()`
        );
        for (const row of r.rows) {
          await client.query(`UPDATE ${table} SET token=$1 WHERE id=$2`, [sha256(row.token), row.id]);
        }
      }
    });

    // Version 19: dedup key for PRE-TENANT webhook messages.
    // wa_messages (the normal idempotency store) lives in a tenant schema, so it
    // can only dedup a message AFTER the patient's clinic is known. First-contact
    // messages are handled before that point, so a Meta redelivery re-sent the
    // "type your clinic name" prompt. Recording the last handled wa_message_id on
    // the global session closes that gap.
    await runMigration(client, 19, 'global_session_last_wa_message_id', async () => {
      await client.query(`
        ALTER TABLE global_bot_sessions
          ADD COLUMN IF NOT EXISTS last_wa_message_id VARCHAR(255);
      `);
    });

    // Version 20: shortlist state for the clinic SEARCH entry point.
    // The patient searches for their clinic instead of being shown every
    // onboarded tenant; when a search returns several matches we send just
    // those, numbered. The reply is a bare "2", which carries no way back to
    // the shortlist it refers to — so the matched tenant ids are parked on the
    // global session, in the exact order they were rendered.
    await runMigration(client, 20, 'global_session_search_matches', async () => {
      await client.query(`
        ALTER TABLE global_bot_sessions
          ADD COLUMN IF NOT EXISTS search_matches JSONB;
      `);
    });

    // Version 21: which clinic is waiting for a reply from this phone.
    // Inbound messages are routed by the patient's CURRENTLY SELECTED clinic
    // (global_bot_sessions). But reminders and feedback requests are sent per
    // tenant by the crons and expect an answer — so a patient who books at
    // clinic A, switches to clinic B, then replies "yes" to A's reminder had
    // that confirmation looked up in B's schema, found nothing, and silently
    // lost. This table lets the webhook hand such a reply back to the clinic
    // that actually asked. Rows are short-lived and best-effort.
    await runMigration(client, 21, 'global_pending_replies', async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS global_pending_replies (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          phone VARCHAR(20) NOT NULL,
          tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          kind VARCHAR(20) NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE (phone, tenant_id, kind)
        );
        CREATE INDEX IF NOT EXISTS idx_pending_replies_lookup
          ON global_pending_replies(phone, kind, expires_at);
      `);
    });

    // ── DROP THE ENTERPRISE TIER ──────────────────────────────
    // Pricing was cut from four tiers to three. The other three are re-seeded
    // above by id, so only 'enterprise' is left orphaned on already-deployed
    // databases; the seed can't remove it because it only touches ids it
    // lists. MUST stay scoped to 'enterprise' — widening this to the other ids
    // would delete the rows the seed just wrote, since the seed runs earlier in
    // this same function.
    //
    // Any tenant still sitting on plan='enterprise' keeps that value and is
    // read as unlimited (no matching row → NULL limits), which is what they
    // were paying for. They can't be moved BACK to it: it's gone from
    // superadmin's VALID_PLANS and validate.js's createTenant enum.
    await runMigration(client, 22, 'drop_enterprise_plan', async () => {
      await client.query(`DELETE FROM plans WHERE id = 'enterprise'`);
    });

    // ── DROP THE GROWTH TIER ──────────────────────────────────
    // Cut from three tiers to two. Growth was ₹1,799 for 6 dentists and one
    // branch; Professional is now ₹1,799 for UNLIMITED dentists and branches,
    // so moving a Growth tenant across costs them nothing and strictly widens
    // their limits — no notice period, no repricing, no one loses a feature.
    //
    // The UPDATE must run BEFORE the DELETE and both must be in this one
    // migration: a tenant left pointing at a deleted plan gets NULL limits from
    // the LEFT JOINs, i.e. silently unlimited everything at ₹799. Same reason
    // the enterprise migration above deliberately did NOT reassign — nobody was
    // on it. Scoped to 'growth' so it can never touch the seeded rows.
    await runMigration(client, 23, 'drop_growth_plan', async () => {
      await client.query(`UPDATE tenants SET plan = 'professional' WHERE plan = 'growth'`);
      await client.query(`DELETE FROM plans WHERE id = 'growth'`);
    });

    // ── TERMS OF SERVICE ACCEPTANCE ───────────────────────────
    // DPDP Act s.8(2) lets a Data Fiduciary (the clinic) engage a Processor
    // (us) only under a valid contract, so we must be able to PROVE each
    // tenant accepted the Terms + incorporated DPA. Click-wrap is valid under
    // IT Act s.10A, but only if the acceptance record exists — a published
    // policy with no evidence of assent is not a contract, which would leave
    // the liability cap unenforceable exactly when it matters.
    //
    // Recorded per TENANT, not per user: the contract is with the clinic, and
    // whichever admin accepts binds it. `terms_accepted_by` keeps the email
    // rather than a user id on purpose — the row must stay meaningful as
    // evidence after that staff member is deleted from the tenant schema.
    //
    // Version is stored, not assumed: when the Terms change, CURRENT_TERMS_VERSION
    // moves ahead of the stored value and the gate re-prompts. Never backfill
    // these columns for existing tenants — a fabricated acceptance is worse
    // than none, since it is evidence of a contract that was never agreed.
    await runMigration(client, 24, 'tenant_terms_acceptance', async () => {
      await client.query(`
        ALTER TABLE tenants ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
        ALTER TABLE tenants ADD COLUMN IF NOT EXISTS terms_version VARCHAR(20);
        ALTER TABLE tenants ADD COLUMN IF NOT EXISTS terms_accepted_ip VARCHAR(45);
        ALTER TABLE tenants ADD COLUMN IF NOT EXISTS terms_accepted_by VARCHAR(255);
      `);
    });

    // Version 25: a BRANCH the patient chose before booking started, so booking
    // doesn't ask again. Written by the "clinics near me" city picker, which has
    // since been removed in favour of per-clinic QR entry codes; the column and
    // its one-shot read in bookingFlow.startBooking are kept as the hook a
    // per-BRANCH QR would use, and stay NULL until something writes them.
    // It lives on the global session rather
    // than in the tenant's bot_sessions context because selecting a clinic hands
    // the engine a synthesised "Hi", and a greeting resets that context to empty
    // — anything parked there would be wiped before booking could read it.
    // Consumed one-shot by bookingFlow.startBooking and cleared on every clinic
    // reset. Versioned, and placed after 16, because global_bot_sessions does
    // not exist until 16 has run.
    await runMigration(client, 25, 'global_session_pending_hospital', async () => {
      await client.query(`
        ALTER TABLE global_bot_sessions ADD COLUMN IF NOT EXISTS pending_hospital_id UUID;
      `);
    });

    // Version 26: the clinic's own way into the shared WhatsApp number. A
    // printed QR encodes a wa.me link with this code pre-typed, so a clinic's
    // patient reaches that clinic directly instead of searching for it by name
    // and being shown a picker that contains competitors. See
    // utils/entryCode.js for the format and why it is not a secret.
    //
    // The unique index is what the generator's collision retry tests against,
    // so it is not optional. It is deliberately NOT partial on NULL: the column
    // is nullable only for the instant between a tenant row being inserted and
    // the backfill below giving it a code, and Postgres already treats NULLs as
    // distinct in a unique index.
    await runMigration(client, 26, 'tenant_entry_code', async () => {
      await client.query(`
        ALTER TABLE tenants ADD COLUMN IF NOT EXISTS entry_code VARCHAR(16);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_entry_code ON tenants(entry_code);
      `);
    });

    // Version 27: drop three feature flags that nothing has ever read.
    //
    // `isEnabled()` is called for exactly two keys — skip_public_holidays and
    // voice_transcription_enabled. The other three were seeded by migration 7
    // and are live, clickable toggles on the super-admin flags panel that do
    // nothing at all: an operator answering a clinic's complaint about message
    // volume can switch off "Send WhatsApp follow-up 1h after appointment",
    // get {success:true}, and change nothing, because that cron was removed.
    //
    // sms_fallback_enabled is worse than dead: it advertises a second delivery
    // channel, which the product deliberately does not have. WhatsApp is the
    // only channel out, so that every patient message is reachable in
    // wa_messages; a toggle implying otherwise invites someone to build it.
    //
    // A NEW version rather than an edit to migration 7's body: 7 has already
    // recorded itself on every existing database and will never run again.
    // tenant_feature_flags rows cascade on the FK.
    await runMigration(client, 27, 'drop_dead_feature_flags', async () => {
      await client.query(`
        DELETE FROM feature_flags
         WHERE key IN ('sms_fallback_enabled', 'google_sheets_export', 'post_appointment_followup');
      `);
    });

    // Version 28: when a refresh token was redeemed.
    //
    // Needed to tell a STOLEN token being replayed from two of the user's own
    // tabs racing on the same token. Both look identical to the reuse check in
    // routes/auth.js — a hit on a row that is already used — but the first
    // should end the session everywhere and the second must not. The client
    // serialises refreshes with a Web Lock, and has an explicit fallback path
    // for browsers where locks are unavailable, so the race is real. `used`
    // alone carries no time, hence this column.
    await runMigration(client, 28, 'refresh_token_used_at', async () => {
      await client.query(`
        ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;
      `);
    });

    // ── SELF-SERVE SIGNUP ─────────────────────────────────────
    // A clinic can now create its own account (routes/signup.js) without a
    // super admin provisioning it. Two things guard that against abuse and
    // against the shared WhatsApp number: identity is verified by a one-time
    // code sent to the owner's OWN WhatsApp (wa_otps — a DIFFERENT mechanism
    // from the removed email reset flow, and the only channel this product
    // has), and a card is taken up front through Razorpay before any schema is
    // created (pending_signups + tenant_billing).
    //
    // Version 29: WhatsApp OTP store + the pre-payment signup holding area.
    //   * wa_otps also backs the WhatsApp-code password reset in routes/auth.js.
    //   * pending_signups holds the verified-but-not-yet-paid signup. The client
    //     is handed a raw token; only its SHA-256 is stored, matching how
    //     refresh_tokens / password_resets treat their tokens. No tenant row and
    //     no schema exist until payment clears, so an abandoned signup leaves
    //     nothing behind but an expiring row here.
    await runMigration(client, 29, 'wa_otps_and_pending_signups', async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS wa_otps (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          phone VARCHAR(20) NOT NULL,
          purpose VARCHAR(20) NOT NULL CHECK (purpose IN ('signup','password_reset')),
          code_hash TEXT NOT NULL,
          payload JSONB DEFAULT '{}',
          attempts INTEGER DEFAULT 0,
          max_attempts INTEGER DEFAULT 5,
          consumed_at TIMESTAMPTZ,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_wa_otps_lookup ON wa_otps(phone, purpose, expires_at);

        CREATE TABLE IF NOT EXISTS pending_signups (
          token VARCHAR(64) PRIMARY KEY,
          phone VARCHAR(20) NOT NULL,
          email VARCHAR(255) NOT NULL,
          slug VARCHAR(56) NOT NULL,
          data JSONB NOT NULL,
          plan VARCHAR(50) NOT NULL DEFAULT 'starter',
          razorpay_customer_id VARCHAR(64),
          razorpay_subscription_id VARCHAR(64),
          tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          consumed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_pending_signups_sub ON pending_signups(razorpay_subscription_id);
        CREATE INDEX IF NOT EXISTS idx_pending_signups_expires ON pending_signups(expires_at);
      `);
    });

    // Version 30: subscription state and a webhook-idempotency ledger.
    //   * tenant_billing is one row per tenant carrying the Razorpay
    //     subscription and where its paid-through date sits. It is the source of
    //     truth the dunning cron reconciles against.
    //   * billing_events dedups Razorpay webhook deliveries (they retry) on
    //     provider_event_id, exactly as the WhatsApp webhook dedups on
    //     wa_message_id.
    await runMigration(client, 30, 'tenant_billing', async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS tenant_billing (
          tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
          provider VARCHAR(20) NOT NULL DEFAULT 'razorpay',
          plan_id VARCHAR(50),
          razorpay_customer_id VARCHAR(64),
          razorpay_subscription_id VARCHAR(64),
          -- created | authenticated | active | pending | halted | cancelled | completed | expired
          subscription_status VARCHAR(30),
          short_url TEXT,
          trial_end TIMESTAMPTZ,
          current_period_end TIMESTAMPTZ,
          last_payment_at TIMESTAMPTZ,
          cancel_at_period_end BOOLEAN DEFAULT false,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_tenant_billing_subscription ON tenant_billing(razorpay_subscription_id);
        CREATE INDEX IF NOT EXISTS idx_tenant_billing_status ON tenant_billing(subscription_status);

        CREATE TABLE IF NOT EXISTS billing_events (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          provider VARCHAR(20) NOT NULL DEFAULT 'razorpay',
          provider_event_id VARCHAR(120) UNIQUE,
          event_type VARCHAR(60),
          subscription_id VARCHAR(64),
          tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
          payload JSONB,
          received_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_billing_events_sub ON billing_events(subscription_id);
      `);
    });

    // Version 31: plan ↔ Razorpay-plan mapping, and how a tenant was born.
    //   * plans.razorpay_plan_id — populated from env below so there is one
    //     place to read it; the operator creates the two plans in the Razorpay
    //     dashboard once (see docs/self-serve-signup.md).
    //   * tenants.signup_source — 'admin' (super-admin created) or 'self_serve'.
    //   * tenants.activated_at — when a self-serve tenant's schema went live.
    // `status` is a free VARCHAR (no CHECK), so the new 'pending_payment' and
    // 'past_due' values need no constraint change — see middleware/auth.js and
    // jobs/billingDunning.js for how they are treated.
    await runMigration(client, 31, 'self_serve_tenant_columns', async () => {
      await client.query(`
        ALTER TABLE plans   ADD COLUMN IF NOT EXISTS razorpay_plan_id VARCHAR(64);
        ALTER TABLE tenants ADD COLUMN IF NOT EXISTS signup_source VARCHAR(20) DEFAULT 'admin';
        ALTER TABLE tenants ADD COLUMN IF NOT EXISTS activated_at  TIMESTAMPTZ;
      `);
    });

    // Keep plans.razorpay_plan_id in step with the env on every boot — the
    // operator may set or rotate these after the migration first ran. Scoped
    // updates, no-ops when unset or unchanged.
    for (const [planId, envKey] of [
      ['starter', 'RAZORPAY_PLAN_STARTER'],
      ['professional', 'RAZORPAY_PLAN_PROFESSIONAL'],
    ]) {
      const rzp = (process.env[envKey] || '').trim();
      if (rzp) {
        await client.query(
          `UPDATE plans SET razorpay_plan_id=$1 WHERE id=$2 AND razorpay_plan_id IS DISTINCT FROM $1`,
          [rzp, planId]
        ).catch(e => console.warn(`⚠️  Could not set ${envKey} on plans.${planId}: ${e.message}`));
      }
    }

    // Backfill, unconditionally on every boot rather than inside the migration
    // above. Two reasons: prod runs with SEED_DEMO_DATA=false so seed-time
    // fixups never execute there, and a tenant created through any path that
    // forgets to mint a code would otherwise have a NULL one forever — with the
    // only symptom being that its QR panel is permanently empty. This UPDATE
    // no-ops once every tenant has a code, which is the normal case.
    //
    // Placed AFTER version 26 and not with the other unconditional blocks at
    // the top of this file: those run before the versioned migrations, so on a
    // fresh database `entry_code` would not exist yet (the same trap documented
    // on global_bot_sessions above).
    try {
      const missing = await client.query(
        `SELECT id FROM tenants WHERE entry_code IS NULL`);
      if (missing.rows.length) {
        const { generateEntryCode } = require('../utils/entryCode');
        let filled = 0;
        for (const t of missing.rows) {
          // Retry on the unique index rather than pre-checking: a SELECT-then-
          // INSERT would race a concurrently booting instance, and the index is
          // the only thing that can actually answer "is this code taken".
          for (let attempt = 0; attempt < 5; attempt++) {
            try {
              await client.query(
                `UPDATE tenants SET entry_code=$1 WHERE id=$2 AND entry_code IS NULL`,
                [generateEntryCode(), t.id]);
              filled++;
              break;
            } catch (e) {
              if (e.code !== '23505') throw e; // not a collision — real failure
            }
          }
        }
        console.log(`✅ Entry codes backfilled for ${filled} tenant(s)`);
      }
    } catch (e) {
      // Never fatal: entrypoint.sh runs migrate under `set -e`, and a clinic
      // without a QR code is a missing feature, not a reason to refuse to boot.
      console.warn('⚠️  Entry code backfill skipped:', e.message);
    }

    console.log('✅ Public schema migrations complete');
    console.log('✅ Plans seeded (starter ₹799, professional ₹1799/branch)');
    // Only claim this when a super admin was actually seeded — otherwise the
    // "no super admin seeded" warning above and this line contradict each other.
    if (superPassword) console.log(`✅ Super admin ensured: ${superEmail}`);
    console.log('✅ audit_logs, cron_jobs, admin_access_logs tables created');

    // ── RUN TENANT MIGRATIONS for existing schemas ───────────────
    // Still inside the advisory lock: tenant migrations include data-mutating
    // steps (dedup + ALTER) that concurrent boots must not interleave.
    try {
      const { runTenantMigrations } = require('./tenantMigrate');
      const tenantsR = await pool.query(`SELECT schema_name, name FROM tenants`);
      if (tenantsR.rows.length > 0) {
        console.log(`Running tenant migrations for ${tenantsR.rows.length} existing schemas...`);
        for (const t of tenantsR.rows) {
          try {
            await runTenantMigrations(t.schema_name);
            console.log(`✅ Tenant migrations applied: ${t.name} (${t.schema_name})`);
          } catch (err) {
            console.error(`❌ Tenant migration failed for ${t.schema_name}:`, err.message);
          }
        }
      }
    } catch (err) {
      console.error('Failed to run tenant schema migrations:', err.message);
    }

    // ── DEMO CLINIC ──────────────────────────────────────────────
    // After the loop above, so an existing demo schema is already migrated
    // before this touches it. Never fatal, for the same reason the entry-code
    // backfill is not: entrypoint.sh runs migrate under `set -e`, and a missing
    // sales fixture must not stop a clinic's real appointments from booting.
    try {
      await ensureDemoTenant();
    } catch (err) {
      console.warn('⚠️  Demo clinic not provisioned:', err.message);
    }

  } finally {
    // generateSlotsForDoctor's public-holiday cache opens the shared Redis
    // client, and its live socket keeps the event loop alive after the pool
    // closes — the hang seed.js documents. entrypoint.sh runs migrate → seed →
    // start on every boot, so a migrate that never exits blocks the deployment.
    // A no-op when nothing opened a client.
    try { require('../utils/redisClient').closeClient(); } catch { /* not fatal */ }
    await client.query(`SELECT pg_advisory_unlock(824619001)`).catch(() => {});
    // Put the pool's own limits back before the connection is reused. If that
    // fails the connection is NOT fit to return — it would go back carrying
    // statement_timeout=0, so a later runaway query could hold it forever.
    // Passing the error to release() destroys it instead of reusing it.
    let resetErr = null;
    try {
      await client.query(`RESET statement_timeout`);
      await client.query(`RESET lock_timeout`);
    } catch (err) {
      resetErr = err;
    }
    client.release(resetErr || undefined);
  }
}

migrate()
  .catch(err => { console.error('Migration failed:', err); process.exit(1); })
  .finally(() => pool.end());
