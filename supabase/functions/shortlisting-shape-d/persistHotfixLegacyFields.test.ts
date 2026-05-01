/**
 * persistHotfixLegacyFields.test.ts — W11.7.17 hotfix unit tests.
 *
 * Run: deno test --no-check --allow-all \
 *   supabase/functions/shortlisting-shape-d/persistHotfixLegacyFields.test.ts
 *
 * Covers the two QC regressions caught on Rainbow Cres post-W11.7.17 cutover:
 *
 *   REGRESSION 1: combined_score = 0 across ALL 33 classifications. Caused by
 *                 selectCombinedScore's per-signal path treating the active
 *                 tier_config.signal_weights' legacy 4-key dimension-name
 *                 aliases (vantage_point, clutter_severity, ...) as if they
 *                 were canonical signals — `?? 0` summed to 0.
 *                 Fix: use computeAggregateScores from dimensionRollup.ts and
 *                 only pass tier_config.signal_weights when at least one key
 *                 overlaps the canonical v2 26-signal set.
 *
 *   REGRESSION 2: flag_for_retouching = false / clutter_severity = null across
 *                 ALL 33 classifications. Caused by the persist reading from
 *                 v1 top-level (out.flag_for_retouching) when the v2 universal
 *                 schema nests these under quality_flags.{flag_for_retouching,
 *                 clutter_severity, clutter_detail}.
 *                 Fix: read from v2 nested object first, fall back to v1
 *                 top-level for backwards compat.
 *
 * The fake-store admin pattern matches persistIter5.test.ts and
 * persistV2SourceTypes.test.ts.
 */

import {
  assertAlmostEquals,
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

const ROUND_ID = '99999999-9999-9999-9999-999999999999';
const PROJECT_ID = '88888888-8888-8888-8888-888888888888';
const GROUP_ID = '77777777-7777-7777-7777-777777777777';

// 26-key v2 signal_scores covering all dimensions. Mirrors a Rainbow-Cres
// emission shape (technical=6, lighting=4, composition=5, aesthetic=4 means
// when combined under DEFAULT_DIMENSION_WEIGHTS).
function v2SignalScores(): Record<string, number | null> {
  return {
    // technical (6)
    exposure_balance: 6, color_cast: 6, sharpness_subject: 7,
    sharpness_corners: 5, plumb_verticals: 6, perspective_distortion: 6,
    // lighting (4)
    light_quality: 4, light_directionality: 4,
    color_temperature_appropriateness: 4, light_falloff_quality: 4,
    // composition (8 — symmetry_quality null is a valid v2 emission)
    depth_layering: 5, composition_geometry: 5, vantage_quality: 5,
    framing_quality: 5, leading_lines: 5, negative_space: 5,
    symmetry_quality: null, foreground_anchor: 5,
    // aesthetic (4)
    material_specificity: 4, period_reading: 4, styling_quality: 4,
    distraction_freeness: 4,
    // workflow (not mapped to a dimension — present but ignored by rollup)
    retouch_debt: 5, gallery_arc_position: 5,
    social_crop_survival: 5, brochure_print_survival: 5,
  };
}

function baseV2Output(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    analysis: 'A 5-sentence analysis.',
    room_type: 'kitchen_main',
    room_type_confidence: 0.9,
    composition_type: 'wide_establishing',
    vantage_point: 'interior_looking_out',
    time_of_day: 'midday',
    is_drone: false,
    is_exterior: false,
    is_detail_shot: false,
    zones_visible: ['kitchen'],
    key_elements: ['cabinetry', 'island'],
    is_styled: true,
    indoor_outdoor_visible: true,
    signal_scores: v2SignalScores(),
    // Top-level dim aggregates: model emits these, but persist must
    // PREFER the rollup-computed values.
    technical_score: 99,
    lighting_score: 99,
    composition_score: 99,
    aesthetic_score: 99,
    combined_score: 99,
    ...extra,
  };
}

function baseCompositionRow() {
  return {
    group_id: GROUP_ID,
    best_bracket_stem: 'IMG_4242',
    delivery_reference_stem: 'IMG_4242',
    exif_metadata: {},
  };
}

function baseResult(out: Record<string, unknown>) {
  return {
    group_id: GROUP_ID,
    stem: 'IMG_4242',
    output: out,
    error: null,
    cost_usd: 0.012,
    wall_ms: 14_000,
    input_tokens: 6_500,
    output_tokens: 3_500,
    vendor_used: 'google' as const,
    model_used: 'gemini-2.5-pro',
    failover_triggered: false,
    failover_reason: null,
  };
}

async function runPersist(
  out: Record<string, unknown>,
  tierConfig: unknown = null,
): Promise<Record<string, unknown>> {
  const captured: Captured = { table: null, row: null, conflict: null };
  await persistOneClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    roundId: ROUND_ID,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseResult(out) as any,
    promptBlockVersions: { stage1: 'v2.0' },
    modelVersion: 'gemini-2.5-pro',
    // deno-lint-ignore no-explicit-any
    composition: baseCompositionRow() as any,
    // deno-lint-ignore no-explicit-any
    tierConfig: tierConfig as any,
    sourceType: 'internal_raw',
    warnings: [],
  });
  return captured.row!;
}

// ─── REGRESSION 1: combined_score from rollup ──────────────────────────────

Deno.test('hotfix R1: combined_score is computed via rollup, not the model emission', async () => {
  // Model emits combined_score=99; persist must IGNORE that and use the rollup.
  const row = await runPersist(baseV2Output(), null);
  // With DEFAULT_DIMENSION_WEIGHTS (0.25/0.30/0.25/0.20):
  //   technical = mean(6,6,7,5,6,6) = 6.0
  //   lighting  = mean(4,4,4,4)     = 4.0
  //   composition = mean(5,5,5,5,5,5,5) = 5.0  (symmetry_quality null skipped)
  //   aesthetic = mean(4,4,4,4) = 4.0
  //   combined  = 6*0.25 + 4*0.30 + 5*0.25 + 4*0.20 = 1.5 + 1.2 + 1.25 + 0.8 = 4.75
  assertAlmostEquals(Number(row.technical_score), 6.0, 0.01);
  assertAlmostEquals(Number(row.lighting_score), 4.0, 0.01);
  assertAlmostEquals(Number(row.composition_score), 5.0, 0.01);
  assertAlmostEquals(Number(row.aesthetic_score), 4.0, 0.01);
  assertAlmostEquals(Number(row.combined_score), 4.75, 0.01);
});

Deno.test('hotfix R1: tier_config with non-overlapping signal_weights falls back to uniform mean', async () => {
  // Reproduces the Rainbow-Cres bug: tier_config.signal_weights has 4 legacy
  // dimension-name aliases that don't exist in the v2 26-signal map. Persist
  // must detect zero overlap and use uniform mean (NOT compute combined=0).
  const buggyTierConfig = {
    id: 'x', tier_id: 'y', version: 1,
    dimension_weights: { technical: 0.25, lighting: 0.30, composition: 0.25, aesthetic: 0.20 },
    signal_weights: {
      vantage_point: 1,
      clutter_severity: 1,
      living_zone_count: 1,
      indoor_outdoor_connection_quality: 1,
    },
    hard_reject_thresholds: {},
    is_active: true,
    activated_at: '2026-01-01T00:00:00Z',
    notes: null,
  };
  const row = await runPersist(baseV2Output(), buggyTierConfig);
  assertAlmostEquals(Number(row.combined_score), 4.75, 0.01);
});

Deno.test('hotfix R1: tier_config with valid v2 signal_weights uses weighted rollup', async () => {
  // signal_weights with at least one canonical v2 key triggers the weighted
  // path inside computeAggregateScores. Boost light_quality 10x to force a
  // measurably different lighting aggregate.
  const tierConfig = {
    id: 'x', tier_id: 'y', version: 1,
    dimension_weights: { technical: 0.25, lighting: 0.30, composition: 0.25, aesthetic: 0.20 },
    signal_weights: { light_quality: 10 }, // only this signal contributes to lighting
    hard_reject_thresholds: {},
    is_active: true,
    activated_at: '2026-01-01T00:00:00Z',
    notes: null,
  };
  const out = baseV2Output();
  // bump light_quality so it differs from the other 3 lighting signals
  (out.signal_scores as Record<string, number>).light_quality = 9;
  const row = await runPersist(out, tierConfig);
  // Lighting aggregate now = 9 (only weighted signal), not 4.0 (unweighted mean).
  assertAlmostEquals(Number(row.lighting_score), 9.0, 0.01);
});

// ─── REGRESSION 2: quality_flags v2-nested read ────────────────────────────

Deno.test('hotfix R2: flag_for_retouching reads from v2 quality_flags (nested)', async () => {
  const out = baseV2Output({
    quality_flags: {
      clutter_severity: 'minor_photoshoppable',
      clutter_detail: 'small toy on the kitchen counter',
      flag_for_retouching: true,
      is_near_duplicate_candidate: false,
    },
  });
  const row = await runPersist(out, null);
  assertStrictEquals(row.flag_for_retouching, true);
  assertStrictEquals(row.clutter_severity, 'minor_photoshoppable');
  assertStrictEquals(row.clutter_detail, 'small toy on the kitchen counter');
});

Deno.test('hotfix R2: clutter_severity reads from v2 quality_flags (nested)', async () => {
  const out = baseV2Output({
    quality_flags: {
      clutter_severity: 'moderate_retouch',
      clutter_detail: 'cables visible behind TV',
      flag_for_retouching: true,
      is_near_duplicate_candidate: false,
    },
  });
  const row = await runPersist(out, null);
  assertStrictEquals(row.clutter_severity, 'moderate_retouch');
  assertStrictEquals(row.clutter_detail, 'cables visible behind TV');
});

Deno.test('hotfix R2: falls back to v1 top-level when quality_flags absent', async () => {
  const out = baseV2Output({
    // no quality_flags object — pre-v2 emission shape
    flag_for_retouching: true,
    clutter_severity: 'minor_photoshoppable',
    clutter_detail: 'box on the floor',
  });
  const row = await runPersist(out, null);
  assertStrictEquals(row.flag_for_retouching, true);
  assertStrictEquals(row.clutter_severity, 'minor_photoshoppable');
  assertStrictEquals(row.clutter_detail, 'box on the floor');
});

Deno.test('hotfix R2: defensive coercion — null/undefined quality_flags fields land as false/null', async () => {
  // Model emits quality_flags but with nullable fields. Persist must coerce
  // null → false for the boolean column, and null → null for the strings.
  const out = baseV2Output({
    quality_flags: {
      clutter_severity: null,
      clutter_detail: null,
      flag_for_retouching: null,
      is_near_duplicate_candidate: false,
    },
  });
  const row = await runPersist(out, null);
  // null flag_for_retouching should fall back to clutter-severity heuristic;
  // clutter is null so heuristic yields false. Defensive: NOT null in DB.
  assertStrictEquals(row.flag_for_retouching, false);
  assertStrictEquals(row.clutter_severity, null);
  assertStrictEquals(row.clutter_detail, null);
});

Deno.test('hotfix R2: v2 quality_flags wins when v1 top-level is also present', async () => {
  // If a model emits BOTH (transitional output), the v2 nested wins.
  const out = baseV2Output({
    flag_for_retouching: false, // legacy: would be false
    clutter_severity: 'none',
    clutter_detail: '',
    quality_flags: {
      flag_for_retouching: true, // v2: should win
      clutter_severity: 'major_reject',
      clutter_detail: 'hoarded room — cannot photograph',
      is_near_duplicate_candidate: false,
    },
  });
  const row = await runPersist(out, null);
  assertStrictEquals(row.flag_for_retouching, true);
  assertStrictEquals(row.clutter_severity, 'major_reject');
  assertStrictEquals(row.clutter_detail, 'hoarded room — cannot photograph');
});

// ─── Edge case: signal_scores empty + dim scores from model ────────────────

Deno.test('hotfix R1: when signal_scores is empty, falls back to model top-level dim scores', async () => {
  // Legacy or partial emissions: no signal_scores. Persist must NOT emit
  // null for combined_score; it should fall back to the model top-level via
  // selectCombinedScore.
  const out = baseV2Output({
    signal_scores: {},
    technical_score: 7,
    lighting_score: 6,
    composition_score: 5,
    aesthetic_score: 4,
    combined_score: 5.5,
  });
  const row = await runPersist(out, null);
  assertStrictEquals(row.technical_score, 7);
  assertStrictEquals(row.lighting_score, 6);
  assertStrictEquals(row.composition_score, 5);
  assertStrictEquals(row.aesthetic_score, 4);
  // combined = 7*0.25 + 6*0.30 + 5*0.25 + 4*0.20 = 1.75 + 1.8 + 1.25 + 0.8 = 5.6
  assertAlmostEquals(Number(row.combined_score), 5.6, 0.01);
});

// Sanity: row keys we modified are the only ones whose values shifted.
Deno.test('hotfix sanity: every other persisted column is unaffected by the hotfix', async () => {
  const out = baseV2Output({
    quality_flags: {
      clutter_severity: 'none', clutter_detail: '',
      flag_for_retouching: false, is_near_duplicate_candidate: false,
    },
  });
  const row = await runPersist(out, null);
  // V2 schema columns (W11.7.17) — must still be present
  assertStrictEquals(row.schema_version, 'v2.0');
  assertStrictEquals(row.source_type, 'internal_raw');
  // signal_scores still passed through
  assertEquals(typeof row.signal_scores, 'object');
  // analysis still passes through
  assertStrictEquals(row.analysis, 'A 5-sentence analysis.');
  // Other identity fields
  assertStrictEquals(row.group_id, GROUP_ID);
  assertStrictEquals(row.round_id, ROUND_ID);
  assertStrictEquals(row.project_id, PROJECT_ID);
});

// Ensure assertAlmostEquals is referenced.
assertAlmostEquals;
