/**
 * W11.6.16 — persist iter-5 enrichments unit tests.
 *
 * Run: deno test --no-check --allow-all \
 *   supabase/functions/shortlisting-shape-d/persistIter5.test.ts
 *
 * Covers the 17 iter-5 enrichment fields plumbed in W11.6.16 part A:
 *  - all 17 fields land in the upserted row when Gemini emits them
 *  - listing_copy.{headline,paragraphs} is correctly flattened to two flat
 *    columns
 *  - missing fields degrade to safe defaults (null / [] / null bool) — never
 *    throw, partial Stage 1 emissions still surface to the swimlane
 *  - confidence_per_field is stored as-is (JSONB)
 *  - boolNullable preserves explicit false (vs the legacy bool() that forced
 *    null/undefined to false)
 *
 * The test mocks the Supabase admin client so we can capture the exact upsert
 * row payload and assert on its shape — same fake-store pattern used by
 * persistProposedSlots.test.ts.
 */

import {
  assertEquals,
  assertStrictEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { persistOneClassification } from './index.ts';

interface Captured {
  table: string | null;
  row: Record<string, unknown> | null;
  conflict: string | null;
}

function makeFakeAdmin(captured: Captured) {
  return {
    from(table: string) {
      captured.table = table;
      return {
        upsert(row: Record<string, unknown>, opts?: { onConflict?: string }) {
          captured.row = row;
          captured.conflict = opts?.onConflict ?? null;
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

const ROUND_ID = '11111111-1111-1111-1111-111111111111';
const PROJECT_ID = '22222222-2222-2222-2222-222222222222';
const GROUP_ID = '33333333-3333-3333-3333-333333333333';

function baseGeminiOutput(): Record<string, unknown> {
  return {
    analysis: 'A 250-word analysis of the kitchen.',
    room_type: 'kitchen_main',
    room_type_confidence: 0.9,
    composition_type: 'wide_establishing',
    vantage_point: 'interior_looking_out',
    time_of_day: 'midday',
    is_drone: false,
    is_exterior: false,
    is_detail_shot: false,
    zones_visible: ['kitchen', 'dining'],
    key_elements: [
      'shaker-style cabinetry',
      'gooseneck mixer tap',
      'Caesarstone benchtop',
      'engineered oak flooring',
      'pendant lighting cluster',
      'under-cabinet LED strip',
      'farmhouse double basin',
      'integrated dishwasher panel',
    ],
    is_styled: true,
    indoor_outdoor_visible: true,
    clutter_severity: 'none',
    clutter_detail: '',
    flag_for_retouching: false,
    technical_score: 8.5,
    lighting_score: 9.0,
    composition_score: 8.0,
    aesthetic_score: 7.5,
  };
}

function baseCompositionRow() {
  return {
    group_id: GROUP_ID,
    best_bracket_stem: 'IMG_1010',
    delivery_reference_stem: 'IMG_1010',
    exif_metadata: {},
  };
}

function baseResult() {
  return {
    group_id: GROUP_ID,
    stem: 'IMG_1010',
    output: baseGeminiOutput(),
    error: null,
    cost_usd: 0.001,
    wall_ms: 200,
    input_tokens: 100,
    output_tokens: 300,
    vendor_used: 'google' as const,
    model_used: 'gemini-2.5-pro',
    failover_triggered: false,
    failover_reason: null,
  };
}

Deno.test('iter-5 persistence: all 17 enrichment fields land when Gemini emits them', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  const out = baseGeminiOutput();
  // Iter-5 enrichments — full set
  Object.assign(out, {
    style_archetype: 'contemporary project home',
    era_hint: '2018-2022 build',
    material_palette_summary: ['Caesarstone', 'engineered oak', 'matte black tapware'],
    embedding_anchor_text: 'Kitchen wide establishing, contemporary project home, Caesarstone island, north light, midday',
    searchable_keywords: ['caesarstone', 'shaker-cabinetry', 'north-facing', 'open-plan'],
    shot_intent: 'hero_establishing',
    appeal_signals: ['natural_light', 'open_plan_flow', 'oversized_kitchen_island'],
    concern_signals: [],
    buyer_persona_hints: ['young_family_upgrader', 'working_professional_couple'],
    retouch_priority: 'recommended',
    retouch_estimate_minutes: 8,
    gallery_position_hint: 'lead_image',
    social_first_friendly: true,
    requires_human_review: false,
    confidence_per_field: {
      room_type: 0.95,
      scoring: 0.85,
      classification: 0.9,
    },
    listing_copy: {
      headline: 'Caesarstone island anchors a north-light kitchen',
      paragraphs: 'The kitchen presents an oversized Caesarstone island...\n\nMatte black tapware...',
    },
  });
  const result = { ...baseResult(), output: out };

  await persistOneClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    roundId: ROUND_ID,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: result as any,
    promptBlockVersions: { stage1: 'v1.0' },
    modelVersion: 'gemini-2.5-pro',
    // deno-lint-ignore no-explicit-any
    composition: baseCompositionRow() as any,
    tierConfig: null,
    sourceType: 'internal_raw',
    warnings: [],
  });

  assertStrictEquals(captured.table, 'composition_classifications');
  assertStrictEquals(captured.conflict, 'group_id');
  const row = captured.row!;

  // 17 iter-5 fields — all present
  assertStrictEquals(row.style_archetype, 'contemporary project home');
  assertStrictEquals(row.era_hint, '2018-2022 build');
  assertEquals(row.material_palette_summary, ['Caesarstone', 'engineered oak', 'matte black tapware']);
  assertStrictEquals(
    row.embedding_anchor_text,
    'Kitchen wide establishing, contemporary project home, Caesarstone island, north light, midday',
  );
  assertEquals(row.searchable_keywords, ['caesarstone', 'shaker-cabinetry', 'north-facing', 'open-plan']);
  assertStrictEquals(row.shot_intent, 'hero_establishing');
  assertEquals(row.appeal_signals, ['natural_light', 'open_plan_flow', 'oversized_kitchen_island']);
  assertEquals(row.concern_signals, []);
  assertEquals(row.buyer_persona_hints, ['young_family_upgrader', 'working_professional_couple']);
  assertStrictEquals(row.retouch_priority, 'recommended');
  assertStrictEquals(row.retouch_estimate_minutes, 8);
  assertStrictEquals(row.gallery_position_hint, 'lead_image');
  assertStrictEquals(row.social_first_friendly, true);
  assertStrictEquals(row.requires_human_review, false);
  assertEquals(row.confidence_per_field, {
    room_type: 0.95,
    scoring: 0.85,
    classification: 0.9,
  });
  // Flattened listing_copy
  assertStrictEquals(row.listing_copy_headline, 'Caesarstone island anchors a north-light kitchen');
  assertStrictEquals(
    row.listing_copy_paragraphs,
    'The kitchen presents an oversized Caesarstone island...\n\nMatte black tapware...',
  );
});

Deno.test('iter-5 persistence: missing fields degrade to safe defaults (null/[] not thrown)', async () => {
  // Bare-minimum Gemini output — only the 20 base fields, no iter-5 enrichments.
  // The persist layer must NOT throw; iter-5 columns must land as null/[].
  const captured: Captured = { table: null, row: null, conflict: null };
  const result = baseResult();

  await persistOneClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    roundId: ROUND_ID,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: result as any,
    promptBlockVersions: { stage1: 'v1.0' },
    modelVersion: 'gemini-2.5-pro',
    // deno-lint-ignore no-explicit-any
    composition: baseCompositionRow() as any,
    tierConfig: null,
    sourceType: 'internal_raw',
    warnings: [],
  });

  const row = captured.row!;
  assertStrictEquals(row.style_archetype, null);
  assertStrictEquals(row.era_hint, null);
  assertEquals(row.material_palette_summary, []);
  assertStrictEquals(row.embedding_anchor_text, null);
  assertEquals(row.searchable_keywords, []);
  assertStrictEquals(row.shot_intent, null);
  assertEquals(row.appeal_signals, []);
  assertEquals(row.concern_signals, []);
  assertEquals(row.buyer_persona_hints, []);
  assertStrictEquals(row.retouch_priority, null);
  assertStrictEquals(row.retouch_estimate_minutes, null);
  assertStrictEquals(row.gallery_position_hint, null);
  assertStrictEquals(row.social_first_friendly, null);
  assertStrictEquals(row.requires_human_review, null);
  assertStrictEquals(row.confidence_per_field, null);
  assertStrictEquals(row.listing_copy_headline, null);
  assertStrictEquals(row.listing_copy_paragraphs, null);
});

Deno.test('iter-5 persistence: listing_copy flattening — nested object split into two flat columns', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  const out = baseGeminiOutput();
  out.listing_copy = {
    headline: 'A bright living room with a north-facing aspect',
    paragraphs: 'First paragraph...\nSecond paragraph...',
  };
  const result = { ...baseResult(), output: out };

  await persistOneClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    roundId: ROUND_ID,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: result as any,
    promptBlockVersions: { stage1: 'v1.0' },
    modelVersion: 'gemini-2.5-pro',
    // deno-lint-ignore no-explicit-any
    composition: baseCompositionRow() as any,
    tierConfig: null,
    sourceType: 'internal_raw',
    warnings: [],
  });

  const row = captured.row!;
  assertStrictEquals(row.listing_copy_headline, 'A bright living room with a north-facing aspect');
  assertStrictEquals(row.listing_copy_paragraphs, 'First paragraph...\nSecond paragraph...');
  // Make sure the nested key isn't blindly written as a column.
  assertStrictEquals('listing_copy' in row, false);
});

Deno.test('iter-5 persistence: listing_copy fallback — top-level flat fields used when nested object missing', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  const out = baseGeminiOutput();
  // Future model version may emit flat fields directly — defensive fallback.
  // deno-lint-ignore no-explicit-any
  (out as any).listing_copy_headline = 'Fallback flat headline';
  // deno-lint-ignore no-explicit-any
  (out as any).listing_copy_paragraphs = 'Fallback flat paragraphs';
  const result = { ...baseResult(), output: out };

  await persistOneClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    roundId: ROUND_ID,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: result as any,
    promptBlockVersions: { stage1: 'v1.0' },
    modelVersion: 'gemini-2.5-pro',
    // deno-lint-ignore no-explicit-any
    composition: baseCompositionRow() as any,
    tierConfig: null,
    sourceType: 'internal_raw',
    warnings: [],
  });

  const row = captured.row!;
  assertStrictEquals(row.listing_copy_headline, 'Fallback flat headline');
  assertStrictEquals(row.listing_copy_paragraphs, 'Fallback flat paragraphs');
});

Deno.test('iter-5 persistence: requires_human_review preserves explicit false (vs forced false)', async () => {
  // boolNullable() must distinguish "model said false" from "model omitted".
  // Both should NOT collapse to the same persistence — explicit false stays
  // false, omitted stays null.
  const captured1: Captured = { table: null, row: null, conflict: null };
  const out1 = baseGeminiOutput();
  out1.requires_human_review = false;
  out1.social_first_friendly = false;
  await persistOneClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured1) as any,
    roundId: ROUND_ID,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: { ...baseResult(), output: out1 } as any,
    promptBlockVersions: { stage1: 'v1.0' },
    modelVersion: 'gemini-2.5-pro',
    // deno-lint-ignore no-explicit-any
    composition: baseCompositionRow() as any,
    tierConfig: null,
    sourceType: 'internal_raw',
    warnings: [],
  });
  assertStrictEquals(captured1.row!.requires_human_review, false);
  assertStrictEquals(captured1.row!.social_first_friendly, false);

  const captured2: Captured = { table: null, row: null, conflict: null };
  const out2 = baseGeminiOutput();
  // explicitly omit — null on persist, NOT false
  await persistOneClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured2) as any,
    roundId: ROUND_ID,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: { ...baseResult(), output: out2 } as any,
    promptBlockVersions: { stage1: 'v1.0' },
    modelVersion: 'gemini-2.5-pro',
    // deno-lint-ignore no-explicit-any
    composition: baseCompositionRow() as any,
    tierConfig: null,
    sourceType: 'internal_raw',
    warnings: [],
  });
  assertStrictEquals(captured2.row!.requires_human_review, null);
  assertStrictEquals(captured2.row!.social_first_friendly, null);
});

Deno.test('iter-5 persistence: confidence_per_field stored as-is when object emitted', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  const out = baseGeminiOutput();
  out.confidence_per_field = {
    room_type: 0.6,
    scoring: 0.4,
    classification: 0.7,
  };
  const result = { ...baseResult(), output: out };

  await persistOneClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    roundId: ROUND_ID,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: result as any,
    promptBlockVersions: { stage1: 'v1.0' },
    modelVersion: 'gemini-2.5-pro',
    // deno-lint-ignore no-explicit-any
    composition: baseCompositionRow() as any,
    tierConfig: null,
    sourceType: 'internal_raw',
    warnings: [],
  });

  assertEquals(captured.row!.confidence_per_field, {
    room_type: 0.6,
    scoring: 0.4,
    classification: 0.7,
  });
});

Deno.test('iter-5 persistence: retouch_estimate_minutes coerced to integer (truncates floats)', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  const out = baseGeminiOutput();
  // Stage 1 schema says INTEGER but Gemini occasionally emits 8.5 etc.
  // The int() coercer truncates so the persist doesn't fail Postgres TYPE.
  // deno-lint-ignore no-explicit-any
  (out as any).retouch_estimate_minutes = 12.7;
  const result = { ...baseResult(), output: out };

  await persistOneClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    roundId: ROUND_ID,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: result as any,
    promptBlockVersions: { stage1: 'v1.0' },
    modelVersion: 'gemini-2.5-pro',
    // deno-lint-ignore no-explicit-any
    composition: baseCompositionRow() as any,
    tierConfig: null,
    sourceType: 'internal_raw',
    warnings: [],
  });

  assertStrictEquals(captured.row!.retouch_estimate_minutes, 12);
});
