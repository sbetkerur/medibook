// Centralised error message constants and shared configuration values

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

const VALID_ROLES = ['admin', 'staff'];

const VALID_APPOINTMENT_STATUSES = ['confirmed', 'completed', 'cancelled', 'no_show'];

const SLOT_LOOKAHEAD_DAYS = 14;
const CRON_LOOKAHEAD_DAYS = 7;
const FEEDBACK_BATCH_LIMIT = 10;

module.exports = {
  ERRORS,
  VALID_ROLES,
  VALID_APPOINTMENT_STATUSES,
  SLOT_LOOKAHEAD_DAYS,
  CRON_LOOKAHEAD_DAYS,
  FEEDBACK_BATCH_LIMIT,
  validateUUID,
};
