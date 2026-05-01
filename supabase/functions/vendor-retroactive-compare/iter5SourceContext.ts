/**
 * iter5SourceContext.ts — source-aware context preamble blocks.
 *
 * The W11.universal schema defines `source.type ∈ { internal_raw, internal_finals,
 * external_listing, floorplan_image }` as a critical input that tells the vision
 * model how to interpret the input image. Without this signal, the model judges
 * RAW exposure brackets as if they were final deliverables — a regression
 * surfaced in iter-5 Saladine (Gemini's coverage_notes called the shoot
 * "complete technical failure" because it read EV0 brackets as final outputs).
 *
 * The fix: inject a source-context preamble at the top of every Stage 1 user
 * prompt AND every Stage 4 user prompt, telling the model exactly what kind of
 * input it's looking at and how to interpret quality issues that arise from
 * the source format itself.
 *
 * Anthropic Opus 4.7 self-classified RAW brackets implicitly from training
 * (its analysis text always mentions "RAW HDR bracket" without prompting).
 * Gemini 2.5 Pro doesn't have that workflow knowledge — it needs telling.
 * The preamble closes that gap.
 *
 * Block architecture (W7.6 pattern): one exported builder function per source
 * type, returning a multi-line string. Versioned via SOURCE_CONTEXT_BLOCK_VERSION
 * so prompt-cache invalidation tracks block changes.
 */

export const SOURCE_CONTEXT_BLOCK_VERSION = 'iter5-v1.0';

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
].join('\n');

/**
 * Build the source-context preamble for the given source type.
 * Inject at the TOP of Stage 1 + Stage 4 user_text so the model reads it
 * before any other instruction.
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
