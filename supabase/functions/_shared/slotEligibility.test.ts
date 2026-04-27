/**
 * Unit tests for slotEligibility (Wave 7 P1-8 + W7.7 cleanup).
 * Run: deno test supabase/functions/_shared/slotEligibility.test.ts --no-check --allow-all
 *
 * Covers:
 *   - resolvePackageEngineRoles: maps embedded JSONB → distinct engine roles,
 *     drops inactive products, ignores unknown role values
 *   - filterSlotsForRound (W7.7 — engine-role only):
 *       - drone-only package picks only drone slots
 *       - mixed package picks union (day + dusk + drone)
 *       - slot with empty engine_roles + is_active=true is defensively dropped
 *       - empty projectEngineRoles drops engine-role-restricted slots
 *   - resolveEligibleSlots: end-to-end convenience wrapper
 *   - isContentInScope: warn-don't-reject rule
 *
 * Wave 7 P1-6 (W7.7): legacy package_types substring fallback test cases
 * have been removed — the column was dropped in mig 339 and the resolver no
 * longer consults it.
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

// ─── 2. filterSlotsForRound (W7.7 — engine-role only) ────────────────────────

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
    roundPackageName: null,
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
    roundPackageName: null,
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
    roundPackageName: null,
  });
  assertEquals(filtered.length, 1);
});

Deno.test('filterSlotsForRound: empty engine_roles + is_active=true → defensively dropped (W7.7)', () => {
  const slots: SlotDefinitionRow[] = [
    makeSlot({
      slot_id: 'misconfigured',
      eligible_when_engine_roles: [],
      is_active: true,
    }),
    makeSlot({
      slot_id: 'kitchen_hero',
      eligible_when_engine_roles: ['photo_day_shortlist'],
      is_active: true,
    }),
  ];
  const filtered = filterSlotsForRound({
    slots,
    projectEngineRoles: ['photo_day_shortlist'],
    roundPackageName: null,
  });
  assertEquals(filtered.map((s) => s.slot_id), ['kitchen_hero']);
});

Deno.test('filterSlotsForRound: empty projectEngineRoles drops engine-role-restricted slots', () => {
  const slots: SlotDefinitionRow[] = [
    makeSlot({ slot_id: 'drone_orbit', eligible_when_engine_roles: ['drone_shortlist'] }),
  ];
  const filtered = filterSlotsForRound({
    slots,
    projectEngineRoles: [],
    roundPackageName: null,
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
    roundPackageName: null,
  });
  assertEquals(result.projectEngineRoles, ['photo_day_shortlist']);
  assertEquals(
    result.eligibleSlots.map((s) => s.slot_id),
    ['kitchen_hero'],
  );
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
