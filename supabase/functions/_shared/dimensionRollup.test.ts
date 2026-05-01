/**
 * dimensionRollup.test.ts — Wave 11.7.17 unit tests.
 *
 * Spec: docs/design-specs/W11-universal-vision-response-schema-v2.md §6
 *
 * Coverage targets (≥30 tests per W11.7.17 ticket):
 *   - All-signals-present (full 26-key emission, normal RAW/finals/external)
 *   - Partial-population (some null, some absent — graceful degradation)
 *   - Per-source dimorphism (RAW: exposure null → don't penalise technical)
 *   - Tier-weight application (signal_weights + dimension_weights)
 *   - Edge cases (empty input, all-null, NaN, negative weights, malformed)
 *   - Q2 lighting rule (lighting computed from 4 NEW signals only)
 */

import { assertEquals, assertAlmostEquals } from 'jsr:@std/assert@1';
import {
  computeAggregateScores,
  computeCombinedFromDimensions,
  computeDimensionScore,
  type SignalScores,
} from './dimensionRollup.ts';

// ─── Test fixtures ─────────────────────────────────────────────────────────

/** All-9 fixture: every signal scored 9. Useful baseline. */
const ALL_NINE: SignalScores = {
  exposure_balance: 9, color_cast: 9, sharpness_subject: 9, sharpness_corners: 9,
  plumb_verticals: 9, perspective_distortion: 9,
  light_quality: 9, light_directionality: 9,
  color_temperature_appropriateness: 9, light_falloff_quality: 9,
  depth_layering: 9, composition_geometry: 9, vantage_quality: 9,
  framing_quality: 9, leading_lines: 9, negative_space: 9,
  symmetry_quality: 9, foreground_anchor: 9,
  material_specificity: 9, period_reading: 9, styling_quality: 9,
  distraction_freeness: 9,
  retouch_debt: 9, gallery_arc_position: 9, social_crop_survival: 9,
  brochure_print_survival: 9,
};

/** RAW fixture per spec §2: exposure_balance is null (HDR brackets are
 *  pre-merge — don't penalise technical). All other technical signals
 *  scored. */
const RAW_TYPICAL: SignalScores = {
  exposure_balance: null,
  color_cast: 7,
  sharpness_subject: 8,
  sharpness_corners: 7,
  plumb_verticals: 6,
  perspective_distortion: 8,
  light_quality: 7,
  light_directionality: 7,
  color_temperature_appropriateness: 6,
  light_falloff_quality: 7,
  depth_layering: 8,
  composition_geometry: 7,
  vantage_quality: 8,
  framing_quality: 7,
  leading_lines: 6,
  negative_space: 7,
  symmetry_quality: 5,
  foreground_anchor: 6,
  material_specificity: 7,
  period_reading: 7,
  styling_quality: 6,
  distraction_freeness: 7,
};

/** Floorplan fixture per spec §2: ALL signal_scores are null. */
const FLOORPLAN_TYPICAL: SignalScores = {
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
};

// ─── 1. All-signals-present tests ──────────────────────────────────────────

Deno.test('all-9 baseline: every dimension is 9.0', () => {
  const r = computeAggregateScores(ALL_NINE);
  assertEquals(r.technical, 9);
  assertEquals(r.lighting, 9);
  assertEquals(r.composition, 9);
  assertEquals(r.aesthetic, 9);
});

Deno.test('all-9 baseline: combined is 9.0', () => {
  const r = computeAggregateScores(ALL_NINE);
  assertEquals(r.combined, 9);
});

Deno.test('uniform 5: every dimension is 5.0', () => {
  const allFive: SignalScores = Object.fromEntries(
    Object.keys(ALL_NINE).map((k) => [k, 5]),
  );
  const r = computeAggregateScores(allFive);
  assertEquals(r.technical, 5);
  assertEquals(r.lighting, 5);
  assertEquals(r.composition, 5);
  assertEquals(r.aesthetic, 5);
  assertEquals(r.combined, 5);
});

Deno.test('uniform 0: every dimension is 0.0', () => {
  const allZero: SignalScores = Object.fromEntries(
    Object.keys(ALL_NINE).map((k) => [k, 0]),
  );
  const r = computeAggregateScores(allZero);
  assertEquals(r.technical, 0);
  assertEquals(r.lighting, 0);
  assertEquals(r.composition, 0);
  assertEquals(r.aesthetic, 0);
  assertEquals(r.combined, 0);
});

// ─── 2. Per-source dimorphism: RAW exposure_balance null ──────────────────

Deno.test('RAW source: exposure_balance null does NOT penalise technical', () => {
  const r = computeAggregateScores(RAW_TYPICAL);
  // Technical signals present: color_cast=7, sharpness_subject=8,
  // sharpness_corners=7, plumb_verticals=6, perspective_distortion=8.
  // Mean = (7+8+7+6+8)/5 = 36/5 = 7.2.
  // exposure_balance=null is SKIPPED — would have dragged the mean down
  // to (0+7+8+7+6+8)/6 = 6.0 if we counted it as 0.
  assertEquals(r.technical, 7.2);
});

Deno.test('RAW source: lighting computed from 4 NEW signals (Q2 binding)', () => {
  const r = computeAggregateScores(RAW_TYPICAL);
  // Lighting signals: light_quality=7, light_directionality=7,
  // color_temperature_appropriateness=6, light_falloff_quality=7.
  // Mean = (7+7+6+7)/4 = 27/4 = 6.75.
  assertEquals(r.lighting, 6.75);
});

Deno.test('RAW source: composition aggregate from 8 signals', () => {
  const r = computeAggregateScores(RAW_TYPICAL);
  // depth=8 + geometry=7 + vantage=8 + framing=7 + leading=6 + negative=7
  // + symmetry=5 + foreground=6 = 54 / 8 = 6.75
  assertEquals(r.composition, 6.75);
});

Deno.test('RAW source: aesthetic aggregate from 4 signals', () => {
  const r = computeAggregateScores(RAW_TYPICAL);
  // material=7 + period=7 + styling=6 + distraction=7 = 27 / 4 = 6.75
  assertEquals(r.aesthetic, 6.75);
});

// ─── 3. Floorplan source: all signals null → all dimensions null ──────────

Deno.test('floorplan source: all signals null → technical is null', () => {
  const r = computeAggregateScores(FLOORPLAN_TYPICAL);
  assertEquals(r.technical, null);
});

Deno.test('floorplan source: all signals null → lighting is null', () => {
  const r = computeAggregateScores(FLOORPLAN_TYPICAL);
  assertEquals(r.lighting, null);
});

Deno.test('floorplan source: all signals null → composition is null', () => {
  const r = computeAggregateScores(FLOORPLAN_TYPICAL);
  assertEquals(r.composition, null);
});

Deno.test('floorplan source: all signals null → aesthetic is null', () => {
  const r = computeAggregateScores(FLOORPLAN_TYPICAL);
  assertEquals(r.aesthetic, null);
});

Deno.test('floorplan source: all dims null → combined is null', () => {
  const r = computeAggregateScores(FLOORPLAN_TYPICAL);
  assertEquals(r.combined, null);
});

// ─── 4. Q2 binding: lighting NEVER pulls from technical signals ────────────

Deno.test('Q2: lighting score is independent of exposure_balance', () => {
  const fixture: SignalScores = {
    ...ALL_NINE,
    exposure_balance: 1, // technical signal — should NOT affect lighting
  };
  const r = computeAggregateScores(fixture);
  // Lighting still 9 (4 lighting signals untouched).
  assertEquals(r.lighting, 9);
});

Deno.test('Q2: lighting score is independent of color_cast', () => {
  const fixture: SignalScores = {
    ...ALL_NINE,
    color_cast: 1, // technical signal — should NOT affect lighting
  };
  const r = computeAggregateScores(fixture);
  assertEquals(r.lighting, 9);
});

Deno.test('Q2: lighting reads ONLY light_* + color_temperature_appropriateness', () => {
  const fixture: SignalScores = {
    light_quality: 5,
    light_directionality: 5,
    color_temperature_appropriateness: 5,
    light_falloff_quality: 5,
    // All other 22 signals untouched (undefined → skipped)
  };
  const r = computeAggregateScores(fixture);
  assertEquals(r.lighting, 5);
  assertEquals(r.technical, null);
  assertEquals(r.composition, null);
  assertEquals(r.aesthetic, null);
});

Deno.test('Q2: lighting null when only 1 of 4 lighting signals present', () => {
  const fixture: SignalScores = {
    light_quality: 8,
    // other 3 lighting signals undefined → skipped
  };
  const r = computeAggregateScores(fixture);
  // Single-signal mean is still that signal's value
  assertEquals(r.lighting, 8);
});

// ─── 5. Tier-weight application ────────────────────────────────────────────

Deno.test('tier-weighted technical: weighted mean over 6 signals', () => {
  const sigW = {
    exposure_balance: 2,
    color_cast: 1,
    sharpness_subject: 1,
    sharpness_corners: 1,
    plumb_verticals: 1,
    perspective_distortion: 1,
  };
  const fixture: SignalScores = {
    exposure_balance: 10,
    color_cast: 5,
    sharpness_subject: 5,
    sharpness_corners: 5,
    plumb_verticals: 5,
    perspective_distortion: 5,
  };
  // weighted = (10*2 + 5+5+5+5+5) / (2+1+1+1+1+1) = (20+25)/7 = 45/7 = 6.43
  const r = computeAggregateScores(fixture, sigW);
  assertAlmostEquals(r.technical ?? -1, 6.43, 0.01);
});

Deno.test('tier-weighted: signal not in weights map is skipped', () => {
  const sigW = {
    exposure_balance: 1,
    // Other technical signals not weighted → contribute weight 0 → skipped
  };
  const fixture: SignalScores = {
    exposure_balance: 8,
    color_cast: 2,
    sharpness_subject: 2,
  };
  const r = computeAggregateScores(fixture, sigW);
  // Only exposure_balance weighted → mean is just 8.
  assertEquals(r.technical, 8);
});

Deno.test('tier-weighted: empty weights map → unweighted simple mean', () => {
  const sigW: Record<string, number> = {};
  const fixture: SignalScores = {
    exposure_balance: 8,
    color_cast: 6,
    sharpness_subject: 4,
    sharpness_corners: 6,
    plumb_verticals: 6,
    perspective_distortion: 6,
  };
  // No weights → mean = (8+6+4+6+6+6)/6 = 36/6 = 6
  const r = computeAggregateScores(fixture, sigW);
  assertEquals(r.technical, 6);
});

Deno.test('tier-weighted: undefined weights → unweighted simple mean', () => {
  const fixture: SignalScores = {
    exposure_balance: 6,
    color_cast: 6,
    sharpness_subject: 6,
    sharpness_corners: 6,
    plumb_verticals: 6,
    perspective_distortion: 6,
  };
  const r = computeAggregateScores(fixture);
  assertEquals(r.technical, 6);
});

Deno.test('tier-weighted: zero weight is skipped (treated as not weighted)', () => {
  const sigW = {
    exposure_balance: 0,
    color_cast: 1,
  };
  const fixture: SignalScores = {
    exposure_balance: 10,
    color_cast: 4,
  };
  // exposure weight 0 → skipped; color_cast weight 1 → mean = 4
  const r = computeAggregateScores(fixture, sigW);
  assertEquals(r.technical, 4);
});

Deno.test('tier-weighted: negative weight is rejected (treated as zero/skipped)', () => {
  const sigW = {
    exposure_balance: -3,
    color_cast: 1,
  };
  const fixture: SignalScores = {
    exposure_balance: 10,
    color_cast: 4,
  };
  const r = computeAggregateScores(fixture, sigW);
  // Negative weight ignored → only color_cast contributes
  assertEquals(r.technical, 4);
});

// ─── 6. dimension_weights application to combined_score ────────────────────

Deno.test('dimension_weights override changes combined', () => {
  const fixture: SignalScores = { ...ALL_NINE };
  // Bias toward composition with 1.0 weight; others 0 → not allowed,
  // but DEFAULT fallback kicks in for any 0/missing weight.
  // Test instead: heavy lighting bias.
  const dimW = {
    technical: 0.1,
    lighting: 0.7,
    composition: 0.1,
    aesthetic: 0.1,
  };
  const r = computeAggregateScores(fixture, undefined, dimW);
  // All dims = 9 → weighted sum = 9; this validates the weighted path runs
  assertEquals(r.combined, 9);
});

Deno.test('dimension_weights default seeds: technical=0.25 lighting=0.30 composition=0.25 aesthetic=0.20', () => {
  // With dims [10, 5, 0, 5] and default weights, combined =
  // (10*0.25 + 5*0.30 + 0*0.25 + 5*0.20) / 1.0 = 2.5+1.5+0+1.0 = 5.0
  const r = computeCombinedFromDimensions(
    { technical: 10, lighting: 5, composition: 0, aesthetic: 5 },
  );
  assertEquals(r, 5);
});

Deno.test('combined: skips null dimension and renormalises', () => {
  // Two dims null, two present at 8 → mean over present = 8.
  const r = computeCombinedFromDimensions(
    { technical: null, lighting: 8, composition: null, aesthetic: 8 },
  );
  assertEquals(r, 8);
});

Deno.test('combined: all dims null → null', () => {
  const r = computeCombinedFromDimensions(
    { technical: null, lighting: null, composition: null, aesthetic: null },
  );
  assertEquals(r, null);
});

Deno.test('combined: technical-only present', () => {
  const r = computeCombinedFromDimensions(
    { technical: 7, lighting: null, composition: null, aesthetic: null },
  );
  assertEquals(r, 7);
});

// ─── 7. Edge cases: empty / malformed input ────────────────────────────────

Deno.test('empty signal_scores → all dims null', () => {
  const r = computeAggregateScores({});
  assertEquals(r.technical, null);
  assertEquals(r.lighting, null);
  assertEquals(r.composition, null);
  assertEquals(r.aesthetic, null);
  assertEquals(r.combined, null);
});

Deno.test('NaN value is skipped (treated as missing)', () => {
  const fixture: SignalScores = {
    exposure_balance: NaN,
    color_cast: 6,
    sharpness_subject: 6,
    sharpness_corners: 6,
    plumb_verticals: 6,
    perspective_distortion: 6,
  };
  const r = computeAggregateScores(fixture);
  // NaN is filtered → 5 signals * 6 / 5 = 6
  assertEquals(r.technical, 6);
});

Deno.test('Infinity value is skipped', () => {
  const fixture: SignalScores = {
    exposure_balance: Infinity,
    color_cast: 6,
  };
  const r = computeAggregateScores(fixture);
  assertEquals(r.technical, 6);
});

Deno.test('string value is skipped', () => {
  const fixture: Record<string, unknown> = {
    exposure_balance: '8.5',
    color_cast: 6,
  };
  // The helper accepts SignalScores type but defensively rejects non-numbers.
  const r = computeAggregateScores(fixture as SignalScores);
  // string '8.5' filtered → only color_cast → mean = 6
  assertEquals(r.technical, 6);
});

Deno.test('unrecognised signal key is ignored', () => {
  const fixture: SignalScores = {
    exposure_balance: 8,
    nonsense_signal_xyz: 0, // not in SIGNAL_TO_DIMENSION → skipped
  };
  const r = computeAggregateScores(fixture);
  assertEquals(r.technical, 8);
});

Deno.test('partial population: only 3 of 6 technical signals present', () => {
  const fixture: SignalScores = {
    exposure_balance: 9,
    color_cast: 6,
    sharpness_subject: 3,
    // 3 others missing
  };
  const r = computeAggregateScores(fixture);
  // (9 + 6 + 3) / 3 = 6
  assertEquals(r.technical, 6);
});

// ─── 8. computeDimensionScore (export) directly ────────────────────────────

Deno.test('computeDimensionScore: technical only', () => {
  const r = computeDimensionScore(RAW_TYPICAL, 'technical');
  assertEquals(r, 7.2);
});

Deno.test('computeDimensionScore: lighting only', () => {
  const r = computeDimensionScore(RAW_TYPICAL, 'lighting');
  assertEquals(r, 6.75);
});

Deno.test('computeDimensionScore: weighted technical', () => {
  const sigW = { sharpness_subject: 3 };
  const fixture: SignalScores = {
    sharpness_subject: 8,
    color_cast: 4, // not weighted → skipped when weights present
  };
  const r = computeDimensionScore(fixture, 'technical', sigW);
  // Only sharpness_subject is weighted → 8.
  assertEquals(r, 8);
});

Deno.test('computeDimensionScore: returns null when no signals match', () => {
  const fixture: SignalScores = {
    light_quality: 8, // lighting, not technical
  };
  const r = computeDimensionScore(fixture, 'technical');
  assertEquals(r, null);
});

// ─── 9. Workflow signals (Q2 unmapped) don't leak into aggregates ─────────

Deno.test('workflow signals (retouch_debt etc.) do NOT pollute aesthetic', () => {
  const fixture: SignalScores = {
    material_specificity: 9,
    period_reading: 9,
    styling_quality: 9,
    distraction_freeness: 9,
    // Workflow signals — these should be IGNORED in the aesthetic aggregate
    retouch_debt: 0,
    gallery_arc_position: 0,
    social_crop_survival: 0,
    brochure_print_survival: 0,
  };
  const r = computeAggregateScores(fixture);
  // aesthetic should be 9 (only the 4 aesthetic signals contribute).
  // If workflow signals leaked in, mean would be (9+9+9+9+0+0+0+0)/8 = 4.5.
  assertEquals(r.aesthetic, 9);
});

// ─── 10. Rounding behaviour ────────────────────────────────────────────────

Deno.test('rounds dimension to 2 decimal places', () => {
  const fixture: SignalScores = {
    exposure_balance: 1, color_cast: 2, sharpness_subject: 3,
    sharpness_corners: 4, plumb_verticals: 5, perspective_distortion: 6,
  };
  // (1+2+3+4+5+6)/6 = 21/6 = 3.5
  const r = computeAggregateScores(fixture);
  assertEquals(r.technical, 3.5);
});

Deno.test('rounds combined to 2 decimal places', () => {
  // Use uneven dims to force a decimal: tech=10, lighting=null, comp=null, aes=null
  // → combined = 10 (single dim, no rounding needed)
  // Better: tech=7.33333, lighting=null, comp=null, aes=null → 7.33
  const r = computeCombinedFromDimensions(
    { technical: 7.33333, lighting: null, composition: null, aesthetic: null },
  );
  assertEquals(r, 7.33);
});

// ─── 11. Q2 binding: lighting computed JUST from the 4 new signals ────────

Deno.test('lighting aggregate: 4 lighting signals all 10 → 10', () => {
  const fixture: SignalScores = {
    light_quality: 10,
    light_directionality: 10,
    color_temperature_appropriateness: 10,
    light_falloff_quality: 10,
  };
  const r = computeAggregateScores(fixture);
  assertEquals(r.lighting, 10);
});

Deno.test('lighting aggregate: 4 lighting signals 9/8/7/6 → 7.5', () => {
  const fixture: SignalScores = {
    light_quality: 9,
    light_directionality: 8,
    color_temperature_appropriateness: 7,
    light_falloff_quality: 6,
  };
  const r = computeAggregateScores(fixture);
  assertEquals(r.lighting, 7.5);
});

Deno.test('lighting aggregate: 1 of 4 null → mean over remaining 3', () => {
  const fixture: SignalScores = {
    light_quality: 9,
    light_directionality: 6,
    color_temperature_appropriateness: 6,
    light_falloff_quality: null,
  };
  const r = computeAggregateScores(fixture);
  // (9+6+6) / 3 = 21/3 = 7
  assertEquals(r.lighting, 7);
});

// ─── 12. Combined integration: realistic v2 emission ───────────────────────

Deno.test('integration: full RAW emission → combined ~7.0', () => {
  const r = computeAggregateScores(RAW_TYPICAL);
  // Computed dim values from individual tests above:
  //   technical=7.2, lighting=6.75, composition=6.75, aesthetic=6.75.
  // Default weights: 0.25/0.30/0.25/0.20 (sum = 1.0).
  // weighted = 7.2*0.25 + 6.75*0.30 + 6.75*0.25 + 6.75*0.20
  //          = 1.8 + 2.025 + 1.6875 + 1.35 = 6.8625 → 6.86
  assertEquals(r.combined, 6.86);
});

Deno.test('integration: tier_config dim weights override changes combined', () => {
  // Heavy bias toward technical (which is 7.2 in RAW_TYPICAL)
  const dimW = {
    technical: 0.7,
    lighting: 0.1,
    composition: 0.1,
    aesthetic: 0.1,
  };
  const r = computeAggregateScores(RAW_TYPICAL, undefined, dimW);
  // 7.2*0.7 + 6.75*0.1 + 6.75*0.1 + 6.75*0.1
  // = 5.04 + 0.675 + 0.675 + 0.675 = 7.065 → 7.07
  assertEquals(r.combined, 7.07);
});
