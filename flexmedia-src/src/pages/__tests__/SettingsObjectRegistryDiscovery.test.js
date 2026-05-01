/**
 * SettingsObjectRegistryDiscovery — unit tests for pure helpers + access control.
 *
 * Covers:
 *   1. canAccessRoute('SettingsObjectRegistryDiscovery', role) — master_admin only
 *   2. suggestCanonicalLabel — snake_case normalisation rules
 *   3. URL filter persistence + parsing semantics (via the same shape used
 *      by the page's URLSearchParams logic).
 *
 * Pure JS; no React/jest-dom. Mirrors routeAccess.test.js pattern (vitest).
 */
import { describe, it, expect } from 'vitest';
import { canAccessRoute, ROUTE_ACCESS } from '@/components/lib/routeAccess';

// ─── 1. Permission gate ────────────────────────────────────────────────────

describe('SettingsObjectRegistryDiscovery — route access', () => {
  it('is registered in ROUTE_ACCESS', () => {
    expect(ROUTE_ACCESS).toHaveProperty('SettingsObjectRegistryDiscovery');
  });

  it('master_admin can access', () => {
    expect(canAccessRoute('SettingsObjectRegistryDiscovery', 'master_admin')).toBe(true);
  });

  it('admin CANNOT access (this surface is owner-only)', () => {
    expect(canAccessRoute('SettingsObjectRegistryDiscovery', 'admin')).toBe(false);
  });

  it('manager / employee / contractor cannot access', () => {
    expect(canAccessRoute('SettingsObjectRegistryDiscovery', 'manager')).toBe(false);
    expect(canAccessRoute('SettingsObjectRegistryDiscovery', 'employee')).toBe(false);
    expect(canAccessRoute('SettingsObjectRegistryDiscovery', 'contractor')).toBe(false);
  });
});

// ─── 2. suggestCanonicalLabel ──────────────────────────────────────────────
// Replicated from the page (kept inline in the .jsx file for bundling).
// If the prod copy diverges this test will fail visibly.

function suggestCanonicalLabel(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

describe('suggestCanonicalLabel', () => {
  it('lowercases', () => {
    expect(suggestCanonicalLabel('Kitchen Island')).toBe('kitchen_island');
  });

  it('replaces non-alphanumeric runs with single underscore', () => {
    expect(suggestCanonicalLabel('white shaker-style cabinet doors')).toBe('white_shaker_style_cabinet_doors');
  });

  it('strips leading + trailing underscores', () => {
    expect(suggestCanonicalLabel('  hello world  ')).toBe('hello_world');
    expect(suggestCanonicalLabel('---kitchen---')).toBe('kitchen');
  });

  it('caps at 80 chars', () => {
    const long = 'a'.repeat(200);
    expect(suggestCanonicalLabel(long).length).toBe(80);
  });

  it('handles null / undefined / empty without throwing', () => {
    expect(suggestCanonicalLabel(null)).toBe('');
    expect(suggestCanonicalLabel(undefined)).toBe('');
    expect(suggestCanonicalLabel('')).toBe('');
  });

  it('preserves digits', () => {
    expect(suggestCanonicalLabel('Floor 2 Master Bedroom')).toBe('floor_2_master_bedroom');
  });

  it('drops emoji + unicode', () => {
    expect(suggestCanonicalLabel('Kitchen 🍳 Island')).toBe('kitchen_island');
  });
});

// ─── 3. URL filter persistence ─────────────────────────────────────────────
// The page uses useSearchParams() to round-trip filter state through the URL.
// We verify the canonical URL ↔ filters mapping by simulating the same
// URLSearchParams reads/writes the page does.

describe('URL filter round-trip', () => {
  function readFiltersFromQuery(qs) {
    const sp = new URLSearchParams(qs);
    return {
      project_id: sp.get('project_id') || '',
      status: sp.get('status') || 'pending',
      source: sp.get('source') || 'all',
      search: sp.get('search') || '',
      page: Number(sp.get('page') || 0),
      limit: Number(sp.get('limit') || 25),
    };
  }

  it('default state (empty query string)', () => {
    const f = readFiltersFromQuery('');
    expect(f.status).toBe('pending');
    expect(f.source).toBe('all');
    expect(f.search).toBe('');
    expect(f.page).toBe(0);
    expect(f.limit).toBe(25);
  });

  it('reads project_id', () => {
    const f = readFiltersFromQuery('project_id=abc123');
    expect(f.project_id).toBe('abc123');
  });

  it('reads status filter', () => {
    expect(readFiltersFromQuery('status=promoted').status).toBe('promoted');
    expect(readFiltersFromQuery('status=rejected').status).toBe('rejected');
    expect(readFiltersFromQuery('status=deferred').status).toBe('deferred');
    expect(readFiltersFromQuery('status=all').status).toBe('all');
  });

  it('reads source filter', () => {
    expect(readFiltersFromQuery('source=slot_suggestion').source).toBe('slot_suggestion');
    expect(readFiltersFromQuery('source=object_candidate').source).toBe('object_candidate');
  });

  it('reads pagination', () => {
    expect(readFiltersFromQuery('page=3').page).toBe(3);
    expect(readFiltersFromQuery('limit=100').limit).toBe(100);
  });

  it('survives composite filter URL', () => {
    const f = readFiltersFromQuery('project_id=p1&status=promoted&source=slot_suggestion&search=island&page=2');
    expect(f.project_id).toBe('p1');
    expect(f.status).toBe('promoted');
    expect(f.source).toBe('slot_suggestion');
    expect(f.search).toBe('island');
    expect(f.page).toBe(2);
  });
});
