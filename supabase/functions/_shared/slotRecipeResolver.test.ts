/**
 * Unit tests for slotRecipeResolver — W11.6.25.
 *
 * Run: deno test supabase/functions/_shared/slotRecipeResolver.test.ts \
 *        --no-check --allow-all
 *
 * Covers the 5 design decisions Joseph confirmed:
 *   1. Precedence: project_type → package_tier → package → individual_product
 *   2. SUM allocated_count + ESCALATE classification
 *   3. HIGHER max_count wins
 *   4. (no version column — exercised via DB layer; unit tests here)
 *   5. Tolerance fallback chain
 */

import {
  assertEquals,
  assert,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  filterAllocationsByScope,
  resolveSlotRecipe,
  resolveTolerance,
  type SlotAllocationRow,
  type SlotDefinitionLite,
  type RecipeResolveContext,
} from './slotRecipeResolver.ts';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SLOTS: SlotDefinitionLite[] = [
  { slot_id: 'kitchen_hero',     phase: 1, min_images: 1, max_images: 2 },
  { slot_id: 'living_hero',      phase: 1, min_images: 1, max_images: 2 },
  { slot_id: 'master_bedroom_hero', phase: 1, min_images: 1, max_images: 2 },
  { slot_id: 'pool_hero',        phase: 2, min_images: 0, max_images: 1 },
  { slot_id: 'kitchen_detail',   phase: 3, min_images: 0, max_images: 1 },
];

const PT_RES = 'project-type-residential';
const TIER_S = 'tier-S-uuid';
const PKG_GOLD = 'package-gold-uuid';
const PKG_DAY_VIDEO = 'package-day-video-uuid';
const PROD_DUSK = 'product-dusk-addon-uuid';

const BASE_CTX: RecipeResolveContext = {
  projectTypeId: PT_RES,
  packageTierId: TIER_S,
  packageId: PKG_GOLD,
  individualProductIds: [],
};

// ─── filterAllocationsByScope ────────────────────────────────────────────────

Deno.test('filterAllocationsByScope: keeps only rows matching project scope IDs', () => {
  const rows: SlotAllocationRow[] = [
    { scope_type: 'project_type', scope_ref_id: PT_RES, slot_id: 'kitchen_hero',
      classification: 'mandatory', allocated_count: 1, max_count: null, priority_rank: 100, notes: null },
    { scope_type: 'project_type', scope_ref_id: 'project-type-other', slot_id: 'kitchen_hero',
      classification: 'mandatory', allocated_count: 5, max_count: null, priority_rank: 100, notes: null },
    { scope_type: 'package_tier', scope_ref_id: TIER_S, slot_id: 'living_hero',
      classification: 'mandatory', allocated_count: 1, max_count: null, priority_rank: 100, notes: null },
    { scope_type: 'individual_product', scope_ref_id: PROD_DUSK, slot_id: 'kitchen_detail',
      classification: 'free_recommendation', allocated_count: 1, max_count: null, priority_rank: 100, notes: null },
  ];
  const filtered = filterAllocationsByScope(rows, {
    ...BASE_CTX,
    individualProductIds: [PROD_DUSK],
  });
  assertEquals(filtered.length, 3);
  assertEquals(
    filtered.map((r) => r.slot_id).sort(),
    ['kitchen_detail', 'kitchen_hero', 'living_hero'],
  );
});

// ─── Precedence (4 cases) ────────────────────────────────────────────────────

Deno.test('precedence — project_type alone resolves cleanly', () => {
  const rows: SlotAllocationRow[] = [
    { scope_type: 'project_type', scope_ref_id: PT_RES, slot_id: 'kitchen_hero',
      classification: 'mandatory', allocated_count: 2, max_count: null, priority_rank: 50, notes: 'project-type rule' },
  ];
  const recipe = resolveSlotRecipe(rows, SLOTS, BASE_CTX);
  assertEquals(recipe.entries.length, 1);
  assertEquals(recipe.entries[0].slot_id, 'kitchen_hero');
  assertEquals(recipe.entries[0].allocated_count, 2);
  assertEquals(recipe.entries[0].classification, 'mandatory');
  assertEquals(recipe.entries[0].priority_rank, 50);
});

Deno.test('precedence — package_tier alone resolves cleanly', () => {
  const rows: SlotAllocationRow[] = [
    { scope_type: 'package_tier', scope_ref_id: TIER_S, slot_id: 'living_hero',
      classification: 'mandatory', allocated_count: 1, max_count: null, priority_rank: 100, notes: null },
  ];
  const recipe = resolveSlotRecipe(rows, SLOTS, BASE_CTX);
  assertEquals(recipe.entries.length, 1);
  assertEquals(recipe.entries[0].slot_id, 'living_hero');
  assertEquals(recipe.entries[0].contributing_scopes[0].scope_type, 'package_tier');
});

Deno.test('precedence — package alone resolves cleanly', () => {
  const rows: SlotAllocationRow[] = [
    { scope_type: 'package', scope_ref_id: PKG_GOLD, slot_id: 'pool_hero',
      classification: 'conditional', allocated_count: 1, max_count: null, priority_rank: 200, notes: null },
  ];
  const recipe = resolveSlotRecipe(rows, SLOTS, BASE_CTX);
  assertEquals(recipe.entries.length, 1);
  assertEquals(recipe.entries[0].slot_id, 'pool_hero');
  assertEquals(recipe.entries[0].classification, 'conditional');
});

Deno.test('precedence — individual_product alone resolves cleanly', () => {
  const rows: SlotAllocationRow[] = [
    { scope_type: 'individual_product', scope_ref_id: PROD_DUSK, slot_id: 'kitchen_detail',
      classification: 'free_recommendation', allocated_count: 1, max_count: null, priority_rank: 300, notes: 'dusk addon detail' },
  ];
  const recipe = resolveSlotRecipe(rows, SLOTS, {
    ...BASE_CTX,
    individualProductIds: [PROD_DUSK],
  });
  assertEquals(recipe.entries.length, 1);
  assertEquals(recipe.entries[0].slot_id, 'kitchen_detail');
  assertEquals(recipe.entries[0].classification, 'free_recommendation');
});

// ─── SUM math ───────────────────────────────────────────────────────────────

Deno.test('SUM — two scopes hit same slot_id, allocated_count sums', () => {
  const rows: SlotAllocationRow[] = [
    { scope_type: 'package_tier', scope_ref_id: TIER_S, slot_id: 'kitchen_hero',
      classification: 'mandatory', allocated_count: 1, max_count: null, priority_rank: 100, notes: 'tier rule' },
    { scope_type: 'package', scope_ref_id: PKG_GOLD, slot_id: 'kitchen_hero',
      classification: 'mandatory', allocated_count: 1, max_count: null, priority_rank: 80, notes: 'package rule' },
  ];
  const recipe = resolveSlotRecipe(rows, SLOTS, BASE_CTX);
  assertEquals(recipe.entries.length, 1);
  assertEquals(recipe.entries[0].allocated_count, 2);
  assertEquals(recipe.entries[0].priority_rank, 80);
  assertEquals(recipe.entries[0].contributing_scopes.length, 2);
});

// ─── Classification escalation ───────────────────────────────────────────────

Deno.test('ESCALATE — mandatory wins over conditional', () => {
  const rows: SlotAllocationRow[] = [
    { scope_type: 'package_tier', scope_ref_id: TIER_S, slot_id: 'living_hero',
      classification: 'conditional', allocated_count: 1, max_count: null, priority_rank: 100, notes: null },
    { scope_type: 'package', scope_ref_id: PKG_GOLD, slot_id: 'living_hero',
      classification: 'mandatory', allocated_count: 1, max_count: null, priority_rank: 100, notes: null },
  ];
  const recipe = resolveSlotRecipe(rows, SLOTS, BASE_CTX);
  assertEquals(recipe.entries[0].classification, 'mandatory');
});

Deno.test('ESCALATE — conditional wins over free_recommendation', () => {
  const rows: SlotAllocationRow[] = [
    { scope_type: 'project_type', scope_ref_id: PT_RES, slot_id: 'pool_hero',
      classification: 'free_recommendation', allocated_count: 1, max_count: null, priority_rank: 100, notes: null },
    { scope_type: 'package', scope_ref_id: PKG_GOLD, slot_id: 'pool_hero',
      classification: 'conditional', allocated_count: 1, max_count: null, priority_rank: 100, notes: null },
  ];
  const recipe = resolveSlotRecipe(rows, SLOTS, BASE_CTX);
  assertEquals(recipe.entries[0].classification, 'conditional');
});

// ─── max_count higher-wins ───────────────────────────────────────────────────

Deno.test('max_count — recipe.max_count higher than slot.max_images wins', () => {
  const rows: SlotAllocationRow[] = [
    { scope_type: 'package', scope_ref_id: PKG_GOLD, slot_id: 'kitchen_hero',
      classification: 'mandatory', allocated_count: 1, max_count: 5, priority_rank: 100, notes: null },
  ];
  const recipe = resolveSlotRecipe(rows, SLOTS, BASE_CTX);
  assertEquals(recipe.entries[0].max_count, 5);
});

Deno.test('max_count — slot.max_images higher than recipe.max_count wins', () => {
  const rows: SlotAllocationRow[] = [
    { scope_type: 'package', scope_ref_id: PKG_GOLD, slot_id: 'kitchen_hero',
      classification: 'mandatory', allocated_count: 1, max_count: 1, priority_rank: 100, notes: null },
  ];
  const recipe = resolveSlotRecipe(rows, SLOTS, BASE_CTX);
  assertEquals(recipe.entries[0].max_count, 2);
});

Deno.test('max_count — recipe NULL falls back to slot.max_images', () => {
  const rows: SlotAllocationRow[] = [
    { scope_type: 'package_tier', scope_ref_id: TIER_S, slot_id: 'living_hero',
      classification: 'mandatory', allocated_count: 1, max_count: null, priority_rank: 100, notes: null },
  ];
  const recipe = resolveSlotRecipe(rows, SLOTS, BASE_CTX);
  assertEquals(recipe.entries[0].max_count, 2);
});

Deno.test('max_count — both higher across two scopes, MAX wins', () => {
  const rows: SlotAllocationRow[] = [
    { scope_type: 'package_tier', scope_ref_id: TIER_S, slot_id: 'kitchen_hero',
      classification: 'mandatory', allocated_count: 1, max_count: 4, priority_rank: 100, notes: null },
    { scope_type: 'package', scope_ref_id: PKG_GOLD, slot_id: 'kitchen_hero',
      classification: 'mandatory', allocated_count: 1, max_count: 6, priority_rank: 100, notes: null },
  ];
  const recipe = resolveSlotRecipe(rows, SLOTS, BASE_CTX);
  assertEquals(recipe.entries[0].max_count, 6);
  assertEquals(recipe.entries[0].allocated_count, 2);
});

// ─── notes concatenation ─────────────────────────────────────────────────────

Deno.test('notes — distinct values concatenated with newline', () => {
  const rows: SlotAllocationRow[] = [
    { scope_type: 'project_type', scope_ref_id: PT_RES, slot_id: 'kitchen_hero',
      classification: 'mandatory', allocated_count: 1, max_count: null, priority_rank: 100, notes: 'Residential default' },
    { scope_type: 'package', scope_ref_id: PKG_GOLD, slot_id: 'kitchen_hero',
      classification: 'mandatory', allocated_count: 1, max_count: null, priority_rank: 100, notes: 'Gold-specific bump' },
  ];
  const recipe = resolveSlotRecipe(rows, SLOTS, BASE_CTX);
  assertEquals(
    recipe.entries[0].notes,
    'Residential default\nGold-specific bump',
  );
});

// ─── orphan slot_id dropped ──────────────────────────────────────────────────

Deno.test('orphan — allocations for slot_ids not in slot_definitions are dropped', () => {
  const rows: SlotAllocationRow[] = [
    { scope_type: 'package', scope_ref_id: PKG_GOLD, slot_id: 'unknown_slot_xyz',
      classification: 'mandatory', allocated_count: 1, max_count: null, priority_rank: 100, notes: null },
    { scope_type: 'package', scope_ref_id: PKG_GOLD, slot_id: 'kitchen_hero',
      classification: 'mandatory', allocated_count: 1, max_count: null, priority_rank: 100, notes: null },
  ];
  const recipe = resolveSlotRecipe(rows, SLOTS, BASE_CTX);
  assertEquals(recipe.entries.length, 1);
  assertEquals(recipe.entries[0].slot_id, 'kitchen_hero');
});

// ─── totals + sort order ─────────────────────────────────────────────────────

Deno.test('totals — sum mandatory / conditional / free_recommendation correctly', () => {
  const rows: SlotAllocationRow[] = [
    { scope_type: 'package_tier', scope_ref_id: TIER_S, slot_id: 'kitchen_hero',
      classification: 'mandatory', allocated_count: 2, max_count: null, priority_rank: 100, notes: null },
    { scope_type: 'package_tier', scope_ref_id: TIER_S, slot_id: 'pool_hero',
      classification: 'conditional', allocated_count: 1, max_count: null, priority_rank: 200, notes: null },
    { scope_type: 'package_tier', scope_ref_id: TIER_S, slot_id: 'kitchen_detail',
      classification: 'free_recommendation', allocated_count: 1, max_count: null, priority_rank: 300, notes: null },
  ];
  const recipe = resolveSlotRecipe(rows, SLOTS, BASE_CTX);
  assertEquals(recipe.totals.mandatory, 2);
  assertEquals(recipe.totals.conditional, 1);
  assertEquals(recipe.totals.free_recommendation, 1);
  assertEquals(recipe.totals.total_min, 4);
  assertEquals(recipe.entries[0].classification, 'mandatory');
  assertEquals(recipe.entries[recipe.entries.length - 1].classification, 'free_recommendation');
});

// ─── tolerance fallback chain ────────────────────────────────────────────────

Deno.test('tolerance — package value wins over global', () => {
  const out = resolveTolerance({
    packageTolBelow: 5, packageTolAbove: 7,
    globalTolBelow: 3,  globalTolAbove: 3,
  });
  assertEquals(out.tolerance_below, 5);
  assertEquals(out.tolerance_above, 7);
});

Deno.test('tolerance — package NULL falls back to global', () => {
  const out = resolveTolerance({
    packageTolBelow: null, packageTolAbove: null,
    globalTolBelow: 4,     globalTolAbove: 6,
  });
  assertEquals(out.tolerance_below, 4);
  assertEquals(out.tolerance_above, 6);
});

Deno.test('tolerance — both NULL falls back to hard default 3', () => {
  const out = resolveTolerance({
    packageTolBelow: null, packageTolAbove: null,
    globalTolBelow: null,  globalTolAbove: null,
  });
  assertEquals(out.tolerance_below, 3);
  assertEquals(out.tolerance_above, 3);
});

Deno.test('tolerance — package zero is honoured (not treated as missing)', () => {
  const out = resolveTolerance({
    packageTolBelow: 0, packageTolAbove: 0,
    globalTolBelow: 3,  globalTolAbove: 3,
  });
  assertEquals(out.tolerance_below, 0);
  assertEquals(out.tolerance_above, 0);
});

Deno.test('tolerance — negative package value is rejected, falls through', () => {
  const out = resolveTolerance({
    packageTolBelow: -5, packageTolAbove: undefined,
    globalTolBelow: 4,    globalTolAbove: undefined,
  });
  assertEquals(out.tolerance_below, 4);
  assertEquals(out.tolerance_above, 3);
});

// ─── Synthetic 4-scope merge ─────────────────────────────────────────────────

Deno.test('synthetic — 4 scopes contribute to a slot, all rules apply', () => {
  const rows: SlotAllocationRow[] = [
    { scope_type: 'project_type', scope_ref_id: PT_RES, slot_id: 'kitchen_hero',
      classification: 'free_recommendation', allocated_count: 1, max_count: 1, priority_rank: 500, notes: 'Residential floor' },
    { scope_type: 'package_tier', scope_ref_id: TIER_S, slot_id: 'kitchen_hero',
      classification: 'conditional', allocated_count: 1, max_count: 3, priority_rank: 200, notes: 'Tier S baseline' },
    { scope_type: 'package', scope_ref_id: PKG_GOLD, slot_id: 'kitchen_hero',
      classification: 'mandatory', allocated_count: 1, max_count: null, priority_rank: 100, notes: 'Gold mandatory' },
    { scope_type: 'individual_product', scope_ref_id: PROD_DUSK, slot_id: 'kitchen_hero',
      classification: 'mandatory', allocated_count: 1, max_count: 4, priority_rank: 50, notes: 'Dusk addon emphasis' },
  ];
  const recipe = resolveSlotRecipe(rows, SLOTS, {
    ...BASE_CTX,
    individualProductIds: [PROD_DUSK],
  });
  assertEquals(recipe.entries.length, 1);
  const e = recipe.entries[0];
  assertEquals(e.classification, 'mandatory');     // ESCALATE
  assertEquals(e.allocated_count, 4);              // SUM 1+1+1+1
  assertEquals(e.max_count, 4);                    // max(1,3,4,slot=2)
  assertEquals(e.priority_rank, 50);               // MIN
  assertEquals(e.contributing_scopes.length, 4);
  assert(typeof e.notes === 'string' && e.notes!.includes('Gold mandatory'));
});

// ─── Synthetic combo from brief ──────────────────────────────────────────────

Deno.test('synthetic from brief — Day Video + dusk addon produces coherent recipe', () => {
  const rows: SlotAllocationRow[] = [
    { scope_type: 'package_tier', scope_ref_id: TIER_S, slot_id: 'kitchen_hero',
      classification: 'mandatory', allocated_count: 1, max_count: null, priority_rank: 101, notes: null },
    { scope_type: 'package_tier', scope_ref_id: TIER_S, slot_id: 'living_hero',
      classification: 'mandatory', allocated_count: 1, max_count: null, priority_rank: 102, notes: null },
    { scope_type: 'package_tier', scope_ref_id: TIER_S, slot_id: 'master_bedroom_hero',
      classification: 'mandatory', allocated_count: 1, max_count: null, priority_rank: 103, notes: null },
    { scope_type: 'package', scope_ref_id: PKG_DAY_VIDEO, slot_id: 'pool_hero',
      classification: 'mandatory', allocated_count: 1, max_count: null, priority_rank: 90, notes: 'Day Video pkg highlights pool' },
    { scope_type: 'individual_product', scope_ref_id: PROD_DUSK, slot_id: 'kitchen_detail',
      classification: 'free_recommendation', allocated_count: 1, max_count: null, priority_rank: 300, notes: 'Dusk addon flair' },
  ];
  const recipe = resolveSlotRecipe(rows, SLOTS, {
    projectTypeId: PT_RES,
    packageTierId: TIER_S,
    packageId: PKG_DAY_VIDEO,
    individualProductIds: [PROD_DUSK],
  });
  assertEquals(recipe.entries.length, 5);
  assertEquals(recipe.totals.mandatory, 4);
  assertEquals(recipe.totals.free_recommendation, 1);
  const pool = recipe.entries.find((e) => e.slot_id === 'pool_hero')!;
  assertEquals(pool.classification, 'mandatory');
  assertEquals(pool.priority_rank, 90);
});
