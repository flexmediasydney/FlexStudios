/**
 * sourceContextBlock.ts — Wave 11.7.1 (W7.6 block) source-aware preamble.
 *
 * Promoted to production from `vendor-retroactive-compare/iter5SourceContext.ts`
 * after the iter-5b Saladine validation showed a pure quality lift with zero
 * cost or latency impact (W11-7-unified-shortlisting-architecture.md §"Source-
 * aware prompting"):
 *
 *   - coverage_notes: "complete technical failure" -> "comprehensive coverage"
 *   - narrative_arc_score: 2/10 -> 7.5/10
 *   - overall_property_score: 2.5/10 -> 4.5/10
 *   - missing_shot_recommendations: 6 reshoot-everything -> 3 real gaps
 *   - reading grade level: 9.5 -> 8.5 (tighter to Standard tier band)
 *
 * The W11.universal schema defines `source.type ∈ { internal_raw,
 * internal_finals, external_listing, floorplan_image }` as a critical input
 * that tells the vision model how to interpret the input image. Without this
 * signal, Gemini judges RAW exposure brackets as if they were final
 * deliverables.
 *
 * Anthropic Opus 4.7 self-classifies RAW brackets implicitly from training
 * (its analysis text always mentions "RAW HDR bracket" without prompting).
 * Gemini 2.5 Pro doesn't have that workflow knowledge — it needs telling.
 * The preamble closes that gap.
 *
 * Block architecture (W7.6 pattern): one exported builder function returning
 * a multi-line string. Versioned via SOURCE_CONTEXT_BLOCK_VERSION so prompt-
 * cache invalidation tracks block changes. Persisted in
 * `composition_classifications.prompt_block_versions` and
 * `engine_run_audit.prompt_block_versions` for replay reproducibility.
 *
 * Inject at the TOP of every Stage 1 + Stage 4 user prompt, before the voice
 * anchor and any other instruction.
 */

// W11.7.17 — bumped from v1.0 to v1.1 for the per-source field-list
// paragraphs that tell the model exactly which `*_specific` JSONB block to
// populate and to leave the other 3 set to null. Q5 binding decision:
// nullable blocks enforced via prompt + persist-layer validation.
export const SOURCE_CONTEXT_BLOCK_VERSION = 'v1.1';

export type SourceType = 'internal_raw' | 'internal_finals' | 'external_listing' | 'floorplan_image';

const INTERNAL_RAW_BLOCK = [
  '── SOURCE CONTEXT — INTERNAL RAW ──',
  '',
  'These images are RAW exposure brackets from the photographer\'s session.',
  'Each frame is the neutral EV0 bracket of a 5-bracket Canon AEB sequence,',
  'pre-merge, pre-retouch. The final delivered images will be HDR-merged from',
  'multiple brackets and post-processed before publication.',
  '',
  'WHAT THIS MEANS FOR YOUR JUDGEMENT:',
  '',
  '1. Exposure characteristics are EXPECTED, not flaws.',
  '   - Dark interiors with bright windows: photographer protected window',
  '     highlights for HDR merge. Final image will recover both ends.',
  '   - Crushed shadows on exteriors at midday: photographer protected the sky.',
  '     Final image will lift shadow detail.',
  '   - High contrast / deep blue saturated skies: bracket-stage rendering.',
  '     Final image will be tonally balanced.',
  '   - "Severely underexposed" or "blown highlights" comments are WRONG when',
  '     describing a RAW bracket. These are intended pre-merge characteristics.',
  '',
  '2. Score architectural quality, not exposure.',
  '   - Composition, framing, vantage, depth layering, plumb verticals: SCORE THESE.',
  '   - Material specificity, period reading, styling, clutter: SCORE THESE.',
  '   - Bracket darkness, blown windows, color cast, dynamic range: DO NOT SCORE.',
  '',
  '3. Describe the FINAL property, not the bracket.',
  '   - Your `analysis` may note "RAW HDR bracket" once for context but should',
  '     focus on what the merged final will reveal about the architecture.',
  '   - Your `listing_copy` and `master_listing` prose should describe the home',
  '     in its final published state — what a buyer will see, not what the',
  '     bracket shows. The architecture is what it is, regardless of bracket',
  '     exposure.',
  '   - Never write "this is severely underexposed" or "requires reshoot" or',
  '     "technical failure" in any prose field. The post-processing pipeline',
  '     will resolve all exposure issues.',
  '',
  '4. Coverage gaps and reshoot recommendations are still valid.',
  '   - You may legitimately flag MISSING coverage (no clean facade hero, no',
  '     detail shot of kitchen hardware, etc.) — these are real gaps.',
  '   - You may legitimately flag clutter, dated finishes, or compositional',
  '     weaknesses — these survive the HDR merge.',
  '   - Distinguish between "the bracket is dark" (NOT a flaw) and "the room',
  '     is cluttered" (real flaw).',
  '',
  '5. clutter_severity, retouch_priority, and material_palette_summary remain',
  '   active and meaningful — they describe the underlying scene, not the',
  '   bracket. Score them normally.',
  '',
  '── W11.7.17 v2 SOURCE-SPECIFIC BLOCK (Q5 binding) ──',
  'Populate `raw_specific.{ luminance_class, is_aeb_zero, bracket_recoverable }`.',
  'Leave the other 3 *_specific blocks (`finals_specific`, `external_specific`,',
  '`floorplan_specific`) set to null.',
  '',
].join('\n');

const INTERNAL_FINALS_BLOCK = [
  '── SOURCE CONTEXT — INTERNAL FINALS ──',
  '',
  'These images are post-edited FINAL deliverables — HDR-merged from the RAW',
  'brackets, with vertical lines corrected, color graded, and digital styling',
  'applied where used. They represent the published quality bar.',
  '',
  'WHAT THIS MEANS FOR YOUR JUDGEMENT:',
  '',
  '1. Exposure characteristics ARE quality signals.',
  '   - Window blowout: hard fail on finals (HDR merge should have resolved).',
  '   - Crushed shadows: hard fail on finals (recoverable in post).',
  '   - Color cast / mixed white balance: real flaw — penalise.',
  '   - Vertical line convergence: should be corrected; soft penalty if not.',
  '',
  '2. Look for post-processing artefacts.',
  '   - Sky replacement halos / unnatural cloud shapes',
  '   - Digital furniture artefacts (incorrect shadows, wrong scale)',
  '   - Digital dusk over-saturation',
  '   - HDR halo around high-contrast edges',
  '   - Retouch errors (cloning patterns, awkward blur)',
  '',
  '3. Score the deliverable bar.',
  '   - Compositional weakness, dated styling, retouch debt, clutter that',
  '     survived editing — all valid concerns.',
  '   - The finals_specific.* fields (sky_replaced, digital_furniture_present,',
  '     digital_dusk_applied) should be populated based on what you can detect.',
  '',
  '4. Describe the property as the published version it is.',
  '   - Listing copy and master_listing should describe what a buyer sees in',
  '     this final published image.',
  '',
  '── W11.7.17 v2 SOURCE-SPECIFIC BLOCK (Q5 binding) ──',
  'Populate `finals_specific.{ looks_post_processed, vertical_lines_corrected,',
  'color_grade_consistent_with_set, sky_replaced, sky_replacement_halo_severity,',
  'digital_furniture_present, digital_furniture_artefact_severity,',
  'digital_dusk_applied, digital_dusk_oversaturation_severity,',
  'window_blowout_severity, shadow_recovery_score, color_cast_score,',
  'hdr_halo_severity, retouch_artefact_severity }`.',
  'Leave the other 3 *_specific blocks (`raw_specific`, `external_specific`,',
  '`floorplan_specific`) set to null.',
  '',
].join('\n');

const EXTERNAL_LISTING_BLOCK = [
  '── SOURCE CONTEXT — EXTERNAL REA LISTING ──',
  '',
  'This is a competitor agency\'s delivered image scraped from a public REA',
  'listing. We are NOT applying our internal quality standards to reject or',
  'critique the work — we are cataloguing what competitor photographers do.',
  '',
  'WHAT THIS MEANS FOR YOUR JUDGEMENT:',
  '',
  '1. Score quality observationally, but do not "reject".',
  '   - The shot exists in a published listing — it cleared its agency\'s bar.',
  '   - You may note quality observations but do not flag for retouch.',
  '',
  '2. Identify package signals.',
  '   - Dusk-quality lighting → agency offered dusk product',
  '   - Drone perspective → agency offered drone product',
  '   - Video thumbnail → agency offered video product',
  '   - Floorplan visible → agency offered floorplan product',
  '   - Populate external_specific.package_signals.* accordingly.',
  '',
  '3. Estimate the listing\'s price class.',
  '   - sub_1M / 1M_to_3M / 3M_to_10M / 10M_plus / unknown',
  '   - Based on home archetype + finishes + suburb signals visible.',
  '',
  '4. Capture competitor branding when visible.',
  '   - Agent watermark, photography credit text, agency logo overlay.',
  '',
  '── W11.7.17 v2 SOURCE-SPECIFIC BLOCK (Q4 + Q5 binding) ──',
  'Populate `external_specific.{ estimated_price_class, competitor_branding,',
  'package_signals }`. NO `delivery_quality_grade` letter scale (Q4 binding —',
  'dropped). External listings get `combined_score` numeric only.',
  'Leave the other 3 *_specific blocks (`raw_specific`, `finals_specific`,',
  '`floorplan_specific`) set to null.',
  '',
].join('\n');

const FLOORPLAN_IMAGE_BLOCK = [
  '── SOURCE CONTEXT — FLOORPLAN IMAGE ──',
  '',
  'This is an architectural floorplan drawing, not a photograph. Treat as',
  'OCR-style input — extract textual labels, room types, dimensions, and',
  'architectural relationships. Do NOT apply photographic scoring.',
  '',
  'WHAT THIS MEANS FOR YOUR JUDGEMENT:',
  '',
  '1. Aesthetic / lighting / composition scoring — N/A. Set to null.',
  '2. Room enumeration — list every labelled room in zones_visible.',
  '3. Capture dimensions / area when legibly drawn.',
  '4. Identify architectural relationships (which rooms connect, flow paths).',
  '5. Identify the home archetype from layout patterns when possible.',
  '',
  '── W11.7.17 v2 SOURCE-SPECIFIC BLOCK (Q5 binding) ──',
  'Populate `floorplan_specific.{ rooms_detected[], total_internal_sqm,',
  'bedrooms_count, bathrooms_count, car_spaces, home_archetype,',
  'north_arrow_orientation, levels_count, cross_check_flags[] }`.',
  'Leave the other 3 *_specific blocks (`raw_specific`, `finals_specific`,',
  '`external_specific`) set to null.',
  '',
].join('\n');

/**
 * Build the source-context preamble for the given source type.
 * Inject at the TOP of Stage 1 + Stage 4 user_text so the model reads it
 * before any other instruction.
 *
 * Default 'internal_raw' is the production RAW workflow.
 */
export function sourceContextBlock(source_type: SourceType): string {
  switch (source_type) {
    case 'internal_raw': return INTERNAL_RAW_BLOCK;
    case 'internal_finals': return INTERNAL_FINALS_BLOCK;
    case 'external_listing': return EXTERNAL_LISTING_BLOCK;
    case 'floorplan_image': return FLOORPLAN_IMAGE_BLOCK;
    default: return INTERNAL_RAW_BLOCK; // safe default for our primary workflow
  }
}
