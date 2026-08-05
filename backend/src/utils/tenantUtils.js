const { query } = require('../db');
const logger = require('./logger');

/**
 * Iterate over all active tenants sequentially, calling callback(tenant) for each.
 * Per-tenant errors are logged and skipped; the iteration continues.
 *
 * @param {string} label  - Label for error log (e.g. 'sendReminders')
 * @param {Function} callback - async (tenant) => void
 */
/**
 * Iterate over all active tenants in parallel batches.
 * Up to `concurrency` tenants are processed simultaneously.
 * Per-tenant errors are logged and skipped.
 *
 * Use this when per-tenant work is I/O-bound and independent (e.g. sending reminders).
 * A slow tenant will not block others within the same batch.
 *
 * @param {string} label       - Label for error log
 * @param {Function} callback  - async (tenant) => void
 * @param {number} concurrency - Max simultaneous tenants (default 5)
 */
async function forEachActiveTenantParallel(label, callback, concurrency = 5) {
  const { rows } = await query(`SELECT * FROM tenants WHERE status='active'`);
  for (let i = 0; i < rows.length; i += concurrency) {
    const batch = rows.slice(i, i + concurrency);
    await Promise.allSettled(
      batch.map(async (tenant) => {
        try {
          await callback(tenant);
        } catch (err) {
          logger.error(`${label} failed for ${tenant.name}`, { error: err.message });
        }
      })
    );
  }
}

module.exports = { forEachActiveTenantParallel };
