const Joi = require('joi');

// Middleware factory — validates req.body against a Joi schema
function validate(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) {
      const details = error.details.map(d => d.message).join('; ');
      return res.status(400).json({ error: details });
    }
    req.body = value;
    next();
  };
}

// ── SCHEMAS ───────────────────────────────────────────────────

const schemas = {
  login: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().min(6).required(),
    tenant_slug: Joi.string().optional(),
  }),

  // Super admin login. NOTE: no complexity rules here — complexity is enforced
  // when a password is SET (resetPassword/changePassword). Enforcing it at login
  // would lock out accounts whose existing password predates the policy, and
  // leaks the password policy to unauthenticated callers.
  loginStrict: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().min(6).required(),
  }),

  forgotPassword: Joi.object({
    email: Joi.string().email().required(),
    tenant_slug: Joi.string().optional(),
  }),

  resetPassword: Joi.object({
    token: Joi.string().required(),
    password: Joi.string().min(8)
      .pattern(/[A-Z]/, 'uppercase letter')
      .pattern(/[a-z]/, 'lowercase letter')
      .pattern(/[0-9]/, 'digit')
      .messages({ 'string.pattern.name': 'Password must contain at least one {{#name}}' })
      .required(),
  }),

  changePassword: Joi.object({
    current_password: Joi.string().required(),
    new_password: Joi.string().min(8)
      .pattern(/[A-Z]/, 'uppercase letter')
      .pattern(/[a-z]/, 'lowercase letter')
      .pattern(/[0-9]/, 'digit')
      .messages({ 'string.pattern.name': 'Password must contain at least one {{#name}}' })
      .required(),
  }),

  createDoctor: Joi.object({
    name: Joi.string().min(2).max(255).required(),
    specialization: Joi.string().max(255).optional().allow('', null),
    qualification: Joi.string().max(255).optional().allow('', null),
    department_id: Joi.string().uuid().optional().allow('', null),
    hospital_id: Joi.string().uuid().required(),
    consultation_fee: Joi.number().min(0).max(999999).optional().default(0),
    slot_duration_minutes: Joi.number().integer().min(5).max(480).optional().default(30),
    is_active: Joi.boolean().optional().default(true),
  }),

  createHospital: Joi.object({
    name: Joi.string().min(2).max(255).required(),
    address: Joi.string().max(500).optional().allow('', null),
    city: Joi.string().max(100).optional().allow('', null),
    phone: Joi.string().max(20).optional().allow('', null),
  }),

  // Partial update — every field optional (PATCH previously reused createHospital,
  // whose required `name` rejected e.g. a phone-only update with a 400).
  updateHospital: Joi.object({
    name: Joi.string().min(2).max(255).optional(),
    address: Joi.string().max(500).optional().allow('', null),
    city: Joi.string().max(100).optional().allow('', null),
    phone: Joi.string().max(20).optional().allow('', null),
  }).min(1).messages({ 'object.min': 'Provide at least one field to update' }),

  createDepartment: Joi.object({
    name: Joi.string().min(2).max(255).required(),
    hospital_id: Joi.string().uuid().required(),
    description: Joi.string().max(500).optional().allow('', null),
  }),

  createStaff: Joi.object({
    name: Joi.string().min(2).max(255).required(),
    email: Joi.string().email().required(),
    password: Joi.string().min(8)
      .pattern(/[A-Z]/, 'uppercase letter')
      .pattern(/[a-z]/, 'lowercase letter')
      .pattern(/[0-9]/, 'digit')
      .messages({ 'string.pattern.name': 'Password must contain at least one {{#name}}' })
      .required(),
    role: Joi.string().valid('admin', 'staff').default('staff'),
  }),

  updateStaff: Joi.object({
    name: Joi.string().min(2).max(255).optional(),
    email: Joi.string().email().optional(),
    password: Joi.string().min(8)
      .pattern(/[A-Z]/, 'uppercase letter')
      .pattern(/[a-z]/, 'lowercase letter')
      .pattern(/[0-9]/, 'digit')
      .messages({ 'string.pattern.name': 'Password must contain at least one {{#name}}' })
      .optional(),
    role: Joi.string().valid('admin', 'staff').optional(),
    is_active: Joi.boolean().optional(),
  }),

  updateSettings: Joi.object({
    name: Joi.string().min(2).max(255).optional(),
    address: Joi.string().max(500).optional().allow('', null),
    phone: Joi.string().max(20).optional().allow('', null),
    // Keys here are merged into the top level of tenants.settings — the same
    // jsonb blob that holds server-controlled keys (rate_limits,
    // alert_webhook_url). Allowlist explicitly so a tenant admin can never
    // inject those.
    notification_prefs: Joi.object({
      email_on_booking: Joi.boolean(),
      reminder_24h_enabled: Joi.boolean(),
      reminder_2h_enabled: Joi.boolean(),
      reminder_hours_before_24: Joi.number().integer().min(1).max(168),
      reminder_hours_before_2: Joi.number().integer().min(1).max(24),
    }).optional(),
    notify_phone: Joi.string().pattern(/^[+]?[0-9]{7,20}$/).optional().allow('', null)
      .messages({ 'string.pattern.base': 'notify_phone must be 7-20 digits, optionally starting with + (e.g. +917795676142)' }),
  }),

  blockRange: Joi.object({
    doctor_id: Joi.string().uuid().required(),
    start_date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
    end_date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required()
      .custom((value, helpers) => {
        if (value < helpers.state.ancestors[0].start_date) {
          return helpers.error('any.invalid');
        }
        return value;
      }).messages({ 'any.invalid': 'end_date must be on or after start_date' }),
    reason: Joi.string().max(255).optional().allow('', null),
  }),

  createAppointment: Joi.object({
    patient_phone: Joi.string().pattern(/^[+]?[0-9]{7,20}$/).required()
      .messages({ 'string.pattern.base': 'patient_phone must be 7-20 digits, optionally starting with +' }),
    patient_name: Joi.string().min(1).max(255).optional().allow('', null),
    doctor_id: Joi.string().uuid().required(),
    hospital_id: Joi.string().uuid().required(),
    slot_id: Joi.string().uuid().optional().allow('', null),
    appointment_date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required()
      .messages({ 'string.pattern.base': 'appointment_date must be YYYY-MM-DD' })
      .custom((value, helpers) => {
        // Use the configured timezone (default IST) for the "today" boundary.
        // Between 18:30–23:59 UTC the UTC date is one calendar day behind IST —
        // without this adjustment, patients in IST could book for yesterday's date.
        const tz = /^[A-Za-z0-9_/+-]+$/.test(process.env.TIMEZONE || '')
          ? process.env.TIMEZONE
          : 'Asia/Kolkata';
        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz }); // returns YYYY-MM-DD
        if (value < todayStr) return helpers.error('any.invalid');
        return value;
      }).messages({ 'any.invalid': 'appointment_date must be today or in the future' }),
    appointment_time: Joi.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).required()
      .messages({ 'string.pattern.base': 'appointment_time must be HH:MM (valid 24-hour time, e.g. 09:30)' }),
    visit_type: Joi.string().valid('in_person', 'video').optional().default('in_person'),
    notes: Joi.string().max(500).optional().allow('', null),
  }),

  createTenant: Joi.object({
    name: Joi.string().min(2).max(255).required(),
    slug: Joi.string().min(2).max(100).pattern(/^[a-z0-9-]+$/).required(),
    owner_email: Joi.string().email().required(),
    owner_password: Joi.string().min(8)
      .pattern(/[A-Z]/, 'uppercase letter')
      .pattern(/[a-z]/, 'lowercase letter')
      .pattern(/[0-9]/, 'digit')
      .messages({ 'string.pattern.name': 'Password must contain at least one {{#name}}' })
      .optional(),
    owner_name: Joi.string().max(255).optional().allow('', null),
    plan: Joi.string().valid('starter', 'growth', 'professional', 'enterprise').optional().default('starter'),
  }),
};

module.exports = { validate, schemas };
