/**
 * Migration: Add lunch_start_time and lunch_end_time to doctor_schedules
 * Run once: node src/db/migrate_lunch.js
 */
require('dotenv').config();
const { pool, query } = require('./index');

async function migrateLunch() {
  const client = await pool.connect();
  try {
    console.log('Adding lunch break columns to doctor_schedules in all tenant schemas...');

    // Get all active tenant schema names
    const tenants = await client.query(`SELECT schema_name, name FROM tenants WHERE status='active'`);

    for (const tenant of tenants.rows) {
      const schema = tenant.schema_name;
      try {
        await client.query(`
          ALTER TABLE "${schema}".doctor_schedules
            ADD COLUMN IF NOT EXISTS lunch_start_time TIME DEFAULT NULL,
            ADD COLUMN IF NOT EXISTS lunch_end_time   TIME DEFAULT NULL
        `);
        console.log(`  ✅ ${tenant.name} (${schema})`);
      } catch (err) {
        console.error(`  ❌ ${tenant.name}: ${err.message}`);
      }
    }

    // Also update tenantMigrate.js template is handled separately (it already will include these)
    console.log('\n✅ Lunch break migration complete.');
    console.log('   Columns: lunch_start_time, lunch_end_time (nullable TIME)');
    console.log('   NULL = no lunch break configured for that day');
  } finally {
    client.release();
    await pool.end();
  }
}

migrateLunch().catch(err => { console.error('Migration failed:', err.message); process.exit(1); });
