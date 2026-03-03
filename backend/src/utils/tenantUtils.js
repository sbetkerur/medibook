const { query } = require('../db');
const logger = require('./logger');

/**
 * Iterate over all active tenants, calling callback(tenant) for each.
 * Per-tenant errors are logged and skipped; the iteration continues.
 *
 * @param {string} label  - Label for error log (e.g. 'sendReminders')
 * @param {Function} callback - async (tenant) => void
 */
async function forEachActiveTenant(label, callback) {
  const { rows } = await query(`SELECT * FROM tenants WHERE status='active'`);
  for (const tenant of rows) {
    try {
      await callback(tenant);
    } catch (err) {
      logger.error(`${label} failed for ${tenant.name}`, { error: err.message });
    }
  }
}

module.exports = { forEachActiveTenant };
