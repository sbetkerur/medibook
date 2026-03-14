'use strict';
/**
 * Shared helpers used by split admin route files.
 */
const { tenantQuery } = require('../db');
const logger = require('../utils/logger');

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

async function writeAuditLog(schema, actorId, actorRole, action, resourceType, resourceId, oldValues, newValues, ipAddress) {
  try {
    await tenantQuery(schema, `
      INSERT INTO audit_logs (actor_id, actor_role, action, resource_type, resource_id, old_values, new_values, ip_address)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [
      actorId, actorRole, action, resourceType, resourceId,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
      ipAddress || null,
    ]);
  } catch (err) { logger.warn('Audit log write failed', { action, error: err.message }); }
}

module.exports = { adminOnly, writeAuditLog };
