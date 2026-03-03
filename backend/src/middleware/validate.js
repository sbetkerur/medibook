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

  loginStrict: Joi.object({
    email: Joi.string().email().required(),
    password: Joi.string().min(8)
      .pattern(/[A-Z]/, 'uppercase letter')
      .pattern(/[a-z]/, 'lowercase letter')
      .pattern(/[0-9]/, 'digit')
      .messages({ 'string.pattern.name': 'Password must contain at least one {{#name}}' })
      .required(),
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
    wa_phone_number_id: Joi.string().max(100).optional().allow('', null),
    wa_access_token: Joi.string().optional().allow('', null),
    notification_prefs: Joi.object().optional(),
  }),

  blockRange: Joi.object({
    doctor_id: Joi.string().uuid().required(),
    start_date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
    end_date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
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
        const d = new Date(value);
        const today = new Date(); today.setHours(0, 0, 0, 0);
        if (d < today) return helpers.error('any.invalid');
        return value;
      }).messages({ 'any.invalid': 'appointment_date must be today or in the future' }),
    appointment_time: Joi.string().pattern(/^\d{2}:\d{2}$/).required()
      .messages({ 'string.pattern.base': 'appointment_time must be HH:MM' }),
    visit_type: Joi.string().valid('in_person', 'video').optional().default('in_person'),
    notes: Joi.string().max(500).optional().allow('', null),
  }),

  createTenant: Joi.object({
    name: Joi.string().min(2).max(255).required(),
    slug: Joi.string().min(2).max(100).pattern(/^[a-z0-9-]+$/).required(),
    owner_email: Joi.string().email().required(),
    owner_password: Joi.string().min(8).optional(),
    owner_name: Joi.string().max(255).optional().allow('', null),
    plan: Joi.string().valid('starter', 'growth', 'professional', 'enterprise').optional().default('starter'),
    wa_phone_number_id: Joi.string().max(100).optional().allow('', null),
    wa_access_token: Joi.string().optional().allow('', null),
  }),
};

module.exports = { validate, schemas };
