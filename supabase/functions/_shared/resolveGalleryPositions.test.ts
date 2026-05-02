/**
 * resolveGalleryPositions.test.ts — unit tests for mig 444 helper.
 *
 * Run:
 *   deno test --no-check --allow-all \
 *     supabase/functions/_shared/resolveGalleryPositions.test.ts
 *
 * Covers the mig 443 schema:
 *   gallery_positions (
 *     scope_type, scope_ref_id, scope_ref_id_2, scope_ref_id_3,
 *     position_index, phase,
 *     room_type, space_type, zone_focus, shot_scale, perspective_compression,
 *     orientation, lens_class, image_type, composition_type,
 *     selection_mode, ai_backfill_on_gap, notes, template_slot_id
 *   )
 *
 * Test cases:
 *  - buildScopeFilters orders scopes broadest -> most-specific.
 *  - buildScopeFilters skips scopes whose key cannot be built (NULL inputs).
 *  - mergePositionsByScope: last-wins per position_index across scopes.
 *  - mergePositionsByScope: lower-specificity entries are preserved when
 *    no higher-specificity entry overrides them (sparse override pattern).
 *  - normaliseRow tolerates partial constraint tuples + NULL axes.
 *  - renderGalleryPositionsBlock formats axes consistently with "any" wildcard.
 */

import { assert, assertEquals, assertStrictEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  buildScopeFilters,
  mergePositionsByScope,
  renderGalleryPositionsBlock,
  type ResolvedGalleryPosition,
} from './resolveGalleryPositions.ts';

const PROJECT_TYPE_ID = '11111111-aaaa-bbbb-cccc-111111111111';
const PACKAGE_ID = '22222222-aaaa-bbbb-cccc-222222222222';
const PRODUCT_ID = '33333333-aaaa-bbbb-cccc-333333333333';
const PRICE_TIER_ID = '44444444-aaaa-bbbb-cccc-444444444444';
const GRADE_ID = '55555555-aaaa-bbbb-cccc-555555555555';

Deno.test('buildScopeFilters: orders broadest to most specific', () => {
  const filters = buildScopeFilters({
    // deno-lint-ignore no-explicit-any
    admin: {} as any,
    project_type_id: PROJECT_TYPE_ID,
    package_id: PACKAGE_ID,
    product_id: PRODUCT_ID,
    price_tier_id: PRICE_TIER_ID,
    grade_id: GRADE_ID,
  });
  assertStrictEquals(filters.length, 7);
  assertEquals(
    filters.map((f) => f.scope_type),
    [
      'project_type',
      'package',
      'package_grade',
      'package_x_price_tier',
      'product',
      'product_x_price_tier',
      'package_x_price_tier_x_project_type',
    ],
  );
  // project_type
  assertStrictEquals(filters[0].scope_ref_id, PROJECT_TYPE_ID);
  assertStrictEquals(filters[0].scope_ref_id_2, null);
  // package
  assertStrictEquals(filters[1].scope_ref_id, PACKAGE_ID);
  assertStrictEquals(filters[1].scope_ref_id_2, null);
  // package_grade
  assertStrictEquals(filters[2].scope_ref_id, PACKAGE_ID);
  assertStrictEquals(filters[2].scope_ref_id_2, GRADE_ID);
  // package_x_price_tier
  assertStrictEquals(filters[3].scope_ref_id, PACKAGE_ID);
  assertStrictEquals(filters[3].scope_ref_id_2, PRICE_TIER_ID);
  // product
  assertStrictEquals(filters[4].scope_ref_id, PRODUCT_ID);
  assertStrictEquals(filters[4].scope_ref_id_2, null);
  // product_x_price_tier
  assertStrictEquals(filters[5].scope_ref_id, PRODUCT_ID);
  assertStrictEquals(filters[5].scope_ref_id_2, PRICE_TIER_ID);
  // package_x_price_tier_x_project_type — all 3 set
  assertStrictEquals(filters[6].scope_ref_id, PACKAGE_ID);
  assertStrictEquals(filters[6].scope_ref_id_2, PRICE_TIER_ID);
  assertStrictEquals(filters[6].scope_ref_id_3, PROJECT_TYPE_ID);
});

Deno.test('buildScopeFilters: skips scopes with NULL inputs', () => {
  const filters = buildScopeFilters({
    // deno-lint-ignore no-explicit-any
    admin: {} as any,
    project_type_id: null,
    package_id: PACKAGE_ID,
    product_id: null,
    price_tier_id: PRICE_TIER_ID,
    grade_id: null,
  });
  // package + package_x_price_tier (no grade) resolve — others skipped
  assertEquals(
    filters.map((f) => f.scope_type),
    ['package', 'package_x_price_tier'],
  );
});

Deno.test('buildScopeFilters: package scope resolves with only package_id', () => {
  const filters = buildScopeFilters({
    // deno-lint-ignore no-explicit-any
    admin: {} as any,
    project_type_id: null,
    package_id: PACKAGE_ID,
    product_id: null,
    price_tier_id: null,
    grade_id: null,
  });
  // Only the bare 'package' scope resolves when nothing else is set
  assertEquals(filters.map((f) => f.scope_type), ['package']);
  assertStrictEquals(filters[0].scope_ref_id, PACKAGE_ID);
  assertStrictEquals(filters[0].scope_ref_id_2, null);
  assertStrictEquals(filters[0].scope_ref_id_3, null);
});

Deno.test('mergePositionsByScope: last-wins per position_index', () => {
  const merged = mergePositionsByScope([
    {
      scope_type: 'project_type',
      scope_ref_id: PROJECT_TYPE_ID,
      rows: [
        { position_index: 0, phase: 'mandatory', room_type: 'kitchen', selection_mode: 'ai_decides' },
        { position_index: 1, phase: 'optional', room_type: 'bedroom', selection_mode: 'ai_decides' },
      ],
    },
    {
      scope_type: 'package_x_price_tier',
      scope_ref_id: PACKAGE_ID,
      rows: [
        // overrides position 0 with a more specific constraint tuple
        {
          position_index: 0,
          phase: 'mandatory',
          room_type: 'kitchen',
          zone_focus: 'island',
          selection_mode: 'curated',
        },
      ],
    },
  ]);
  assertStrictEquals(merged.size, 2);
  assertStrictEquals(merged.get(0)?.resolved_from_scope_type, 'package_x_price_tier');
  assertStrictEquals(merged.get(0)?.zone_focus, 'island');
  assertStrictEquals(merged.get(0)?.selection_mode, 'curated');
  // Position 1 stayed at project_type (no override)
  assertStrictEquals(merged.get(1)?.resolved_from_scope_type, 'project_type');
  assertStrictEquals(merged.get(1)?.room_type, 'bedroom');
});

Deno.test('mergePositionsByScope: NULL constraints become wildcards', () => {
  const merged = mergePositionsByScope([
    {
      scope_type: 'project_type',
      scope_ref_id: PROJECT_TYPE_ID,
      rows: [
        // Only room_type set; everything else null
        { position_index: 0, phase: 'mandatory', room_type: 'kitchen' },
      ],
    },
  ]);
  const pos = merged.get(0)!;
  assertStrictEquals(pos.room_type, 'kitchen');
  assertStrictEquals(pos.space_type, null);
  assertStrictEquals(pos.zone_focus, null);
  assertStrictEquals(pos.shot_scale, null);
  assertStrictEquals(pos.orientation, null);
});

Deno.test('mergePositionsByScope: phase defaults to optional when missing', () => {
  const merged = mergePositionsByScope([
    {
      scope_type: 'project_type',
      scope_ref_id: PROJECT_TYPE_ID,
      rows: [{ position_index: 0 }],
    },
  ]);
  assertStrictEquals(merged.get(0)?.phase, 'optional');
});

Deno.test('mergePositionsByScope: invalid position_index entries are skipped', () => {
  const merged = mergePositionsByScope([
    {
      scope_type: 'project_type',
      scope_ref_id: PROJECT_TYPE_ID,
      rows: [
        { position_index: -1, phase: 'mandatory' },
        { position_index: 'oops' as unknown as number, phase: 'mandatory' },
        { position_index: 5, phase: 'mandatory' },
      ],
    },
  ]);
  assertStrictEquals(merged.size, 1);
  assertStrictEquals(merged.get(5)?.phase, 'mandatory');
});

Deno.test('mergePositionsByScope: ai_backfill_on_gap defaults to true when undefined', () => {
  const merged = mergePositionsByScope([
    {
      scope_type: 'project_type',
      scope_ref_id: PROJECT_TYPE_ID,
      rows: [
        { position_index: 0, phase: 'mandatory' },
        { position_index: 1, phase: 'mandatory', ai_backfill_on_gap: false },
      ],
    },
  ]);
  assertStrictEquals(merged.get(0)?.ai_backfill_on_gap, true);
  assertStrictEquals(merged.get(1)?.ai_backfill_on_gap, false);
});

Deno.test('mergePositionsByScope: selection_mode defaults to ai_decides', () => {
  const merged = mergePositionsByScope([
    {
      scope_type: 'project_type',
      scope_ref_id: PROJECT_TYPE_ID,
      rows: [{ position_index: 0, phase: 'mandatory' }],
    },
  ]);
  assertStrictEquals(merged.get(0)?.selection_mode, 'ai_decides');
});

Deno.test('renderGalleryPositionsBlock: empty list renders empty string', () => {
  assertStrictEquals(renderGalleryPositionsBlock([]), '');
});

Deno.test('renderGalleryPositionsBlock: NULL constraints render as "any"', () => {
  const positions: ResolvedGalleryPosition[] = [
    {
      position_index: 0,
      phase: 'mandatory',
      room_type: 'kitchen',
      space_type: null,
      zone_focus: 'island',
      shot_scale: null,
      perspective_compression: null,
      orientation: null,
      lens_class: null,
      image_type: null,
      composition_type: null,
      selection_mode: 'ai_decides',
      ai_backfill_on_gap: true,
      notes: null,
      template_slot_id: null,
      resolved_from_scope_type: 'package_x_price_tier',
      resolved_from_scope_ref_id: PACKAGE_ID,
    },
  ];
  const block = renderGalleryPositionsBlock(positions);
  assert(block.includes('GALLERY POSITIONS'));
  assert(block.includes('mandatory'));
  assert(block.includes('[0]'));
  // Filled axes
  assert(block.includes('room_type=kitchen'));
  assert(block.includes('zone_focus=island'));
  // Wildcards
  assert(block.includes('space_type=any'));
  assert(block.includes('shot_scale=any'));
  assert(block.includes('orientation=any'));
});

Deno.test('renderGalleryPositionsBlock: ai_backfill_on_gap=false + curated mode render flags', () => {
  const positions: ResolvedGalleryPosition[] = [
    {
      position_index: 7,
      phase: 'conditional',
      room_type: 'wine_room',
      space_type: null,
      zone_focus: null,
      shot_scale: null,
      perspective_compression: null,
      orientation: null,
      lens_class: null,
      image_type: null,
      composition_type: null,
      selection_mode: 'curated',
      ai_backfill_on_gap: false,
      notes: 'leave empty if no wine room visible',
      template_slot_id: null,
      resolved_from_scope_type: 'product',
      resolved_from_scope_ref_id: PRODUCT_ID,
    },
  ];
  const block = renderGalleryPositionsBlock(positions);
  assert(block.includes('[7]'));
  assert(block.includes('ai_backfill_on_gap=false'));
  assert(block.includes('(curated)'));
  assert(block.includes('leave empty if no wine room visible'));
});
