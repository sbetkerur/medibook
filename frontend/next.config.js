const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  webpack: (config) => {
    config.resolve.alias['@'] = path.join(__dirname, 'src');
    return config;
  },
  // Proxy all /api/proxy/* calls to the backend.
  //
  // BACKEND_URL has no NEXT_PUBLIC_ prefix, so it never reaches the browser
  // bundle — but it IS resolved at BUILD time, not per request: `next build`
  // invokes this rewrites() function and writes the result into
  // .next/routes-manifest.json, which is what `next start` serves from. This
  // comment used to claim the opposite ("read at request time"), directly
  // contradicting Dockerfile:12, which has it right.
  //
  // The practical consequence of the wrong reading: changing the Railway
  // variable and restarting WITHOUT a rebuild silently keeps proxying to the
  // old backend. The Dockerfile passes it as a build ARG for exactly this
  // reason. Set BACKEND_URL in the Railway service variables (Railway forwards
  // service variables as Docker build args) and redeploy to change it.
  async rewrites() {
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:3001';
    return [
      {
        source: '/api/proxy/:path*',
        destination: `${backendUrl}/:path*`,
      },
    ];
  },
  async headers() {
    // Since all API calls go through the Next.js rewrite proxy (/api/proxy/*),
    // the browser only ever connects to 'self'. No external backend origin needed in CSP.
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');

    return [
      {
        // Immutable cache for hashed Next.js static chunks (/_next/static/)
        source: '/_next/static/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
      {
        // Short-lived cache for static public assets only (images, fonts, icons).
        // Scoped by file type so HTML pages and API responses are excluded.
        source: '/:all*(svg|jpg|jpeg|gif|png|ico|webp|avif|woff|woff2|ttf)',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=3600, stale-while-revalidate=86400' },
        ],
      },
      {
        // Never cache proxied API responses — they are authenticated JSON
        // (patient data). A blanket public max-age here previously let browsers
        // and shared caches store PHI for an hour. Declared AFTER the asset rule
        // so it wins if both ever match the same path (last matching rule wins).
        source: '/api/proxy/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Content-Security-Policy', value: csp },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
