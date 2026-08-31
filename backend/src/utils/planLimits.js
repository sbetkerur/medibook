'use strict';

/**
 * A tenant's EFFECTIVE dentist / branch ceiling, honouring a per-tenant
 * negotiated override.
 *
 * `tenants.max_doctors_override` / `max_branches_override` are set by the super
 * admin during a deal — "settle for 4 dentists at a rate between the two
 * tiers". They override `plans.max_doctors` / `plans.max_branches` for that one
 * clinic. NULL means "use the plan's list limit", exactly like
 * `tenants.billing_monthly` being NULL means "bill the list price". An override
 * of 0 is honoured literally (a deliberately frozen pilot); only null /
 * undefined falls through to the plan.
 *
 * Returns `null` for "no limit" — Professional's `plans.max_doctors` is NULL,
 * and a missing plan row (pricing not seeded) reads the same way. Callers
 * already treat a null limit as unlimited.
 *
 * This is the ONLY place the COALESCE(override, plan) decision is made — every
 * quota check (POST /doctors, /doctors/import, /hospitals), downgrade fit
 * check, and usage readout (GET /settings, /billing, superadmin quota) goes
 * through it, so a tenant's negotiated cap can never disagree between the
 * screen that shows it and the route that enforces it.
 */
function resolveLimit(overrideVal, planVal) {
  if (overrideVal !== null && overrideVal !== undefined) return overrideVal;
  return planVal ?? null;
}

/** @param tenant a `tenants` row (needs `max_doctors_override`); @param plan a `plans` row or null */
function effectiveDoctorLimit(tenant, plan) {
  return resolveLimit(tenant && tenant.max_doctors_override, plan && plan.max_doctors);
}

/** @param tenant a `tenants` row (needs `max_branches_override`); @param plan a `plans` row or null */
function effectiveBranchLimit(tenant, plan) {
  return resolveLimit(tenant && tenant.max_branches_override, plan && plan.max_branches);
}

module.exports = { effectiveDoctorLimit, effectiveBranchLimit };
