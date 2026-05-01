/**
 * persistFinalsClassification.test.ts — Wave 15a unit tests.
 *
 * Run: deno test --no-check --allow-all \
 *   supabase/functions/shortlisting-finals-qa/persistFinalsClassification.test.ts
 *
 * Coverage (per W15a spec Part F):
 *   1. finals source_type forces flag_for_retouching interpretation
 *   2. retouch_priority semantics on finals (urgent / recommended / none)
 *   3. finals_specific block always populated when source_type='internal_finals'
 *   4. raw_specific is null on finals (and external/floorplan blocks too)
 *   5. signal_scores.exposure_balance is scored on finals (NOT null like RAW)
 *   6. quality_flags v2-nested read works for finals emissions
 *   7. graceful: malformed finals_specific lands as null, not crashes
 */

import {
  assertEquals,
  assertStrictEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { persistFinalsClassification } from './index.ts';

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

const PROJECT_ID = 'aaaaaaaa-1111-1111-1111-111111111111';
const GROUP_ID = 'bbbbbbbb-2222-2222-2222-222222222222';

function baseFinalsResult(out: Record<string, unknown>) {
  return {
    group_id: GROUP_ID,
    finals_path: '/Flex Media Team Folder/Projects/test/Photos/Finals/IMG_1234.jpg',
    filename: 'IMG_1234.jpg',
    output: out,
    error: null,
    cost_usd: 0.014,
    wall_ms: 18_000,
    input_tokens: 6_500,
    output_tokens: 4_000,
    vendor_used: 'google' as const,
    model_used: 'gemini-2.5-pro',
    failover_triggered: false,
    failover_reason: null,
  };
}

// ─── Mock v2 finals emission ────────────────────────────────────────────────

const FINALS_OUTPUT_GOOD = {
  schema_version: '2.0',
  source: { type: 'internal_finals', media_kind: 'still_image' },
  analysis: 'Five sentences describing a finalised kitchen delivery.',
  image_type: 'is_day',
  image_classification: {
    is_relevant_property_content: true, subject: 'interior',
    is_dusk: false, is_day: true, is_golden_hour: false, is_night: false,
    time_of_day_confidence: 0.95, is_drone: false, drone_type: null,
    is_video_frame: false, quarantine_reason: null,
  },
  room_type: 'kitchen_main',
  composition_type: 'wide_establishing',
  vantage_point: 'interior_looking_out',
  is_styled: true,
  indoor_outdoor_visible: true,
  zones_visible: ['kitchen'],
  key_elements: ['Caesarstone island'],
  signal_scores: {
    exposure_balance: 9, color_cast: 9, sharpness_subject: 9,
    sharpness_corners: 8, plumb_verticals: 9, perspective_distortion: 9,
    light_quality: 9, light_directionality: 8,
    color_temperature_appropriateness: 9, light_falloff_quality: 9,
    depth_layering: 9, composition_geometry: 8, vantage_quality: 9,
    framing_quality: 9, leading_lines: 7, negative_space: 8,
    symmetry_quality: 6, foreground_anchor: 7,
    material_specificity: 9, period_reading: 8, styling_quality: 9,
    distraction_freeness: 9,
    retouch_debt: 10, gallery_arc_position: 9, social_crop_survival: 9,
    brochure_print_survival: 9,
  },
  quality_flags: {
    clutter_severity: 'none', clutter_detail: '',
    flag_for_retouching: false, is_near_duplicate_candidate: false,
  },
  retouch_priority: 'none',
  retouch_estimate_minutes: 0,
  gallery_position_hint: 'lead_image',
  social_first_friendly: true,
  requires_human_review: false,
  finals_specific: {
    looks_post_processed: true,
    vertical_lines_corrected: true,
    color_grade_consistent_with_set: true,
    sky_replaced: false,
    sky_replacement_halo_severity: null,
    digital_furniture_present: false,
    digital_furniture_artefact_severity: null,
    digital_dusk_applied: false,
    digital_dusk_oversaturation_severity: null,
    window_blowout_severity: 1,
    retouch_artefact_severity: 0,
  },
};

const FINALS_OUTPUT_BLOWN_OUT = {
  ...FINALS_OUTPUT_GOOD,
  analysis: 'Editor missed the window blowout — exterior trees clipped to white.',
  signal_scores: {
    ...FINALS_OUTPUT_GOOD.signal_scores,
    exposure_balance: 3, // hard fail on finals
  },
  quality_flags: {
    clutter_severity: 'minor_photoshoppable',
    clutter_detail: 'window blowout requires luminance mask',
    flag_for_retouching: true,
    is_near_duplicate_candidate: false,
  },
  retouch_priority: 'urgent',
  retouch_estimate_minutes: 8,
  finals_specific: {
    ...FINALS_OUTPUT_GOOD.finals_specific,
    window_blowout_severity: 8,
    retouch_artefact_severity: 0,
  },
};

const FINALS_OUTPUT_SKY_HALO = {
  ...FINALS_OUTPUT_GOOD,
  analysis: 'Sky replacement halo around roofline — recommended secondary pass.',
  retouch_priority: 'recommended',
  retouch_estimate_minutes: 4,
  quality_flags: {
    clutter_severity: 'minor_photoshoppable',
    clutter_detail: 'sky halo around eaves',
    flag_for_retouching: true,
    is_near_duplicate_candidate: false,
  },
  finals_specific: {
    ...FINALS_OUTPUT_GOOD.finals_specific,
    sky_replaced: true,
    sky_replacement_halo_severity: 6,
    window_blowout_severity: 2,
    retouch_artefact_severity: 5,
  },
};

// ─── Test 1: finals source_type → flag_for_retouching honoured ─────────────

Deno.test('W15a — finals source_type tags row source_type=internal_finals + schema v2', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  await persistFinalsClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseFinalsResult(FINALS_OUTPUT_GOOD) as any,
    warnings: [],
  });

  const row = captured.row!;
  assertStrictEquals(captured.table, 'composition_classifications');
  assertStrictEquals(captured.conflict, 'group_id');
  assertStrictEquals(row.source_type, 'internal_finals');
  assertStrictEquals(row.schema_version, 'v2.0');
  assertStrictEquals(row.image_type, 'is_day');
  // round_id is null for finals (no upstream round).
  assertStrictEquals(row.round_id, null);
  // group_id mirrors the synthetic uuid passed in (W15a creates one per finals
  // image — there's no composition_groups row to link to).
  assertStrictEquals(row.group_id, GROUP_ID);
});

// ─── Test 2: flag_for_retouching honoured on blown-out finals ──────────────

Deno.test('W15a — finals source_type forces flag_for_retouching=true on missed blowout', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  await persistFinalsClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseFinalsResult(FINALS_OUTPUT_BLOWN_OUT) as any,
    warnings: [],
  });

  const row = captured.row!;
  assertStrictEquals(row.flag_for_retouching, true);
  assertStrictEquals(row.clutter_severity, 'minor_photoshoppable');
  // exposure_balance IS scored on finals (not null like RAW HDR brackets).
  const sig = row.signal_scores as Record<string, number | null>;
  assertStrictEquals(sig.exposure_balance, 3);
  // window_blowout_severity surfaced in finals_specific.
  const finals = row.finals_specific as Record<string, unknown>;
  assertStrictEquals(finals.window_blowout_severity, 8);
});

// ─── Test 3: retouch_priority semantics on finals ──────────────────────────

Deno.test('W15a — retouch_priority semantics: none on clean finals', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  await persistFinalsClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseFinalsResult(FINALS_OUTPUT_GOOD) as any,
    warnings: [],
  });

  assertStrictEquals(captured.row!.retouch_priority, 'none');
  assertStrictEquals(captured.row!.retouch_estimate_minutes, 0);
});

Deno.test('W15a — retouch_priority semantics: urgent on missed blowout', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  await persistFinalsClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseFinalsResult(FINALS_OUTPUT_BLOWN_OUT) as any,
    warnings: [],
  });

  assertStrictEquals(captured.row!.retouch_priority, 'urgent');
  assertStrictEquals(captured.row!.retouch_estimate_minutes, 8);
});

Deno.test('W15a — retouch_priority semantics: recommended on sky halo', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  await persistFinalsClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseFinalsResult(FINALS_OUTPUT_SKY_HALO) as any,
    warnings: [],
  });

  assertStrictEquals(captured.row!.retouch_priority, 'recommended');
  assertStrictEquals(captured.row!.retouch_estimate_minutes, 4);
  const finals = captured.row!.finals_specific as Record<string, unknown>;
  assertStrictEquals(finals.sky_replaced, true);
  assertStrictEquals(finals.sky_replacement_halo_severity, 6);
});

// ─── Test 4: finals_specific block always populated ────────────────────────

Deno.test('W15a — finals_specific populated; raw/external/floorplan_specific are null', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  await persistFinalsClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseFinalsResult(FINALS_OUTPUT_GOOD) as any,
    warnings: [],
  });

  const row = captured.row!;
  // The whole point of W15a: finals_specific carries the editor-QA payload.
  const finals = row.finals_specific as Record<string, unknown>;
  assertStrictEquals(typeof finals, 'object');
  assertStrictEquals(finals.looks_post_processed, true);
  assertStrictEquals(finals.vertical_lines_corrected, true);
  assertStrictEquals(finals.color_grade_consistent_with_set, true);
  assertStrictEquals(finals.window_blowout_severity, 1);
  // Other 3 *_specific blocks must be null on finals.
  assertStrictEquals(row.raw_specific, null);
  assertStrictEquals(row.external_specific, null);
  assertStrictEquals(row.floorplan_specific, null);
});

// ─── Test 5: signal_scores.exposure_balance scored on finals (vs null on RAW) ──

Deno.test('W15a — signal_scores.exposure_balance is scored (not null) on finals', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  await persistFinalsClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseFinalsResult(FINALS_OUTPUT_GOOD) as any,
    warnings: [],
  });

  const sig = captured.row!.signal_scores as Record<string, number | null>;
  assertStrictEquals(sig.exposure_balance, 9);
  // sharpness, plumb_verticals etc all scored too.
  assertStrictEquals(sig.sharpness_subject, 9);
  assertStrictEquals(sig.plumb_verticals, 9);
});

// ─── Test 6: graceful — malformed finals_specific → null ───────────────────

Deno.test('W15a — graceful: malformed finals_specific (string) lands as null', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  const out = { ...FINALS_OUTPUT_GOOD, finals_specific: 'not an object' };
  await persistFinalsClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseFinalsResult(out) as any,
    warnings: [],
  });
  // Wrong-shape finals_specific is coerced to null defensively.
  assertStrictEquals(captured.row!.finals_specific, null);
});

// ─── Test 7: graceful — array finals_specific → null ───────────────────────

Deno.test('W15a — graceful: array finals_specific lands as null', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  const out = { ...FINALS_OUTPUT_GOOD, finals_specific: [1, 2, 3] };
  await persistFinalsClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseFinalsResult(out) as any,
    warnings: [],
  });
  assertStrictEquals(captured.row!.finals_specific, null);
});

// ─── Test 8: model omits flag_for_retouching → falls back to clutter heuristic ──

Deno.test('W15a — model omits flag_for_retouching: clutter heuristic fills it in', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  const out = {
    ...FINALS_OUTPUT_GOOD,
    quality_flags: {
      clutter_severity: 'minor_photoshoppable', // editor missed, model says minor
      clutter_detail: 'small sky halo',
      // flag_for_retouching omitted by model (legitimate "model forgot" case)
      is_near_duplicate_candidate: false,
    },
  };
  await persistFinalsClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseFinalsResult(out) as any,
    warnings: [],
  });

  // clutter='minor_photoshoppable' implies flag_for_retouching=true via heuristic.
  assertStrictEquals(captured.row!.flag_for_retouching, true);
});

// ─── Test 9b: persisted model_version reflects vendor failover ────────────

Deno.test('W15a — persisted model_version reflects actual vendor used (Anthropic on failover)', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  const result = {
    ...baseFinalsResult(FINALS_OUTPUT_GOOD),
    vendor_used: 'anthropic' as const,
    model_used: 'claude-opus-4-7',
    failover_triggered: true,
    failover_reason: 'gemini_schema_400',
  };
  await persistFinalsClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: result as any,
    warnings: [],
  });

  // The persisted model_version threads through from the per-image result —
  // critical for replay/debug when failover took over for an image.
  assertStrictEquals(captured.row!.model_version, 'claude-opus-4-7');
  // source_type stays internal_finals regardless of which vendor served the
  // emission (caller-controlled, not vendor-derived).
  assertStrictEquals(captured.row!.source_type, 'internal_finals');
});

// ─── Test 9: signal_scores normalisation graceful on missing keys ─────────

Deno.test('W15a — signal_scores normalisation: aggregate axis scores computed', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  await persistFinalsClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseFinalsResult(FINALS_OUTPUT_GOOD) as any,
    warnings: [],
  });

  const row = captured.row!;
  // technical_score / lighting_score / composition_score / aesthetic_score
  // should all be numeric (computed from signal_scores via dimensionRollup).
  assertEquals(typeof row.technical_score, 'number');
  assertEquals(typeof row.lighting_score, 'number');
  assertEquals(typeof row.composition_score, 'number');
  assertEquals(typeof row.aesthetic_score, 'number');
});
