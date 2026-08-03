'use strict';

const { tenantQuery } = require('../../db');
const logger = require('../../utils/logger');

/**
 * Every active BRANCH of every active clinic, with the city it should be listed
 * under.
 *
 * The "clinics near me" picker lists branches rather than clinics because a
 * clinic can have several in one city — offering "Smile Dental Clinic" once and
 * asking which branch three steps later defeats the point of choosing by
 * location.
 *
 * `hospitals` is a PER-TENANT table, so this is one query per active clinic
 * rather than one query overall. They run concurrently and each is caught on
 * its own: one tenant whose schema is mid-migration must not take the whole
 * entry step down with it, which a UNION across every schema would. Each query
 * goes through `tenantQuery`, so the schema name is validated and scoped the
 * same way as all other tenant SQL.
 *
 * This is O(active clinics) per call, so callers must load it LAZILY — only
 * when a city is actually being shown or resolved, never on a plain name
 * search. If the roster grows, a short Redis cache here is the first move.
 *
 * A branch with no city of its own falls back to the CLINIC's city: that is the
 * value super admin sets, and it is what made a clinic reachable by location
 * before branches were listed at all.
 */
async function listActiveBranches(tenants) {
  const list = Array.isArray(tenants) ? tenants : [];

  const perTenant = await Promise.all(list.map(async (t) => {
    try {
      const r = await tenantQuery(
        t.schema_name,
        `SELECT id, name, address, city
           FROM hospitals
          WHERE is_active = true AND deleted_at IS NULL
          ORDER BY name`
      );
      return r.rows.map(h => ({
        tenant_id: t.id,
        tenant_name: t.name,
        hospital_id: h.id,
        hospital_name: h.name,
        address: (h.address || '').trim(),
        city: (h.city || t.city || '').trim(),
      }));
    } catch (err) {
      // Includes an invalid schema name — tenantQuery throws on those.
      logger.error('Failed to list branches for tenant', {
        tenant: t.slug || t.id, error: err.message,
      });
      return [];
    }
  }));

  return perTenant.flat();
}

module.exports = { listActiveBranches };
