/**
 * universalVisionResponseSchemaV2.ts — Wave 11.7.17 universal Stage 1 schema.
 *
 * Spec: docs/design-specs/W11-universal-vision-response-schema-v2.md §3
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 *
 * v1 of the universal schema (`stage1ResponseSchema.ts`, 22 signals + 4
 * aggregates) was authored before W11.7 production cutover. It conflated
 * "the schema" with "the producer". v2 separates the two cleanly: this
 * block IS the schema contract; the producer (Shape D Stage 1) is wired
 * in `shortlisting-shape-d/index.ts`.
 *
 * ─── Joseph's binding decisions (signed off 2026-05-01) ──────────────────────
 *
 * Q1 — image_type enum: ship the 11 options as listed in spec.
 *
 * Q2 — Lighting dimension: ADD 4 NEW lighting signals instead of computing
 *      lighting_score from existing technical signals. Total = 26 signals
 *      (22 from spec + 4 new lighting):
 *        - light_quality
 *        - light_directionality
 *        - color_temperature_appropriateness
 *        - light_falloff_quality
 *      `lighting_score` aggregate now computes from these 4.
 *
 * Q3 — Bounding boxes on observed_objects: DEFAULT ON. Stage 1 emits
 *      bounding_box: { x_pct, y_pct, w_pct, h_pct } on every observed_object
 *      by default. Required, not optional.
 *
 * Q4 — DROP `external_specific.delivery_quality_grade` letter scale.
 *      External listings get `combined_score` numeric only.
 *
 * Q5 — Nullable *_specific blocks: keep 4 nullable blocks; enforce via
 *      prompt + persist-layer validation.
 *
 * Q6 — HARD CUTOVER to v2.0. Existing v1 rows tagged 'v1.0' (immutable);
 *      new emissions are 'v2.0' from day one.
 *
 * Q7 — Floorplan: keep `floorplan_image` as its own source type.
 *
 * ─── Schema contract ─────────────────────────────────────────────────────────
 *
 * One fixed shape, regardless of source_type. The model receives the same
 * JSON Schema; what changes is which fields are populated, scored, or null.
 * Caller passes source_type as an input that drives prompt-side instruction
 * (see signalMeasurementBlock + sourceContextBlock); the schema itself is
 * fixed.
 *
 * Required fields (nullable values for source-inactive signals):
 *   schema_version, source, analysis, image_type, image_classification,
 *   signal_scores (object always present, values may be null),
 *   technical_score, lighting_score, composition_score, aesthetic_score,
 *   combined_score, quality_flags, key_elements, zones_visible,
 *   appeal_signals, concern_signals, retouch_priority, gallery_position_hint,
 *   requires_human_review, confidence_per_field, style_archetype, era_hint,
 *   material_palette_summary, embedding_anchor_text, shot_intent,
 *   observed_objects, observed_attributes, prompt_block_versions, vendor,
 *   model_version.
 *
 * Nullable per source: room_classification, listing_copy, raw_specific,
 * finals_specific, external_specific, floorplan_specific.
 *
 * ─── Block-architecture pattern ─────────────────────────────────────────────
 *
 * Pure exported tool name + JSON schema (W7.6 pattern). Versioned via
 * UNIVERSAL_VISION_RESPONSE_SCHEMA_VERSION so prompt-cache invalidation
 * tracks block changes. Persisted in
 * `composition_classifications.prompt_block_versions`.
 *
 * ─── GEMINI COMPATIBILITY (W11.7.17 hotfix-3) ───────────────────────────────
 *
 * Gemini's `responseSchema` is OpenAPI 3.0, NOT JSON Schema 2020-12 / OpenAPI
 * 3.1. The 3.1 type-array nullable form is REJECTED with a 400 INVALID_ARGUMENT
 * — every emission then silently fails over to Anthropic at ~12x the cost
 * (~$0.17/image vs ~$0.014/image on Gemini).
 *
 * REQUIRED CONVENTION for nullable fields in this schema:
 *
 *   FORBIDDEN (OpenAPI 3.1):    { type: ['string', 'null'] }
 *   REQUIRED  (OpenAPI 3.0):    { type: 'string', nullable: true }
 *
 *   FORBIDDEN nullable object:  { type: ['object', 'null'], properties: {...} }
 *   REQUIRED  nullable object:  { type: 'object', nullable: true, properties: {...} }
 *
 *   FORBIDDEN array w/ null items:    { items: { type: ['string', 'null'] } }
 *   REQUIRED  array w/ null items:    { items: { type: 'string', nullable: true } }
 *
 *   FORBIDDEN multi-type union:    { type: ['string', 'number', 'null'] }
 *   ACCEPTED  multi-type union:    pick a single primary type + nullable: true
 *                                  (Gemini does NOT support multi-type unions
 *                                  even without null — collapse to one type).
 *
 * Other Gemini responseSchema constraints (UNCHANGED):
 *   - no `$ref`
 *   - no `oneOf` / `anyOf`
 *   - no `patternProperties`
 *   - no `additionalProperties` (use `properties: {}` only)
 *   - no `minLength` / `maxLength` on strings (use `description` guidance)
 *   - `minItems`, `maxItems`, `enum`, `required` ARE honoured
 *
 * Future schema authors: when adding a nullable field, ALWAYS use
 * `nullable: true` next to a single primary `type`. The `geminiCompatibility`
 * test walks the schema tree and FAILS the build if any of the forbidden
 * patterns reappear.
 *
 * ─── PER-SOURCE SCHEMA VARIANTS (W11.7.17 hotfix-4) ─────────────────────────
 *
 * Hotfix-3 fixed the nullable annotation form (type-array → nullable: true)
 * but Gemini still rejected the schema with `"too many states for serving"`.
 * Root cause: Gemini's responseSchema validator runs the schema as an FSM and
 * has a hard state-count limit. The single-schema universal contract had FOUR
 * deeply-nested `*_specific` blocks (raw, finals, external, floorplan), each
 * with its own properties tree. Per emission only ONE block is populated, but
 * the schema declared all four → FSM blew the state ceiling.
 *
 * SOLUTION: per-source schema variants. We build FOUR separate Gemini
 * responseSchemas — one per source_type — each containing only its own
 * `*_specific` block plus the universal core. Caller picks the variant via
 * `universalSchemaForSource(source_type)`. The TypeScript discriminated union
 * `UniversalVisionResponseV2` is unchanged so downstream consumers (persist
 * layer, dimensionRollup, scoreRollup) read identical row shapes regardless
 * of which variant produced them. The DB columns are unchanged: all four
 * `*_specific` JSONB columns remain; persist writes whichever block the
 * variant emitted, leaves the others null.
 */

// W11.7.17 hotfix-5 (2026-05-02): import the canonical SPACE/ZONE vocabulary
// so the schema enum stays in lockstep with the prompt block + the SettingsUI
// dropdown source-of-truth. Drift between prompt vocabulary and schema enum
// would cause Gemini to reject the model's emission and silently fail over to
// Anthropic at 12x the cost — exactly the scenario hotfix-3 fixed structurally.
import {
  SPACE_TYPE_OPTIONS,
  ZONE_FOCUS_OPTIONS,
} from './spaceZoneTaxonomy.ts';

// W11.7.17 hotfix-4: bumped from v2.1 to v2.2 for per-source schema variants
// (Gemini FSM state-count fix). Schema SHAPE per variant is identical to v2.1
// for the populated *_specific block; the only change is splitting the single
// schema into 4 source-keyed variants. Bumped for downstream prompt-cache
// invalidation.
//
// W11.7.17 hotfix-5 (2026-05-02): bumped to v2.3. Adds three top-level fields
// the prompt has been teaching the model to emit since W11.6.13 but the closed
// responseSchema silently stripped on emission: `space_type`, `zone_focus`,
// `space_zone_count`. Persist read top-level keys that NEVER arrived → 100%
// NULL on these columns since the W11.7.17 cutover. Same bug class as F-D-002
// (image_classification gap fixed yesterday). Schema must DECLARE every field
// the prompt asks for or Gemini drops it.
export const UNIVERSAL_VISION_RESPONSE_SCHEMA_VERSION = 'v2.4';
export const UNIVERSAL_VISION_RESPONSE_TOOL_NAME = 'classify_image';

/**
 * Source discriminator. Defined locally to keep this block self-contained —
 * sourceContextBlock.ts re-exports the same union, but importing from there
 * would couple a pure schema block to a prompt-string renderer.
 */
export type SourceType =
  | 'internal_raw'
  | 'internal_finals'
  | 'external_listing'
  | 'floorplan_image';

/**
 * 26 per-signal measurement keys (0-10 scale).
 * 22 from the v1 spec + 4 new lighting signals (Q2 binding).
 *
 * Exported separately so unit tests + tier-config wiring can reference the
 * canonical key list without parsing the schema object.
 *
 * Scoring rubric (every signal):
 *   10  = exemplary (top 5% of professional output)
 *   7-9 = strong (publishable as-is)
 *   4-6 = competent (acceptable with minor remediation)
 *   1-3 = weak (needs significant rework)
 *   0   = catastrophic (unrecoverable / unusable)
 *   null = signal does not apply to this source/subject (RAW exposure_balance,
 *          floorplan composition_*, etc.)
 *
 * Each key's description in UNIVERSAL_VISION_RESPONSE_SCHEMA below is read
 * by the model as inline per-signal measurement instruction.
 */
export const UNIVERSAL_SIGNAL_KEYS = [
  // ─ Technical (6) ─
  'exposure_balance',
  'color_cast',
  'sharpness_subject',
  'sharpness_corners',
  'plumb_verticals',
  'perspective_distortion',
  // ─ Lighting (4 new — Q2 binding) ─
  'light_quality',
  'light_directionality',
  'color_temperature_appropriateness',
  'light_falloff_quality',
  // ─ Compositional (8) ─
  'depth_layering',
  'composition_geometry',
  'vantage_quality',
  'framing_quality',
  'leading_lines',
  'negative_space',
  'symmetry_quality',
  'foreground_anchor',
  // ─ Aesthetic / styling (4) ─
  'material_specificity',
  'period_reading',
  'styling_quality',
  'distraction_freeness',
  // ─ Workflow (4) ─
  'retouch_debt',
  'gallery_arc_position',
  'social_crop_survival',
  'brochure_print_survival',
] as const;

export type UniversalSignalKey = typeof UNIVERSAL_SIGNAL_KEYS[number];

/**
 * W11.6.22 — image_type 11-option enum (Q1 binding from this schema).
 *
 * Exported as a frozen array so the per-slot curated-position editor in
 * SettingsShortlistingSlots can render the dropdown without re-declaring
 * the list. Mirrors the inline `image_type` description in
 * UNIVERSAL_CORE_PROPERTIES below — DO NOT diverge.
 */
export const IMAGE_TYPE_OPTIONS = [
  'is_day',
  'is_dusk',
  'is_drone',
  'is_agent_headshot',
  'is_test_shot',
  'is_bts',
  'is_floorplan',
  'is_video_frame',
  'is_detail_shot',
  'is_facade_hero',
  'is_other',
] as const;
export type ImageTypeOption = typeof IMAGE_TYPE_OPTIONS[number];

/**
 * W11.6.22 — lighting_state 4-option enum (Q2 binding).
 *
 * Stage 1's `image_classification.is_dusk/is_day/is_golden_hour/is_night`
 * booleans roll up into one of these states. The curated-position editor
 * surfaces them as a dropdown for `preferred_lighting_state`.
 *
 * `golden_hour` is intentionally absent — it's a sub-state of either day
 * or dusk surfaced via signal scores, not as a top-level lighting_state.
 */
export const LIGHTING_STATE_OPTIONS = [
  'day',
  'dusk',
  'twilight',
  'night',
] as const;
export type LightingStateOption = typeof LIGHTING_STATE_OPTIONS[number];

/**
 * Mapping of each signal to its rollup dimension. Used by
 * `_shared/dimensionRollup.ts:computeAggregateScores` to produce the 4
 * aggregate axis scores from the 26 underlying signals.
 *
 * Q2 binding: lighting now has its own 4 dedicated signals; the lighting
 * aggregate is computed FROM them, not derived from technical.
 *
 * Workflow signals (retouch_debt, gallery_arc_position, social_crop_survival,
 * brochure_print_survival) are NOT mapped to any dimension — they're standalone
 * outputs (e.g. retouch_debt feeds retouch_priority/retouch_estimate_minutes).
 * `dimensionRollup.ts` filters them out by name, not by mapping presence.
 */
export const SIGNAL_TO_DIMENSION: Partial<Record<UniversalSignalKey, 'technical' | 'lighting' | 'composition' | 'aesthetic'>> = {
  // technical
  exposure_balance: 'technical',
  color_cast: 'technical',
  sharpness_subject: 'technical',
  sharpness_corners: 'technical',
  plumb_verticals: 'technical',
  perspective_distortion: 'technical',
  // lighting (4 new signals — Q2)
  light_quality: 'lighting',
  light_directionality: 'lighting',
  color_temperature_appropriateness: 'lighting',
  light_falloff_quality: 'lighting',
  // composition
  depth_layering: 'composition',
  composition_geometry: 'composition',
  vantage_quality: 'composition',
  framing_quality: 'composition',
  leading_lines: 'composition',
  negative_space: 'composition',
  symmetry_quality: 'composition',
  foreground_anchor: 'composition',
  // aesthetic
  material_specificity: 'aesthetic',
  period_reading: 'aesthetic',
  styling_quality: 'aesthetic',
  distraction_freeness: 'aesthetic',
};

// ─── Schema definition (Gemini responseSchema-compatible) ───────────────────

const SIGNAL_SCORE_PROP = (description: string): Record<string, unknown> => ({
  type: 'number',
  nullable: true,
  description,
});

const SIGNAL_SCORES_SCHEMA: Record<string, unknown> = {
  type: 'object',
  description:
    'W11.7.17 v2: per-signal 0-10 scores. 26 signals total = 22 from v1 + 4 ' +
    'new lighting signals (Q2 binding). Score 0-10 OR null. 10=exemplary; ' +
    '7-9=strong; 4-6=competent; 1-3=weak; 0=catastrophic. NULL when the ' +
    'signal does not apply to this source/subject (e.g. RAW exposure_balance ' +
    'is null because brackets are pre-merge; floorplan composition_* is null ' +
    'because architectural drawings have no aesthetic frame). The 4 ' +
    'aggregate axis scores (technical/lighting/composition/aesthetic) ' +
    'are weighted rollups of these signals — be internally consistent.',
  properties: {
    // ─ Technical (6) ─
    exposure_balance: SIGNAL_SCORE_PROP(
      '0-10: highlights AND shadows held without clipping. 10=both ends ' +
        'preserved; 5=one end clips; 0=both ends blow out. RAW source: ' +
        'NULL (HDR merge will resolve). Finals: scored — blowout is hard-fail. ' +
        'External: scored observationally only. Floorplan: NULL.',
    ),
    color_cast: SIGNAL_SCORE_PROP(
      '0-10: white balance neutrality. 10=neutral whites and skin tones; ' +
        'lower as cast strengthens (warm orange, cool blue, magenta/green). ' +
        'Mixed-light scenes get partial credit for hero-zone neutrality. ' +
        'Floorplan: NULL.',
    ),
    sharpness_subject: SIGNAL_SCORE_PROP(
      '0-10: focus accuracy on the hero subject. 10=razor-crisp on intended ' +
        'hero zone; 5=soft but recognisable; 0=motion-blurred or mis-focused ' +
        'beyond recovery. Floorplan: NULL.',
    ),
    sharpness_corners: SIGNAL_SCORE_PROP(
      '0-10: lens corner sharpness. 10=uniformly crisp edge-to-edge; ' +
        '5=visible corner softness expected of wide-aperture wide-angle; ' +
        '0=corners smeared or coma-distorted. Floorplan: NULL.',
    ),
    plumb_verticals: SIGNAL_SCORE_PROP(
      '0-10: vertical lines vertical or converging? 10=walls plumb, no ' +
        'keystoning; 5=mild lean correctable in post; 0=severe converging ' +
        'verticals. RAW: soft penalty (correctable). Finals: hard threshold. ' +
        'Floorplan: NULL.',
    ),
    perspective_distortion: SIGNAL_SCORE_PROP(
      '0-10: wide-angle stretch — appropriate or excessive? 10=no visible ' +
        'distortion; 5=mild stretch typical of 16-24mm; 0=severe ' +
        'barrel/pincushion. Floorplan: NULL.',
    ),
    // ─ Lighting (4 new — Q2 binding) ─
    light_quality: SIGNAL_SCORE_PROP(
      '0-10: overall lighting CHARACTER and quality. 10=beautiful, ' +
        'evocative light that flatters the subject (golden-hour warmth, ' +
        'soft north-facing daylight, evenly-modulated dusk); 5=adequate ' +
        'ambient light, no character; 0=harsh fluorescent overheads, mixed ' +
        'colour temperature chaos, or flat featureless light. RAW: scored ' +
        '(implicit in the bracket). Finals: scored. External: observational. ' +
        'Floorplan: NULL.',
    ),
    light_directionality: SIGNAL_SCORE_PROP(
      '0-10: direction of light and how it shapes the subject. 10=clear, ' +
        'intentional direction that reveals form (raking side-light on ' +
        'textured walls, top-back rim on architectural detail); 5=neutral ' +
        'frontal/ambient with no shaping; 0=lighting works against the ' +
        'subject (e.g. hot spot on background, subject in shadow). ' +
        'RAW: scored. Finals: scored. External: observational. ' +
        'Floorplan: NULL.',
    ),
    color_temperature_appropriateness: SIGNAL_SCORE_PROP(
      '0-10: white balance MATCHES the scene the photographer is selling. ' +
        '10=tonally consistent with the property style (warm interiors for ' +
        'period homes, neutral cool for contemporary, dusk-amber for twilight ' +
        'sets); 5=slightly off but recoverable; 0=jarring mixed white ' +
        'balance or wrong temperature for the era/style. ' +
        'RAW: scored. Finals: scored — should be locked. External: ' +
        'observational. Floorplan: NULL.',
    ),
    light_falloff_quality: SIGNAL_SCORE_PROP(
      '0-10: gradient and rolloff between bright and shadow zones. ' +
        '10=smooth, photographic falloff that creates depth (gentle window ' +
        'wash gradient onto a wall, soft shadow into ceiling line); 5=hard ' +
        'edges between zones but not distracting; 0=harsh sharp-edged ' +
        'shadows, banding, or flash-flat with no falloff at all. ' +
        'RAW: scored. Finals: scored. External: observational. ' +
        'Floorplan: NULL.',
    ),
    // ─ Compositional (8) ─
    depth_layering: SIGNAL_SCORE_PROP(
      '0-10: foreground / middleground / background separation. 10=three ' +
        'distinct planes; 5=two planes; 0=flat single-plane. ' +
        'Floorplan: NULL.',
    ),
    composition_geometry: SIGNAL_SCORE_PROP(
      '0-10: rule of thirds, leading lines, symmetry — geometric strength of ' +
        'the frame. 10=textbook; 5=adequate; 0=chaotic. Floorplan: NULL.',
    ),
    vantage_quality: SIGNAL_SCORE_PROP(
      '0-10: camera position appropriateness for subject. 10=ideal vantage; ' +
        '5=workable; 0=wrong vantage. Floorplan: NULL.',
    ),
    framing_quality: SIGNAL_SCORE_PROP(
      '0-10: subject placement and breathing room. 10=intentional framing; ' +
        '5=cramped or floating; 0=amputated by frame edge. Floorplan: NULL.',
    ),
    leading_lines: SIGNAL_SCORE_PROP(
      '0-10: do lines pull the eye toward the subject? 10=strong convergence ' +
        'on hero; 5=neutral; 0=lines lead AWAY. Score 5 if no lines present. ' +
        'Floorplan: NULL.',
    ),
    negative_space: SIGNAL_SCORE_PROP(
      '0-10: intentional vs accidental negative space. 10=amplifies subject; ' +
        '5=neutral; 0=dead air. Floorplan: NULL.',
    ),
    symmetry_quality: SIGNAL_SCORE_PROP(
      '0-10: when symmetry is the intent, how well executed? 10=pixel-' +
        'perfect; 5=near-symmetric off; 0=badly broken. NULL when not a ' +
        'symmetrical composition or for floorplans.',
    ),
    foreground_anchor: SIGNAL_SCORE_PROP(
      '0-10: anchoring foreground element. 10=strong anchor; 5=some ' +
        'foreground but not anchoring; 0=no foreground, frame floats. ' +
        'Floorplan: NULL.',
    ),
    // ─ Aesthetic / styling (4) ─
    material_specificity: SIGNAL_SCORE_PROP(
      '0-10: how specifically can materials be identified? 10=specific ' +
        'material name (Caesarstone Calacatta, spotted gum); 5=generic ' +
        '("stone benchtop"); 0=materials unreadable. Floorplan: NULL.',
    ),
    period_reading: SIGNAL_SCORE_PROP(
      '0-10: era/architectural style legibility. 10=unambiguous era; ' +
        '5=mixed signals; 0=unreadable. Floorplan: scored from drawing legend.',
    ),
    styling_quality: SIGNAL_SCORE_PROP(
      '0-10: intentional vs neglected styling. 10=magazine-level; 5=lived-in; ' +
        '0=visibly cluttered or pre-styling. Floorplan: NULL.',
    ),
    distraction_freeness: SIGNAL_SCORE_PROP(
      '0-10: clutter, power lines, neighbours, errant objects. 10=clean ' +
        'frame; 5=minor distractions; 0=major distractions. Floorplan: NULL.',
    ),
    // ─ Workflow (4) ─
    retouch_debt: SIGNAL_SCORE_PROP(
      '0-10: total retouch work the editor will need. HIGHER score = LESS ' +
        'debt. 10=no retouch debt; 5=standard retouch; 0=major retouch. ' +
        'Floorplan: NULL.',
    ),
    gallery_arc_position: SIGNAL_SCORE_PROP(
      '0-10: pre-Stage-4 hint at gallery placement value. 10=lead-image ' +
        'candidate; 5=mid-gallery; 0=archive-only. Floorplan: NULL.',
    ),
    social_crop_survival: SIGNAL_SCORE_PROP(
      '0-10: does a 1:1 Instagram crop preserve the subject? 10=centre ' +
        'square preserves hero; 5=mostly preserved; 0=subject lost. ' +
        'Floorplan: NULL.',
    ),
    brochure_print_survival: SIGNAL_SCORE_PROP(
      '0-10: print-quality at A4 brochure size. 10=print-ready; 5=adequate ' +
        'for digital, marginal in print; 0=artefacts. Floorplan: NULL.',
    ),
  },
  required: [...UNIVERSAL_SIGNAL_KEYS],
};

const IMAGE_CLASSIFICATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  description:
    'Image-level classification (always required). Drives downstream ' +
    'routing: agent_headshot/bts/test_shot quarantine, drone partitioning, ' +
    'video frame handling.',
  properties: {
    is_relevant_property_content: { type: 'boolean' },
    subject: {
      type: 'string',
      description:
        'One of: interior | exterior | drone | detail | floorplan | ' +
        'agent_headshot | test_shot | bts | equipment | video_thumbnail | other.',
    },
    is_dusk: { type: 'boolean' },
    is_day: { type: 'boolean' },
    is_golden_hour: { type: 'boolean' },
    is_night: { type: 'boolean' },
    time_of_day_confidence: { type: 'number' },
    is_drone: { type: 'boolean' },
    drone_type: {
      type: 'string',
      nullable: true,
      description:
        'One of: orbit_oblique | nadir | elevation_rise | null when not a drone shot.',
    },
    is_video_frame: { type: 'boolean' },
    quarantine_reason: {
      type: 'string',
      nullable: true,
      description:
        'One of: agent_headshot | bts | test_shot | equipment | corrupt_frame | ' +
        'severe_underexposure | null when no quarantine reason applies.',
    },
  },
  required: [
    'is_relevant_property_content',
    'subject',
    'is_dusk',
    'is_day',
    'is_golden_hour',
    'is_night',
    'time_of_day_confidence',
    'is_drone',
    'is_video_frame',
  ],
};

const ROOM_CLASSIFICATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  nullable: true,
  description:
    'Room/composition classification. NULL when the source is a floorplan ' +
    'or when the subject is not a single-room interior/exterior shot.',
  properties: {
    room_type: { type: 'string' },
    room_type_confidence: { type: 'number' },
    composition_type: { type: 'string' },
    vantage_point: {
      type: 'string',
      description:
        'One of: interior_looking_out | exterior_looking_in | neutral | ' +
        'low_angle | high_angle | eye_level_through_threshold | ' +
        'aerial_oblique | aerial_nadir.',
    },
    is_styled: { type: 'boolean' },
    indoor_outdoor_visible: { type: 'boolean' },
    eligible_for_exterior_rear: { type: 'boolean' },
  },
  required: ['room_type', 'composition_type', 'vantage_point'],
};

const OBSERVED_OBJECTS_SCHEMA: Record<string, unknown> = {
  type: 'array',
  description:
    'Wave 12 object registry feed. List every distinguishable object/feature ' +
    'in the frame. Q3 binding: bounding_box is REQUIRED on each entry by ' +
    'default — emit { x_pct, y_pct, w_pct, h_pct } as 0-100 percentages of ' +
    'the frame width/height.',
  items: {
    type: 'object',
    properties: {
      raw_label: {
        type: 'string',
        description:
          'Specific multi-noun label from the photographer/architect ' +
          'vocabulary. GOOD: "shaker-style cabinetry", "gooseneck mixer tap", ' +
          '"casement window with venetian blinds". FORBIDDEN: "cabinetry", ' +
          '"tap", "window".',
      },
      proposed_canonical_id: {
        type: 'string',
        nullable: true,
        description:
          'When the raw_label matches a known canonical object_id from the ' +
          'CANONICAL FEATURE REGISTRY block, emit that id; else null.',
      },
      confidence: { type: 'number' },
      bounding_box: {
        type: 'object',
        description:
          'Q3 binding (DEFAULT ON): bounding box in 0-100 percentage of ' +
          'frame width/height. x_pct/y_pct = top-left corner; w_pct/h_pct = ' +
          'width/height in percent. Always populate.',
        properties: {
          x_pct: { type: 'number' },
          y_pct: { type: 'number' },
          w_pct: { type: 'number' },
          h_pct: { type: 'number' },
        },
        required: ['x_pct', 'y_pct', 'w_pct', 'h_pct'],
      },
      attributes: {
        type: 'object',
        description:
          'Free-form key/value attributes. Use the W12 attribute keys ' +
          'when known (material, color_family, finish, era).',
      },
    },
    required: ['raw_label', 'confidence', 'bounding_box'],
  },
};

const OBSERVED_ATTRIBUTES_SCHEMA: Record<string, unknown> = {
  type: 'array',
  description:
    'Wave 12 attribute registry feed. Each entry is a single ' +
    'attribute observation, optionally anchored to an object label.',
  items: {
    type: 'object',
    properties: {
      raw_label: { type: 'string' },
      canonical_attribute_id: { type: 'string', nullable: true },
      canonical_value_id: { type: 'string', nullable: true },
      confidence: { type: 'number' },
      object_anchor: {
        type: 'string',
        nullable: true,
        description:
          'When this attribute belongs to a specific observed_object, anchor ' +
          'by that object\'s raw_label or proposed_canonical_id.',
      },
    },
    required: ['raw_label', 'confidence'],
  },
};

const QUALITY_FLAGS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  description:
    'Quality / workflow flags. clutter_severity, clutter_detail and ' +
    'flag_for_retouching are scored on internal sources; ' +
    'flag_for_retouching is always FALSE for external_listing (we observe, ' +
    "we don't reject). is_near_duplicate_candidate is scored on all sources.",
  properties: {
    clutter_severity: {
      type: 'string',
      nullable: true,
      description:
        'One of: none | minor_photoshoppable | moderate_retouch | major_reject | null. ' +
        'NULL on floorplan_image.',
    },
    clutter_detail: { type: 'string', nullable: true },
    flag_for_retouching: { type: 'boolean' },
    is_near_duplicate_candidate: { type: 'boolean' },
  },
  required: ['flag_for_retouching', 'is_near_duplicate_candidate'],
};

const SOURCE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  description:
    'Caller-provided source metadata. Echoed back for provenance. Drives ' +
    "the model's interpretation of every other field via the prompt-side " +
    'sourceContextBlock + signalMeasurementBlock.',
  properties: {
    type: {
      type: 'string',
      description:
        'One of: internal_raw | internal_finals | external_listing | floorplan_image.',
    },
    media_kind: {
      type: 'string',
      description:
        'One of: still_image | video_frame | drone_image | floorplan_image.',
    },
    is_hdr_bracket: { type: 'boolean', nullable: true },
    is_post_edit: { type: 'boolean', nullable: true },
    external_url: { type: 'string', nullable: true },
    listing_id: { type: 'string', nullable: true },
    bracket_index: { type: 'number', nullable: true },
    bracket_count: { type: 'number', nullable: true },
    property_tier: {
      type: 'string',
      nullable: true,
      description: 'One of: premium | standard | approachable | null.',
    },
  },
  required: ['type', 'media_kind'],
};

const RAW_SPECIFIC_SCHEMA: Record<string, unknown> = {
  type: 'object',
  nullable: true,
  description:
    'RAW-only signals. Populate when source.type=internal_raw; NULL otherwise. ' +
    'Q5 binding: leave the other 3 *_specific blocks set to null.',
  properties: {
    luminance_class: {
      type: 'string',
      description: 'One of: underexposed | balanced | overexposed.',
    },
    is_aeb_zero: {
      type: 'boolean',
      description:
        'TRUE when this is the neutral EV0 frame of a Canon AEB sequence ' +
        '(neither EV-2/-1 nor EV+1/+2).',
    },
    bracket_recoverable: {
      type: 'boolean',
      description:
        'TRUE when the bracket can be merged to a publishable final without ' +
        'requiring a reshoot (signal-to-noise, blur, framing all acceptable).',
    },
  },
  required: ['luminance_class', 'is_aeb_zero', 'bracket_recoverable'],
};

const FINALS_SPECIFIC_SCHEMA: Record<string, unknown> = {
  type: 'object',
  nullable: true,
  description:
    'Finals-only signals. Populate when source.type=internal_finals; NULL ' +
    'otherwise. Look for post-processing artefacts (sky replacement, digital ' +
    'furniture, digital dusk, HDR halos, retouch errors). Q5 binding: leave ' +
    'the other 3 *_specific blocks set to null.',
  properties: {
    looks_post_processed: { type: 'boolean' },
    vertical_lines_corrected: { type: 'boolean' },
    color_grade_consistent_with_set: { type: 'boolean', nullable: true },
    sky_replaced: { type: 'boolean' },
    sky_replacement_halo_severity: { type: 'number', nullable: true },
    digital_furniture_present: { type: 'boolean' },
    digital_furniture_artefact_severity: { type: 'number', nullable: true },
    digital_dusk_applied: { type: 'boolean' },
    digital_dusk_oversaturation_severity: { type: 'number', nullable: true },
    window_blowout_severity: { type: 'number', nullable: true },
    shadow_recovery_score: { type: 'number', nullable: true },
    color_cast_score: { type: 'number', nullable: true },
    hdr_halo_severity: { type: 'number', nullable: true },
    retouch_artefact_severity: { type: 'number', nullable: true },
  },
  required: [
    'looks_post_processed',
    'vertical_lines_corrected',
    'sky_replaced',
    'digital_furniture_present',
    'digital_dusk_applied',
  ],
};

const EXTERNAL_SPECIFIC_SCHEMA: Record<string, unknown> = {
  type: 'object',
  nullable: true,
  description:
    'External listing observational signals. Populate when ' +
    "source.type=external_listing; NULL otherwise. Q4 binding: NO " +
    "delivery_quality_grade letter scale — combined_score numeric only. " +
    'Q5 binding: leave the other 3 *_specific blocks set to null.',
  properties: {
    estimated_price_class: {
      type: 'string',
      description: 'One of: sub_1M | 1M_to_3M | 3M_to_10M | 10M_plus | unknown.',
    },
    competitor_branding: {
      type: 'object',
      properties: {
        watermark_visible: { type: 'boolean' },
        agency_logo: { type: 'string', nullable: true },
        photographer_credit: { type: 'string', nullable: true },
      },
      required: ['watermark_visible'],
    },
    package_signals: {
      type: 'object',
      description:
        'Detect what products the competing agency offered: dusk, drone, ' +
        'video, floorplan, agent watermark, twilight HDR.',
      properties: {
        dusk_quality: { type: 'boolean' },
        drone_perspective: { type: 'boolean' },
        video_thumbnail: { type: 'boolean' },
        floorplan_present: { type: 'boolean' },
        twilight_hdr: { type: 'boolean' },
        photo_count_in_listing: { type: 'number', nullable: true },
      },
      required: [
        'dusk_quality',
        'drone_perspective',
        'video_thumbnail',
        'floorplan_present',
        'twilight_hdr',
      ],
    },
  },
  required: ['estimated_price_class', 'competitor_branding', 'package_signals'],
};

const FLOORPLAN_SPECIFIC_SCHEMA: Record<string, unknown> = {
  type: 'object',
  nullable: true,
  description:
    'Floorplan OCR-style signals. Populate when source.type=floorplan_image; ' +
    'NULL otherwise. Q5 binding: leave the other 3 *_specific blocks set ' +
    "to null. cross_check_flags records mismatches against the CRM project's " +
    'declared bedrooms/bathrooms/sqm — feeds W11.5 and W11.6.',
  properties: {
    rooms_detected: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          room_label: { type: 'string' },
          canonical_room_type: { type: 'string', nullable: true },
          area_sqm: { type: 'number', nullable: true },
          dimensions_text: { type: 'string', nullable: true },
        },
        required: ['room_label'],
      },
    },
    total_internal_sqm: { type: 'number', nullable: true },
    bedrooms_count: { type: 'number', nullable: true },
    bathrooms_count: { type: 'number', nullable: true },
    car_spaces: { type: 'number', nullable: true },
    home_archetype: { type: 'string', nullable: true },
    north_arrow_orientation: {
      type: 'string',
      nullable: true,
      description: 'One of: N | NE | E | SE | S | SW | W | NW | null.',
    },
    levels_count: { type: 'number', nullable: true },
    cross_check_flags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          flag: { type: 'string' },
          // W11.7.17 hotfix-3: Gemini does NOT support multi-type unions —
          // collapsed to `string` (with nullable). Numeric CRM values like
          // bedrooms/bathrooms render perfectly well as their string form
          // ("3", "2.5") so the model can stringify before emit. The
          // persist layer accepts both.
          crm_value: { type: 'string', nullable: true },
          floorplan_value: { type: 'string', nullable: true },
        },
        required: ['flag'],
      },
    },
  },
  required: ['rooms_detected', 'cross_check_flags'],
};

const LISTING_COPY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  nullable: true,
  description:
    'Per-image listing copy. Populated for internal sources only ' +
    "(internal_raw, internal_finals); NULL for external_listing (we don't " +
    'write copy for competitor images) and floorplan_image (no aesthetic frame).',
  properties: {
    headline: { type: 'string' },
    paragraphs: { type: 'string' },
  },
  required: ['headline', 'paragraphs'],
};

/**
 * Universal core properties shared by ALL 4 source variants.
 *
 * The properties below are present in every variant of the schema regardless
 * of source_type. Source-specific blocks (raw_specific / finals_specific /
 * external_specific / floorplan_specific) are added by `universalSchemaForSource`
 * — only the variant matching the caller's source_type ships in the
 * Gemini responseSchema, keeping the FSM state count under the serving limit.
 */
const UNIVERSAL_CORE_PROPERTIES: Record<string, unknown> = {
  schema_version: {
    type: 'string',
    description: "Echo '2.3' — Wave 11.7.17 hotfix-5 (space_type/zone_focus/space_zone_count fields restored after silent strip).",
  },
  source: SOURCE_SCHEMA,
  analysis: {
    type: 'string',
    description:
      'Write 5-7 detailed sentences (~250 words minimum) covering: ' +
      '(1) composition geometry, vantage and depth layering; ' +
      '(2) lighting condition, exposure stage, tonal balance; ' +
      '(3) distinguishing architectural features and materials with specific ' +
      'descriptors (e.g. "Corinthian column with capital", "terracotta hipped ' +
      'roof", "shaker cabinetry"); ' +
      '(4) styling state, distractions, clutter, retouch concerns; ' +
      '(5) hero-shot vs supporting-angle judgement with reasoning. ' +
      'Floorplan images: describe the LAYOUT (rooms, flow, archetype) ' +
      'rather than aesthetics.',
  },
  image_type: {
    type: 'string',
    description:
      'Q1 binding (11 options): is_day | is_dusk | is_drone | ' +
      'is_agent_headshot | is_test_shot | is_bts | is_floorplan | ' +
      'is_video_frame | is_detail_shot | is_facade_hero | is_other.',
  },
  image_classification: IMAGE_CLASSIFICATION_SCHEMA,
  room_classification: ROOM_CLASSIFICATION_SCHEMA,
  // ─── W11.7.17 hotfix-5 (2026-05-02): SPACE/ZONE top-level triplet ──────────
  // The spaceZoneTaxonomy prompt block (W11.6.13) has been teaching the model
  // to emit these three fields for ~3 weeks, but the closed responseSchema
  // never declared them — Gemini's structured-output mode silently strips any
  // emitted property not in the schema → persist saw NULL on every row since
  // the W11.7.17 cutover (2026-05-01). Declaring them here closes the loop.
  // The enums mirror SPACE_TYPE_OPTIONS / ZONE_FOCUS_OPTIONS from
  // spaceZoneTaxonomy.ts so the schema, prompt, and SettingsUI stay in lockstep.
  space_type: {
    type: 'string',
    // W11.7.x (2026-05-02): closed `enum: [...SPACE_TYPE_OPTIONS]` (32 entries)
    // combined with ZONE_FOCUS_OPTIONS (29 entries) plus the rest of the v2
    // schema tipped Gemini's "schema produces a constraint that has too many
    // states for serving" threshold intermittently — Stage 1 succeeded for
    // some rounds and 400'd for others depending on Gemini's serving-capacity
    // weather. Same family of issue that bbb4337 fixed for Stage 4's slot_id
    // enum. Drop the closed enum, teach the canonical list inline in the
    // description (the spaceZoneTaxonomyBlock prompt also lists them in the
    // user-prompt portion). Persistence-layer normalisation collapses any
    // drift; non-canonical strings are tolerated rather than dropped.
    description:
      'W11.6.13 ARCHITECTURAL ENCLOSURE (the 4 walls). Use ONE OF the canonical ' +
      `${SPACE_TYPE_OPTIONS.length} space_type values: ${SPACE_TYPE_OPTIONS.join(', ')}. ` +
      'Pick the most-specific match. Distinct from zone_focus: in studios and ' +
      'open-plan apartments ONE space contains MANY zones. A shot of the ' +
      'dining table inside a combined living/dining envelope is ' +
      'space_type=living_dining_combined, zone_focus=dining_table — distinct ' +
      'from a shot of a dedicated dining room (space_type=dining_room_dedicated). ' +
      'See spaceZoneTaxonomyBlock for canonical reasoning. Floorplan images: ' +
      'pick the dominant enclosure type (often the open-plan envelope).',
  },
  zone_focus: {
    type: 'string',
    // See space_type comment above for the closed-enum-drop rationale.
    description:
      'W11.6.13 COMPOSITIONAL SUBJECT of the shot — what the photographer is ' +
      `actually showing inside the architectural enclosure. Use ONE OF the ` +
      `canonical ${ZONE_FOCUS_OPTIONS.length} zone_focus values: ${ZONE_FOCUS_OPTIONS.join(', ')}. ` +
      'Even single-zone shots benefit: a master bedroom shot is ' +
      'space_type=master_bedroom, zone_focus=bed_focal vs wardrobe_built_in vs ' +
      'window_view depending on what the frame highlights. The engine uses ' +
      'this alongside space_type to drive slot eligibility and clean training data.',
  },
  space_zone_count: {
    type: 'integer',
    description:
      'W11.6.13 integer hint for total distinct zones visible in the frame: ' +
      '1 = single-purpose enclosed room (dedicated bedroom, dedicated ' +
      'bathroom); 2-4 = multi-zone open plan (living/dining combined = 2; ' +
      'kitchen+dining+living = 3); 5+ = studio-style (kitchen + bed + lounge ' +
      '+ bathroom in one envelope). Optional — only emit when zones are ' +
      'distinguishable. Floorplan: count rooms visible in the drawing.',
  },
  observed_objects: OBSERVED_OBJECTS_SCHEMA,
  observed_attributes: OBSERVED_ATTRIBUTES_SCHEMA,
  signal_scores: SIGNAL_SCORES_SCHEMA,
  technical_score: { type: 'number' },
  lighting_score: { type: 'number' },
  composition_score: { type: 'number' },
  aesthetic_score: { type: 'number' },
  combined_score: { type: 'number' },
  quality_flags: QUALITY_FLAGS_SCHEMA,
  key_elements: {
    type: 'array',
    minItems: 0,
    description:
      'List specific architectural and styling elements visible in the frame. ' +
      'Use multi-noun phrases including a material or descriptor. ' +
      'Floorplan: room labels and dimensions when visible. Empty array OK ' +
      'for sources where this does not apply.',
    items: { type: 'string' },
  },
  zones_visible: {
    type: 'array',
    minItems: 0,
    description:
      'Distinct functional zones visible in the frame (e.g. "kitchen", ' +
      '"alfresco_through_doors"). Different from key_elements — these ' +
      'are AREAS, not objects.',
    items: { type: 'string' },
  },
  listing_copy: LISTING_COPY_SCHEMA,
  appeal_signals: {
    type: 'array',
    description:
      'Marketing-relevant positives. snake_case tokens. Empty array if none.',
    items: { type: 'string' },
  },
  concern_signals: {
    type: 'array',
    description:
      'Marketing-relevant negatives. snake_case tokens. Empty array if none.',
    items: { type: 'string' },
  },
  buyer_persona_hints: {
    type: 'array',
    description: 'Up to 3 likely buyer personas. snake_case tokens.',
    items: { type: 'string' },
  },
  retouch_priority: {
    type: 'string',
    description:
      'One of: urgent | recommended | none. external_listing: always "none". ' +
      'floorplan_image: always "none".',
  },
  retouch_estimate_minutes: { type: 'number', nullable: true },
  gallery_position_hint: {
    type: 'string',
    description:
      'One of: lead_image | early_gallery | late_gallery | archive_only. ' +
      'external_listing: always "archive_only". floorplan_image: ' +
      'always "archive_only".',
  },
  social_first_friendly: { type: 'boolean', nullable: true },
  requires_human_review: { type: 'boolean' },
  confidence_per_field: {
    type: 'object',
    description:
      '0-1 self-reported confidence. Use 1.0 only when the evidence is ' +
      'unambiguous. Drop below 0.7 when an operator should eyeball this row.',
    properties: {
      room_type: { type: 'number' },
      scoring: { type: 'number' },
      classification: { type: 'number' },
    },
    required: ['room_type', 'scoring', 'classification'],
  },
  style_archetype: { type: 'string', nullable: true },
  era_hint: { type: 'string', nullable: true },
  material_palette_summary: {
    type: 'array',
    description:
      'Top materials by visual weight. Specific phrases ("face brick", ' +
      '"Caesarstone benchtop"). Empty array if no materials visible.',
    items: { type: 'string' },
  },
  embedding_anchor_text: {
    type: 'string',
    description:
      '~50-word concise summary optimised for vector embedding. Lead with ' +
      'the most distinctive content tokens.',
  },
  searchable_keywords: {
    type: 'array',
    description: '5-12 lowercase snake_case or single-word tokens.',
    items: { type: 'string' },
  },
  shot_intent: {
    type: 'string',
    nullable: true,
    description:
      'One of: hero_establishing | scale_clarification | lifestyle_anchor | ' +
      'material_proof | indoor_outdoor_connection | detail_specimen | ' +
      'record_only | reshoot_candidate | null.',
  },
  prompt_block_versions: {
    type: 'object',
    description:
      'Echo of the caller-injected prompt-block version map for replay ' +
      'reproducibility. The caller (Stage 1 orchestrator) populates this; ' +
      'the model is asked to echo it verbatim.',
  },
  vendor: {
    type: 'string',
    description: "Caller-injected vendor tag. One of: gemini | anthropic.",
  },
  model_version: {
    type: 'string',
    description: 'Caller-injected model version tag.',
  },
};

/**
 * `required` keys universal to every variant. Each variant's `required`
 * array is identical: only one `*_specific` block is declared per variant
 * and we do not require it (the field name itself depends on source_type).
 */
export const UNIVERSAL_CORE_REQUIRED: string[] = [
  'schema_version',
  'source',
  'analysis',
  'image_type',
  'image_classification',
  // W11.7.17 hotfix-5: space_type / zone_focus are REQUIRED. The model has
  // been emitting them via the prompt block since W11.6.13; making them
  // schema-required guarantees Gemini will validate-or-retry rather than
  // silently dropping them. space_zone_count remains optional — it's a hint,
  // not a hard signal, and forcing it would over-constrain on shots where
  // zone count is genuinely ambiguous (e.g. wide hallway-into-multiple-rooms).
  'space_type',
  'zone_focus',
  'signal_scores',
  'technical_score',
  'lighting_score',
  'composition_score',
  'aesthetic_score',
  'combined_score',
  'quality_flags',
  'key_elements',
  'zones_visible',
  'appeal_signals',
  'concern_signals',
  'retouch_priority',
  'gallery_position_hint',
  'requires_human_review',
  'confidence_per_field',
  'style_archetype',
  'era_hint',
  'material_palette_summary',
  'embedding_anchor_text',
  'shot_intent',
  'observed_objects',
  'observed_attributes',
  'prompt_block_versions',
  'vendor',
  'model_version',
];

/**
 * Build the Gemini-compatible responseSchema for a specific source_type.
 *
 * Returns ONLY the universal core + the single matching `*_specific` block
 * (or no `*_specific` block at all in the unlikely event the FSM is still
 * tight — but all four are tried). The TypeScript discriminated union shape
 * for downstream consumers (`UniversalVisionResponseV2`) still includes all
 * four blocks as nullable members; the persist layer keys off
 * `composition_classifications.source_type` to choose which JSONB column to
 * populate.
 *
 * Hotfix-4 motivation: Gemini's responseSchema validator runs the full
 * schema as an FSM and capped the state count when all four nested
 * `*_specific` blocks were declared together. Per-source variants drop the
 * three irrelevant blocks per call → FSM stays under budget.
 */
export function universalSchemaForSource(source_type: SourceType): Record<string, unknown> {
  const properties: Record<string, unknown> = { ...UNIVERSAL_CORE_PROPERTIES };
  switch (source_type) {
    case 'internal_raw':
      properties.raw_specific = RAW_SPECIFIC_SCHEMA;
      break;
    case 'internal_finals':
      properties.finals_specific = FINALS_SPECIFIC_SCHEMA;
      break;
    case 'external_listing':
      properties.external_specific = EXTERNAL_SPECIFIC_SCHEMA;
      break;
    case 'floorplan_image':
      properties.floorplan_specific = FLOORPLAN_SPECIFIC_SCHEMA;
      break;
  }
  return {
    type: 'object',
    properties,
    required: [...UNIVERSAL_CORE_REQUIRED],
  };
}

/**
 * @deprecated Use `universalSchemaForSource(source_type)` instead.
 *
 * Kept as a backwards-compat default for tests / fixtures that have not yet
 * migrated. Resolves to the `internal_raw` variant — the production hot path
 * for Stage 1 RAW classification. New callers MUST pick a variant explicitly
 * via `universalSchemaForSource`; emitting all four `*_specific` blocks at
 * once is what triggered the Gemini FSM state-count rejection in hotfix-4.
 */
export const UNIVERSAL_VISION_RESPONSE_SCHEMA: Record<string, unknown> = universalSchemaForSource('internal_raw');

/**
 * v2 schema TypeScript shape — exported for unit-test fixtures and the
 * persist-layer typing in `shortlisting-shape-d/index.ts`.
 */
export interface UniversalVisionResponseV2 {
  schema_version: '2.0' | '2.1' | '2.2' | '2.3';
  source: {
    type: 'internal_raw' | 'internal_finals' | 'external_listing' | 'floorplan_image';
    media_kind: 'still_image' | 'video_frame' | 'drone_image' | 'floorplan_image';
    is_hdr_bracket?: boolean | null;
    is_post_edit?: boolean | null;
    external_url?: string | null;
    listing_id?: string | null;
    bracket_index?: number | null;
    bracket_count?: number | null;
    property_tier?: 'premium' | 'standard' | 'approachable' | null;
  };
  analysis: string;
  image_type:
    | 'is_day' | 'is_dusk' | 'is_drone' | 'is_agent_headshot'
    | 'is_test_shot' | 'is_bts' | 'is_floorplan' | 'is_video_frame'
    | 'is_detail_shot' | 'is_facade_hero' | 'is_other';
  image_classification: {
    is_relevant_property_content: boolean;
    subject:
      | 'interior' | 'exterior' | 'drone' | 'detail'
      | 'floorplan' | 'agent_headshot' | 'test_shot' | 'bts'
      | 'equipment' | 'video_thumbnail' | 'other';
    is_dusk: boolean;
    is_day: boolean;
    is_golden_hour: boolean;
    is_night: boolean;
    time_of_day_confidence: number;
    is_drone: boolean;
    drone_type: 'orbit_oblique' | 'nadir' | 'elevation_rise' | null;
    is_video_frame: boolean;
    quarantine_reason:
      | 'agent_headshot' | 'bts' | 'test_shot' | 'equipment'
      | 'corrupt_frame' | 'severe_underexposure' | null;
  };
  room_classification: {
    room_type: string;
    room_type_confidence: number;
    composition_type: string;
    vantage_point:
      | 'interior_looking_out' | 'exterior_looking_in' | 'neutral'
      | 'low_angle' | 'high_angle' | 'eye_level_through_threshold'
      | 'aerial_oblique' | 'aerial_nadir';
    is_styled: boolean;
    indoor_outdoor_visible: boolean;
    eligible_for_exterior_rear: boolean;
  } | null;
  // W11.7.17 hotfix-5: SPACE/ZONE top-level triplet. Required pair + optional
  // count. Typed as `string` (not the canonical enum literal union) because
  // the persist layer accepts any string and falls back to NULL on unknown
  // tokens — over-strict typing here would force every test fixture to
  // import the full SPACE_TYPE_OPTIONS / ZONE_FOCUS_OPTIONS arrays.
  space_type: string;
  zone_focus: string;
  space_zone_count?: number | null;
  observed_objects: Array<{
    raw_label: string;
    proposed_canonical_id: string | null;
    confidence: number;
    bounding_box: {
      x_pct: number; y_pct: number;
      w_pct: number; h_pct: number;
    };
    attributes: Record<string, unknown>;
  }>;
  observed_attributes: Array<{
    raw_label: string;
    canonical_attribute_id: string | null;
    canonical_value_id: string | null;
    confidence: number;
    object_anchor: string | null;
  }>;
  signal_scores: Record<UniversalSignalKey, number | null>;
  technical_score: number;
  lighting_score: number;
  composition_score: number;
  aesthetic_score: number;
  combined_score: number;
  quality_flags: {
    clutter_severity: 'none' | 'minor_photoshoppable' | 'moderate_retouch' | 'major_reject' | null;
    clutter_detail: string | null;
    flag_for_retouching: boolean;
    is_near_duplicate_candidate: boolean;
  };
  key_elements: string[];
  zones_visible: string[];
  listing_copy: {
    headline: string;
    paragraphs: string;
  } | null;
  appeal_signals: string[];
  concern_signals: string[];
  buyer_persona_hints: string[];
  retouch_priority: 'urgent' | 'recommended' | 'none';
  retouch_estimate_minutes: number | null;
  gallery_position_hint: 'lead_image' | 'early_gallery' | 'late_gallery' | 'archive_only';
  social_first_friendly: boolean | null;
  requires_human_review: boolean;
  confidence_per_field: {
    room_type: number;
    scoring: number;
    classification: number;
    [k: string]: number;
  };
  style_archetype: string | null;
  era_hint: string | null;
  material_palette_summary: string[];
  embedding_anchor_text: string;
  searchable_keywords: string[];
  shot_intent:
    | 'hero_establishing' | 'scale_clarification' | 'lifestyle_anchor'
    | 'material_proof' | 'indoor_outdoor_connection' | 'detail_specimen'
    | 'record_only' | 'reshoot_candidate'
    | null;
  raw_specific: {
    luminance_class: 'underexposed' | 'balanced' | 'overexposed';
    is_aeb_zero: boolean;
    bracket_recoverable: boolean;
  } | null;
  finals_specific: {
    looks_post_processed: boolean;
    vertical_lines_corrected: boolean;
    color_grade_consistent_with_set: boolean | null;
    sky_replaced: boolean;
    sky_replacement_halo_severity: number | null;
    digital_furniture_present: boolean;
    digital_furniture_artefact_severity: number | null;
    digital_dusk_applied: boolean;
    digital_dusk_oversaturation_severity: number | null;
    window_blowout_severity: number | null;
    shadow_recovery_score: number | null;
    color_cast_score: number | null;
    hdr_halo_severity: number | null;
    retouch_artefact_severity: number | null;
  } | null;
  external_specific: {
    estimated_price_class: 'sub_1M' | '1M_to_3M' | '3M_to_10M' | '10M_plus' | 'unknown';
    competitor_branding: {
      watermark_visible: boolean;
      agency_logo: string | null;
      photographer_credit: string | null;
    };
    package_signals: {
      dusk_quality: boolean;
      drone_perspective: boolean;
      video_thumbnail: boolean;
      floorplan_present: boolean;
      twilight_hdr: boolean;
      photo_count_in_listing: number | null;
    };
  } | null;
  floorplan_specific: {
    rooms_detected: Array<{
      room_label: string;
      canonical_room_type: string | null;
      area_sqm: number | null;
      dimensions_text: string | null;
    }>;
    total_internal_sqm: number | null;
    bedrooms_count: number | null;
    bathrooms_count: number | null;
    car_spaces: number | null;
    home_archetype: string | null;
    north_arrow_orientation: 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW' | null;
    levels_count: number | null;
    cross_check_flags: Array<{
      flag: string;
      crm_value: string | number;
      floorplan_value: string | number;
    }>;
  } | null;
  prompt_block_versions: Record<string, string>;
  vendor: 'gemini' | 'anthropic';
  model_version: string;
}
