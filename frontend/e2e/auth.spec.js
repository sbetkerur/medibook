const { test, expect } = require('@playwright/test');

// Seeded clinic admin (backend seed.js) — tenant slug demo-clinic.
const SLUG = 'demo-clinic';
const EMAIL = 'demo@medibook.com';
const PASSWORD = 'Demo@123456';

async function fillLogin(page, { slug, email, password }) {
  await page.goto('/login');
  await page.getByPlaceholder('e.g. demo-clinic').fill(slug);
  await page.getByPlaceholder('admin@example.com').fill(email);
  await page.getByPlaceholder('••••••••').fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();
}

test('rejects wrong credentials and stays on the login page', async ({ page }) => {
  await fillLogin(page, { slug: SLUG, email: EMAIL, password: 'WrongPass@123' });
  await page.waitForTimeout(3000);
  await expect(page).toHaveURL(/\/login/);
  // no session was stored
  const token = await page.evaluate(() => localStorage.getItem('token'));
  expect(token).toBeNull();
});

test('accepts the seeded clinic admin and reaches the dashboard', async ({ page }) => {
  await fillLogin(page, { slug: SLUG, email: EMAIL, password: PASSWORD });
  await page.waitForURL('**/dashboard', { timeout: 25_000 });

  // A fresh admin session is blocked by the Terms gate until accepted
  await expect(page.getByText(/Before you continue/i)).toBeVisible({ timeout: 20_000 });

  const token = await page.evaluate(() => localStorage.getItem('token'));
  expect(token).toBeTruthy();
});
