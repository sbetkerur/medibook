// Centralised error message constants and shared configuration values
const logger = require('./logger');

// UUID validation middleware
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is META_APP_SECRET a real secret, or a placeholder?
 *
 * SINGLE SOURCE OF TRUTH. index.js (startup fail-fast) and routes/webhook.js
 * (runtime "should I verify signatures?") previously kept two DISJOINT lists,
 * and .env.example shipped a value only one of them recognised. The two
 * failure modes were both live:
 *   - a value only webhook.js knew  → startup passed, signature verification
 *     silently switched OFF, so anyone could POST a forged messages[].from and
 *     drive the bot as any patient;
 *   - a value only index.js knew    → signature verification stayed ON but
 *     compared against a placeholder, rejecting every genuine Meta delivery.
 * Both call sites must use this function.
 */
const PLACEHOLDER_APP_SECRETS = new Set([
  '',
  'your_app_secret',
  'your_app_secret_here',
  'changeme',
  'placeholder',
  'PLACEHOLDER',
  'PLACEHOLDER_REPLACE_WITH_APP_SECRET',
]);

function isRealAppSecret(secret) {
  const s = (secret || '').trim();
  if (!s) return false;
  if (PLACEHOLDER_APP_SECRETS.has(s)) return false;
  // Anything still containing "placeholder" is a placeholder, whatever its shape.
  if (/placeholder/i.test(s)) return false;
  return true;
}
function validateUUID(param = 'id') {
  return (req, res, next) => {
    if (!UUID_RE.test(req.params[param])) {
      return res.status(400).json({ error: `Invalid ${param} format` });
    }
    next();
  };
}

const ERRORS = {
  UNAUTHORIZED: 'Invalid credentials',
  NO_TOKEN: 'No token provided',
  TOKEN_REVOKED: 'Token has been revoked',
  TOKEN_INVALID: 'Invalid or expired token',
  FORBIDDEN: 'Access denied',
  NOT_FOUND: 'Resource not found',
  CONFLICT: 'Resource already exists',
  TOKEN_VALIDATION_UNAVAILABLE: 'Token validation unavailable',
};

const VALID_ROLES = ['admin', 'staff', 'doctor'];

const VALID_APPOINTMENT_STATUSES = ['confirmed', 'completed', 'cancelled', 'no_show'];

// Allowed appointment status transitions — single source of truth used by both
// the single-appointment PATCH and the bulk update route.
const APPOINTMENT_TRANSITIONS = {
  confirmed: ['completed', 'cancelled', 'no_show'],
  no_show:   ['confirmed'],   // allow re-confirmation if patient arrived late
  completed: [],              // terminal — no further transitions
  cancelled: [],              // terminal
};

const SLOT_LOOKAHEAD_DAYS = 14;
const CRON_LOOKAHEAD_DAYS = 60; // must be >= SLOT_LOOKAHEAD_DAYS to keep a rolling buffer
// Per-run cap on outbound feedback/follow-up messages, per tenant. 10 was far
// below a real clinic's daily throughput (a 6-dentist practice completes 50+),
// and the job now marks what it sent so a backlog drains across later runs
// instead of being dropped. Kept bounded so one busy tenant cannot monopolise
// the WhatsApp send path.
const FEEDBACK_BATCH_LIMIT = 100;

// Centralised magic-number constants — import from here instead of hard-coding
const LIMITS = {
  BOT_INPUT_MAX_LENGTH: 500,          // chars; oversized inputs are silently dropped
  QUEUE_BACKPRESSURE_THRESHOLD: 10000, // jobs; above this we fall back to sync processing
  SLOT_BATCH_SIZE: 100,               // rows per INSERT during slot generation
  MAX_BOOKINGS_PER_HOUR: 3,           // per patient phone; prevents bot abuse
  MAX_PATIENTS_PER_PAGE: 200,         // hard cap on patients list page size
  ANALYTICS_RATE_LIMIT_PER_MIN: 5,    // requests per minute per user for analytics endpoints
  SESSION_CONTEXT_MAX_BYTES: 10000,   // 10 KB; oversized context resets to idle
  EMAIL_DEDUP_WINDOW_HOURS: 2,        // same email not resent within this window
  TOKEN_BLACKLIST_CLEANUP_GRACE_DAYS: 1, // extra days kept after expiry before hard delete
};

/**
 * Safe 500 error responder — logs full error internally, returns generic message to client.
 * Use this in every route catch block to avoid leaking DB internals.
 */
function handleError(res, err, context = 'Route error') {
  logger.error(context, { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
}

module.exports = {
  ERRORS,
  VALID_ROLES,
  VALID_APPOINTMENT_STATUSES,
  APPOINTMENT_TRANSITIONS,
  UUID_RE,
  isRealAppSecret,
  SLOT_LOOKAHEAD_DAYS,
  CRON_LOOKAHEAD_DAYS,
  FEEDBACK_BATCH_LIMIT,
  LIMITS,
  validateUUID,
  handleError,
};
