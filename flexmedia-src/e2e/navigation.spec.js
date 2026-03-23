import { test, expect } from '@playwright/test';

test.describe('Navigation', () => {
  test('sidebar link navigates to Dashboard', async ({ page }) => {
    await page.goto('/');
    // Click Dashboard link in sidebar
    await page.getByRole('link', { name: /dashboard/i }).first().click();
    await expect(page).toHaveURL(/\/(dashboard)?$/);
  });

  test('sidebar link navigates to Projects', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: /projects/i }).first().click();
    await expect(page).toHaveURL(/\/projects/i);
    // Verify page loaded with a relevant heading or title
    await expect(page.locator('h1, h2, [data-testid="page-title"]').filter({ hasText: /project/i }).first()).toBeVisible({ timeout: 10000 });
  });

  test('sidebar link navigates to Contacts', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: /contacts/i }).first().click();
    await expect(page).toHaveURL(/\/contacts/i);
    await expect(page.locator('h1, h2, [data-testid="page-title"]').filter({ hasText: /contact/i }).first()).toBeVisible({ timeout: 10000 });
  });

  test('sidebar link navigates to Calendar', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: /calendar/i }).first().click();
    await expect(page).toHaveURL(/\/calendar/i);
  });

  test('page title updates on navigation', async ({ page }) => {
    await page.goto('/');

    // Navigate to Projects and check document title or heading changes
    await page.getByRole('link', { name: /projects/i }).first().click();
    await page.waitForURL(/\/projects/i);

    // The page should have a relevant heading
    const heading = page.locator('h1, h2').filter({ hasText: /project/i }).first();
    await expect(heading).toBeVisible({ timeout: 10000 });

    // Navigate to Contacts
    await page.getByRole('link', { name: /contacts/i }).first().click();
    await page.waitForURL(/\/contacts/i);

    const contactHeading = page.locator('h1, h2').filter({ hasText: /contact/i }).first();
    await expect(contactHeading).toBeVisible({ timeout: 10000 });
  });
});
