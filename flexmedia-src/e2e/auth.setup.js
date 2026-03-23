import { test as setup, expect } from '@playwright/test';

setup('authenticate', async ({ page }) => {
  await page.goto('/login');
  await page.getByText('or sign in with password').click();
  await page.getByPlaceholder('you@example.com').fill('david@flexmedia.sydney');
  await page.getByPlaceholder('Enter your password').fill('123456789');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/');
  await page.context().storageState({ path: 'e2e/.auth/user.json' });
});
