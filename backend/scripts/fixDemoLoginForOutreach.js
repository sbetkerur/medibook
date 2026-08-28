'use strict';
/**
 * One-off fix for the demo-clinic (Smile Dental Clinic) dashboard login ahead
 * of the IDA outreach campaign.
 *
 * 1. Resets demo@medibook.com's password back to the documented default
 *    (Demo@123456) — it stopped working against dev, most likely drifted when
 *    the historical test tenants were copied prod->dev on 2026-08-19. This is
 *    a publicly-documented sales/demo fixture password, not a secret, so
 *    resetting it to the known value is intentional, not a compromise.
 * 2. Creates (or tops up) a dedicated STAFF-role login for the campaign —
 *    trial@medibook.com — so outreach recipients get a working dashboard
 *    without admin-only powers (QR regen, deleting payments, deactivating
 *    doctors). Idempotent: safe to re-run.
 *
 *   DATABASE_URL=<dev proxy url> node scripts/fixDemoLoginForOutreach.js
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { query, tenantQuery, pool } = require('../src/db');

const SLUG = 'demo-clinic';
const ADMIN_EMAIL = 'demo@medibook.com';
const ADMIN_PASSWORD = 'Demo@123456';
const TRIAL_EMAIL = 'trial@medibook.com';
const TRIAL_PASSWORD = 'TryMedi2026';

async function main() {
  const dbHost = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).host : '(unknown)';
  console.log(`Fixing demo-clinic logins on ${dbHost}\n`);

  const t = (await query(`SELECT id, schema_name FROM tenants WHERE slug=$1`, [SLUG])).rows[0];
  if (!t) { console.log(`No tenant with slug ${SLUG} found — aborting.`); return; }
  const schema = t.schema_name;

  const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  const adminUpd = await tenantQuery(schema,
    `UPDATE users SET password_hash=$1, is_active=true WHERE email=$2 RETURNING id`,
    [adminHash, ADMIN_EMAIL]);
  if (adminUpd.rowCount > 0) {
    console.log(`  reset ${ADMIN_EMAIL} -> ${ADMIN_PASSWORD}`);
  } else {
    // Account didn't exist at all — create it as admin, matching seed.js.
    await tenantQuery(schema, `
      INSERT INTO users (email, password_hash, name, role)
      VALUES ($1,$2,'Smile Dental Admin','admin')`, [ADMIN_EMAIL, adminHash]);
    console.log(`  created ${ADMIN_EMAIL} -> ${ADMIN_PASSWORD} (did not exist)`);
  }

  const trialHash = await bcrypt.hash(TRIAL_PASSWORD, 12);
  const existing = (await tenantQuery(schema, `SELECT id FROM users WHERE email=$1`, [TRIAL_EMAIL])).rows[0];
  if (existing) {
    await tenantQuery(schema,
      `UPDATE users SET password_hash=$1, role='staff', is_active=true WHERE id=$2`,
      [trialHash, existing.id]);
    console.log(`  reset ${TRIAL_EMAIL} -> ${TRIAL_PASSWORD} (staff)`);
  } else {
    await tenantQuery(schema, `
      INSERT INTO users (email, password_hash, name, role)
      VALUES ($1,$2,'IDA Trial Access','staff')`, [TRIAL_EMAIL, trialHash]);
    console.log(`  created ${TRIAL_EMAIL} -> ${TRIAL_PASSWORD} (staff)`);
  }

  console.log(`\nClinic slug: ${SLUG}`);
  console.log('Done.');
}

(async () => {
  try {
    await main();
  } catch (err) {
    console.error('\nFAILED:', err.message);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
    process.exit(process.exitCode || 0);
  }
})();
