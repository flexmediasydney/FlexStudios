/**
 * persistImageClassificationV2.test.ts — W11.7.17 QC-iter2-W2 P0 (F-D-002).
 *
 * Run: SUPABASE_URL=test SUPABASE_SERVICE_ROLE_KEY=test deno test \
 *   --no-check --allow-all \
 *   supabase/functions/shortlisting-shape-d/persistImageClassificationV2.test.ts
 *
 * Covers the F-D-002 fix: v2 universal schema places `time_of_day_*`,
 * exterior/detail subject under `out.image_classification.{is_dusk, is_day,
 * is_golden_hour, is_night, subject, is_drone}`. The pre-fix persist read
 * the top-level v1 fields (`out.time_of_day`, `out.is_exterior`,
 * `out.is_detail_shot`) which v2 NEVER emits — every row since the W11.7.17
 * cutover (2026-05-01) landed NULL in those columns. This test ensures the
 * derive-from-nested logic survives regression.
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

const ROUND_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PROJECT_ID = '11111111-2222-3333-4444-555555555555';
const GROUP_ID = 'ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb';

function v2SignalScores(): Record<string, number | null> {
  return {
    exposure_balance: 7, color_cast: 7, sharpness_subject: 7,
    sharpness_corners: 7, plumb_verticals: 7, perspective_distortion: 7,
    light_quality: 7, light_directionality: 7,
    color_temperature_appropriateness: 7, light_falloff_quality: 7,
    depth_layering: 7, composition_geometry: 7, vantage_quality: 7,
    framing_quality: 7, leading_lines: 7, negative_space: 7,
    symmetry_quality: 7, foreground_anchor: 7,
    material_specificity: 7, period_reading: 7, styling_quality: 7,
    distraction_freeness: 7,
    retouch_debt: 7, gallery_arc_position: 7,
    social_crop_survival: 7, brochure_print_survival: 7,
  };
}

function baseV2Output(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '2.0',
    source: { type: 'internal_raw', media_kind: 'still_image' },
    analysis: 'A 5-sentence kitchen analysis.',
    image_type: 'is_day',
    room_type: 'kitchen_main',
    composition_type: 'wide_establishing',
    vantage_point: 'interior_looking_out',
    is_styled: true,
    indoor_outdoor_visible: true,
    zones_visible: ['kitchen'],
    key_elements: ['cabinetry'],
    signal_scores: v2SignalScores(),
    technical_score: 7, lighting_score: 7,
    composition_score: 7, aesthetic_score: 7,
    combined_score: 7,
    quality_flags: {
      clutter_severity: 'none', clutter_detail: null,
      flag_for_retouching: false, is_near_duplicate_candidate: false,
    },
    appeal_signals: [], concern_signals: [], buyer_persona_hints: [],
    retouch_priority: 'none', retouch_estimate_minutes: 0,
    gallery_position_hint: 'early_gallery',
    social_first_friendly: true, requires_human_review: false,
    confidence_per_field: { room_type: 0.9, scoring: 0.9, classification: 0.9 },
    style_archetype: null, era_hint: null,
    material_palette_summary: [], embedding_anchor_text: 'kitchen',
    searchable_keywords: [], shot_intent: 'hero_establishing',
    observed_objects: [], observed_attributes: [],
    raw_specific: { luminance_class: 'balanced', is_aeb_zero: true, bracket_recoverable: true },
    finals_specific: null, external_specific: null, floorplan_specific: null,
    prompt_block_versions: {}, vendor: 'gemini', model_version: 'gemini-2.5-pro',
    ...extra,
  };
}

function baseCompositionRow() {
  return {
    group_id: GROUP_ID,
    best_bracket_stem: 'IMG_QC2',
    delivery_reference_stem: 'IMG_QC2',
    exif_metadata: {},
  };
}

function baseResult(out: Record<string, unknown>) {
  return {
    group_id: GROUP_ID,
    stem: 'IMG_QC2',
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
    tierConfig: null,
    sourceType: 'internal_raw',
    warnings: [],
  });
  return captured.row!;
}

// ─── time_of_day derivation from nested booleans ─────────────────────────────

Deno.test('F-D-002: time_of_day = "dusk_twilight" when image_classification.is_dusk is true', async () => {
  const out = baseV2Output({
    image_classification: {
      is_relevant_property_content: true, subject: 'exterior',
      is_dusk: true, is_day: false, is_golden_hour: false, is_night: false,
      time_of_day_confidence: 0.9, is_drone: false, drone_type: null,
      is_video_frame: false, quarantine_reason: null,
    },
  });
  const row = await runPersist(out);
  assertStrictEquals(row.time_of_day, 'dusk_twilight');
  assertStrictEquals(row.is_exterior, true);
});

Deno.test('F-D-002: time_of_day = "night" when image_classification.is_night is true (highest priority)', async () => {
  // Night beats every other tod flag if multiple are true.
  const out = baseV2Output({
    image_classification: {
      is_relevant_property_content: true, subject: 'exterior',
      is_dusk: true, is_day: false, is_golden_hour: false, is_night: true,
      time_of_day_confidence: 0.95, is_drone: false, drone_type: null,
      is_video_frame: false, quarantine_reason: null,
    },
  });
  const row = await runPersist(out);
  assertStrictEquals(row.time_of_day, 'night');
});

Deno.test('F-D-002: time_of_day = "golden_hour" when image_classification.is_golden_hour is true', async () => {
  const out = baseV2Output({
    image_classification: {
      is_relevant_property_content: true, subject: 'exterior',
      is_dusk: false, is_day: false, is_golden_hour: true, is_night: false,
      time_of_day_confidence: 0.85, is_drone: false, drone_type: null,
      is_video_frame: false, quarantine_reason: null,
    },
  });
  const row = await runPersist(out);
  assertStrictEquals(row.time_of_day, 'golden_hour');
});

Deno.test('F-D-002: time_of_day = "day" when only is_day is true', async () => {
  const out = baseV2Output({
    image_classification: {
      is_relevant_property_content: true, subject: 'interior',
      is_dusk: false, is_day: true, is_golden_hour: false, is_night: false,
      time_of_day_confidence: 0.9, is_drone: false, drone_type: null,
      is_video_frame: false, quarantine_reason: null,
    },
  });
  const row = await runPersist(out);
  assertStrictEquals(row.time_of_day, 'day');
});

Deno.test('F-D-002: time_of_day = null when all 4 booleans are false (e.g. floorplan)', async () => {
  const out = baseV2Output({
    image_type: 'is_floorplan',
    image_classification: {
      is_relevant_property_content: true, subject: 'floorplan',
      is_dusk: false, is_day: false, is_golden_hour: false, is_night: false,
      time_of_day_confidence: 0, is_drone: false, drone_type: null,
      is_video_frame: false, quarantine_reason: null,
    },
  });
  const row = await runPersist(out);
  assertStrictEquals(row.time_of_day, null);
});

// ─── is_exterior / is_detail_shot derivation from subject + image_type ───────

Deno.test('mig 442: is_detail_shot = false even when image_classification.subject = "detail" (column DEPRECATED)', async () => {
  // Mig 442 (2026-05-02): is_detail_shot is DEPRECATED — replaced by
  // shot_scale="detail" / "tight". Schema v2.5 dropped 'is_detail_shot' from
  // IMAGE_TYPE_OPTIONS, and persist now writes is_detail_shot=false on every
  // row regardless of the model emission. Pre-mig-442 behaviour was to derive
  // is_detail_shot from subject==='detail' OR image_type==='is_detail_shot';
  // post-mig-442 the column always lands FALSE for backwards-compat readers.
  const out = baseV2Output({
    image_type: 'is_other',  // v2.5 no longer carries 'is_detail_shot' in IMAGE_TYPE_OPTIONS
    image_classification: {
      is_relevant_property_content: true, subject: 'detail',
      is_dusk: false, is_day: true, is_golden_hour: false, is_night: false,
      time_of_day_confidence: 0.9, is_drone: false, drone_type: null,
      is_video_frame: false, quarantine_reason: null,
    },
  });
  const row = await runPersist(out);
  assertStrictEquals(row.is_detail_shot, false);
  // detail subject is NOT exterior
  assertStrictEquals(row.is_exterior, false);
});

Deno.test('mig 442: is_detail_shot always false even if image_type is legacy "is_detail_shot" (column DEPRECATED)', async () => {
  // Backwards-compat: a replay of pre-mig-442 traffic still carrying
  // image_type='is_detail_shot' must NOT light up is_detail_shot=true.
  // Column is always false post-mig-442.
  const out = baseV2Output({
    image_type: 'is_detail_shot',
    image_classification: {
      is_relevant_property_content: true, subject: 'interior',
      is_dusk: false, is_day: true, is_golden_hour: false, is_night: false,
      time_of_day_confidence: 0.9, is_drone: false, drone_type: null,
      is_video_frame: false, quarantine_reason: null,
    },
  });
  const row = await runPersist(out);
  // Mig 442 behaviour — column DEPRECATED, always false.
  assertStrictEquals(row.is_detail_shot, false);
  assertStrictEquals(row.is_exterior, false);
});

Deno.test('F-D-002: is_drone = true when image_classification.is_drone is true', async () => {
  const out = baseV2Output({
    image_type: 'is_drone',
    image_classification: {
      is_relevant_property_content: true, subject: 'drone',
      is_dusk: false, is_day: true, is_golden_hour: false, is_night: false,
      time_of_day_confidence: 0.9, is_drone: true, drone_type: 'orbit_oblique',
      is_video_frame: false, quarantine_reason: null,
    },
  });
  const row = await runPersist(out);
  assertStrictEquals(row.is_drone, true);
});

// ─── Backwards-compat: image_classification null/absent falls through to v1 ─

Deno.test('F-D-002: defensive — image_classification null → falls back to v1 top-level fields', async () => {
  // Hypothetical replay of a pre-v2 emission. The persist must NOT corrupt
  // the row when image_classification is absent — straggling v1.x traffic
  // (legacy engine_modes, replay tests) needs to keep landing cleanly.
  const out = baseV2Output({
    image_classification: null,
    time_of_day: 'dusk_twilight',
    is_exterior: true,
    is_detail_shot: false,
    is_drone: false,
  });
  const row = await runPersist(out);
  assertStrictEquals(row.time_of_day, 'dusk_twilight');
  assertStrictEquals(row.is_exterior, true);
  assertStrictEquals(row.is_detail_shot, false);
  assertStrictEquals(row.is_drone, false);
});

Deno.test('F-D-002: defensive — image_classification non-object → falls back to v1 top-level', async () => {
  const out = baseV2Output({
    image_classification: 'not_an_object',
    time_of_day: 'day',
    is_exterior: false,
    is_detail_shot: true,
    is_drone: false,
  });
  const row = await runPersist(out);
  // Wrong-type image_classification is treated as absent → v1 path.
  assertStrictEquals(row.time_of_day, 'day');
  assertStrictEquals(row.is_exterior, false);
  // Mig 442: is_detail_shot is DEPRECATED — always false post-mig-442 even
  // when the v1-fallback signal would have set it true. Column kept for
  // backwards compat with v1/v1.x/v2 readers.
  assertStrictEquals(row.is_detail_shot, false);
});

// ─── Regression: pre-fix v2 emission would have written all-NULLs ──────────

Deno.test('F-D-002: pre-fix scenario — pure v2 emission (no top-level fields) lands NON-NULL', async () => {
  // The exact bug: v2 model emits ONLY nested image_classification with no
  // top-level time_of_day / is_exterior / is_detail_shot / is_drone fallback.
  // Pre-fix this row would have landed with all 4 columns = NULL/false.
  const out = baseV2Output({
    image_type: 'is_dusk',
    image_classification: {
      is_relevant_property_content: true, subject: 'exterior',
      is_dusk: true, is_day: false, is_golden_hour: false, is_night: false,
      time_of_day_confidence: 0.95, is_drone: false, drone_type: null,
      is_video_frame: false, quarantine_reason: null,
    },
  });
  // CRITICAL: explicitly DELETE all 4 top-level fields to mirror real v2
  // schema-validated emissions (which never include them).
  delete out.time_of_day;
  delete out.is_exterior;
  delete out.is_detail_shot;
  delete out.is_drone;

  const row = await runPersist(out);

  // Post-fix: derived from nested classification — NOT null/false.
  assertStrictEquals(row.time_of_day, 'dusk_twilight');
  assertStrictEquals(row.is_exterior, true);
  assertStrictEquals(row.is_detail_shot, false);
  assertStrictEquals(row.is_drone, false);
});
