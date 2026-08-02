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

async function migrate() {
  const client = await pool.connect();
  try {
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

      INSERT INTO cron_jobs (job_name) VALUES
        ('slot_generator'),
        ('reminders'),
        ('feedback'),
        ('backup'),
        ('weekly_backup'),
        ('weekly_digest'),
        ('webhook_retry')
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
          stat_date DATE NOT NULL DEFAULT CURRENT_DATE,
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
    await client.query(`
      INSERT INTO plans (id, name, max_doctors, max_appointments_per_month, price_monthly) VALUES
        ('starter',      'Starter',      3,    200,  0),
        ('growth',       'Growth',       10,   1000, 1999),
        ('professional', 'Professional', 25,   5000, 4999),
        ('enterprise',   'Enterprise',   999,  99999,9999)
      ON CONFLICT (id) DO NOTHING;
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
        INSERT INTO feature_flags (key, description, default_value) VALUES
          ('sms_fallback_enabled', 'Send SMS when WhatsApp delivery fails', false),
          ('voice_transcription_enabled', 'Transcribe audio messages via Whisper', false),
          ('skip_public_holidays', 'Skip Indian public holidays in slot generation', false),
          ('google_sheets_export', 'Push nightly analytics to Google Sheets webhook', false),
          ('post_appointment_followup', 'Send WhatsApp follow-up 1h after appointment', true)
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

    console.log('✅ Public schema migrations complete');
    console.log('✅ Plans seeded (starter, growth, professional, enterprise)');
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

  } finally {
    await client.query(`SELECT pg_advisory_unlock(824619001)`).catch(() => {});
    client.release();
  }
}

migrate()
  .catch(err => { console.error('Migration failed:', err); process.exit(1); })
  .finally(() => pool.end());
