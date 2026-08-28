'use strict';
/**
 * Turning a signup into a live clinic. ONE place for slug reservation, entry-code
 * minting, the tenant row, the PG schema + migrations, and the first admin user —
 * two copies of that is the last place drift should be allowed.
 *
 * Entry points:
 *   - provisionTenant()             — super-admin console (POST /superadmin/tenants).
 *                                     One shot: everything, straight to 'active'.
 *   - registerSelfServeTenant()     — routes/signup.js /signup/confirm. Phase 1:
 *                                     INSERT the tenant row at 'pending_review'
 *                                     with an entry code and NOTHING else.
 *   - buildSelfServeTenantSchema()  — POST /superadmin/tenants/:id/approve. Phase
 *                                     2: build the schema + first admin user for
 *                                     a clinic that was just approved.
 *   - provisionSelfServeTenant()    — LEGACY. Only the billing-dunning retry for
 *                                     old-flow 'pending_payment' rows still calls
 *                                     it; new signups never reach that state.
 *
 * This used to live inline in routes/superadmin.js.
 */
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { query, tenantQuery, validateSchemaName } = require('../db');
const { createTenantSchema, runTenantMigrations } = require('../db/tenantMigrate');
const { generateEntryCode } = require('../utils/entryCode');
const { frontendBaseUrl } = require('../utils/appUrls');
const logger = require('../utils/logger');

const DEMO_ENTRY_CODE = 'TRYMED'; // never hand this out — it is the demo clinic's

function schemaNameForSlug(slug) {
  return 'tenant_' + String(slug).replace(/-/g, '_').toLowerCase();
}

/**
 * INSERT the tenants row with a unique entry code. Retries only on an
 * entry-code collision (settled by idx_tenants_entry_code, never a prior
 * SELECT). Any other 23505 — the slug — is a real conflict and is re-thrown
 * with `.code` preserved so the caller can turn it into a 409.
 */
async function _insertTenantRow({ name, slug, schema, owner_email, plan, city, billing_monthly, status, signup_source }) {
  for (let attempt = 0; attempt < 6; attempt++) {
    let code = generateEntryCode();
    if (code === DEMO_ENTRY_CODE) code = generateEntryCode();
    try {
      const r = await query(`
        INSERT INTO tenants (name, slug, schema_name, owner_email, plan, status, city, entry_code, billing_monthly, signup_source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING *
      `, [name, slug, schema, owner_email, plan, status, city || null, code, billing_monthly ?? null, signup_source]);
      return r.rows[0];
    } catch (e) {
      if (e.code === '23505' && e.constraint === 'idx_tenants_entry_code') continue;
      throw e; // slug collision or anything else — surface it
    }
  }
  const err = new Error('Could not allocate a clinic entry code — please retry.');
  err.retryable = true;
  throw err;
}

/** Create the schema, run its migrations, and add the first admin user. */
async function _buildSchemaAndAdmin(schema, { owner_email, owner_name, passwordHash }) {
  await createTenantSchema(schema);
  await runTenantMigrations(schema);
  await tenantQuery(schema, `
    INSERT INTO users (email, password_hash, name, role)
    VALUES ($1,$2,$3,'admin')
    ON CONFLICT (email) DO NOTHING
  `, [owner_email, passwordHash, owner_name || (owner_email.split('@')[0] + ' (Admin)')]);
}

async function _rollback(tenantId, schema, why) {
  logger.error('Tenant provisioning failed — rolling back', { schema, error: why });
  try {
    validateSchemaName(schema);
    await query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
  } catch (validationErr) {
    logger.error('Refusing to DROP SCHEMA — name failed validation', { schema, error: validationErr.message });
  }
  if (tenantId) await query(`DELETE FROM tenants WHERE id=$1`, [tenantId]).catch(() => {});
}

async function _audit({ actor_id, actor_role, action, tenant_id, new_values, ip }) {
  try {
    await query(`
      INSERT INTO audit_logs (actor_id, actor_role, action, resource_type, resource_id, new_values, ip_address)
      VALUES ($1,$2,$3,'tenant',$4,$5,$6)
    `, [actor_id || null, actor_role || 'system', action, tenant_id, JSON.stringify(new_values || {}), ip || null]);
  } catch (err) { logger.warn(`Audit log failed (${action})`, { error: err.message }); }
}

/**
 * Full one-shot provisioning (super-admin path).
 *
 * @returns {{ tenant, credentials, generatedPassword: boolean }}
 * @throws  an Error whose `.status` is 409 on a slug clash, 400 on a bad slug.
 */
async function provisionTenant({
  name, slug, owner_email, owner_name,
  owner_password, plan = 'starter', city = null, billing_monthly = null,
  signup_source = 'admin', audit = {},
}) {
  const schema = schemaNameForSlug(slug);
  try { validateSchemaName(schema); }
  catch (e) { const err = new Error('That clinic ID cannot be used — try a shorter one with only letters, numbers and hyphens.'); err.status = 400; throw err; }

  const existing = await query(`SELECT id FROM tenants WHERE slug=$1`, [slug]);
  if (existing.rows[0]) { const err = new Error('That clinic ID is already taken.'); err.status = 409; throw err; }

  const generatedPassword = !owner_password;
  const effectivePassword = owner_password || crypto.randomBytes(9).toString('base64url');
  const passwordHash = await bcrypt.hash(effectivePassword, 12);

  let tenant;
  try {
    tenant = await _insertTenantRow({
      name, slug, schema, owner_email, plan, city, billing_monthly,
      status: 'active', signup_source,
    });
  } catch (e) {
    if (e.code === '23505') { const err = new Error('That clinic ID is already taken.'); err.status = 409; throw err; }
    throw e;
  }

  try {
    await _buildSchemaAndAdmin(schema, { owner_email, owner_name, passwordHash });
  } catch (setupErr) {
    await _rollback(tenant.id, schema, setupErr.message);
    throw setupErr;
  }

  await _audit({
    actor_id: audit.actor_id, actor_role: audit.actor_role || 'super_admin',
    action: 'CREATE_TENANT', tenant_id: tenant.id,
    new_values: { name, slug, plan, billing_monthly: billing_monthly ?? null, signup_source }, ip: audit.ip,
  });

  return {
    tenant,
    credentials: {
      email: owner_email,
      password: effectivePassword,
      tenant_slug: slug,
      login_url: `${frontendBaseUrl()}/login`,
    },
    generatedPassword,
  };
}

/**
 * Phase 1 of self-serve provisioning: register the clinic for review WITHOUT
 * building anything.
 *
 * A self-serve signup no longer provisions a schema at /signup/confirm. All it
 * does is INSERT a `tenants` row at status 'pending_review' (with an entry code
 * so the super-admin queue can show one) and link it to the `pending_signups`
 * row that carries the owner's password hash. The PG schema, the first admin
 * user and the trial are all created later, by
 * POST /superadmin/tenants/:id/approve → buildSelfServeTenantSchema().
 *
 * Until approval there is nothing to log into: 'pending_review' is out of
 * LOGIN_ALLOWED_STATUSES / DASHBOARD_ALLOWED_STATUSES.
 *
 * Idempotent: a replayed /signup/confirm with the same token returns the
 * existing tenant row untouched.
 *
 * @param {object} pending  a `pending_signups` row (token already matched by caller)
 * @returns {{ tenant, alreadyRegistered: boolean }}
 */
async function registerSelfServeTenant(pending) {
  const data = typeof pending.data === 'string' ? JSON.parse(pending.data) : (pending.data || {});
  const { name } = data;
  const slug = pending.slug;
  const owner_email = pending.email;
  const plan = pending.plan || 'starter';
  const schema = schemaNameForSlug(slug);

  if (pending.tenant_id) {
    const t = await query(`SELECT * FROM tenants WHERE id=$1`, [pending.tenant_id]);
    if (t.rows[0]) return { tenant: t.rows[0], alreadyRegistered: true };
  }

  try { validateSchemaName(schema); }
  catch (e) { const err = new Error('That clinic ID cannot be used.'); err.status = 400; throw err; }

  const dup = await query(`SELECT id FROM tenants WHERE slug=$1`, [slug]);
  if (dup.rows[0]) { const err = new Error('That clinic ID was taken while you were signing up — please start again with another.'); err.status = 409; throw err; }

  let tenant;
  try {
    tenant = await _insertTenantRow({
      name, slug, schema, owner_email, plan, city: null, billing_monthly: null,
      status: 'pending_review', signup_source: 'self_serve',
    });
  } catch (e) {
    if (e.code === '23505') { const err = new Error('That clinic ID was taken while you were signing up — please start again.'); err.status = 409; throw err; }
    throw e;
  }
  await query(`UPDATE pending_signups SET tenant_id=$1 WHERE token=$2`, [tenant.id, pending.token]);

  await _audit({
    actor_role: 'system', action: 'CREATE_TENANT_SELF_SERVE', tenant_id: tenant.id,
    new_values: { name, slug, plan, signup_source: 'self_serve', status: 'pending_review', schema_built: false },
  });
  return { tenant, alreadyRegistered: false };
}

/**
 * Phase 2 of self-serve provisioning: build the PG schema + first admin user for
 * a clinic that has been APPROVED. Called from the super-admin approve route.
 *
 * Idempotent — `_buildSchemaAndAdmin` is `CREATE SCHEMA IF NOT EXISTS` +
 * `INSERT ... ON CONFLICT DO NOTHING` — so a re-run (or an approve that races
 * the dunning recovery) is harmless.
 *
 * @param {object} tenant   the `tenants` row (already at pending_review)
 * @param {object} pending  the linked `pending_signups` row (carries the hash)
 */
async function buildSelfServeTenantSchema(tenant, pending) {
  const data = typeof pending.data === 'string' ? JSON.parse(pending.data) : (pending.data || {});
  const { owner_name, owner_password_hash } = data;
  const schema = tenant.schema_name || schemaNameForSlug(tenant.slug);
  validateSchemaName(schema);
  await _buildSchemaAndAdmin(schema, {
    owner_email: tenant.owner_email || pending.email,
    owner_name,
    passwordHash: owner_password_hash,
  });
  await _audit({
    actor_role: 'system', action: 'PROVISION_TENANT_SCHEMA', tenant_id: tenant.id,
    new_values: { slug: tenant.slug, schema },
  });
}

/**
 * LEGACY recovery path — only reachable for `pending_payment` tenants left over
 * from the old flow (where /signup/confirm built the schema inline and could die
 * half-way). New signups never reach `pending_payment`. `jobs/billingDunning.js`
 * `retryStuckProvisioning` is the sole caller.
 *
 * @param {object} pending  a `pending_signups` row (token already matched by caller)
 * @returns {{ tenant, alreadyProvisioned: boolean }}
 */
async function provisionSelfServeTenant(pending) {
  const data = typeof pending.data === 'string' ? JSON.parse(pending.data) : (pending.data || {});
  const { name, owner_name, owner_password_hash } = data;
  const slug = pending.slug;
  const owner_email = pending.email;
  const plan = pending.plan || 'starter';
  const schema = schemaNameForSlug(slug);

  // Already provisioned?
  if (pending.tenant_id) {
    const t = await query(`SELECT * FROM tenants WHERE id=$1`, [pending.tenant_id]);
    if (t.rows[0] && t.rows[0].status !== 'pending_payment') {
      return { tenant: t.rows[0], alreadyProvisioned: true };
    }
    if (t.rows[0]) {
      // Retry the schema build for the existing pending_payment tenant.
      await _buildSchemaAndAdmin(schema, { owner_email, owner_name, passwordHash: owner_password_hash });
      const upd = await query(
        `UPDATE tenants SET status='pending_review', onboarding_completed=false WHERE id=$1 RETURNING *`,
        [pending.tenant_id]
      );
      return { tenant: upd.rows[0], alreadyProvisioned: false };
    }
  }

  try { validateSchemaName(schema); }
  catch (e) { const err = new Error('That clinic ID cannot be used.'); err.status = 400; throw err; }

  const dup = await query(`SELECT id FROM tenants WHERE slug=$1`, [slug]);
  if (dup.rows[0]) { const err = new Error('That clinic ID was taken while you were paying — please contact support to finish setup.'); err.status = 409; throw err; }

  let tenant;
  try {
    tenant = await _insertTenantRow({
      name, slug, schema, owner_email, plan, city: null, billing_monthly: null,
      status: 'pending_payment', signup_source: 'self_serve',
    });
  } catch (e) {
    if (e.code === '23505') { const err = new Error('That clinic ID was taken while you were paying — please contact support.'); err.status = 409; throw err; }
    throw e;
  }
  await query(`UPDATE pending_signups SET tenant_id=$1 WHERE token=$2`, [tenant.id, pending.token]);

  try {
    await _buildSchemaAndAdmin(schema, { owner_email, owner_name, passwordHash: owner_password_hash });
  } catch (setupErr) {
    // Do NOT drop the tenant row here — tenant_billing may already point at it
    // and the webhook/dunning path can retry the build. It stays out of every
    // "active tenant" query in the meantime.
    logger.error('Self-serve schema build failed — tenant left pending_payment for retry', {
      slug, tenant_id: tenant.id, error: setupErr.message,
    });
    throw setupErr;
  }

  const upd = await query(
    `UPDATE tenants SET status='pending_review', onboarding_completed=false WHERE id=$1 RETURNING *`,
    [tenant.id]
  );
  await _audit({
    actor_role: 'system', action: 'CREATE_TENANT_SELF_SERVE', tenant_id: tenant.id,
    new_values: { name, slug, plan, signup_source: 'self_serve', status: 'pending_review' },
  });
  return { tenant: upd.rows[0], alreadyProvisioned: false };
}

module.exports = {
  provisionTenant,
  registerSelfServeTenant,
  buildSelfServeTenantSchema,
  provisionSelfServeTenant,
  schemaNameForSlug,
};
