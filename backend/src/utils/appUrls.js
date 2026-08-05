'use strict';
/**
 * Resolved public URLs for this deployment.
 *
 * FRONTEND_URL is a COMMA-SEPARATED list of origins — .env.example documents it
 * that way and index.js parses it that way for CORS, because real cutovers run
 * a custom domain alongside the old *.up.railway.app one. But anything that
 * BUILDS A LINK needs exactly one origin, and three callers were interpolating
 * the raw variable instead:
 *
 *   - the tenant login_url      → "https://a.com,https://b.com/login"
 *   - the unsubscribe link
 *   - the login_url handed back when a tenant is created
 *
 * With one origin configured those happen to work, which is why it went unseen;
 * the day a second origin is added, password reset breaks for everyone and the
 * generated links stop resolving. Links use the FIRST origin — the canonical one.
 */

function parseOrigins() {
  return (process.env.FRONTEND_URL || '')
    .split(',')
    .map(s => s.trim().replace(/\/+$/, '')) // browsers send bare origins, no trailing slash
    .filter(Boolean);
}

/** Every configured origin, in order. Used for CORS/CSP allowlists. */
function frontendOrigins() {
  return parseOrigins();
}

/** The canonical origin to build user-facing links from. */
function frontendBaseUrl() {
  return parseOrigins()[0] || 'http://localhost:3000';
}

module.exports = { frontendOrigins, frontendBaseUrl };
