/**
 * Unit tests for engineTierResolver (Wave 7 P1-6 / W7.7).
 * Run: deno test supabase/functions/_shared/engineTierResolver.test.ts --no-check --allow-all
 *
 * Covers the three-shape resolver per spec Section 3:
 *   - Bundled path: package_engine_tier_mapping wins
 *   - À la carte path: project.pricing_tier directly
 *   - Mixed path: package wins
 *   - Defensive: missing mapping falls through; missing tier throws
 */

import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  resolveEngineTierId,
  type PackageEngineTierMappingRow,
  type ProjectForTierResolve,
  type ShortlistingTierRow,
} from './engineTierResolver.ts';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TIERS: ShortlistingTierRow[] = [
  { id: 'tier-S-uuid', tier_code: 'S' },
  { id: 'tier-P-uuid', tier_code: 'P' },
  { id: 'tier-A-uuid', tier_code: 'A' },
];

// Joseph-confirmed seeds for Gold and Flex; representative subset of the real
// package_engine_tier_mapping table.
const MAPPING: PackageEngineTierMappingRow[] = [
  { package_id: 'pkg-gold', tier_choice: 'standard', engine_tier_id: 'tier-S-uuid' },
  { package_id: 'pkg-gold', tier_choice: 'premium',  engine_tier_id: 'tier-P-uuid' },
  { package_id: 'pkg-flex', tier_choice: 'standard', engine_tier_id: 'tier-A-uuid' },
  { package_id: 'pkg-flex', tier_choice: 'premium',  engine_tier_id: 'tier-A-uuid' },
];

// ─── Bundled path tests ──────────────────────────────────────────────────────

Deno.test('resolveEngineTierId: bundled Gold + standard → S', () => {
  const project: ProjectForTierResolve = {
    packages: [{ package_id: 'pkg-gold', tier_choice: 'standard' }],
    pricing_tier: null,
  };
  assertEquals(resolveEngineTierId(project, MAPPING, TIERS), 'tier-S-uuid');
});

Deno.test('resolveEngineTierId: bundled Gold + premium → P', () => {
  const project: ProjectForTierResolve = {
    packages: [{ package_id: 'pkg-gold', tier_choice: 'premium' }],
    pricing_tier: null,
  };
  assertEquals(resolveEngineTierId(project, MAPPING, TIERS), 'tier-P-uuid');
});

Deno.test('resolveEngineTierId: bundled Flex (either tier) → A', () => {
  const projectStd: ProjectForTierResolve = {
    packages: [{ package_id: 'pkg-flex', tier_choice: 'standard' }],
    pricing_tier: null,
  };
  const projectPrem: ProjectForTierResolve = {
    packages: [{ package_id: 'pkg-flex', tier_choice: 'premium' }],
    pricing_tier: null,
  };
  assertEquals(resolveEngineTierId(projectStd, MAPPING, TIERS), 'tier-A-uuid');
  assertEquals(resolveEngineTierId(projectPrem, MAPPING, TIERS), 'tier-A-uuid');
});

Deno.test('resolveEngineTierId: bundled package without tier_choice falls back to project.pricing_tier', () => {
  const project: ProjectForTierResolve = {
    packages: [{ package_id: 'pkg-gold', tier_choice: null }],
    pricing_tier: 'premium',
  };
  // Gold + premium (from pricing_tier) → P
  assertEquals(resolveEngineTierId(project, MAPPING, TIERS), 'tier-P-uuid');
});

Deno.test('resolveEngineTierId: bundled package without tier_choice and no pricing_tier defaults to standard', () => {
  const project: ProjectForTierResolve = {
    packages: [{ package_id: 'pkg-gold', tier_choice: null }],
    pricing_tier: null,
  };
  // Gold + standard (default) → S
  assertEquals(resolveEngineTierId(project, MAPPING, TIERS), 'tier-S-uuid');
});

// ─── À la carte path tests ───────────────────────────────────────────────────

Deno.test('resolveEngineTierId: à la carte premium → P', () => {
  const project: ProjectForTierResolve = {
    packages: [],
    pricing_tier: 'premium',
  };
  assertEquals(resolveEngineTierId(project, MAPPING, TIERS), 'tier-P-uuid');
});

Deno.test('resolveEngineTierId: à la carte standard → S', () => {
  const project: ProjectForTierResolve = {
    packages: [],
    pricing_tier: 'standard',
  };
  assertEquals(resolveEngineTierId(project, MAPPING, TIERS), 'tier-S-uuid');
});

Deno.test('resolveEngineTierId: à la carte null pricing_tier → S (default per Joseph)', () => {
  const project: ProjectForTierResolve = {
    packages: [],
    pricing_tier: null,
  };
  assertEquals(resolveEngineTierId(project, MAPPING, TIERS), 'tier-S-uuid');
});

Deno.test('resolveEngineTierId: à la carte unknown pricing_tier → S (default)', () => {
  const project: ProjectForTierResolve = {
    packages: [],
    pricing_tier: 'enterprise', // unknown value
  };
  assertEquals(resolveEngineTierId(project, MAPPING, TIERS), 'tier-S-uuid');
});

Deno.test('resolveEngineTierId: à la carte premium case-insensitive', () => {
  const project: ProjectForTierResolve = {
    packages: [],
    pricing_tier: 'PREMIUM',
  };
  assertEquals(resolveEngineTierId(project, MAPPING, TIERS), 'tier-P-uuid');
});

Deno.test('resolveEngineTierId: empty/null project → S (default à la carte)', () => {
  assertEquals(resolveEngineTierId({}, MAPPING, TIERS), 'tier-S-uuid');
  assertEquals(resolveEngineTierId(null, MAPPING, TIERS), 'tier-S-uuid');
});

// ─── Defensive fall-through ──────────────────────────────────────────────────

Deno.test('resolveEngineTierId: bundled package with no mapping row → falls through to à la carte rule', () => {
  // Defensive: admin hasn't seeded a tier mapping for this package yet. Don't
  // blow up — fall through to project.pricing_tier.
  const project: ProjectForTierResolve = {
    packages: [{ package_id: 'pkg-mystery-not-in-mapping', tier_choice: 'standard' }],
    pricing_tier: 'premium',
  };
  // Falls to à la carte rule → premium → P
  assertEquals(resolveEngineTierId(project, MAPPING, TIERS), 'tier-P-uuid');
});

Deno.test('resolveEngineTierId: bundled package with mapping miss + null pricing_tier → S', () => {
  const project: ProjectForTierResolve = {
    packages: [{ package_id: 'pkg-unknown', tier_choice: 'standard' }],
    pricing_tier: null,
  };
  assertEquals(resolveEngineTierId(project, MAPPING, TIERS), 'tier-S-uuid');
});

Deno.test('resolveEngineTierId: empty packages array uses à la carte rule', () => {
  const project: ProjectForTierResolve = {
    packages: [],
    pricing_tier: 'premium',
  };
  assertEquals(resolveEngineTierId(project, MAPPING, TIERS), 'tier-P-uuid');
});

Deno.test('resolveEngineTierId: package entry without package_id uses à la carte rule', () => {
  const project: ProjectForTierResolve = {
    packages: [{ package_id: null, tier_choice: 'premium' }],
    pricing_tier: 'standard',
  };
  // No usable package_id → à la carte → standard → S
  assertEquals(resolveEngineTierId(project, MAPPING, TIERS), 'tier-S-uuid');
});

// ─── Data-quality failures ───────────────────────────────────────────────────

Deno.test('resolveEngineTierId: empty tiers table throws (data quality bug)', () => {
  const project: ProjectForTierResolve = { packages: [], pricing_tier: 'standard' };
  assertThrows(
    () => resolveEngineTierId(project, MAPPING, []),
    Error,
    'shortlisting_tiers',
  );
});

Deno.test('resolveEngineTierId: tiers missing tier_code S throws when needed', () => {
  const project: ProjectForTierResolve = { packages: [], pricing_tier: 'standard' };
  // Only P present — S lookup fails.
  const tiersOnlyP: ShortlistingTierRow[] = [{ id: 'tier-P-uuid', tier_code: 'P' }];
  assertThrows(
    () => resolveEngineTierId(project, MAPPING, tiersOnlyP),
    Error,
    "tier_code='S'",
  );
});
