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
  await sqlFn();
  await client.query(
    `INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`, [version, name]);
  console.log(`  ✅ Migration ${version}: ${name}`);
}

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running migrations...');

    // ── PUBLIC SCHEMA — platform-level tables ──────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(100) UNIQUE NOT NULL,
        schema_name VARCHAR(100) UNIQUE NOT NULL,
        wa_phone_number_id VARCHAR(100),
        wa_access_token_enc TEXT,
        wa_webhook_verify_token VARCHAR(255),
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
      CREATE INDEX IF NOT EXISTS idx_tenants_wa_phone ON tenants(wa_phone_number_id);
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
        ('feedback')
      ON CONFLICT (job_name) DO NOTHING;
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
    const hash = await bcrypt.hash('SuperAdmin@123', 12);
    await client.query(`
      INSERT INTO super_admins (email, password_hash, name)
      VALUES ('admin@medibook.com', $1, 'Super Admin')
      ON CONFLICT (email) DO NOTHING;
    `, [hash]);

    console.log('✅ Public schema migrations complete');
    console.log('✅ Plans seeded (starter, growth, professional, enterprise)');
    console.log('✅ Super admin created: admin@medibook.com / SuperAdmin@123');
    console.log('✅ audit_logs, cron_jobs, admin_access_logs tables created');

  } finally {
    client.release();
  }

  // ── RUN TENANT MIGRATIONS for existing schemas ───────────────
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
}

migrate()
  .catch(err => { console.error('Migration failed:', err); process.exit(1); })
  .finally(() => pool.end());
