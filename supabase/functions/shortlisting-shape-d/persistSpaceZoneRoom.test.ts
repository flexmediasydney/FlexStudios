/**
 * persistSpaceZoneRoom.test.ts — W11.7.17 hotfix-5 (2026-05-02).
 *
 * Run: SUPABASE_URL=test SUPABASE_SERVICE_ROLE_KEY=test deno test \
 *   --no-check --allow-all \
 *   supabase/functions/shortlisting-shape-d/persistSpaceZoneRoom.test.ts
 *
 * Bug: v2 universal schema didn't DECLARE `space_type`, `zone_focus`,
 * `space_zone_count` at all — Gemini's structured-output mode silently
 * stripped them on emission, the prompt was teaching the model to emit
 * them, and persist read top-level keys that NEVER arrived → 100% NULL on
 * these columns since the W11.7.17 cutover (2026-05-01). Plus: `room_type`
 * sat under `room_classification.room_type` in v2 but persist read top
 * level → 37/38 v2 rows landed with NULL room_type.
 *
 * Fix:
 *   Piece 1 — declare space_type/zone_focus/space_zone_count in v2 schema
 *             (universalVisionResponseSchemaV2.ts) so Gemini stops stripping.
 *   Piece 2 — read room_type from `out.room_classification.room_type`
 *             with defensive top-level fallback (mirrors F-D-002 fix).
 *
 * Same fix-pattern as F-D-002 (image_classification gap, fixed yesterday).
 */

import {
  assertEquals,
  assertStrictEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { persistOneClassification } from './index.ts';
import {
  UNIVERSAL_CORE_REQUIRED,
  UNIVERSAL_VISION_RESPONSE_SCHEMA_VERSION,
  universalSchemaForSource,
  type UniversalVisionResponseV2,
} from '../_shared/visionPrompts/blocks/universalVisionResponseSchemaV2.ts';

// ─── Test plumbing (mirrors persistImageClassificationV2.test.ts) ────────────

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
    schema_version: '2.3',
    source: { type: 'internal_raw', media_kind: 'still_image' },
    analysis: 'A 5-sentence kitchen analysis.',
    image_type: 'is_day',
    image_classification: {
      is_relevant_property_content: true, subject: 'interior',
      is_dusk: false, is_day: true, is_golden_hour: false, is_night: false,
      time_of_day_confidence: 0.9, is_drone: false, drone_type: null,
      is_video_frame: false, quarantine_reason: null,
    },
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
    best_bracket_stem: 'IMG_HOTFIX5',
    delivery_reference_stem: 'IMG_HOTFIX5',
    exif_metadata: {},
  };
}

function baseResult(out: Record<string, unknown>) {
  return {
    group_id: GROUP_ID,
    stem: 'IMG_HOTFIX5',
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
    promptBlockVersions: { stage1: 'v2.4' },
    modelVersion: 'gemini-2.5-pro',
    // deno-lint-ignore no-explicit-any
    composition: baseCompositionRow() as any,
    tierConfig: null,
    sourceType: 'internal_raw',
    warnings: [],
  });
  return captured.row!;
}

// ─── Schema-level assertions (Piece 1) ───────────────────────────────────────

Deno.test('schema version bumped to v2.6 (mig 451 composition_type decomposition)', () => {
  // v2.3 (W11.7.17 hotfix-5) declared space_type / zone_focus with closed
  // enums. v2.4 (commit 9325f46, 2026-05-02) drops those enums to fit
  // Gemini's schema state-count limit; canonical lists are now taught via
  // the property `description` instead.
  // v2.5 (mig 442, 2026-05-02) adds three composition observability axes:
  // shot_scale, perspective_compression (REQUIRED) + orientation (optional,
  // derived from EXIF at persist time). is_detail_shot dropped from
  // IMAGE_TYPE_OPTIONS — replaced by shot_scale="detail".
  // v2.6 (mig 451, 2026-05-02) decomposes the legacy composition_type axis
  // into vantage_position + composition_geometry as separate top-level
  // properties.
  assertStrictEquals(UNIVERSAL_VISION_RESPONSE_SCHEMA_VERSION, 'v2.6');
});

Deno.test('schema declares space_type with canonical taxonomy in description (no closed enum)', () => {
  // v2.4: `enum: [...SPACE_TYPE_OPTIONS]` was dropped from the responseSchema
  // because the cumulative state count tipped Gemini's serving threshold.
  // The canonical list is now embedded in the property `description` and the
  // persistence layer's normalisation handles drift. We assert the field is
  // declared as a string AND the description contains a representative slice
  // of the canonical taxonomy so the model is still taught the closed list.
  for (const src of ['internal_raw', 'internal_finals', 'external_listing', 'floorplan_image'] as const) {
    const schema = universalSchemaForSource(src);
    const props = (schema as { properties: Record<string, unknown> }).properties;
    if (!('space_type' in props)) {
      throw new Error(`space_type missing from ${src} variant`);
    }
    const st = props.space_type as { type?: string; enum?: string[]; description?: string };
    assertStrictEquals(st.type, 'string', `space_type.type should be string in ${src}`);
    if (st.enum !== undefined) {
      throw new Error(`space_type.enum should be DROPPED in v2.4 (${src})`);
    }
    if (typeof st.description !== 'string' || st.description.length < 50) {
      throw new Error(`space_type.description must teach the taxonomy in v2.4 (${src})`);
    }
    // Description must reference enough canonical SPACE_TYPE_OPTIONS values
    // that the model has the closed list to pick from.
    if (!st.description.includes('master_bedroom') || !st.description.includes('kitchen_dedicated')) {
      throw new Error(`space_type.description does not embed canonical SPACE_TYPE_OPTIONS in ${src}`);
    }
  }
});

Deno.test('schema declares zone_focus with canonical taxonomy in description (no closed enum)', () => {
  for (const src of ['internal_raw', 'internal_finals', 'external_listing', 'floorplan_image'] as const) {
    const schema = universalSchemaForSource(src);
    const props = (schema as { properties: Record<string, unknown> }).properties;
    if (!('zone_focus' in props)) {
      throw new Error(`zone_focus missing from ${src} variant`);
    }
    const zf = props.zone_focus as { type?: string; enum?: string[]; description?: string };
    assertStrictEquals(zf.type, 'string', `zone_focus.type should be string in ${src}`);
    if (zf.enum !== undefined) {
      throw new Error(`zone_focus.enum should be DROPPED in v2.4 (${src})`);
    }
    if (typeof zf.description !== 'string' || zf.description.length < 50) {
      throw new Error(`zone_focus.description must teach the taxonomy in v2.4 (${src})`);
    }
    if (!zf.description.includes('bed_focal') || !zf.description.includes('kitchen_island')) {
      throw new Error(`zone_focus.description does not embed canonical ZONE_FOCUS_OPTIONS in ${src}`);
    }
  }
});

Deno.test('hotfix-5: schema declares space_zone_count as integer (optional)', () => {
  for (const src of ['internal_raw', 'internal_finals', 'external_listing', 'floorplan_image'] as const) {
    const schema = universalSchemaForSource(src);
    const props = (schema as { properties: Record<string, unknown> }).properties;
    if (!('space_zone_count' in props)) {
      throw new Error(`space_zone_count missing from ${src} variant`);
    }
    const szc = props.space_zone_count as { type?: string };
    assertStrictEquals(szc.type, 'integer', `space_zone_count.type should be integer in ${src}`);
  }
});

Deno.test('hotfix-5: space_type and zone_focus are REQUIRED; space_zone_count is OPTIONAL', () => {
  // Walk the exported required-list AND the per-variant required arrays.
  if (!UNIVERSAL_CORE_REQUIRED.includes('space_type')) {
    throw new Error('space_type missing from UNIVERSAL_CORE_REQUIRED');
  }
  if (!UNIVERSAL_CORE_REQUIRED.includes('zone_focus')) {
    throw new Error('zone_focus missing from UNIVERSAL_CORE_REQUIRED');
  }
  if (UNIVERSAL_CORE_REQUIRED.includes('space_zone_count')) {
    throw new Error('space_zone_count must NOT be required (it is a hint)');
  }
  for (const src of ['internal_raw', 'internal_finals', 'external_listing', 'floorplan_image'] as const) {
    const schema = universalSchemaForSource(src) as { required: string[] };
    if (!schema.required.includes('space_type')) {
      throw new Error(`space_type missing from required[] in ${src}`);
    }
    if (!schema.required.includes('zone_focus')) {
      throw new Error(`zone_focus missing from required[] in ${src}`);
    }
    if (schema.required.includes('space_zone_count')) {
      throw new Error(`space_zone_count must not be required in ${src}`);
    }
  }
});

Deno.test('hotfix-5: TypeScript interface union accepts v2.3', () => {
  // Compile-time check via a typed assignment. If schema_version: '2.3' were
  // not in the union, this would refuse to compile.
  const probe: Pick<UniversalVisionResponseV2, 'schema_version'> = { schema_version: '2.3' };
  assertEquals(probe.schema_version, '2.3');
});

// ─── Persist-layer assertions (Piece 2) ──────────────────────────────────────

Deno.test('hotfix-5: synthetic v2 with top-level space_type+zone_focus persists both', async () => {
  // Exact post-fix happy path: model emits the triplet at top level (after
  // the schema declares them), persist writes them to the dedicated columns.
  const out = baseV2Output({
    space_type: 'kitchen_dedicated',
    zone_focus: 'kitchen_island',
    space_zone_count: 1,
    room_classification: {
      room_type: 'kitchen', room_type_confidence: 0.95,
      composition_type: 'wide_establishing', vantage_point: 'neutral',
      is_styled: true, indoor_outdoor_visible: false,
      eligible_for_exterior_rear: false,
    },
  });
  const row = await runPersist(out);
  assertStrictEquals(row.space_type, 'kitchen_dedicated');
  assertStrictEquals(row.zone_focus, 'kitchen_island');
  assertStrictEquals(row.space_zone_count, 1);
});

Deno.test('hotfix-5: synthetic v2 with nested room_classification.room_type derives room_type', async () => {
  // Fix the 37/38 NULL-room-type bug: persist must read from
  // out.room_classification.room_type, not out.room_type.
  const out = baseV2Output({
    space_type: 'living_dining_combined',
    zone_focus: 'lounge_seating',
    room_classification: {
      room_type: 'living_room', room_type_confidence: 0.9,
      composition_type: 'wide_establishing',
      vantage_point: 'interior_looking_out',
      is_styled: true, indoor_outdoor_visible: true,
      eligible_for_exterior_rear: false,
    },
  });
  // Critical: NO top-level room_type field — mirroring the real v2 emission shape.
  delete out.room_type;
  const row = await runPersist(out);
  assertStrictEquals(row.room_type, 'living_room');
  assertStrictEquals(row.room_type_confidence, 0.9);
  assertStrictEquals(row.composition_type, 'wide_establishing');
});

Deno.test('hotfix-5: defensive — neither nested NOR top-level room_type → NULL gracefully', async () => {
  // Belt-and-braces guard: if the model emits an utterly broken row with
  // no room composition at all, persist must not throw — it lands NULL and
  // moves on.
  const out = baseV2Output({
    space_type: 'streetscape',
    zone_focus: 'full_facade',
    room_classification: null,
  });
  delete out.room_type;
  const row = await runPersist(out);
  assertStrictEquals(row.room_type, null);
  assertStrictEquals(row.room_type_confidence, null);
});

Deno.test('hotfix-5: legacy v1 traffic — top-level room_type still wins when room_classification absent', async () => {
  // Backwards-compat: any straggling pre-v2 emission must keep landing
  // cleanly. With no nested room_classification, the top-level fields win.
  const out = baseV2Output({
    space_type: 'master_bedroom',
    zone_focus: 'bed_focal',
    room_classification: null,
    room_type: 'bedroom_main',
    room_type_confidence: 0.85,
    composition_type: 'wide_establishing',
    vantage_point: 'neutral',
    is_styled: false,
    indoor_outdoor_visible: false,
  });
  const row = await runPersist(out);
  assertStrictEquals(row.room_type, 'bedroom_main');
  assertStrictEquals(row.room_type_confidence, 0.85);
  assertStrictEquals(row.composition_type, 'wide_establishing');
  assertStrictEquals(row.is_styled, false);
});

Deno.test('hotfix-5: pre-fix scenario — pure v2 emission with no top-level fields lands NON-NULL', async () => {
  // The exact bug: v2 model emits nested room_classification + top-level
  // space_type/zone_focus (now declared in schema). Pre-fix this row would
  // have landed with room_type=NULL and space_type=NULL.
  const out = baseV2Output({
    space_type: 'alfresco_undercover',
    zone_focus: 'outdoor_dining',
    space_zone_count: 2,
    room_classification: {
      room_type: 'alfresco', room_type_confidence: 0.88,
      composition_type: 'lifestyle_anchor',
      vantage_point: 'exterior_looking_in',
      is_styled: true, indoor_outdoor_visible: true,
      eligible_for_exterior_rear: true,
    },
  });
  // Strip every top-level legacy alias so we mirror real v2 emissions.
  delete out.room_type;
  delete out.room_type_confidence;
  delete out.composition_type;
  delete out.vantage_point;
  delete out.is_styled;
  delete out.indoor_outdoor_visible;

  const row = await runPersist(out);

  // Post-fix: derived from nested + top-level — NOT NULL.
  assertStrictEquals(row.room_type, 'alfresco');
  assertStrictEquals(row.room_type_confidence, 0.88);
  assertStrictEquals(row.composition_type, 'lifestyle_anchor');
  // vantage_point CHECK constraint accepts only 3 values; exterior_looking_in is one.
  assertStrictEquals(row.vantage_point, 'exterior_looking_in');
  assertStrictEquals(row.is_styled, true);
  assertStrictEquals(row.indoor_outdoor_visible, true);
  // The triplet itself.
  assertStrictEquals(row.space_type, 'alfresco_undercover');
  assertStrictEquals(row.zone_focus, 'outdoor_dining');
  assertStrictEquals(row.space_zone_count, 2);
  // eligible_for_exterior_rear is computed from room_type + vantage,
  // which now both source from nested.
  assertStrictEquals(row.eligible_for_exterior_rear, true);
});

Deno.test('hotfix-5: space_zone_count optional — null when omitted', async () => {
  const out = baseV2Output({
    space_type: 'powder_room',
    zone_focus: 'vanity_detail',
    // no space_zone_count
    room_classification: {
      room_type: 'powder_room', room_type_confidence: 0.9,
      composition_type: 'detail_specimen', vantage_point: 'neutral',
      is_styled: true, indoor_outdoor_visible: false,
      eligible_for_exterior_rear: false,
    },
  });
  const row = await runPersist(out);
  assertStrictEquals(row.space_zone_count, null);
  assertStrictEquals(row.space_type, 'powder_room');
  assertStrictEquals(row.zone_focus, 'vanity_detail');
});

// ─── Mig 442 (schema v2.5) — composition observability axes ─────────────────

Deno.test('mig 442: schema declares shot_scale + perspective_compression as STRING properties with rich descriptions (no closed enum)', () => {
  for (const src of ['internal_raw', 'internal_finals', 'external_listing', 'floorplan_image'] as const) {
    const schema = universalSchemaForSource(src);
    const props = (schema as { properties: Record<string, unknown> }).properties;

    // shot_scale
    if (!('shot_scale' in props)) {
      throw new Error(`shot_scale missing from ${src} variant`);
    }
    const ss = props.shot_scale as { type?: string; enum?: string[]; description?: string };
    assertStrictEquals(ss.type, 'string', `shot_scale.type should be string in ${src}`);
    if (ss.enum !== undefined) {
      throw new Error(`shot_scale.enum should NOT be declared in v2.5 (${src}) — taxonomy is taught via description`);
    }
    if (typeof ss.description !== 'string' || ss.description.length < 80) {
      throw new Error(
        `shot_scale.description must teach the canonical list (>=80 chars) in ${src}, got ${ss.description?.length ?? 0}`,
      );
    }
    // Description must reference enough canonical SHOT_SCALE_OPTIONS values.
    for (const required of ['wide', 'medium', 'tight', 'detail', 'vignette']) {
      if (!ss.description.includes(required)) {
        throw new Error(`shot_scale.description missing canonical token "${required}" in ${src}`);
      }
    }

    // perspective_compression
    if (!('perspective_compression' in props)) {
      throw new Error(`perspective_compression missing from ${src} variant`);
    }
    const pc = props.perspective_compression as { type?: string; enum?: string[]; description?: string };
    assertStrictEquals(pc.type, 'string', `perspective_compression.type should be string in ${src}`);
    if (pc.enum !== undefined) {
      throw new Error(`perspective_compression.enum should NOT be declared in v2.5 (${src})`);
    }
    if (typeof pc.description !== 'string' || pc.description.length < 80) {
      throw new Error(
        `perspective_compression.description must teach the canonical list (>=80 chars) in ${src}`,
      );
    }
    for (const required of ['expanded', 'neutral', 'compressed']) {
      if (!pc.description.includes(required)) {
        throw new Error(`perspective_compression.description missing canonical token "${required}" in ${src}`);
      }
    }

    // orientation — also string with rich description
    if (!('orientation' in props)) {
      throw new Error(`orientation missing from ${src} variant`);
    }
    const ori = props.orientation as { type?: string; enum?: string[]; description?: string; nullable?: boolean };
    assertStrictEquals(ori.type, 'string', `orientation.type should be string in ${src}`);
    if (ori.enum !== undefined) {
      throw new Error(`orientation.enum should NOT be declared in v2.5 (${src})`);
    }
    if (typeof ori.description !== 'string' || ori.description.length < 80) {
      throw new Error(`orientation.description must teach the canonical list (>=80 chars) in ${src}`);
    }
    for (const required of ['landscape', 'portrait', 'square']) {
      if (!ori.description.includes(required)) {
        throw new Error(`orientation.description missing canonical token "${required}" in ${src}`);
      }
    }
  }
});

Deno.test('mig 442: shot_scale + perspective_compression are REQUIRED; orientation is OPTIONAL', () => {
  if (!UNIVERSAL_CORE_REQUIRED.includes('shot_scale')) {
    throw new Error('shot_scale missing from UNIVERSAL_CORE_REQUIRED');
  }
  if (!UNIVERSAL_CORE_REQUIRED.includes('perspective_compression')) {
    throw new Error('perspective_compression missing from UNIVERSAL_CORE_REQUIRED');
  }
  if (UNIVERSAL_CORE_REQUIRED.includes('orientation')) {
    throw new Error('orientation must NOT be required (it is derived from EXIF at persist)');
  }
  for (const src of ['internal_raw', 'internal_finals', 'external_listing', 'floorplan_image'] as const) {
    const schema = universalSchemaForSource(src) as { required: string[] };
    if (!schema.required.includes('shot_scale')) {
      throw new Error(`shot_scale missing from required[] in ${src}`);
    }
    if (!schema.required.includes('perspective_compression')) {
      throw new Error(`perspective_compression missing from required[] in ${src}`);
    }
    if (schema.required.includes('orientation')) {
      throw new Error(`orientation must not be required in ${src}`);
    }
  }
});

Deno.test('mig 442: is_detail_shot REMOVED from image_type description (replaced by shot_scale)', () => {
  for (const src of ['internal_raw', 'internal_finals', 'external_listing', 'floorplan_image'] as const) {
    const schema = universalSchemaForSource(src);
    const props = (schema as { properties: Record<string, unknown> }).properties;
    const it = props.image_type as { description?: string };
    if (typeof it.description !== 'string') {
      throw new Error(`image_type.description missing in ${src}`);
    }
    if (it.description.includes('is_detail_shot |') || it.description.includes('| is_detail_shot')) {
      throw new Error(`image_type.description still references is_detail_shot in ${src} (should be dropped in v2.5)`);
    }
  }
});

Deno.test('mig 442: persist normalises shot_scale + perspective_compression and writes is_detail_shot=false', async () => {
  const out = baseV2Output({
    space_type: 'kitchen_dedicated',
    zone_focus: 'kitchen_island',
    shot_scale: '  WIDE  ',                     // drift: caps + whitespace
    perspective_compression: 'Compressed',       // drift: caps
    orientation: 'landscape',                    // drift-free
    room_classification: {
      room_type: 'kitchen', room_type_confidence: 0.95,
      composition_type: 'wide_establishing', vantage_point: 'neutral',
      is_styled: true, indoor_outdoor_visible: false,
      eligible_for_exterior_rear: false,
    },
  });
  const row = await runPersist(out);
  assertStrictEquals(row.shot_scale, 'wide');
  assertStrictEquals(row.perspective_compression, 'compressed');
  assertStrictEquals(row.orientation, 'landscape');
  // is_detail_shot is always false post-mig-442 regardless of model emission.
  assertStrictEquals(row.is_detail_shot, false);
});

Deno.test('mig 442: persist drops non-canonical shot_scale and emits warning', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  const warnings: string[] = [];
  await persistOneClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    roundId: ROUND_ID,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseResult(baseV2Output({
      space_type: 'kitchen_dedicated',
      zone_focus: 'kitchen_island',
      shot_scale: 'panoramic',           // non-canonical
      perspective_compression: 'flat',   // non-canonical
      room_classification: {
        room_type: 'kitchen', room_type_confidence: 0.9,
        composition_type: 'wide_establishing', vantage_point: 'neutral',
        is_styled: true, indoor_outdoor_visible: false,
        eligible_for_exterior_rear: false,
      },
    })) as any,
    promptBlockVersions: { stage1: 'v2.5' },
    modelVersion: 'gemini-2.5-pro',
    // deno-lint-ignore no-explicit-any
    composition: baseCompositionRow() as any,
    tierConfig: null,
    sourceType: 'internal_raw',
    warnings,
  });
  const row = captured.row!;
  assertStrictEquals(row.shot_scale, null);
  assertStrictEquals(row.perspective_compression, null);
  // 2 warnings emitted (one per non-canonical axis).
  if (warnings.filter((w) => w.includes('mig 442')).length < 2) {
    throw new Error(`expected at least 2 mig-442 warnings, got: ${JSON.stringify(warnings)}`);
  }
});

Deno.test('mig 442: orientation derived from EXIF dims overrides model emission', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  await persistOneClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    roundId: ROUND_ID,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseResult(baseV2Output({
      space_type: 'master_bedroom',
      zone_focus: 'bed_focal',
      shot_scale: 'wide',
      perspective_compression: 'neutral',
      orientation: 'portrait',  // model says portrait...
      room_classification: {
        room_type: 'bedroom', room_type_confidence: 0.9,
        composition_type: 'wide_establishing', vantage_point: 'neutral',
        is_styled: true, indoor_outdoor_visible: false,
        eligible_for_exterior_rear: false,
      },
    })) as any,
    promptBlockVersions: { stage1: 'v2.5' },
    modelVersion: 'gemini-2.5-pro',
    // ...but EXIF dims are clearly landscape (3:2 sensor)
    composition: {
      group_id: GROUP_ID,
      best_bracket_stem: 'IMG_HOTFIX5',
      delivery_reference_stem: 'IMG_HOTFIX5',
      exif_metadata: {
        IMG_HOTFIX5: { imageWidth: 6000, imageHeight: 4000 },
      },
      // deno-lint-ignore no-explicit-any
    } as any,
    tierConfig: null,
    sourceType: 'internal_raw',
    warnings: [],
  });
  // EXIF wins — landscape, not portrait.
  assertStrictEquals(captured.row!.orientation, 'landscape');
});

Deno.test('mig 442: orientation falls back to model emission when EXIF dims missing', async () => {
  const out = baseV2Output({
    space_type: 'master_bedroom',
    zone_focus: 'bed_focal',
    shot_scale: 'wide',
    perspective_compression: 'neutral',
    orientation: 'portrait',
    room_classification: {
      room_type: 'bedroom', room_type_confidence: 0.9,
      composition_type: 'wide_establishing', vantage_point: 'neutral',
      is_styled: true, indoor_outdoor_visible: false,
      eligible_for_exterior_rear: false,
    },
  });
  // baseCompositionRow has empty exif_metadata → EXIF dims unavailable.
  const row = await runPersist(out);
  assertStrictEquals(row.orientation, 'portrait');
});

Deno.test('mig 442: orientation NULL when neither EXIF nor model emission available', async () => {
  const out = baseV2Output({
    space_type: 'master_bedroom',
    zone_focus: 'bed_focal',
    shot_scale: 'wide',
    perspective_compression: 'neutral',
    // no orientation field at all
    room_classification: {
      room_type: 'bedroom', room_type_confidence: 0.9,
      composition_type: 'wide_establishing', vantage_point: 'neutral',
      is_styled: true, indoor_outdoor_visible: false,
      eligible_for_exterior_rear: false,
    },
  });
  delete out.orientation;
  const row = await runPersist(out);
  assertStrictEquals(row.orientation, null);
});

// ─── Mig 451 (schema v2.6) — composition_type decomposition ─────────────────

Deno.test('mig 451: schema declares vantage_position + composition_geometry as STRING properties (no closed enum)', () => {
  for (const src of ['internal_raw', 'internal_finals', 'external_listing', 'floorplan_image'] as const) {
    const schema = universalSchemaForSource(src);
    const props = (schema as { properties: Record<string, unknown> }).properties;

    // vantage_position
    if (!('vantage_position' in props)) {
      throw new Error(`vantage_position missing from ${src} variant`);
    }
    const vp = props.vantage_position as { type?: string; enum?: string[]; description?: string; nullable?: boolean };
    assertStrictEquals(vp.type, 'string', `vantage_position.type should be string in ${src}`);
    if (vp.enum !== undefined) {
      throw new Error(`vantage_position.enum must NOT be declared in v2.6 (${src}) — taxonomy is taught via description`);
    }
    if (typeof vp.description !== 'string' || vp.description.length < 80) {
      throw new Error(`vantage_position.description must teach the canonical list (>=80 chars) in ${src}`);
    }
    // Description must reference enough canonical VANTAGE_POSITION_OPTIONS values.
    for (const required of ['eye_level', 'corner', 'square_to_wall', 'through_doorway', 'down_corridor']) {
      if (!vp.description.includes(required)) {
        throw new Error(`vantage_position.description missing canonical token "${required}" in ${src}`);
      }
    }

    // composition_geometry
    if (!('composition_geometry' in props)) {
      throw new Error(`composition_geometry missing from ${src} variant`);
    }
    const cg = props.composition_geometry as { type?: string; enum?: string[]; description?: string; nullable?: boolean };
    assertStrictEquals(cg.type, 'string', `composition_geometry.type should be string in ${src}`);
    if (cg.enum !== undefined) {
      throw new Error(`composition_geometry.enum must NOT be declared in v2.6 (${src})`);
    }
    if (typeof cg.description !== 'string' || cg.description.length < 80) {
      throw new Error(`composition_geometry.description must teach the canonical list (>=80 chars) in ${src}`);
    }
    for (const required of ['one_point_perspective', 'two_point_perspective', 'leading_lines', 'symmetrical']) {
      if (!cg.description.includes(required)) {
        throw new Error(`composition_geometry.description missing canonical token "${required}" in ${src}`);
      }
    }
  }
});

Deno.test('mig 451: vantage_position + composition_geometry are REQUIRED (values nullable)', () => {
  if (!UNIVERSAL_CORE_REQUIRED.includes('vantage_position')) {
    throw new Error('vantage_position missing from UNIVERSAL_CORE_REQUIRED');
  }
  if (!UNIVERSAL_CORE_REQUIRED.includes('composition_geometry')) {
    throw new Error('composition_geometry missing from UNIVERSAL_CORE_REQUIRED');
  }
  for (const src of ['internal_raw', 'internal_finals', 'external_listing', 'floorplan_image'] as const) {
    const schema = universalSchemaForSource(src) as { required: string[] };
    if (!schema.required.includes('vantage_position')) {
      throw new Error(`vantage_position missing from required[] in ${src}`);
    }
    if (!schema.required.includes('composition_geometry')) {
      throw new Error(`composition_geometry missing from required[] in ${src}`);
    }
  }
});

Deno.test('mig 451: persist normalises vantage_position + composition_geometry against canonical lists', async () => {
  const out = baseV2Output({
    space_type: 'living_dining_combined',
    zone_focus: 'lounge_seating',
    shot_scale: 'wide',
    perspective_compression: 'expanded',
    vantage_position: '  CORNER  ',                   // drift: caps + whitespace
    composition_geometry: 'Two_Point_Perspective',    // drift: caps
    room_classification: {
      room_type: 'living_room', room_type_confidence: 0.9,
      composition_type: 'wide_establishing', vantage_point: 'neutral',
      is_styled: true, indoor_outdoor_visible: false,
      eligible_for_exterior_rear: false,
    },
  });
  const row = await runPersist(out);
  assertStrictEquals(row.vantage_position, 'corner');
  assertStrictEquals(row.composition_geometry, 'two_point_perspective');
});

Deno.test('mig 451: persist drops non-canonical vantage_position + composition_geometry with warning', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  const warnings: string[] = [];
  await persistOneClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    roundId: ROUND_ID,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseResult(baseV2Output({
      space_type: 'kitchen_dedicated',
      zone_focus: 'kitchen_island',
      shot_scale: 'wide',
      perspective_compression: 'neutral',
      vantage_position: 'sky_view',          // non-canonical
      composition_geometry: 'wonky',         // non-canonical
      room_classification: {
        room_type: 'kitchen', room_type_confidence: 0.9,
        composition_type: 'wide_establishing', vantage_point: 'neutral',
        is_styled: true, indoor_outdoor_visible: false,
        eligible_for_exterior_rear: false,
      },
    })) as any,
    promptBlockVersions: { stage1: 'v2.6' },
    modelVersion: 'gemini-2.5-pro',
    // deno-lint-ignore no-explicit-any
    composition: baseCompositionRow() as any,
    tierConfig: null,
    sourceType: 'internal_raw',
    warnings,
  });
  const row = captured.row!;
  assertStrictEquals(row.vantage_position, null);
  assertStrictEquals(row.composition_geometry, null);
  // warnings emitted (one per non-canonical axis)
  if (warnings.filter((w) => w.includes('vantage_position') || w.includes('composition_geometry')).length < 2) {
    throw new Error(`expected at least 2 mig-451 warnings, got: ${JSON.stringify(warnings)}`);
  }
});

Deno.test('mig 451: vantage_position + composition_geometry NULL when omitted', async () => {
  const out = baseV2Output({
    space_type: 'master_bedroom',
    zone_focus: 'bed_focal',
    shot_scale: 'wide',
    perspective_compression: 'neutral',
    // no vantage_position, no composition_geometry
    room_classification: {
      room_type: 'bedroom', room_type_confidence: 0.9,
      composition_type: 'wide_establishing', vantage_point: 'neutral',
      is_styled: true, indoor_outdoor_visible: false,
      eligible_for_exterior_rear: false,
    },
  });
  const row = await runPersist(out);
  assertStrictEquals(row.vantage_position, null);
  assertStrictEquals(row.composition_geometry, null);
});
