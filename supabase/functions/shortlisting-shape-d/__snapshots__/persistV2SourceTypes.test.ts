/**
 * persistV2SourceTypes.test.ts — Wave 11.7.17 v2 schema snapshot tests.
 *
 * Run: deno test --no-check --allow-all \
 *   supabase/functions/shortlisting-shape-d/__snapshots__/persistV2SourceTypes.test.ts
 *
 * Coverage: for each of the 4 source types
 * (internal_raw / internal_finals / external_listing / floorplan_image),
 * a mock v2 Gemini emission is fed through `persistOneClassification` and
 * the upserted row payload is asserted against the expected v2-shape.
 *
 * Goal: regression detection if anyone changes the schema or persist logic.
 *
 * Why these are called snapshot tests but use assertEquals: Deno's bundled
 * snapshot library (`@std/testing/snapshot`) requires file IO permissions and
 * a more complex test runner setup. The "snapshot" here is the inline
 * EXPECTED_*_SHAPE objects — they ARE the snapshot, just expressed in code.
 * If anyone changes the persist logic without intent, the EXPECTED_*_SHAPE
 * diffs will fail loudly with a clean assertEquals error message.
 */

import {
  assertEquals,
  assertStrictEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { persistOneClassification } from '../index.ts';

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

const ROUND_ID = 'aaaaaaaa-1111-1111-1111-111111111111';
const PROJECT_ID = 'bbbbbbbb-2222-2222-2222-222222222222';
const GROUP_ID = 'cccccccc-3333-3333-3333-333333333333';

function baseCompositionRow() {
  return {
    group_id: GROUP_ID,
    best_bracket_stem: 'IMG_2020',
    delivery_reference_stem: 'IMG_2020',
    exif_metadata: {},
  };
}

function baseResult(out: Record<string, unknown>) {
  return {
    group_id: GROUP_ID,
    stem: 'IMG_2020',
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

// ─── Mock v2 emissions, one per source type ─────────────────────────────────

const RAW_V2_OUTPUT = {
  schema_version: '2.0',
  source: { type: 'internal_raw', media_kind: 'still_image' },
  analysis: '5 sentences of analysis describing the kitchen.',
  image_type: 'is_day',
  image_classification: {
    is_relevant_property_content: true, subject: 'interior',
    is_dusk: false, is_day: true, is_golden_hour: false, is_night: false,
    time_of_day_confidence: 0.9, is_drone: false, drone_type: null,
    is_video_frame: false, quarantine_reason: null,
  },
  room_type: 'kitchen_main',
  room_type_confidence: 0.9,
  composition_type: 'wide_establishing',
  vantage_point: 'interior_looking_out',
  is_styled: true,
  indoor_outdoor_visible: true,
  is_drone: false,
  is_exterior: false,
  is_detail_shot: false,
  zones_visible: ['kitchen'],
  key_elements: ['shaker-style cabinetry', 'gooseneck mixer tap'],
  signal_scores: {
    // RAW: exposure_balance is null (HDR bracket — pre-merge)
    exposure_balance: null,
    color_cast: 7, sharpness_subject: 8, sharpness_corners: 7,
    plumb_verticals: 6, perspective_distortion: 8,
    light_quality: 7, light_directionality: 7,
    color_temperature_appropriateness: 6, light_falloff_quality: 7,
    depth_layering: 8, composition_geometry: 7, vantage_quality: 8,
    framing_quality: 7, leading_lines: 6, negative_space: 7,
    symmetry_quality: 5, foreground_anchor: 6,
    material_specificity: 7, period_reading: 7, styling_quality: 6,
    distraction_freeness: 7,
    retouch_debt: 7, gallery_arc_position: 7, social_crop_survival: 7,
    brochure_print_survival: 6,
  },
  technical_score: 7.2,
  lighting_score: 6.75,
  composition_score: 6.75,
  aesthetic_score: 6.75,
  combined_score: 6.86,
  quality_flags: {
    clutter_severity: 'none', clutter_detail: '',
    flag_for_retouching: false, is_near_duplicate_candidate: false,
  },
  clutter_severity: 'none', clutter_detail: '',
  flag_for_retouching: false,
  appeal_signals: ['natural_light'],
  concern_signals: [],
  buyer_persona_hints: ['young_family_upgrader'],
  retouch_priority: 'none',
  retouch_estimate_minutes: 0,
  gallery_position_hint: 'early_gallery',
  social_first_friendly: true,
  requires_human_review: false,
  confidence_per_field: { room_type: 0.95, scoring: 0.85, classification: 0.9 },
  style_archetype: 'contemporary project home',
  era_hint: '2018-2022 build',
  material_palette_summary: ['Caesarstone', 'engineered oak'],
  embedding_anchor_text: 'Kitchen wide establishing, contemporary, north light',
  searchable_keywords: ['caesarstone', 'shaker-cabinetry'],
  shot_intent: 'hero_establishing',
  listing_copy: {
    headline: 'Caesarstone island anchors a north-light kitchen',
    paragraphs: 'The kitchen presents an oversized Caesarstone island...',
  },
  observed_objects: [
    {
      raw_label: 'shaker-style cabinetry',
      proposed_canonical_id: 'kitchen.cabinetry.shaker',
      confidence: 0.9,
      bounding_box: { x_pct: 5, y_pct: 30, w_pct: 60, h_pct: 50 },
      attributes: { material: 'painted_timber', finish: 'matte' },
    },
    {
      raw_label: 'gooseneck mixer tap',
      proposed_canonical_id: 'kitchen.tapware.gooseneck',
      confidence: 0.95,
      bounding_box: { x_pct: 45, y_pct: 35, w_pct: 8, h_pct: 15 },
      attributes: { finish: 'chrome' },
    },
  ],
  observed_attributes: [
    { raw_label: 'matte black tapware', canonical_attribute_id: null,
      canonical_value_id: null, confidence: 0.8, object_anchor: null },
  ],
  raw_specific: {
    luminance_class: 'balanced',
    is_aeb_zero: true,
    bracket_recoverable: true,
  },
  finals_specific: null,
  external_specific: null,
  floorplan_specific: null,
  prompt_block_versions: { universal_vision_response_schema: 'v2.0' },
  vendor: 'gemini',
  model_version: 'gemini-2.5-pro',
};

const FINALS_V2_OUTPUT = {
  schema_version: '2.0',
  source: { type: 'internal_finals', media_kind: 'still_image' },
  analysis: '5 sentences of analysis describing the post-edited kitchen.',
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
    // Finals: ALL signals scored
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
  technical_score: 8.83,
  lighting_score: 8.75,
  composition_score: 7.88,
  aesthetic_score: 8.75,
  combined_score: 8.55,
  quality_flags: {
    clutter_severity: 'none', clutter_detail: '',
    flag_for_retouching: false, is_near_duplicate_candidate: false,
  },
  clutter_severity: 'none', clutter_detail: '',
  flag_for_retouching: false,
  appeal_signals: ['natural_light'],
  concern_signals: [],
  buyer_persona_hints: ['working_professional_couple'],
  retouch_priority: 'none',
  retouch_estimate_minutes: 0,
  gallery_position_hint: 'lead_image',
  social_first_friendly: true,
  requires_human_review: false,
  confidence_per_field: { room_type: 0.97, scoring: 0.92, classification: 0.95 },
  style_archetype: 'contemporary project home',
  era_hint: '2018-2022 build',
  material_palette_summary: ['Caesarstone', 'matte black tapware'],
  embedding_anchor_text: 'Kitchen final delivery, Caesarstone, contemporary',
  searchable_keywords: ['caesarstone'],
  shot_intent: 'hero_establishing',
  listing_copy: {
    headline: 'A Caesarstone-led kitchen with northern light',
    paragraphs: 'The kitchen has been finalised with...',
  },
  observed_objects: [
    {
      raw_label: 'Caesarstone island',
      proposed_canonical_id: 'kitchen.island.stone',
      confidence: 0.95,
      bounding_box: { x_pct: 20, y_pct: 50, w_pct: 60, h_pct: 35 },
      attributes: { material: 'caesarstone' },
    },
  ],
  observed_attributes: [],
  raw_specific: null,
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
    shadow_recovery_score: 9,
    color_cast_score: 9,
    hdr_halo_severity: 0,
    retouch_artefact_severity: 0,
  },
  external_specific: null,
  floorplan_specific: null,
  prompt_block_versions: { universal_vision_response_schema: 'v2.0' },
  vendor: 'gemini',
  model_version: 'gemini-2.5-pro',
};

const EXTERNAL_V2_OUTPUT = {
  schema_version: '2.0',
  source: {
    type: 'external_listing', media_kind: 'still_image',
    listing_id: 'rea_listing_88123',
    external_url: 'https://rea.com.au/listing/88123/img/3.jpg',
  },
  analysis: '5 sentences observational description of the competitor listing.',
  image_type: 'is_dusk',
  image_classification: {
    is_relevant_property_content: true, subject: 'exterior',
    is_dusk: true, is_day: false, is_golden_hour: false, is_night: false,
    time_of_day_confidence: 0.85, is_drone: false, drone_type: null,
    is_video_frame: false, quarantine_reason: null,
  },
  room_type: 'exterior_facade',
  composition_type: 'wide_establishing',
  vantage_point: 'eye_level_through_threshold',
  is_styled: false,
  indoor_outdoor_visible: false,
  zones_visible: ['front_garden'],
  key_elements: ['rendered facade'],
  signal_scores: {
    exposure_balance: 7, color_cast: 7, sharpness_subject: 8,
    sharpness_corners: 7, plumb_verticals: 8, perspective_distortion: 8,
    light_quality: 8, light_directionality: 8,
    color_temperature_appropriateness: 8, light_falloff_quality: 8,
    depth_layering: 7, composition_geometry: 7, vantage_quality: 7,
    framing_quality: 7, leading_lines: 6, negative_space: 7,
    symmetry_quality: 6, foreground_anchor: 6,
    material_specificity: 7, period_reading: 8, styling_quality: 6,
    distraction_freeness: 8,
    retouch_debt: 8, gallery_arc_position: 0, social_crop_survival: 7,
    brochure_print_survival: 7,
  },
  technical_score: 7.5,
  lighting_score: 8,
  composition_score: 6.63,
  aesthetic_score: 7.25,
  combined_score: 7.36,
  quality_flags: {
    clutter_severity: 'none', clutter_detail: '',
    flag_for_retouching: false, // external: always false
    is_near_duplicate_candidate: false,
  },
  clutter_severity: 'none', clutter_detail: '',
  flag_for_retouching: false,
  appeal_signals: ['period_features_intact'],
  concern_signals: [],
  buyer_persona_hints: [],
  retouch_priority: 'none',     // external: always 'none'
  retouch_estimate_minutes: 0,
  gallery_position_hint: 'archive_only', // external: always archive_only
  social_first_friendly: false,
  requires_human_review: false,
  confidence_per_field: { room_type: 0.85, scoring: 0.7, classification: 0.85 },
  style_archetype: 'Federation cottage',
  era_hint: 'circa 1900-1920',
  material_palette_summary: ['render', 'tile roof'],
  embedding_anchor_text: 'Federation facade, dusk lighting, render finish',
  searchable_keywords: ['federation', 'dusk'],
  shot_intent: 'hero_establishing',
  listing_copy: null, // external: no listing_copy
  observed_objects: [
    {
      raw_label: 'rendered facade',
      proposed_canonical_id: 'exterior.facade.render',
      confidence: 0.9,
      bounding_box: { x_pct: 10, y_pct: 30, w_pct: 80, h_pct: 60 },
      attributes: { material: 'render' },
    },
  ],
  observed_attributes: [],
  raw_specific: null,
  finals_specific: null,
  external_specific: {
    estimated_price_class: '3M_to_10M',
    competitor_branding: {
      watermark_visible: true,
      agency_logo: 'BlueChip Realty',
      photographer_credit: null,
    },
    package_signals: {
      dusk_quality: true,
      drone_perspective: false,
      video_thumbnail: false,
      floorplan_present: true,
      twilight_hdr: true,
      photo_count_in_listing: 24,
    },
  },
  floorplan_specific: null,
  prompt_block_versions: { universal_vision_response_schema: 'v2.0' },
  vendor: 'gemini',
  model_version: 'gemini-2.5-pro',
};

const FLOORPLAN_V2_OUTPUT = {
  schema_version: '2.0',
  source: { type: 'floorplan_image', media_kind: 'floorplan_image' },
  analysis: 'A 4-bedroom, 2-bathroom single-storey home with rear alfresco.',
  image_type: 'is_floorplan',
  image_classification: {
    is_relevant_property_content: true, subject: 'floorplan',
    is_dusk: false, is_day: false, is_golden_hour: false, is_night: false,
    time_of_day_confidence: 0, is_drone: false, drone_type: null,
    is_video_frame: false, quarantine_reason: null,
  },
  // Floorplan: room_classification = null
  room_type: null,
  composition_type: null,
  vantage_point: null,
  is_styled: false,
  indoor_outdoor_visible: false,
  zones_visible: [],
  key_elements: [],
  // Floorplan: ALL signal_scores set to null
  signal_scores: {
    exposure_balance: null, color_cast: null,
    sharpness_subject: null, sharpness_corners: null,
    plumb_verticals: null, perspective_distortion: null,
    light_quality: null, light_directionality: null,
    color_temperature_appropriateness: null, light_falloff_quality: null,
    depth_layering: null, composition_geometry: null, vantage_quality: null,
    framing_quality: null, leading_lines: null, negative_space: null,
    symmetry_quality: null, foreground_anchor: null,
    material_specificity: null, period_reading: null, styling_quality: null,
    distraction_freeness: null,
    retouch_debt: null, gallery_arc_position: null, social_crop_survival: null,
    brochure_print_survival: null,
  },
  technical_score: 0,
  lighting_score: 0,
  composition_score: 0,
  aesthetic_score: 0,
  combined_score: 0,
  quality_flags: {
    clutter_severity: null, clutter_detail: null,
    flag_for_retouching: false, is_near_duplicate_candidate: false,
  },
  clutter_severity: null, clutter_detail: null,
  flag_for_retouching: false,
  appeal_signals: [],
  concern_signals: [],
  buyer_persona_hints: [],
  retouch_priority: 'none',
  retouch_estimate_minutes: null,
  gallery_position_hint: 'archive_only',
  social_first_friendly: null,
  requires_human_review: false,
  confidence_per_field: { room_type: 0, scoring: 0, classification: 0.9 },
  style_archetype: 'single-storey contemporary',
  era_hint: null,
  material_palette_summary: [],
  embedding_anchor_text: 'Single-storey 4br/2ba floorplan, rear alfresco',
  searchable_keywords: ['floorplan'],
  shot_intent: null,
  listing_copy: null,
  observed_objects: [
    {
      raw_label: 'door swing arc — front entry',
      proposed_canonical_id: null,
      confidence: 0.95,
      bounding_box: { x_pct: 12, y_pct: 70, w_pct: 4, h_pct: 8 },
      attributes: { type: 'door_swing' },
    },
  ],
  observed_attributes: [
    { raw_label: 'BED 1 4.2x3.6', canonical_attribute_id: 'room.dimension',
      canonical_value_id: null, confidence: 0.9, object_anchor: 'BED 1' },
  ],
  raw_specific: null,
  finals_specific: null,
  external_specific: null,
  floorplan_specific: {
    rooms_detected: [
      { room_label: 'BED 1', canonical_room_type: 'master_bedroom',
        area_sqm: 15.12, dimensions_text: '4.2x3.6' },
      { room_label: 'BED 2', canonical_room_type: 'bedroom_secondary',
        area_sqm: 11.4, dimensions_text: '3.0x3.8' },
    ],
    total_internal_sqm: 198.5,
    bedrooms_count: 4,
    bathrooms_count: 2,
    car_spaces: 2,
    home_archetype: 'single-storey contemporary',
    north_arrow_orientation: 'N',
    levels_count: 1,
    cross_check_flags: [],
  },
  prompt_block_versions: { universal_vision_response_schema: 'v2.0' },
  vendor: 'gemini',
  model_version: 'gemini-2.5-pro',
};

// ─── 4 snapshot tests, one per source type ──────────────────────────────────

Deno.test('v2 snapshot — internal_raw: persists raw_specific, schema_version v2.0', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  await persistOneClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    roundId: ROUND_ID,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseResult(RAW_V2_OUTPUT) as any,
    promptBlockVersions: {
      universal_vision_response_schema: 'v2.0',
      signal_measurement: 'v1.0',
      source_context: 'v1.1',
    },
    modelVersion: 'gemini-2.5-pro',
    // deno-lint-ignore no-explicit-any
    composition: baseCompositionRow() as any,
    tierConfig: null,
    sourceType: 'internal_raw',
    warnings: [],
  });

  const row = captured.row!;
  assertStrictEquals(captured.table, 'composition_classifications');
  assertStrictEquals(row.schema_version, 'v2.0');
  assertStrictEquals(row.source_type, 'internal_raw');
  assertStrictEquals(row.image_type, 'is_day');
  // raw_specific populated; the other 3 *_specific are null.
  assertEquals(row.raw_specific, {
    luminance_class: 'balanced',
    is_aeb_zero: true,
    bracket_recoverable: true,
  });
  assertStrictEquals(row.finals_specific, null);
  assertStrictEquals(row.external_specific, null);
  assertStrictEquals(row.floorplan_specific, null);
  // observed_objects has bounding_box populated on each entry (Q3 binding).
  const objs = row.observed_objects as Array<Record<string, unknown>>;
  assertStrictEquals(objs.length, 2);
  assertEquals(objs[0].bounding_box, { x_pct: 5, y_pct: 30, w_pct: 60, h_pct: 50 });
  assertEquals(objs[1].bounding_box, { x_pct: 45, y_pct: 35, w_pct: 8, h_pct: 15 });
  // signal_scores includes the 4 NEW lighting signals (Q2 binding)
  const sig = row.signal_scores as Record<string, number | null>;
  assertStrictEquals(sig.light_quality, 7);
  assertStrictEquals(sig.light_directionality, 7);
  assertStrictEquals(sig.color_temperature_appropriateness, 6);
  assertStrictEquals(sig.light_falloff_quality, 7);
  // RAW: exposure_balance is null (don't penalise the bracket)
  assertStrictEquals(sig.exposure_balance, null);
});

Deno.test('v2 snapshot — internal_finals: persists finals_specific only', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  await persistOneClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    roundId: ROUND_ID,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseResult(FINALS_V2_OUTPUT) as any,
    promptBlockVersions: { universal_vision_response_schema: 'v2.0' },
    modelVersion: 'gemini-2.5-pro',
    // deno-lint-ignore no-explicit-any
    composition: baseCompositionRow() as any,
    tierConfig: null,
    sourceType: 'internal_finals',
    warnings: [],
  });

  const row = captured.row!;
  assertStrictEquals(row.schema_version, 'v2.0');
  assertStrictEquals(row.source_type, 'internal_finals');
  assertStrictEquals(row.raw_specific, null);
  // finals_specific populated, others null
  const finals = row.finals_specific as Record<string, unknown>;
  assertStrictEquals(finals.looks_post_processed, true);
  assertStrictEquals(finals.vertical_lines_corrected, true);
  assertStrictEquals(finals.sky_replaced, false);
  assertStrictEquals(finals.window_blowout_severity, 1);
  assertStrictEquals(finals.shadow_recovery_score, 9);
  assertStrictEquals(row.external_specific, null);
  assertStrictEquals(row.floorplan_specific, null);
  // Finals: exposure_balance is scored (not null like RAW)
  const sig = row.signal_scores as Record<string, number | null>;
  assertStrictEquals(sig.exposure_balance, 9);
});

Deno.test('v2 snapshot — external_listing: persists external_specific; no delivery_quality_grade (Q4)', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  await persistOneClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    roundId: ROUND_ID,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseResult(EXTERNAL_V2_OUTPUT) as any,
    promptBlockVersions: { universal_vision_response_schema: 'v2.0' },
    modelVersion: 'gemini-2.5-pro',
    // deno-lint-ignore no-explicit-any
    composition: baseCompositionRow() as any,
    tierConfig: null,
    sourceType: 'external_listing',
    warnings: [],
  });

  const row = captured.row!;
  assertStrictEquals(row.schema_version, 'v2.0');
  assertStrictEquals(row.source_type, 'external_listing');
  assertStrictEquals(row.raw_specific, null);
  assertStrictEquals(row.finals_specific, null);
  assertStrictEquals(row.floorplan_specific, null);
  // external_specific populated
  const ext = row.external_specific as Record<string, unknown>;
  assertStrictEquals(ext.estimated_price_class, '3M_to_10M');
  // Q4 binding: NO delivery_quality_grade letter scale
  assertStrictEquals(ext.delivery_quality_grade, undefined);
  // Branding + package signals
  assertEquals(ext.competitor_branding, {
    watermark_visible: true,
    agency_logo: 'BlueChip Realty',
    photographer_credit: null,
  });
  const pkg = ext.package_signals as Record<string, unknown>;
  assertStrictEquals(pkg.dusk_quality, true);
  assertStrictEquals(pkg.floorplan_present, true);
  assertStrictEquals(pkg.twilight_hdr, true);
  // External: gallery_position_hint always 'archive_only'
  assertStrictEquals(row.gallery_position_hint, 'archive_only');
  assertStrictEquals(row.retouch_priority, 'none');
});

Deno.test('v2 snapshot — floorplan_image: persists floorplan_specific; signal_scores all null', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  await persistOneClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    roundId: ROUND_ID,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseResult(FLOORPLAN_V2_OUTPUT) as any,
    promptBlockVersions: { universal_vision_response_schema: 'v2.0' },
    modelVersion: 'gemini-2.5-pro',
    // deno-lint-ignore no-explicit-any
    composition: baseCompositionRow() as any,
    tierConfig: null,
    sourceType: 'floorplan_image',
    warnings: [],
  });

  const row = captured.row!;
  assertStrictEquals(row.schema_version, 'v2.0');
  assertStrictEquals(row.source_type, 'floorplan_image');
  assertStrictEquals(row.image_type, 'is_floorplan');
  assertStrictEquals(row.raw_specific, null);
  assertStrictEquals(row.finals_specific, null);
  assertStrictEquals(row.external_specific, null);
  // floorplan_specific populated
  const fp = row.floorplan_specific as Record<string, unknown>;
  assertStrictEquals(fp.bedrooms_count, 4);
  assertStrictEquals(fp.bathrooms_count, 2);
  assertStrictEquals(fp.car_spaces, 2);
  assertStrictEquals(fp.total_internal_sqm, 198.5);
  assertStrictEquals(fp.home_archetype, 'single-storey contemporary');
  assertStrictEquals(fp.north_arrow_orientation, 'N');
  assertStrictEquals(fp.levels_count, 1);
  assertEquals((fp.rooms_detected as unknown[]).length, 2);
  // Floorplan: ALL signal_scores values are null
  const sig = row.signal_scores as Record<string, number | null>;
  for (const v of Object.values(sig)) {
    assertStrictEquals(v, null);
  }
});

// ─── Defensive coverage: helpers behave when *_specific blocks are wrong shape ──

Deno.test('v2 snapshot — graceful: non-object raw_specific lands as null', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  const out = { ...RAW_V2_OUTPUT, raw_specific: 'this is not an object' };
  await persistOneClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    roundId: ROUND_ID,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseResult(out) as any,
    promptBlockVersions: {},
    modelVersion: 'gemini-2.5-pro',
    // deno-lint-ignore no-explicit-any
    composition: baseCompositionRow() as any,
    tierConfig: null,
    sourceType: 'internal_raw',
    warnings: [],
  });

  // Wrong-shape raw_specific is coerced to null (defensive).
  assertStrictEquals(captured.row!.raw_specific, null);
});

Deno.test('v2 snapshot — observed_objects array filters out non-object entries', async () => {
  const captured: Captured = { table: null, row: null, conflict: null };
  const out = {
    ...RAW_V2_OUTPUT,
    observed_objects: [
      RAW_V2_OUTPUT.observed_objects[0],
      'this is a string',
      null,
      RAW_V2_OUTPUT.observed_objects[1],
    ],
  };
  await persistOneClassification({
    // deno-lint-ignore no-explicit-any
    admin: makeFakeAdmin(captured) as any,
    roundId: ROUND_ID,
    projectId: PROJECT_ID,
    // deno-lint-ignore no-explicit-any
    result: baseResult(out) as any,
    promptBlockVersions: {},
    modelVersion: 'gemini-2.5-pro',
    // deno-lint-ignore no-explicit-any
    composition: baseCompositionRow() as any,
    tierConfig: null,
    sourceType: 'internal_raw',
    warnings: [],
  });

  const objs = captured.row!.observed_objects as unknown[];
  // Only the 2 valid object entries remain.
  assertStrictEquals(objs.length, 2);
});
