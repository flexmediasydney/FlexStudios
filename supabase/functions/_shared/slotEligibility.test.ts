/**
 * Unit tests for slotEligibility (Wave 7 P1-8).
 * Run: deno test supabase/functions/_shared/slotEligibility.test.ts --no-check --allow-all
 *
 * Covers:
 *   - resolvePackageEngineRoles: maps embedded JSONB → distinct engine roles,
 *     drops inactive products, ignores unknown role values
 *   - filterSlotsForRound:
 *       - drone-only package picks only drone slots
 *       - mixed package picks union (day + dusk + drone)
 *       - universal slot (empty engine_roles + empty package_types) survives
 *       - fallback to package_types substring match when engine_roles is empty
 *       - strict mode (no roundPackageName) drops legacy-only slots safely
 *   - resolveEligibleSlots: end-to-end convenience wrapper
 *   - isContentInScope: warn-don't-reject rule
 */

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  resolvePackageEngineRoles,
  filterSlotsForRound,
  resolveEligibleSlots,
  isContentInScope,
  type ProductRow,
  type PackageProductEntry,
  type SlotDefinitionRow,
} from './slotEligibility.ts';

// ─── Fixture builders ────────────────────────────────────────────────────────

function makeProduct(over: Partial<ProductRow> = {}): ProductRow {
  return {
    id: over.id || 'prod-1',
    engine_role: over.engine_role !== undefined ? over.engine_role : 'photo_day_shortlist',
    is_active: over.is_active !== undefined ? over.is_active : true,
  };
}

function makeSlot(over: Partial<SlotDefinitionRow> = {}): SlotDefinitionRow {
  return {
    slot_id: over.slot_id || 'kitchen_hero',
    display_name: over.display_name ?? 'Kitchen — hero',
    phase: over.phase ?? 1,
    package_types: over.package_types ?? [],
    eligible_when_engine_roles: over.eligible_when_engine_roles ?? [],
    eligible_room_types: over.eligible_room_types ?? ['kitchen_main'],
    max_images: over.max_images ?? 1,
    min_images: over.min_images ?? 1,
    notes: over.notes ?? null,
    version: over.version ?? 1,
    is_active: over.is_active ?? true,
    ...over,
  };
}

// ─── 1. resolvePackageEngineRoles ────────────────────────────────────────────

Deno.test('resolvePackageEngineRoles: empty/null package → empty roles', () => {
  assertEquals(resolvePackageEngineRoles(null, []), []);
  assertEquals(resolvePackageEngineRoles(undefined, []), []);
  assertEquals(resolvePackageEngineRoles([], []), []);
});

Deno.test('resolvePackageEngineRoles: maps product_ids → distinct roles', () => {
  const products: ProductRow[] = [
    makeProduct({ id: 'p-day', engine_role: 'photo_day_shortlist' }),
    makeProduct({ id: 'p-dusk', engine_role: 'photo_dusk_shortlist' }),
    makeProduct({ id: 'p-drone', engine_role: 'drone_shortlist' }),
  ];
  const pkgProducts: PackageProductEntry[] = [
    { product_id: 'p-day', quantity: 12 },
    { product_id: 'p-dusk', quantity: 4 },
    { product_id: 'p-drone', quantity: 1 },
  ];
  const roles = resolvePackageEngineRoles(pkgProducts, products);
  assertEquals(roles.sort(), ['drone_shortlist', 'photo_day_shortlist', 'photo_dusk_shortlist']);
});

Deno.test('resolvePackageEngineRoles: skips inactive products', () => {
  const products: ProductRow[] = [
    makeProduct({ id: 'p-day', engine_role: 'photo_day_shortlist', is_active: true }),
    makeProduct({ id: 'p-old-drone', engine_role: 'drone_shortlist', is_active: false }),
  ];
  const pkgProducts: PackageProductEntry[] = [
    { product_id: 'p-day' },
    { product_id: 'p-old-drone' },
  ];
  const roles = resolvePackageEngineRoles(pkgProducts, products);
  assertEquals(roles, ['photo_day_shortlist']);
});

Deno.test('resolvePackageEngineRoles: skips products with null engine_role (addons)', () => {
  const products: ProductRow[] = [
    makeProduct({ id: 'p-day', engine_role: 'photo_day_shortlist' }),
    makeProduct({ id: 'p-fee', engine_role: null }),
    makeProduct({ id: 'p-edit', engine_role: null }),
  ];
  const pkgProducts: PackageProductEntry[] = [
    { product_id: 'p-day' },
    { product_id: 'p-fee' },
    { product_id: 'p-edit' },
  ];
  const roles = resolvePackageEngineRoles(pkgProducts, products);
  assertEquals(roles, ['photo_day_shortlist']);
});

Deno.test('resolvePackageEngineRoles: deduplicates repeated roles', () => {
  const products: ProductRow[] = [
    makeProduct({ id: 'p-sales', engine_role: 'photo_day_shortlist' }),
    makeProduct({ id: 'p-rental', engine_role: 'photo_day_shortlist' }),
  ];
  const pkgProducts: PackageProductEntry[] = [
    { product_id: 'p-sales' },
    { product_id: 'p-rental' },
  ];
  assertEquals(resolvePackageEngineRoles(pkgProducts, products), ['photo_day_shortlist']);
});

Deno.test('resolvePackageEngineRoles: ignores unknown engine_role strings (forward-compat)', () => {
  const products: ProductRow[] = [
    makeProduct({ id: 'p-day', engine_role: 'photo_day_shortlist' }),
    makeProduct({ id: 'p-future', engine_role: 'thermal_imaging_shortlist' }),
  ];
  const pkgProducts: PackageProductEntry[] = [
    { product_id: 'p-day' },
    { product_id: 'p-future' },
  ];
  // Future role string is dropped; recognised role survives.
  assertEquals(resolvePackageEngineRoles(pkgProducts, products), ['photo_day_shortlist']);
});

Deno.test('resolvePackageEngineRoles: missing product_id → silently dropped', () => {
  const products: ProductRow[] = [makeProduct({ id: 'p-day' })];
  const pkgProducts: PackageProductEntry[] = [
    { product_id: 'p-day' },
    { product_id: 'p-orphan' }, // no matching product row
  ];
  assertEquals(resolvePackageEngineRoles(pkgProducts, products), ['photo_day_shortlist']);
});

Deno.test('resolvePackageEngineRoles: accepts Map<id, ProductRow> for the lookup', () => {
  const map = new Map<string, ProductRow>();
  map.set('p-day', makeProduct({ id: 'p-day', engine_role: 'photo_day_shortlist' }));
  const pkgProducts: PackageProductEntry[] = [{ product_id: 'p-day' }];
  assertEquals(resolvePackageEngineRoles(pkgProducts, map), ['photo_day_shortlist']);
});

// ─── 2. filterSlotsForRound ──────────────────────────────────────────────────

Deno.test('filterSlotsForRound: drone-only package picks only drone slots', () => {
  const slots: SlotDefinitionRow[] = [
    makeSlot({ slot_id: 'kitchen_hero', eligible_when_engine_roles: ['photo_day_shortlist'] }),
    makeSlot({ slot_id: 'drone_orbit_primary', eligible_when_engine_roles: ['drone_shortlist'] }),
    makeSlot({ slot_id: 'drone_nadir', eligible_when_engine_roles: ['drone_shortlist'] }),
    makeSlot({ slot_id: 'exterior_front_dusk', eligible_when_engine_roles: ['photo_dusk_shortlist'] }),
  ];
  const filtered = filterSlotsForRound({
    slots,
    projectEngineRoles: ['drone_shortlist'],
    roundPackageName: 'Premium Package',
  });
  const ids = filtered.map((s) => s.slot_id).sort();
  assertEquals(ids, ['drone_nadir', 'drone_orbit_primary']);
});

Deno.test('filterSlotsForRound: mixed package picks union of relevant slots', () => {
  const slots: SlotDefinitionRow[] = [
    makeSlot({ slot_id: 'kitchen_hero', eligible_when_engine_roles: ['photo_day_shortlist'] }),
    makeSlot({ slot_id: 'exterior_front_dusk', eligible_when_engine_roles: ['photo_dusk_shortlist'] }),
    makeSlot({ slot_id: 'drone_orbit', eligible_when_engine_roles: ['drone_shortlist'] }),
    makeSlot({ slot_id: 'video_intro', eligible_when_engine_roles: ['video_day_shortlist'] }),
  ];
  // Premium-with-drone project: day + dusk + drone but NO video.
  const filtered = filterSlotsForRound({
    slots,
    projectEngineRoles: ['photo_day_shortlist', 'photo_dusk_shortlist', 'drone_shortlist'],
    roundPackageName: 'Premium Package',
  });
  const ids = filtered.map((s) => s.slot_id).sort();
  assertEquals(ids, ['drone_orbit', 'exterior_front_dusk', 'kitchen_hero']);
});

Deno.test('filterSlotsForRound: slot with multiple engine roles matches if ANY overlap', () => {
  const slots: SlotDefinitionRow[] = [
    makeSlot({
      slot_id: 'alfresco_hero',
      eligible_when_engine_roles: ['photo_day_shortlist', 'photo_dusk_shortlist'],
    }),
  ];
  // Day-only project: still matches because alfresco_hero accepts day OR dusk.
  const filtered = filterSlotsForRound({
    slots,
    projectEngineRoles: ['photo_day_shortlist'],
    roundPackageName: 'Gold',
  });
  assertEquals(filtered.length, 1);
});

Deno.test('filterSlotsForRound: fallback to package_types when engine_roles is empty', () => {
  const slots: SlotDefinitionRow[] = [
    // Legacy slot — no engine_roles, only package_types.
    makeSlot({
      slot_id: 'kitchen_hero',
      eligible_when_engine_roles: [],
      package_types: ['Gold Package', 'Premium Package'],
    }),
    // Newer slot — has engine_roles, ignores package_types.
    makeSlot({
      slot_id: 'drone_orbit',
      eligible_when_engine_roles: ['drone_shortlist'],
      package_types: ['Premium Package'],
    }),
  ];
  // Project with NO engine roles (e.g. products not yet backfilled) — only the
  // fallback slot should survive, via package-name match.
  const filtered = filterSlotsForRound({
    slots,
    projectEngineRoles: [],
    roundPackageName: 'Gold Package',
  });
  const ids = filtered.map((s) => s.slot_id);
  assertEquals(ids, ['kitchen_hero']);
});

Deno.test('filterSlotsForRound: fallback uses substring match (audit defect #53 parity)', () => {
  // Mimics the existing fetchSlotDefinitions pkgMatches() behaviour: "Gold"
  // and "Gold Package" both match.
  const slots: SlotDefinitionRow[] = [
    makeSlot({
      slot_id: 'kitchen_hero',
      eligible_when_engine_roles: [],
      package_types: ['Gold'],
    }),
  ];
  const filteredA = filterSlotsForRound({
    slots,
    projectEngineRoles: [],
    roundPackageName: 'Gold Package',
  });
  assertEquals(filteredA.length, 1);

  const filteredB = filterSlotsForRound({
    slots,
    projectEngineRoles: [],
    roundPackageName: 'Premium',
  });
  assertEquals(filteredB.length, 0);
});

Deno.test('filterSlotsForRound: universal slot (both empty) always included', () => {
  const slots: SlotDefinitionRow[] = [
    makeSlot({
      slot_id: 'whatever_room',
      eligible_when_engine_roles: [],
      package_types: [],
    }),
  ];
  // Empty engine roles + empty package_types → universal.
  const filteredA = filterSlotsForRound({
    slots,
    projectEngineRoles: [],
    roundPackageName: 'Gold Package',
  });
  assertEquals(filteredA.length, 1);

  // Even with no fallback name supplied.
  const filteredB = filterSlotsForRound({
    slots,
    projectEngineRoles: [],
    roundPackageName: null,
  });
  assertEquals(filteredB.length, 1);
});

Deno.test('filterSlotsForRound: strict mode (null roundPackageName) drops legacy slots', () => {
  // When roundPackageName is null AND the slot relies on package_types
  // fallback, we drop it rather than guessing.
  const slots: SlotDefinitionRow[] = [
    makeSlot({
      slot_id: 'kitchen_hero',
      eligible_when_engine_roles: [],
      package_types: ['Gold Package'],
    }),
  ];
  const filtered = filterSlotsForRound({
    slots,
    projectEngineRoles: [],
    roundPackageName: null,
  });
  assertEquals(filtered.length, 0);
});

Deno.test('filterSlotsForRound: empty projectEngineRoles drops engine-role-restricted slots', () => {
  const slots: SlotDefinitionRow[] = [
    makeSlot({ slot_id: 'drone_orbit', eligible_when_engine_roles: ['drone_shortlist'] }),
  ];
  const filtered = filterSlotsForRound({
    slots,
    projectEngineRoles: [],
    roundPackageName: 'Whatever',
  });
  assertEquals(filtered.length, 0);
});

// ─── 3. resolveEligibleSlots (end-to-end wrapper) ────────────────────────────

Deno.test('resolveEligibleSlots: end-to-end with day-only package', () => {
  const products: ProductRow[] = [
    makeProduct({ id: 'p-sales', engine_role: 'photo_day_shortlist' }),
    makeProduct({ id: 'p-rental', engine_role: 'photo_day_shortlist' }),
  ];
  const pkgProducts: PackageProductEntry[] = [
    { product_id: 'p-sales' },
    { product_id: 'p-rental' },
  ];
  const slots: SlotDefinitionRow[] = [
    makeSlot({ slot_id: 'kitchen_hero', eligible_when_engine_roles: ['photo_day_shortlist'] }),
    makeSlot({ slot_id: 'drone_orbit', eligible_when_engine_roles: ['drone_shortlist'] }),
    makeSlot({
      slot_id: 'exterior_front_dusk',
      eligible_when_engine_roles: ['photo_dusk_shortlist'],
    }),
  ];
  const result = resolveEligibleSlots({
    packageProducts: pkgProducts,
    products,
    slots,
    roundPackageName: 'Gold Package',
  });
  assertEquals(result.projectEngineRoles, ['photo_day_shortlist']);
  assertEquals(
    result.eligibleSlots.map((s) => s.slot_id),
    ['kitchen_hero'],
  );
});

Deno.test('resolveEligibleSlots: hybrid round mixes engine-role + legacy slots', () => {
  const products: ProductRow[] = [
    makeProduct({ id: 'p-sales', engine_role: 'photo_day_shortlist' }),
  ];
  const pkgProducts: PackageProductEntry[] = [{ product_id: 'p-sales' }];

  const slots: SlotDefinitionRow[] = [
    // Engine-role-driven new-style slot.
    makeSlot({
      slot_id: 'kitchen_hero',
      eligible_when_engine_roles: ['photo_day_shortlist'],
      package_types: [], // even an empty list here doesn't open it up — engine_roles take precedence
    }),
    // Legacy fallback slot.
    makeSlot({
      slot_id: 'living_room_hero_legacy',
      eligible_when_engine_roles: [],
      package_types: ['Gold Package'],
    }),
    // Drone slot — should not match.
    makeSlot({
      slot_id: 'drone_orbit',
      eligible_when_engine_roles: ['drone_shortlist'],
    }),
  ];
  const { eligibleSlots } = resolveEligibleSlots({
    packageProducts: pkgProducts,
    products,
    slots,
    roundPackageName: 'Gold Package',
  });
  const ids = eligibleSlots.map((s) => s.slot_id).sort();
  assertEquals(ids, ['kitchen_hero', 'living_room_hero_legacy']);
});

// ─── 4. isContentInScope (Pass 0 OOS warning) ────────────────────────────────

Deno.test('isContentInScope: detected role in project roles → in scope', () => {
  assert(isContentInScope('photo_day_shortlist', ['photo_day_shortlist', 'drone_shortlist']));
});

Deno.test('isContentInScope: detected role missing from project roles → out of scope', () => {
  assertEquals(
    isContentInScope('photo_dusk_shortlist', ['photo_day_shortlist']),
    false,
  );
});

Deno.test('isContentInScope: empty project roles → permissive (warn-only policy)', () => {
  // When we have no engine roles for the project (e.g. unrecognised package),
  // we lean permissive so we don't false-positive a quarantine.
  assert(isContentInScope('photo_dusk_shortlist', []));
  assert(isContentInScope('photo_dusk_shortlist', null));
  assert(isContentInScope('photo_dusk_shortlist', undefined));
});

Deno.test('isContentInScope: empty detected role → in scope (no signal)', () => {
  assert(isContentInScope('', ['photo_day_shortlist']));
});
