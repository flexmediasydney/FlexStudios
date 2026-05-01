/**
 * Unit tests for the Wave 11.6.9 reclassify validation helper.
 * Run: deno test --no-check --allow-all supabase/functions/_shared/reclassifyValidate.test.ts
 *
 * Spec: docs/design-specs/W11-5-human-reclassification-capture.md
 *       (W11.6.9 task brief — multi-field reclassify route on shortlisting-overrides)
 *
 * The full E2E (HTTP roundtrip + DB upsert + RLS check + audit emission) is
 * exercised by the smoke test on the Rainbow Cres round; these unit tests
 * cover the validator's input contract: every field-type round-trip, the
 * "at least one field" rule, idempotency-friendly normalisation, and stable
 * error_codes for the toast layer.
 */

import {
  assert,
  assertEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  validateReclassify,
  CANONICAL_ROOM_TYPES,
  CANONICAL_COMPOSITION_TYPES,
  CANONICAL_VANTAGE_POINTS,
} from './reclassifyValidate.ts';

const GROUP_ID = '11111111-2222-3333-4444-555555555555';
const ROUND_ID = '22222222-3333-4444-5555-666666666666';

// ─── Field-type round-trips (W11.6.9 task spec: "5+ tests covering each") ────

Deno.test('validateReclassify: room_type round-trip', () => {
  const result = validateReclassify({
    group_id: GROUP_ID,
    round_id: ROUND_ID,
    ai_room_type: 'interior_open_plan',
    human_room_type: 'living_secondary',
    override_reason: 'Upstairs lounge — different floor from main living.',
  });
  assert(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
  assertEquals(result.group_id, GROUP_ID);
  assertEquals(result.round_id, ROUND_ID);
  assertEquals(result.override_source, 'stage1_correction'); // default
  assertEquals(result.ai_room_type, 'interior_open_plan');
  assertEquals(result.human_room_type, 'living_secondary');
  assertEquals(result.changed_fields, ['room_type']);
  assertEquals(result.override_reason, 'Upstairs lounge — different floor from main living.');
});

Deno.test('validateReclassify: composition_type round-trip', () => {
  const result = validateReclassify({
    group_id: GROUP_ID,
    round_id: ROUND_ID,
    ai_composition_type: 'hero_wide',
    human_composition_type: 'corner_two_point',
  });
  assert(result.ok);
  assertEquals(result.human_composition_type, 'corner_two_point');
  assertEquals(result.changed_fields, ['composition_type']);
  assertEquals(result.override_reason, null); // optional
});

Deno.test('validateReclassify: vantage_point round-trip', () => {
  const result = validateReclassify({
    group_id: GROUP_ID,
    round_id: ROUND_ID,
    human_vantage_point: 'exterior_looking_in',
  });
  assert(result.ok);
  assertEquals(result.human_vantage_point, 'exterior_looking_in');
  assertEquals(result.changed_fields, ['vantage_point']);
});

Deno.test('validateReclassify: combined_score round-trip + .5 snap', () => {
  // 7.3 → snapped to 7.5 per W11.6.9 .5-step task spec.
  const result = validateReclassify({
    group_id: GROUP_ID,
    round_id: ROUND_ID,
    ai_combined_score: 6.4,
    human_combined_score: 7.3,
  });
  assert(result.ok);
  assertEquals(result.ai_combined_score, 6.4); // ai field preserved verbatim
  assertEquals(result.human_combined_score, 7.5); // snapped
  assertEquals(result.changed_fields, ['combined_score']);
});

Deno.test('validateReclassify: eligible_slot_ids round-trip + dedupe + canonicalise', () => {
  const result = validateReclassify({
    group_id: GROUP_ID,
    round_id: ROUND_ID,
    human_eligible_slot_ids: [
      'exterior_rear',
      'EXTERIOR_REAR', // dupe after lowercase
      'alfresco_hero',
      '   ', // empty after trim — dropped
    ],
  });
  assert(result.ok);
  assertEquals(result.human_eligible_slot_ids, ['exterior_rear', 'alfresco_hero']);
  assertEquals(result.changed_fields, ['eligible_slot_ids']);
});

// ─── Multi-field per request (the differentiator vs composition-override) ────

Deno.test('validateReclassify: multi-field correction in one request', () => {
  const result = validateReclassify({
    group_id: GROUP_ID,
    round_id: ROUND_ID,
    human_room_type: 'exterior_rear',
    human_vantage_point: 'exterior_looking_in',
    human_combined_score: 8,
  });
  assert(result.ok);
  assertEquals(result.human_room_type, 'exterior_rear');
  assertEquals(result.human_vantage_point, 'exterior_looking_in');
  assertEquals(result.human_combined_score, 8);
  // Order matches our priority sweep: room > comp > vantage > score > slot.
  assertEquals(result.changed_fields, ['room_type', 'vantage_point', 'combined_score']);
});

// ─── override_source variants (RLS check lives in the edge fn) ──────────────

Deno.test('validateReclassify: override_source defaults to stage1_correction', () => {
  const result = validateReclassify({
    group_id: GROUP_ID,
    round_id: ROUND_ID,
    human_room_type: 'kitchen_main',
  });
  assert(result.ok);
  assertEquals(result.override_source, 'stage1_correction');
});

Deno.test('validateReclassify: master_admin_correction validates at this layer', () => {
  // The validator passes master_admin_correction through; the edge fn enforces
  // the role check. This test asserts the validator doesn't get in the way of
  // the legitimate path.
  const result = validateReclassify({
    group_id: GROUP_ID,
    round_id: ROUND_ID,
    override_source: 'master_admin_correction',
    human_combined_score: 9.5,
  });
  assert(result.ok);
  assertEquals(result.override_source, 'master_admin_correction');
});

Deno.test('validateReclassify: stage4_visual_override validates at this layer', () => {
  const result = validateReclassify({
    group_id: GROUP_ID,
    round_id: ROUND_ID,
    override_source: 'stage4_visual_override',
    human_room_type: 'exterior_rear',
  });
  assert(result.ok);
  assertEquals(result.override_source, 'stage4_visual_override');
});

Deno.test('validateReclassify: rejects unknown override_source', () => {
  const result = validateReclassify({
    group_id: GROUP_ID,
    round_id: ROUND_ID,
    override_source: 'random_admin_action',
    human_room_type: 'kitchen_main',
  });
  assert(!result.ok);
  assertEquals(result.error_code, 'RECLASSIFY_OVERRIDE_SOURCE_INVALID');
});

// ─── Required-field guards ───────────────────────────────────────────────────

Deno.test('validateReclassify: rejects non-object body', () => {
  const result = validateReclassify(null);
  assert(!result.ok);
  assertEquals(result.error_code, 'RECLASSIFY_NOT_OBJECT');
});

Deno.test('validateReclassify: rejects array body', () => {
  const result = validateReclassify([]);
  assert(!result.ok);
  assertEquals(result.error_code, 'RECLASSIFY_NOT_OBJECT');
});

Deno.test('validateReclassify: requires group_id', () => {
  const result = validateReclassify({
    round_id: ROUND_ID,
    human_room_type: 'kitchen_main',
  });
  assert(!result.ok);
  assertEquals(result.error_code, 'RECLASSIFY_GROUP_ID_REQUIRED');
});

Deno.test('validateReclassify: requires round_id', () => {
  const result = validateReclassify({
    group_id: GROUP_ID,
    human_room_type: 'kitchen_main',
  });
  assert(!result.ok);
  assertEquals(result.error_code, 'RECLASSIFY_ROUND_ID_REQUIRED');
});

Deno.test('validateReclassify: rejects request with no human_* field set', () => {
  const result = validateReclassify({
    group_id: GROUP_ID,
    round_id: ROUND_ID,
    ai_room_type: 'kitchen_main',
    override_reason: 'Just thinking out loud.',
  });
  assert(!result.ok);
  assertEquals(result.error_code, 'RECLASSIFY_NO_FIELDS_TO_CHANGE');
});

// ─── Per-field validation rejects ────────────────────────────────────────────

Deno.test('validateReclassify: rejects unknown room_type', () => {
  const result = validateReclassify({
    group_id: GROUP_ID,
    round_id: ROUND_ID,
    human_room_type: 'definitely_not_a_room',
  });
  assert(!result.ok);
  assertEquals(result.error_code, 'RECLASSIFY_ROOM_TYPE_INVALID');
});

Deno.test('validateReclassify: rejects unknown composition_type', () => {
  const result = validateReclassify({
    group_id: GROUP_ID,
    round_id: ROUND_ID,
    human_composition_type: 'panoramic_drone_thing',
  });
  assert(!result.ok);
  assertEquals(result.error_code, 'RECLASSIFY_COMPOSITION_TYPE_INVALID');
});

Deno.test('validateReclassify: rejects unknown vantage_point', () => {
  const result = validateReclassify({
    group_id: GROUP_ID,
    round_id: ROUND_ID,
    human_vantage_point: 'side_looking_back',
  });
  assert(!result.ok);
  assertEquals(result.error_code, 'RECLASSIFY_VANTAGE_POINT_INVALID');
});

Deno.test('validateReclassify: rejects out-of-range combined_score', () => {
  const result = validateReclassify({
    group_id: GROUP_ID,
    round_id: ROUND_ID,
    human_combined_score: 11,
  });
  assert(!result.ok);
  assertEquals(result.error_code, 'RECLASSIFY_SCORE_INVALID');
});

Deno.test('validateReclassify: rejects negative combined_score', () => {
  const result = validateReclassify({
    group_id: GROUP_ID,
    round_id: ROUND_ID,
    human_combined_score: -0.5,
  });
  assert(!result.ok);
  assertEquals(result.error_code, 'RECLASSIFY_SCORE_INVALID');
});

Deno.test('validateReclassify: rejects too-many slot_ids', () => {
  const result = validateReclassify({
    group_id: GROUP_ID,
    round_id: ROUND_ID,
    human_eligible_slot_ids: Array.from({ length: 11 }, (_, i) => `slot_${i}`),
  });
  assert(!result.ok);
  assertEquals(result.error_code, 'RECLASSIFY_SLOT_IDS_INVALID');
});

Deno.test('validateReclassify: rejects malformed slot_id (whitespace, caps mid-string)', () => {
  const result = validateReclassify({
    group_id: GROUP_ID,
    round_id: ROUND_ID,
    // After lowercase + trim, "EXTERIOR FACADE HERO" still contains spaces
    // → fails the snake_case regex.
    human_eligible_slot_ids: ['EXTERIOR FACADE HERO'],
  });
  assert(!result.ok);
  assertEquals(result.error_code, 'RECLASSIFY_SLOT_IDS_INVALID');
});

Deno.test('validateReclassify: rejects override_reason over 2000 chars', () => {
  const result = validateReclassify({
    group_id: GROUP_ID,
    round_id: ROUND_ID,
    human_room_type: 'kitchen_main',
    override_reason: 'x'.repeat(2001),
  });
  assert(!result.ok);
  assertEquals(result.error_code, 'RECLASSIFY_REASON_TOO_LONG');
});

Deno.test('validateReclassify: empty-after-trim reason collapses to null', () => {
  const result = validateReclassify({
    group_id: GROUP_ID,
    round_id: ROUND_ID,
    human_room_type: 'kitchen_main',
    override_reason: '    ',
  });
  assert(result.ok);
  assertEquals(result.override_reason, null);
});

// ─── Idempotency-friendly normalisation ──────────────────────────────────────

Deno.test('validateReclassify: empty slot_ids array does not flag eligible_slot_ids change', () => {
  // Operator opens the multi-select, deselects everything, saves. We treat
  // this as "no slot eligibility change" rather than "explicitly clear" —
  // the latter would route the group to nothing, which is destructive.
  const result = validateReclassify({
    group_id: GROUP_ID,
    round_id: ROUND_ID,
    human_eligible_slot_ids: [],
    human_room_type: 'kitchen_main', // need at least one other change
  });
  assert(result.ok);
  assertEquals(result.human_eligible_slot_ids, null);
  assertEquals(result.changed_fields, ['room_type']);
});

Deno.test('validateReclassify: trims whitespace on string fields', () => {
  const result = validateReclassify({
    group_id: GROUP_ID,
    round_id: ROUND_ID,
    human_room_type: '  master_bedroom  ',
    ai_room_type: '  bedroom_secondary  ',
  });
  assert(result.ok);
  assertEquals(result.human_room_type, 'master_bedroom');
  assertEquals(result.ai_room_type, 'bedroom_secondary');
});

// ─── Canonical-set sanity checks (drift guard) ───────────────────────────────

Deno.test('validateReclassify: canonical room_types includes critical Shape D values', () => {
  // Spot-check the values most likely to be reclassified per the W11.5 spec
  // (the Saladine IMG_6195 case + open-plan/secondary-living disambiguation).
  for (const v of [
    'exterior_front', 'exterior_rear', 'living_secondary', 'interior_open_plan',
    'master_bedroom', 'kitchen_main', 'alfresco',
  ]) {
    assert(CANONICAL_ROOM_TYPES.has(v), `expected ${v} in CANONICAL_ROOM_TYPES`);
  }
});

Deno.test('validateReclassify: canonical composition_types match Stage 1 prompt taxonomy', () => {
  for (const v of [
    'hero_wide', 'corner_two_point', 'detail_closeup', 'corridor_leading',
  ]) {
    assert(CANONICAL_COMPOSITION_TYPES.has(v), `expected ${v} in CANONICAL_COMPOSITION_TYPES`);
  }
});

Deno.test('validateReclassify: canonical vantage_points are exactly the 3 expected', () => {
  assertEquals(CANONICAL_VANTAGE_POINTS.size, 3);
  for (const v of ['interior_looking_out', 'exterior_looking_in', 'neutral']) {
    assert(CANONICAL_VANTAGE_POINTS.has(v));
  }
});
