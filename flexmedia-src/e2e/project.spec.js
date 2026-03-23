import { test, expect } from '@playwright/test';

test.describe('Project Lifecycle', () => {
  test('navigates to Projects page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: /projects/i }).first().click();
    await expect(page).toHaveURL(/\/projects/i);
  });

  test('kanban board loads on Projects page', async ({ page }) => {
    await page.goto('/projects');

    // Wait for the kanban board to appear — look for stage columns or board container
    const kanbanBoard = page.locator(
      '[data-testid="kanban-board"], [class*="kanban"], [class*="board"], [class*="pipeline"]'
    ).first();

    // Alternatively look for stage column headers typical in a kanban
    const stageHeaders = page.locator(
      '[data-testid*="stage"], [data-testid*="column"], [class*="column-header"]'
    );

    // Either the board container or stage columns should be visible
    await expect(
      kanbanBoard.or(stageHeaders.first())
    ).toBeVisible({ timeout: 15000 });
  });

  test('can click into a project from the board', async ({ page }) => {
    await page.goto('/projects');

    // Wait for project cards to load
    await page.waitForTimeout(3000);

    // Find a project card and click it
    const projectCard = page.locator(
      '[data-testid*="project-card"], [class*="project-card"], [class*="kanban-card"]'
    ).first();

    // If no specific test IDs, try clicking a card-like element within the board
    if (await projectCard.isVisible().catch(() => false)) {
      await projectCard.click();
    } else {
      // Fallback: click any link or clickable item that looks like a project entry
      const projectLink = page.locator('a[href*="/project"], a[href*="ProjectDetails"]').first();
      if (await projectLink.isVisible().catch(() => false)) {
        await projectLink.click();
      } else {
        // Try clicking the first card-style element in the main content area
        const card = page.locator('main .rounded-lg, main .rounded-xl, [class*="card"]').first();
        await card.click();
      }
    }

    // Should navigate to a project detail page
    await page.waitForTimeout(2000);
  });

  test('project detail page shows stage pipeline', async ({ page }) => {
    await page.goto('/projects');

    // Wait for content to load
    await page.waitForTimeout(3000);

    // Click into first available project
    const projectLink = page.locator(
      'a[href*="/project"], a[href*="ProjectDetails"], [data-testid*="project-card"]'
    ).first();

    if (await projectLink.isVisible({ timeout: 10000 }).catch(() => false)) {
      await projectLink.click();
    } else {
      // If projects are rendered differently, try clicking text that looks like an address or project title
      const clickableProject = page.locator('main').getByRole('link').first();
      await clickableProject.click();
    }

    // On project detail page, verify the stage pipeline renders
    // Look for pipeline indicators: stage buttons, step indicators, or status badges
    const pipeline = page.locator(
      '[data-testid*="pipeline"], [data-testid*="stage"], [class*="pipeline"], [class*="stage-indicator"], [class*="stepper"]'
    ).first();

    const statusBadge = page.locator(
      '[class*="badge"], [data-testid*="status"]'
    ).first();

    // Either the pipeline component or at least a status badge should be present
    await expect(
      pipeline.or(statusBadge)
    ).toBeVisible({ timeout: 15000 });
  });
});
