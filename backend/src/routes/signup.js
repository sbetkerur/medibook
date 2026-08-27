'use strict';
/**
 * Self-serve clinic signup — public, unauthenticated.
 *
 * The trial is CARD-FREE. A clinic gets 14 days on signing up; the card is only
 * needed to keep going past the trial (POST /admin/billing/subscribe).
 *
 * Flow (frontend: src/app/signup/page.js):
 *   1. POST /signup/start       — validate, reserve nothing, send a WhatsApp OTP
 *                                 to the owner's number. The password is hashed
 *                                 here and carried (hash only) inside the OTP row.
 *   2. POST /signup/verify-otp  — check the code, create a Razorpay customer
 *                                 (best-effort, for the later subscription), and
 *                                 park the verified signup in `pending_signups`.
 *   3. POST /signup/confirm     — provision the tenant (schema + first admin
 *                                 user) at status `pending_review`, start a
 *                                 14-day trial in `tenant_billing`, and return a
 *                                 live session so the owner lands in the
 *                                 onboarding wizard. A super admin still has to
 *                                 approve before patients can reach the clinic.
 *
 * Nothing here creates a tenant row or a schema until step 3, so an abandoned
 * signup leaves only an expiring `pending_signups` / `wa_otps` row.
 *
 * Gated on SELF_SIGNUP_ENABLED=true AND a real Razorpay config (so a trial can
 * actually convert) AND, for production delivery, an OTP template.
 */
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { query, tenantQuery, validateSchemaName } = require('../db');
const { validate, schemas } = require('../middleware/validate');
const { handleError } = require('../utils/errors');
const logger = require('../utils/logger');
const razorpay = require('../services/razorpay');
const { issueOtp, verifyOtp, normalizePhone } = require('../services/otp');
const { provisionSelfServeTenant, schemaNameForSlug } = require('../services/signupProvision');

const TRIAL_DAYS = Math.max(0, parseInt(process.env.SIGNUP_TRIAL_DAYS || '14', 10) || 14);
const PENDING_TTL_MINUTES = 45;

// Slugs that would collide with a route, the demo clinic, or an obvious phish.
const RESERVED_SLUGS = new Set([
  'demo-clinic', 'pragati-demo', 'demo', 'admin', 'superadmin', 'super-admin',
  'api', 'app', 'www', 'signup', 'login', 'logout', 'dashboard', 'onboarding',
  'auth', 'webhook', 'billing', 'health', 'metrics', 'static', 'assets',
  'medibook', 'support', 'help', 'status', 'test',
]);

const skipInDev = () => process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';

// One clinic-creation attempt is cheap until /confirm (which builds a schema);
// the OTP sender has its own per-phone cap. These bound abuse of the public
// surface itself.
const startLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 12,
  message: { error: 'Too many signup attempts from this network. Try again in an hour.' },
  standardHeaders: true, legacyHeaders: false, skip: skipInDev,
});
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 40,
  message: { error: 'Too many attempts. Slow down.' },
  standardHeaders: true, legacyHeaders: false, skip: skipInDev,
});
const confirmLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 20,
  message: { error: 'Too many attempts. Try again shortly.' },
  standardHeaders: true, legacyHeaders: false, skip: skipInDev,
});

function selfSignupEnabled() {
  return String(process.env.SELF_SIGNUP_ENABLED || 'false') === 'true' && razorpay.isConfigured();
}

function sha256(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }

async function slugTaken(slug) {
  if (RESERVED_SLUGS.has(slug)) return true;
  const [t, p] = await Promise.all([
    query(`SELECT 1 FROM tenants WHERE slug=$1`, [slug]),
    query(`SELECT 1 FROM pending_signups WHERE slug=$1 AND consumed_at IS NULL AND expires_at > NOW()`, [slug]),
  ]);
  return t.rowCount > 0 || p.rowCount > 0;
}

// ── PUBLIC CONFIG ────────────────────────────────────────────
router.get('/signup/config', async (req, res) => {
  try {
    const enabled = selfSignupEnabled();
    let plans = [];
    if (enabled) {
      const r = await query(
        `SELECT id, name, price_monthly, max_doctors, max_branches
           FROM plans WHERE id IN ('starter','professional') ORDER BY price_monthly ASC`
      );
      plans = r.rows;
    }
    res.json({
      enabled,
      reason: enabled ? null : 'Self-serve signup is not available right now.',
      razorpay_key_id: enabled ? razorpay.keyId() : null,
      trial_days: TRIAL_DAYS,
      plans,
    });
  } catch (err) { handleError(res, err); }
});

// ── SLUG AVAILABILITY ────────────────────────────────────────
router.get('/signup/slug-available', async (req, res) => {
  try {
    // Gate on the feature flag — otherwise this is a public oracle for which
    // clinic IDs exist on the platform, live even when signup is switched off.
    if (!selfSignupEnabled()) return res.status(503).json({ available: false, reason: 'Self-serve signup is not available right now.' });
    const slug = String(req.query.slug || '').trim().toLowerCase();
    if (!/^[a-z0-9-]{3,56}$/.test(slug)) {
      return res.json({ available: false, reason: 'Use 3–56 lowercase letters, numbers and hyphens.' });
    }
    if (await slugTaken(slug)) return res.json({ available: false, reason: 'That clinic ID is taken.' });
    res.json({ available: true });
  } catch (err) { handleError(res, err); }
});

// ── STEP 1: START — send the WhatsApp OTP ────────────────────
router.post('/signup/start', startLimiter, validate(schemas.selfSignupStart), async (req, res) => {
  try {
    if (!selfSignupEnabled()) return res.status(503).json({ error: 'Self-serve signup is not available right now.' });
    const { name, owner_email, owner_name, owner_password, plan } = req.body;
    const slug = req.body.slug.toLowerCase();
    const phone = normalizePhone(req.body.owner_phone);

    try { validateSchemaName(schemaNameForSlug(slug)); }
    catch { return res.status(400).json({ error: 'That clinic ID cannot be used — try a shorter one.' }); }

    if (await slugTaken(slug)) return res.status(409).json({ error: 'That clinic ID is taken.' });
    if (!razorpay.planIdFor(plan)) {
      return res.status(503).json({ error: 'That plan is not available for self-serve signup yet.' });
    }

    // Hash the password now — it must never be persisted in plaintext, and the
    // OTP row is the only place it lives until the pending_signups row is written.
    const owner_password_hash = await bcrypt.hash(owner_password, 12);

    const result = await issueOtp(phone, 'signup', {
      name, slug, owner_email: owner_email.trim().toLowerCase(), owner_name,
      owner_password_hash, plan, phone,
    });
    if (!result.ok) {
      // 429 only for an actual rate limit (a cooldown or the hourly cap); a bad
      // number is a 400.
      const rateLimited = result.retryAfter != null || /too many/i.test(result.error || '');
      return res.status(rateLimited ? 429 : 400).json({ error: result.error, retry_after: result.retryAfter });
    }

    res.json({
      ok: true,
      phone_hint: '…' + phone.slice(-4),
      expires_in_minutes: result.expiresInMinutes,
    });
  } catch (err) { handleError(res, err); }
});

// ── STEP 2: VERIFY OTP — park the verified signup ────────────
router.post('/signup/verify-otp', verifyLimiter, validate(schemas.selfSignupVerify), async (req, res) => {
  try {
    if (!selfSignupEnabled()) return res.status(503).json({ error: 'Self-serve signup is not available right now.' });
    const phone = normalizePhone(req.body.owner_phone);
    const check = await verifyOtp(phone, 'signup', req.body.code);
    if (!check.ok) return res.status(400).json({ error: check.error });

    const p = check.payload || {};
    if (!p.slug || !p.owner_email || !p.owner_password_hash) {
      return res.status(400).json({ error: 'Your signup session expired. Please start again.' });
    }
    if (await slugTaken(p.slug)) return res.status(409).json({ error: 'That clinic ID was taken — please start again with another.' });

    // Create the Razorpay customer now so the later "add card" step just needs a
    // subscription. Best-effort: a card-free trial must not be blocked by a
    // billing hiccup.
    let customerId = null;
    try {
      const customer = await razorpay.createCustomer({ name: p.owner_name, email: p.owner_email, contact: phone });
      customerId = customer.id;
    } catch (rzpErr) {
      logger.warn('Razorpay customer create failed during signup — continuing card-free', { error: rzpErr.message });
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + PENDING_TTL_MINUTES * 60 * 1000).toISOString();
    await query(`
      INSERT INTO pending_signups (token, phone, email, slug, data, plan, razorpay_customer_id, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [
      sha256(rawToken), phone, p.owner_email, p.slug,
      JSON.stringify({ name: p.name, owner_name: p.owner_name, owner_password_hash: p.owner_password_hash }),
      p.plan, customerId, expiresAt,
    ]);

    res.json({ ok: true, signup_token: rawToken, trial_days: TRIAL_DAYS });
  } catch (err) { handleError(res, err); }
});

// ── STEP 3: CONFIRM — provision + start the trial, return a session ──
router.post('/signup/confirm', confirmLimiter, validate(schemas.selfSignupConfirm), async (req, res) => {
  try {
    if (!selfSignupEnabled()) return res.status(503).json({ error: 'Self-serve signup is not available right now.' });
    const { signup_token } = req.body;

    const pr = await query(`SELECT * FROM pending_signups WHERE token=$1`, [sha256(signup_token)]);
    const pending = pr.rows[0];
    if (!pending) return res.status(400).json({ error: 'This signup session has expired. Please start again.' });
    if (new Date(pending.expires_at).getTime() < Date.now() && !pending.tenant_id) {
      return res.status(400).json({ error: 'This signup session has expired. Please start again.' });
    }

    // Idempotent replay: already provisioned → hand back a fresh session.
    if (pending.tenant_id && pending.consumed_at) {
      const t = await query(`SELECT * FROM tenants WHERE id=$1`, [pending.tenant_id]);
      if (t.rows[0]) return res.json(await sessionFor(t.rows[0]));
    }

    let provisioned;
    try {
      provisioned = await provisionSelfServeTenant(pending);
    } catch (provErr) {
      if (provErr.status === 409) return res.status(409).json({ error: provErr.message });
      logger.error('Signup confirm: provisioning failed', { slug: pending.slug, error: provErr.message });
      return res.status(500).json({
        error: 'We hit a snag creating your clinic. Please try again in a minute — if it keeps happening, contact support.',
      });
    }
    const tenant = provisioned.tenant;

    // Start a card-free trial. subscription_status 'trialing' is OUR marker (not
    // a Razorpay state) — jobs/billingDunning.js moves the tenant to past_due
    // when trial_end passes with no razorpay_subscription_id attached.
    await query(`
      INSERT INTO tenant_billing
        (tenant_id, provider, plan_id, razorpay_customer_id, subscription_status, trial_end, updated_at)
      VALUES ($1,'razorpay',$2,$3,'trialing', NOW() + make_interval(days => $4::int), NOW())
      ON CONFLICT (tenant_id) DO UPDATE SET
        plan_id=EXCLUDED.plan_id,
        razorpay_customer_id=COALESCE(tenant_billing.razorpay_customer_id, EXCLUDED.razorpay_customer_id),
        updated_at=NOW()
    `, [tenant.id, tenant.plan, pending.razorpay_customer_id, TRIAL_DAYS]);

    await query(`UPDATE pending_signups SET consumed_at=NOW(), tenant_id=$1 WHERE token=$2`,
      [tenant.id, pending.token]);

    logger.info('Self-serve clinic provisioned (card-free trial) — awaiting review', { slug: tenant.slug, tenant_id: tenant.id });
    notifyReviewQueue(tenant).catch(() => {});

    res.json(await sessionFor(tenant));
  } catch (err) { handleError(res, err); }
});

/** Build the { tenant_slug, status, session } payload the frontend expects. */
async function sessionFor(tenant) {
  const { issueSession } = require('./auth');
  const ur = await tenantQuery(tenant.schema_name,
    `SELECT * FROM users WHERE role='admin' AND is_active=true ORDER BY created_at ASC LIMIT 1`);
  const user = ur.rows[0];
  const session = user ? await issueSession(user, tenant) : null;
  return {
    ok: true,
    tenant_slug: tenant.slug,
    status: tenant.status,
    review_pending: tenant.status === 'pending_review',
    session,
  };
}

/**
 * Flag a new clinic for review. There is no super-admin notify channel yet
 * (`super_admins` has no phone/email-for-alerts column), so the queue lives in
 * the dashboard — `GET /superadmin/tenants?status=pending_review` — and this
 * just leaves a breadcrumb in the log and the public audit trail. Wire a real
 * push here if/when a super-admin alert target exists.
 */
async function notifyReviewQueue(tenant) {
  logger.info('Self-serve clinic awaiting review', { slug: tenant.slug, name: tenant.name, tenant_id: tenant.id });
  await query(`
    INSERT INTO audit_logs (actor_role, action, resource_type, resource_id, new_values)
    VALUES ('system','TENANT_AWAITING_REVIEW','tenant',$1,$2)
  `, [tenant.id, JSON.stringify({ slug: tenant.slug, name: tenant.name })]).catch(() => {});
}

module.exports = router;
