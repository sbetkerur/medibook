const { test, expect } = require('@playwright/test');

test('demo dashboard: opens read-only, tabs navigate, no page errors', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto('/demo');
  await expect(page.getByRole('heading', { name: /Take a look inside/i })).toBeVisible();

  await page.getByRole('button', { name: /Open the demo dashboard/i }).click();
  await page.waitForURL('**/dashboard', { timeout: 25_000 });

  // The whole-tenant read-only guard is surfaced as a banner
  await expect(page.getByText(/read-only demo clinic/i)).toBeVisible({ timeout: 20_000 });

  // Each sidebar tab loads its own view (heading in the top bar mirrors the tab)
  for (const tab of ['Appointments', 'Day Close', 'Analytics', 'Patients', 'Treatments']) {
    await page.getByRole('button', { name: new RegExp(`^\\S*\\s*${tab}$`) }).first().click();
    await expect(page.getByRole('heading', { name: new RegExp(tab, 'i') }).first())
      .toBeVisible({ timeout: 20_000 });
  }

  // Day Close renders a money figure, not an error state
  await page.getByRole('button', { name: /Day Close/ }).first().click();
  await expect(page.getByText(/Collected today/i)).toBeVisible({ timeout: 20_000 });

  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
});
