/**
 * ProjectDetails — layout invariants (source-level structural assertions).
 *
 * Why source-level instead of mounting? ProjectDetails.jsx is a 1800+ line page
 * that orchestrates ~25 child components and several API hooks. Mounting it in
 * a test would require massive mocking surface for a couple of pure-CSS layout
 * checks. Reading the source and asserting invariants is fast, deterministic,
 * and catches the exact regression we care about: the right panel ordering and
 * the grid ratio.
 *
 * Guards:
 *   1. Pricing & Deliverables card lives in the right sidebar, ABOVE the
 *      ProjectWeatherCard render.
 *   2. The main two-column grid uses the narrowed `lg:grid-cols-[10fr_3fr]`
 *      ratio (right panel ≈ 23% wide, ~30% narrower than the previous 1/3).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DETAILS_PATH = path.resolve(__dirname, '../ProjectDetails.jsx');
const SOURCE = fs.readFileSync(PROJECT_DETAILS_PATH, 'utf8');

describe('ProjectDetails layout invariants', () => {
  it('right sidebar renders the Pricing & Deliverables card above the WeatherCard', () => {
    const sidebarStart = SOURCE.indexOf('data-testid="project-detail-sidebar"');
    const pricingCardStart = SOURCE.indexOf(
      'data-testid="sidebar-pricing-card"',
      sidebarStart,
    );
    const weatherWrapperStart = SOURCE.indexOf(
      'data-testid="sidebar-weather-wrapper"',
      sidebarStart,
    );

    expect(sidebarStart).toBeGreaterThan(-1);
    expect(pricingCardStart).toBeGreaterThan(sidebarStart);
    expect(weatherWrapperStart).toBeGreaterThan(pricingCardStart);
  });

  it('does not render a second Pricing & Deliverables card in the main column', () => {
    // The CardTitle for the pricing card appears exactly once — the relocated
    // sidebar instance. Comments mentioning the relocation are ignored.
    const titleOccurrences =
      SOURCE.match(/<CardTitle[^>]*>Pricing &amp; Deliverables<\/CardTitle>|<CardTitle[^>]*>Pricing & Deliverables<\/CardTitle>/g) || [];
    expect(titleOccurrences).toHaveLength(1);
  });

  it('uses the narrower [10fr_3fr] grid ratio for the main / sidebar split', () => {
    const gridStart = SOURCE.indexOf('data-testid="project-detail-grid"');
    expect(gridStart).toBeGreaterThan(-1);

    // Pull the className that follows the testid attribute.
    const gridLineMatch = SOURCE.slice(gridStart, gridStart + 400).match(
      /className="([^"]+)"/,
    );
    expect(gridLineMatch).not.toBeNull();
    const className = gridLineMatch[1];

    expect(className).toContain('lg:grid-cols-[10fr_3fr]');
    // Old ratio is gone on the project-detail grid.
    expect(className).not.toContain('lg:grid-cols-3');
  });

  it('removes the `lg:col-span-2` constraint from the main column (now flexes to grid track)', () => {
    // The relocated layout no longer needs col-span-2 because the grid
    // template defines two explicit fr tracks. Guard against accidental
    // re-introduction which would break the 30%-narrower contract.
    const gridStart = SOURCE.indexOf('data-testid="project-detail-grid"');
    const sidebarStart = SOURCE.indexOf(
      'data-testid="project-detail-sidebar"',
      gridStart,
    );
    const mainColumnSlice = SOURCE.slice(gridStart, sidebarStart);
    expect(mainColumnSlice).not.toContain('lg:col-span-2');
  });
});
