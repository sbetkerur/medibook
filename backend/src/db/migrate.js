require('dotenv').config();
const { pool } = require('./index');
const bcrypt = require('bcryptjs');

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Running migrations...');

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
      INSERT INTO plans (id, name, max_doctors, max_appointments_per_month, price_monthly) VALUES
        ('starter',      'Starter',      3,    200,  0),
        ('growth',       'Growth',       10,   1000, 1999),
        ('professional', 'Professional', 25,   5000, 4999),
        ('enterprise',   'Enterprise',   999,  99999,9999)
      ON CONFLICT (id) DO NOTHING;
    `);

    const hash = await bcrypt.hash('SuperAdmin@123', 12);
    await client.query(`
      INSERT INTO super_admins (email, password_hash, name)
      VALUES ('admin@medibook.com', $1, 'Super Admin')
      ON CONFLICT (email) DO NOTHING;
    `, [hash]);

    console.log('✅ Public schema migrations complete');
    console.log('✅ Plans seeded (starter, growth, professional, enterprise)');
    console.log('✅ Super admin created: admin@medibook.com / SuperAdmin@123');

  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => { console.error('Migration failed:', err); process.exit(1); });
