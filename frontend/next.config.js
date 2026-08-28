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
  // The bare domain now serves the public marketing page (src/app/page.js) —
  // a real statically prerendered page with "Log in" / "See live demo" / "Start
  // free trial" links. Railway's healthcheck points at /login (railway.toml), so
  // the root is free to be the product's front door.
  //
  // History worth keeping: src/app/page.js once did `redirect('/login')`, and
  // Next 14.2 served that as a 307 with NO Location header — unfollowable. When
  // the healthcheck was still on `/` it read that as 'service unavailable' and
  // killed every deploy after the 14.0.4 → 14.2.35 bump. A `redirects()` entry
  // here was the fix; a real page here is the better one. Do NOT reintroduce a
  // redirect from '/' without moving the healthcheck first.

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
    // the browser only ever connects to 'self' — EXCEPT for Razorpay Checkout,
    // which is loaded as a hosted script + iframe and talks to Razorpay's own
    // API/telemetry hosts directly. These four entries are the minimum Checkout
    // needs and cannot be proxied (the SDK is served and sandboxed by Razorpay).
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://checkout.razorpay.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self' https://api.razorpay.com https://checkout.razorpay.com https://lumberjack.razorpay.com",
      "frame-src 'self' https://api.razorpay.com https://checkout.razorpay.com",
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
