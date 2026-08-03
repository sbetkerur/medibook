// Single source of truth for which version of the Terms of Service + Data
// Processing Agreement is currently in force.
//
// Bump CURRENT_TERMS_VERSION whenever the legal documents change MATERIALLY.
// Every tenant whose stored `terms_version` is behind this value is re-prompted
// on next login, so a bump is a re-consent event for the entire customer base —
// don't bump it for a typo fix.
//
// Keep this in step with the `Version:` header in:
//   legal/TERMS_OF_SERVICE.md
//   legal/DATA_PROCESSING_AGREEMENT.md
//
// The Privacy Policy is deliberately NOT gated on this. It is a published
// NOTICE under the DPDP Act, not a contract anyone assents to, so versioning it
// here would imply an agreement that does not exist.
const CURRENT_TERMS_VERSION = '1.0';

// Terms changes need notice before they bind (ToS Clause 13: 30 days for
// material changes). Set this when publishing a new version so the acceptance
// UI can show the date the new terms take effect. null = effective immediately,
// which is only correct for the very first version.
const TERMS_EFFECTIVE_FROM = null;

/**
 * Has this tenant accepted the version currently in force?
 *
 * A tenant that accepted 1.0 when 1.1 is current counts as NOT accepted, which
 * is the point — that is how a re-consent is triggered. Takes the tenant row
 * rather than an id so callers that already hold it (the login route does)
 * don't need a second query.
 */
function hasAcceptedCurrentTerms(tenant) {
  if (!tenant) return false;
  return Boolean(tenant.terms_accepted_at) && tenant.terms_version === CURRENT_TERMS_VERSION;
}

module.exports = {
  CURRENT_TERMS_VERSION,
  TERMS_EFFECTIVE_FROM,
  hasAcceptedCurrentTerms,
};
