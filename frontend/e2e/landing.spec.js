const { test, expect } = require('@playwright/test');

test.describe('marketing landing page', () => {
  test('renders the hero, the "Try it" nav anchor and the two-sides section', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await page.goto('/');
    await expect(page).toHaveTitle(/MediBook/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/books appointments/i);

    // "Try it" nav link (added so both demos are reachable from the header)
    await expect(page.locator('header nav a', { hasText: 'Try it' })).toHaveAttribute('href', '#try');

    // "Try both sides yourself" section — one card per half of the product
    const trySection = page.locator('#try');
    await trySection.scrollIntoViewIfNeeded();
    await expect(trySection).toContainText('What the patient does');
    await expect(trySection).toContainText('What your front desk sees');
    await expect(trySection.getByRole('link', { name: /Open the demo dashboard/i })).toBeVisible();

    expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  });

  test('the live WhatsApp bot widget connects and advances a booking', async ({ page }) => {
    await page.goto('/');

    // The widget greets in the demo clinic's name (proves it reached the bot engine)
    await expect(page.getByText(/Pragati Dental Studio/i).first()).toBeVisible({ timeout: 20_000 });

    const bookBtn = page.getByRole('button', { name: /Book Appointment/i });
    await expect(bookBtn).toBeVisible({ timeout: 20_000 });
    await bookBtn.click();

    // Bot advances to the treatment picker
    await expect(page.getByRole('button', { name: /General Dentistry/i })).toBeVisible({ timeout: 20_000 });
  });
});
