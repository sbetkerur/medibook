// Centralised error message constants and shared configuration values
const logger = require('./logger');

// UUID validation middleware
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

const SLOT_LOOKAHEAD_DAYS = 14;
const CRON_LOOKAHEAD_DAYS = 60; // must be >= SLOT_LOOKAHEAD_DAYS to keep a rolling buffer
const FEEDBACK_BATCH_LIMIT = 10;

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
  SLOT_LOOKAHEAD_DAYS,
  CRON_LOOKAHEAD_DAYS,
  FEEDBACK_BATCH_LIMIT,
  LIMITS,
  validateUUID,
  handleError,
};
