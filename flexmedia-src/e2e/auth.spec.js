import { test, expect } from '@playwright/test';

// These tests do NOT use stored auth — they test the login flow itself
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Authentication', () => {
  test('wrong password shows error message', async ({ page }) => {
    await page.goto('/login');
    await page.getByText('or sign in with password').click();
    await page.getByPlaceholder('you@example.com').fill('david@flexmedia.sydney');
    await page.getByPlaceholder('Enter your password').fill('wrongpassword');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Should show an error message
    await expect(page.getByText(/invalid|incorrect|error/i)).toBeVisible({ timeout: 10000 });
    // Should remain on login page
    expect(page.url()).toContain('/login');
  });

  test('successful login redirects to dashboard', async ({ page }) => {
    await page.goto('/login');
    await page.getByText('or sign in with password').click();
    await page.getByPlaceholder('you@example.com').fill('david@flexmedia.sydney');
    await page.getByPlaceholder('Enter your password').fill('123456789');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Should redirect away from login
    await page.waitForURL('**/', { timeout: 15000 });
    expect(page.url()).not.toContain('/login');
  });

  test('sign out returns to login page', async ({ page }) => {
    // First, log in
    await page.goto('/login');
    await page.getByText('or sign in with password').click();
    await page.getByPlaceholder('you@example.com').fill('david@flexmedia.sydney');
    await page.getByPlaceholder('Enter your password').fill('123456789');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL('**/', { timeout: 15000 });

    // Look for a sign out / logout button (may be in a dropdown or sidebar)
    const signOutBtn = page.getByRole('button', { name: /sign out|log out|logout/i });
    const signOutLink = page.getByText(/sign out|log out|logout/i);

    if (await signOutBtn.isVisible().catch(() => false)) {
      await signOutBtn.click();
    } else if (await signOutLink.isVisible().catch(() => false)) {
      await signOutLink.click();
    } else {
      // Try clicking avatar/menu to reveal sign out
      const avatar = page.locator('[data-testid="user-menu"], [data-testid="avatar"], button:has(img[alt])').first();
      if (await avatar.isVisible().catch(() => false)) {
        await avatar.click();
        await page.getByText(/sign out|log out|logout/i).click();
      }
    }

    // Should return to login
    await expect(page).toHaveURL(/\/login/, { timeout: 10000 });
  });
});
