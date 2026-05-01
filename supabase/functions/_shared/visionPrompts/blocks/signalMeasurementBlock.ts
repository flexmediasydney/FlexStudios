/**
 * signalMeasurementBlock.ts — Wave 11.7.17 source-aware signal measurement.
 *
 * Spec: docs/design-specs/W11-universal-vision-response-schema-v2.md §9
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 *
 * The v2 universal schema (`universalVisionResponseSchemaV2.ts`) declares 26
 * signal_scores keys but the schema's per-property descriptions are necessarily
 * compact. The model needs source-aware activation guidance: which signals are
 * scored vs nullable, and the high-impact dimorphism deltas (RAW exposure
 * is null because brackets are pre-merge; finals exposure is hard-fail;
 * floorplan signal_scores are entirely null).
 *
 * This block renders the 26 measurement prompts with per-source activation
 * notes, injected into the Stage 1 system prompt AFTER `header` and BEFORE
 * `roomTypeTaxonomy`. The result keeps prompt-cache friendliness (the bulk of
 * each prompt is identical across calls) while letting the source-specific
 * activation paragraph float to the right block per source.
 *
 * ─── Caller-facing API ─────────────────────────────────────────────────────
 *
 * `signalMeasurementBlock(source_type)` returns a multi-line string. Same
 * call shape as `sourceContextBlock`. Versioned via
 * `SIGNAL_MEASUREMENT_BLOCK_VERSION` for prompt-cache invalidation.
 *
 * ─── 4 source dimorphism rules (per spec §9) ───────────────────────────────
 *
 *   internal_raw       → "RAW: ..." override lines apply (exposure_balance,
 *                        plumb_verticals, color_cast scored as soft penalties).
 *   internal_finals    → "Finals: ..." lines apply (window blowout = hard-fail,
 *                        sky-replacement halos populate finals_specific.*).
 *   external_listing   → all signals scored OBSERVATIONALLY; do NOT recommend
 *                        retouching, do NOT flag for rejection.
 *   floorplan_image    → ALL signal_scores = NULL; the block emits a single
 *                        line saying so. floorplan_specific.* is the primary
 *                        output.
 */

import type { SourceType } from './sourceContextBlock.ts';

export const SIGNAL_MEASUREMENT_BLOCK_VERSION = 'v1.0';

// ─── Static block — rendered for internal_raw / internal_finals / external ──

const SIGNAL_PROMPTS_BODY = [
  'SIGNAL MEASUREMENT INSTRUCTIONS — score 0-10. NULL = signal does not apply',
  'to this source type or subject.',
  '',
  '— TECHNICAL —',
  'exposure_balance:',
  '  Are highlights and shadows both held without clipping? 10 = both ends preserved;',
  '  5 = one end clips noticeably; 0 = both ends blow out. RAW brackets: NULL (HDR',
  '  merge will resolve). Finals: scored — blowout is hard-fail. External: scored',
  '  observationally only.',
  '',
  'color_cast:',
  '  Are colours consistent across the frame, or does a tint dominate?',
  '  10 = neutral unified. 5 = mild cast acceptable. 0 = severe cast unfixable.',
  '',
  'sharpness_subject:',
  '  Edge contrast on the primary subject. 10 = razor-sharp. 5 = adequate.',
  '  0 = significant softness or blur.',
  '',
  'sharpness_corners:',
  '  Edge contrast at frame corners. 10 = corners as sharp as centre.',
  '  5 = mild corner softness expected at wide aperture. 0 = severe corner mush.',
  '',
  'plumb_verticals:',
  '  Are vertical structural elements parallel to the frame edge, or do they',
  '  keystone? 10 = perfect verticals. 5 = mild keystone. 0 = severe keystone.',
  '  RAW: soft penalty (correctable). Finals: hard threshold (should be corrected).',
  '',
  'perspective_distortion:',
  '  Do straight architectural lines bow at frame edges (lens barrel/pincushion)?',
  '  10 = no bow. 5 = mild bow at edges. 0 = severe fisheye effect.',
  '',
  '— LIGHTING (W11.7.17 Q2 — 4 NEW signals) —',
  'light_quality:',
  '  Overall lighting CHARACTER and quality of the frame. 10 = beautiful, evocative',
  '  light that flatters the subject (golden-hour warmth, soft north-facing daylight,',
  "  evenly-modulated dusk); 5 = adequate ambient light, no character; 0 = harsh",
  '  fluorescent overheads, mixed colour temperature chaos, or flat featureless light.',
  '',
  'light_directionality:',
  '  Direction of light and how it shapes the subject. 10 = clear, intentional',
  '  direction that reveals form (raking side-light on textured walls, top-back',
  '  rim on architectural detail); 5 = neutral frontal/ambient with no shaping;',
  '  0 = lighting works against the subject (e.g. hot spot on background, subject',
  '  in shadow).',
  '',
  'color_temperature_appropriateness:',
  '  White balance MATCHES the scene the photographer is selling. 10 = tonally',
  '  consistent with property style (warm interiors for period homes, neutral',
  '  cool for contemporary, dusk-amber for twilight sets); 5 = slightly off but',
  '  recoverable; 0 = jarring mixed white balance or wrong temperature for the',
  '  era/style. Finals: should be locked — penalise off-temperature finals.',
  '',
  'light_falloff_quality:',
  '  Gradient and rolloff between bright and shadow zones. 10 = smooth photographic',
  '  falloff that creates depth (gentle window wash gradient onto a wall, soft',
  '  shadow into ceiling line); 5 = hard edges between zones but not distracting;',
  '  0 = harsh sharp-edged shadows, banding, or flash-flat with no falloff at all.',
  '',
  '— COMPOSITIONAL —',
  'depth_layering:',
  '  Distinct foreground / midground / background depth zones.',
  '  10 = three-plus clear layers. 5 = two layers. 0 = flat single-plane.',
  '',
  'composition_geometry:',
  '  Does the actual composition style match a recognised pattern?',
  '  10 = textbook example. 5 = recognisable but loose. 0 = composition style unclear.',
  '',
  'vantage_quality:',
  '  Camera-position alignment with what the slot needs.',
  '  10 = vantage matches slot intent. 5 = neutral vantage. 0 = vantage works against the slot.',
  '',
  'framing_quality:',
  '  Crop and edge management. 10 = clean edges. 5 = adequate. 0 = cluttered edges',
  '  or awkward cropping.',
  '',
  'leading_lines:',
  '  Do architectural lines draw the eye to the primary subject?',
  '  10 = strong leading lines anchoring the composition. 5 = some directional cues.',
  '  0 = no leading lines.',
  '',
  'negative_space:',
  '  Is breathing room around the subject deliberate (vs cramped or empty)?',
  '  10 = ideal balance. 5 = adequate. 0 = subject crowded or floating in empty frame.',
  '',
  'symmetry_quality:',
  '  When the composition is symmetrical, is the symmetry axis aligned to frame centre?',
  '  10 = perfect axial symmetry. 5 = adequate. 0 = symmetry attempted but off-axis.',
  '  NULL when not a symmetrical composition.',
  '',
  'foreground_anchor:',
  '  Anchoring foreground element. 10 = strong anchor. 5 = some foreground but not',
  '  anchoring. 0 = no foreground, frame floats.',
  '',
  '— AESTHETIC / STYLING —',
  'material_specificity:',
  '  Are key textures (stone veining, timber grain, tile grout) visible and',
  '  identifiable? 10 = textures crisp. 5 = adequate. 0 = textures lost.',
  '',
  'period_reading:',
  '  Does the image read its architectural era cleanly?',
  '  10 = era reads unambiguously. 5 = mixed signals. 0 = era unclear.',
  '',
  'styling_quality:',
  '  Is the staging intentional and considered?',
  '  10 = deliberate styling throughout. 5 = some staging. 0 = unstaged.',
  '',
  'distraction_freeness:',
  '  Power lines, neighbouring properties, owner in frame, etc.',
  '  10 = no distractions. 5 = minor distractions, retouchable. 0 = major distractions.',
  '',
  '— WORKFLOW —',
  'retouch_debt:',
  '  Total retouch effort the editor will need.',
  '  10 = no retouch debt. 5 = standard retouch. 0 = major retouch.',
  '  HIGHER score = LESS debt.',
  '',
  'gallery_arc_position:',
  '  Pre-Stage-4 hint at gallery placement value.',
  '  10 = lead-image candidate. 5 = mid-gallery. 0 = archive-only.',
  '',
  'social_crop_survival:',
  '  Does the image survive a 1:1 Instagram crop without losing the hero feature?',
  '  10 = centre square preserves the subject. 5 = mostly preserved. 0 = subject lost.',
  '',
  'brochure_print_survival:',
  '  Does the image hold up at print resolution and print colour?',
  '  10 = print-ready. 5 = adequate for digital, marginal in print. 0 = artefacts.',
].join('\n');

const RAW_TAIL = [
  '',
  '── RAW ACTIVATION OVERRIDES ──',
  '- exposure_balance: NULL (this is a pre-merge bracket; HDR will resolve).',
  '- plumb_verticals: SOFT penalty only — verticals are correctable in post.',
  '- color_cast: SOFT penalty only — white balance is correctable in post.',
  '- All other signals: scored as observed.',
].join('\n');

const FINALS_TAIL = [
  '',
  '── FINALS ACTIVATION OVERRIDES ──',
  '- exposure_balance: HARD-FAIL on window blowout or crushed shadows (HDR',
  '  merge should have resolved both).',
  '- plumb_verticals: HARD threshold — uncorrected verticals are a real flaw.',
  '- color_cast: REAL flaw — penalise.',
  '- color_temperature_appropriateness: should be locked — penalise off-temp.',
  '- Look for post-processing artefacts and populate finals_specific.* with',
  '  sky_replacement_halo_severity, digital_furniture_artefact_severity,',
  '  digital_dusk_oversaturation_severity, hdr_halo_severity, retouch_artefact_severity.',
].join('\n');

const EXTERNAL_TAIL = [
  '',
  '── EXTERNAL LISTING ACTIVATION OVERRIDES ──',
  '- All signal_scores are scored OBSERVATIONALLY ONLY.',
  '- Do NOT recommend retouching. Do NOT flag for rejection.',
  '- retouch_priority is always "none". gallery_position_hint is always',
  '  "archive_only". flag_for_retouching is always FALSE.',
  '- Primary outputs: external_specific.package_signals.* (dusk, drone, video,',
  '  floorplan, twilight_hdr) and external_specific.estimated_price_class.',
].join('\n');

const FLOORPLAN_BLOCK = [
  'SIGNAL MEASUREMENT INSTRUCTIONS — FLOORPLAN IMAGE',
  '',
  'This is an architectural drawing, not a photograph. Photographic scoring',
  'is meaningless on floorplans. Set ALL signal_scores values to NULL.',
  '',
  '- Do NOT score exposure, sharpness, composition, lighting, etc.',
  '- The four aggregate axis scores (technical/lighting/composition/aesthetic)',
  '  may be set to 0 or null — they are not meaningful for an OCR-style input.',
  '- Primary output: floorplan_specific.* — rooms_detected[],',
  '  total_internal_sqm, bedrooms_count, bathrooms_count, car_spaces,',
  '  home_archetype, north_arrow_orientation, levels_count, cross_check_flags[].',
  '- room_classification = null. quality_flags.clutter_severity = null.',
  '- Treat raw_label observations as the architectural symbology (door swings,',
  '  wall lines, sliding tracks, room name labels, dimension annotations).',
].join('\n');

/**
 * Build the source-aware signal measurement block.
 * Inject in the system prompt AFTER `header` and BEFORE `roomTypeTaxonomy`.
 */
export function signalMeasurementBlock(source_type: SourceType): string {
  switch (source_type) {
    case 'internal_raw':
      return SIGNAL_PROMPTS_BODY + RAW_TAIL;
    case 'internal_finals':
      return SIGNAL_PROMPTS_BODY + FINALS_TAIL;
    case 'external_listing':
      return SIGNAL_PROMPTS_BODY + EXTERNAL_TAIL;
    case 'floorplan_image':
      return FLOORPLAN_BLOCK;
    default:
      // Safe default — internal_raw is the production workflow.
      return SIGNAL_PROMPTS_BODY + RAW_TAIL;
  }
}
