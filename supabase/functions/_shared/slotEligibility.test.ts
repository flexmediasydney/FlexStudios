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
  imageMatchesSlot,
  filterImagesForSlot,
  type ProductRow,
  type PackageProductEntry,
  type SlotDefinitionRow,
  type ImageClassification,
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

// ─── 5. W11.6.13 — imageMatchesSlot (space/zone tuple matching) ──────────────

function makeImg(over: Partial<ImageClassification> = {}): ImageClassification {
  return {
    space_type: over.space_type ?? null,
    zone_focus: over.zone_focus ?? null,
    room_type: over.room_type ?? null,
  };
}

Deno.test('imageMatchesSlot Tier 1: AND-intersection — both arrays match → true', () => {
  // entry_hero scenario from the W11.6.13 verification step.
  const slot = makeSlot({
    slot_id: 'entry_hero',
    eligible_space_types: ['entry_foyer'],
    eligible_zone_focuses: ['full_facade', 'door_threshold'],
  });
  // 7961 corner shot — entry_foyer + full_facade. Strong match.
  const img7961 = makeImg({ space_type: 'entry_foyer', zone_focus: 'full_facade' });
  // 7958 looks-through-screen shot — entry_foyer + door_threshold.
  const img7958 = makeImg({ space_type: 'entry_foyer', zone_focus: 'door_threshold' });
  assert(imageMatchesSlot(img7961, slot));
  assert(imageMatchesSlot(img7958, slot));
});

Deno.test('imageMatchesSlot Tier 1: zone NOT in slot.eligible_zone_focuses → false', () => {
  const slot = makeSlot({
    slot_id: 'entry_hero',
    eligible_space_types: ['entry_foyer'],
    eligible_zone_focuses: ['full_facade', 'door_threshold'],
  });
  // entry_foyer + dining_table — wrong zone (would never happen in practice
  // but exercises the AND-intersection logic).
  const wrong = makeImg({ space_type: 'entry_foyer', zone_focus: 'dining_table' });
  assertEquals(imageMatchesSlot(wrong, slot), false);
});

Deno.test('imageMatchesSlot Tier 1: space NOT in slot.eligible_space_types → false', () => {
  const slot = makeSlot({
    slot_id: 'kitchen_hero',
    eligible_space_types: ['kitchen_dining_living_combined', 'kitchen_dedicated'],
    eligible_zone_focuses: ['kitchen_island'],
  });
  // dining_room space with kitchen_island zone — space mismatches.
  const wrong = makeImg({ space_type: 'dining_room_dedicated', zone_focus: 'kitchen_island' });
  assertEquals(imageMatchesSlot(wrong, slot), false);
});

Deno.test('imageMatchesSlot Tier 1: missing space_type or zone_focus → false', () => {
  const slot = makeSlot({
    slot_id: 'entry_hero',
    eligible_space_types: ['entry_foyer'],
    eligible_zone_focuses: ['door_threshold'],
  });
  assertEquals(imageMatchesSlot(makeImg({ space_type: 'entry_foyer' }), slot), false);
  assertEquals(imageMatchesSlot(makeImg({ zone_focus: 'door_threshold' }), slot), false);
});

Deno.test('imageMatchesSlot Tier 2: space-only match (zone array empty)', () => {
  // master_bedroom_hero: any zone inside master_bedroom is fair game.
  const slot = makeSlot({
    slot_id: 'master_bedroom_hero',
    eligible_space_types: ['master_bedroom'],
    eligible_zone_focuses: [],
  });
  const bed = makeImg({ space_type: 'master_bedroom', zone_focus: 'bed_focal' });
  const wardrobe = makeImg({ space_type: 'master_bedroom', zone_focus: 'wardrobe_built_in' });
  const view = makeImg({ space_type: 'master_bedroom', zone_focus: 'window_view' });
  const wrong = makeImg({ space_type: 'bedroom_secondary', zone_focus: 'bed_focal' });
  assert(imageMatchesSlot(bed, slot));
  assert(imageMatchesSlot(wardrobe, slot));
  assert(imageMatchesSlot(view, slot));
  assertEquals(imageMatchesSlot(wrong, slot), false);
});

Deno.test('imageMatchesSlot Tier 2b: zone-only match (space array empty)', () => {
  // Hypothetical "any-fireplace" detail slot — zone gates, space free.
  const slot = makeSlot({
    slot_id: 'fireplace_detail',
    eligible_space_types: [],
    eligible_zone_focuses: ['fireplace_focal'],
  });
  const livingRoom = makeImg({ space_type: 'living_room_dedicated', zone_focus: 'fireplace_focal' });
  const masterBedroom = makeImg({ space_type: 'master_bedroom', zone_focus: 'fireplace_focal' });
  const wrong = makeImg({ space_type: 'living_room_dedicated', zone_focus: 'lounge_seating' });
  assert(imageMatchesSlot(livingRoom, slot));
  assert(imageMatchesSlot(masterBedroom, slot));
  assertEquals(imageMatchesSlot(wrong, slot), false);
});

Deno.test('imageMatchesSlot Tier 3: legacy room_type fallback when both new arrays empty', () => {
  const legacy = makeSlot({
    slot_id: 'kitchen_hero',
    eligible_space_types: [],
    eligible_zone_focuses: [],
    eligible_room_types: ['kitchen_main'],
  });
  const matching = makeImg({ room_type: 'kitchen_main' });
  const noMatch = makeImg({ room_type: 'living_room' });
  // New fields populated but slot still uses legacy → still matches via room_type.
  const newPlusLegacy = makeImg({
    space_type: 'kitchen_dedicated',
    zone_focus: 'kitchen_island',
    room_type: 'kitchen_main',
  });
  assert(imageMatchesSlot(matching, legacy));
  assert(imageMatchesSlot(newPlusLegacy, legacy));
  assertEquals(imageMatchesSlot(noMatch, legacy), false);
});

Deno.test('imageMatchesSlot: misconfigured slot (no constraints anywhere) → false', () => {
  const broken = makeSlot({
    slot_id: 'misconfigured',
    eligible_space_types: [],
    eligible_zone_focuses: [],
    eligible_room_types: [],
  });
  const img = makeImg({ space_type: 'master_bedroom', zone_focus: 'bed_focal', room_type: 'master_bedroom' });
  assertEquals(imageMatchesSlot(img, broken), false);
});

Deno.test('imageMatchesSlot: null/undefined image → false (defensive)', () => {
  const slot = makeSlot({
    slot_id: 'entry_hero',
    eligible_space_types: ['entry_foyer'],
    eligible_zone_focuses: ['door_threshold'],
  });
  assertEquals(imageMatchesSlot(null, slot), false);
  assertEquals(imageMatchesSlot(undefined, slot), false);
});

Deno.test('filterImagesForSlot: real entry_hero verification scenario from spec', () => {
  // Spec verification step #13: entry_hero with space=[entry_foyer] alone
  // qualifies all 4 candidates; adding zone=[full_facade,door_threshold]
  // gates 7961 (corner shot showing facade) cleanly.
  const spaceOnly = makeSlot({
    slot_id: 'entry_hero',
    eligible_space_types: ['entry_foyer'],
    eligible_zone_focuses: [],
  });
  const tight = makeSlot({
    slot_id: 'entry_hero',
    eligible_space_types: ['entry_foyer'],
    eligible_zone_focuses: ['full_facade', 'door_threshold'],
  });
  const candidates = [
    { image: '7961', classification: makeImg({ space_type: 'entry_foyer', zone_focus: 'full_facade' }) },
    { image: '7956', classification: makeImg({ space_type: 'entry_foyer', zone_focus: 'door_threshold' }) },
    { image: '7958', classification: makeImg({ space_type: 'entry_foyer', zone_focus: 'door_threshold' }) },
    { image: '7960', classification: makeImg({ space_type: 'entry_foyer', zone_focus: 'door_threshold' }) },
  ];
  // Tier 2: space-only — all 4 qualify.
  assertEquals(filterImagesForSlot(candidates, spaceOnly).sort(), ['7956', '7958', '7960', '7961']);
  // Tier 1: AND-intersection — all 4 still qualify because their zones are
  // all inside the slot's zone set. The point of zone gating is to exclude
  // images where someone painted the same space but the SUBJECT isn't a
  // facade or threshold (e.g. a vanity_detail in the entry).
  assertEquals(filterImagesForSlot(candidates, tight).sort(), ['7956', '7958', '7960', '7961']);
  // Add a noise candidate that's in the entry but is shooting a vanity —
  // should drop out under Tier 1, survive under Tier 2.
  const withNoise = [
    ...candidates,
    { image: 'noise', classification: makeImg({ space_type: 'entry_foyer', zone_focus: 'vanity_detail' }) },
  ];
  assertEquals(
    filterImagesForSlot(withNoise, spaceOnly).sort(),
    ['7956', '7958', '7960', '7961', 'noise'],
  );
  assertEquals(
    filterImagesForSlot(withNoise, tight).sort(),
    ['7956', '7958', '7960', '7961'],
  );
});

Deno.test('imageMatchesSlot Tier 1: living_dining_combined dining_table — Joseph IMG_034A7916 case', () => {
  // The bug that motivated W11.6.13: a shot of the dining zone INSIDE a
  // combined living/dining envelope should match a dining_hero slot whose
  // eligible_space_types includes BOTH living_dining_combined AND
  // dining_room_dedicated (the backfill rule).
  const dining = makeSlot({
    slot_id: 'dining_hero',
    eligible_space_types: ['dining_room_dedicated', 'living_dining_combined'],
    eligible_zone_focuses: ['dining_table'],
  });
  const ld = makeImg({ space_type: 'living_dining_combined', zone_focus: 'dining_table' });
  const dr = makeImg({ space_type: 'dining_room_dedicated', zone_focus: 'dining_table' });
  // Same combined space but the photographer is shooting the LOUNGE zone —
  // would have been mislabelled "living_room" under the legacy schema; now
  // it correctly fails the dining_hero gate.
  const lounge = makeImg({ space_type: 'living_dining_combined', zone_focus: 'lounge_seating' });
  assert(imageMatchesSlot(ld, dining));
  assert(imageMatchesSlot(dr, dining));
  assertEquals(imageMatchesSlot(lounge, dining), false);
});
