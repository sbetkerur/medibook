// Playwright E2E config for the MediBook dashboard.
//
// Assumes the BACKEND is already running on :3001 (docker compose up postgres
// redis backend) with the demo tenant seeded. Playwright starts the FRONTEND
// itself via `npm run start` (the production build in .next), whose proxy
// rewrite targets http://localhost:3001 by default (see next.config.js).
//
//   cd frontend && npm ci
//   npx playwright install chromium   # once — .npmrc skips it on npm ci
//   npm run build                     # once, or after a frontend change
//   npm run e2e                       # runs everything in e2e/

const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 12_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    headless: true,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run start',
    url: 'http://localhost:3000/login',
    reuseExistingServer: true,
    timeout: 90_000,
  },
});
