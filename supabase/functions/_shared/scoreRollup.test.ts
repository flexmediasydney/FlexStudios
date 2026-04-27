/**
 * Unit tests for scoreRollup pure helpers (Wave 8).
 *
 * Run: deno test --no-check --allow-all supabase/functions/_shared/scoreRollup.test.ts
 *
 * The defining regression-guard test:
 *   "balanced 0.25 weights produce a uniform mean" — proves that v1 dimension
 *   weights are calibrated for byte-stable rollover from the pre-W8 Pass 1
 *   formula `(tech + light + comp + aes) / 4` when uniform 0.25 weights are
 *   used. The v1 seed uses 0.25/0.30/0.25/0.20 (lighting-biased), NOT uniform,
 *   so live rounds will see slightly different combined_scores once the
 *   weighted rollup ships. The "lighting-biased v1 produces lighting bias"
 *   test asserts the math under the actual seed.
 */

import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertStrictEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  BALANCED_DIMENSION_WEIGHTS,
  computeWeightedDimensionContributions,
  computeWeightedScore,
  computeWeightedSignalScore,
  DEFAULT_DIMENSION_WEIGHTS,
  validateDimensionWeights,
  type DimensionScores,
} from './scoreRollup.ts';

// ─── computeWeightedScore: regression-equivalence ────────────────────────────

Deno.test('computeWeightedScore: balanced 0.25 weights == pre-W8 uniform mean', () => {
  // Spec invariant: with uniform 0.25 weights, weighted rollup MUST equal
  // the pre-W8 formula `(tech + light + comp + aes) / 4` for ANY input.
  const samples: DimensionScores[] = [
    { technical: 8.0, lighting: 7.5, composition: 8.5, aesthetic: 7.0 },
    { technical: 5.0, lighting: 5.0, composition: 5.0, aesthetic: 5.0 },
    { technical: 9.5, lighting: 9.0, composition: 9.5, aesthetic: 9.0 },
    { technical: 0, lighting: 10, composition: 5, aesthetic: 5 },
    { technical: 4.5, lighting: 6.0, composition: 7.0, aesthetic: 8.0 },
  ];

  for (const s of samples) {
    const uniformMean =
      Math.round(((s.technical + s.lighting + s.composition + s.aesthetic) / 4) * 100) / 100;
    const weighted = computeWeightedScore(s, BALANCED_DIMENSION_WEIGHTS);
    assertEquals(weighted, uniformMean, `mismatch for sample ${JSON.stringify(s)}`);
  }
});

Deno.test('computeWeightedScore: v1 default weights apply lighting bias', () => {
  // Lighting=0.30 means a high-lighting / low-other shot scores higher than
  // it would under uniform. The math: 0.25*tech + 0.30*light + 0.25*comp + 0.20*aes
  const s: DimensionScores = {
    technical: 6.0,
    lighting: 9.0,
    composition: 6.0,
    aesthetic: 6.0,
  };
  // Hand-computed expected:
  //   0.25*6.0 + 0.30*9.0 + 0.25*6.0 + 0.20*6.0
  //   = 1.5 + 2.7 + 1.5 + 1.2 = 6.9
  const result = computeWeightedScore(s, DEFAULT_DIMENSION_WEIGHTS);
  assertEquals(result, 6.9);
  // Compare to the uniform-mean baseline: (6 + 9 + 6 + 6) / 4 = 6.75
  // Lighting-biased rollup is HIGHER (6.9 > 6.75) — bias works.
  const uniform = computeWeightedScore(s, BALANCED_DIMENSION_WEIGHTS);
  assert(result > uniform, `lighting bias should raise score (got ${result}, uniform ${uniform})`);
});

Deno.test('computeWeightedScore: aesthetic-biased weights raise score for aesthetic-strong shot', () => {
  // Hypothetical Tier-A weights leaning into aesthetic (0.40)
  const aestheticBiased = {
    technical: 0.20,
    lighting: 0.20,
    composition: 0.20,
    aesthetic: 0.40,
  };
  const s: DimensionScores = {
    technical: 7.0,
    lighting: 7.0,
    composition: 7.0,
    aesthetic: 9.5,
  };
  // 0.20*7 + 0.20*7 + 0.20*7 + 0.40*9.5 = 4.2 + 3.8 = 8.0
  const result = computeWeightedScore(s, aestheticBiased);
  assertEquals(result, 8);
  const uniform = computeWeightedScore(s, BALANCED_DIMENSION_WEIGHTS);
  assert(result > uniform);
});

Deno.test('computeWeightedScore: missing weight key falls back to default', () => {
  // If a key is missing, the function uses DEFAULT_DIMENSION_WEIGHTS for that
  // key (defensive against malformed configs).
  const partial = {
    technical: 0.10, // overridden
    // lighting: defaults to 0.30
    // composition: defaults to 0.25
    // aesthetic: defaults to 0.20
  };
  const s: DimensionScores = { technical: 8, lighting: 8, composition: 8, aesthetic: 8 };
  // 0.10*8 + 0.30*8 + 0.25*8 + 0.20*8 = 0.8 + 2.4 + 2.0 + 1.6 = 6.8
  const result = computeWeightedScore(s, partial);
  assertEquals(result, 6.8);
});

Deno.test('computeWeightedScore: null/undefined weights use all defaults', () => {
  const s: DimensionScores = { technical: 8, lighting: 8, composition: 8, aesthetic: 8 };
  // Defaults sum to 1.0; 8 * 1.0 = 8.0
  assertEquals(computeWeightedScore(s, null), 8);
  assertEquals(computeWeightedScore(s, undefined), 8);
  assertEquals(computeWeightedScore(s, {}), 8);
});

Deno.test('computeWeightedScore: rounds to 2 decimals matching pre-W8 storage', () => {
  // Pre-W8 Pass 1: combined_score = Math.round(combined * 100) / 100
  const s: DimensionScores = { technical: 8.345, lighting: 7.123, composition: 8.987, aesthetic: 7.456 };
  // 0.25*8.345 + 0.30*7.123 + 0.25*8.987 + 0.20*7.456
  // = 2.08625 + 2.1369 + 2.24675 + 1.4912 = 7.961... → round to 7.96
  const result = computeWeightedScore(s, DEFAULT_DIMENSION_WEIGHTS);
  // Two-decimal precision check.
  assertAlmostEquals(result, 7.96, 0.01);
  // The rounded value matches Math.round(result * 100) / 100 (idempotent).
  assertEquals(Math.round(result * 100) / 100, result);
});

Deno.test('computeWeightedScore: non-numeric weight values fall back to default', () => {
  // String "0.25" parses; "abc" doesn't — fallback to default 0.25
  const partial = { technical: '0.25', lighting: 'abc', composition: 0.25, aesthetic: 0.25 };
  const s: DimensionScores = { technical: 8, lighting: 8, composition: 8, aesthetic: 8 };
  // technical: 0.25 (parsed), lighting: 0.30 (fallback), composition: 0.25, aesthetic: 0.25
  // = 8 * (0.25 + 0.30 + 0.25 + 0.25) = 8 * 1.05 = 8.4
  // (Note this exceeds 1.0 — but the function does not renormalise; spec calls
  // for save-time validation to reject such configs.)
  const result = computeWeightedScore(s, partial as Record<string, unknown> as Record<string, number>);
  assertEquals(result, 8.4);
});

// ─── computeWeightedDimensionContributions ────────────────────────────────────

Deno.test('computeWeightedDimensionContributions: returns per-dim products that sum to combined', () => {
  const s: DimensionScores = { technical: 8, lighting: 7, composition: 8.5, aesthetic: 7.5 };
  const contribs = computeWeightedDimensionContributions(s, DEFAULT_DIMENSION_WEIGHTS);
  // 0.25*8 = 2.0; 0.30*7 = 2.1; 0.25*8.5 = 2.125; 0.20*7.5 = 1.5
  assertEquals(contribs.technical, 2.0);
  assertEquals(contribs.lighting, 2.1);
  assertEquals(contribs.composition, 2.13); // 2.125 rounds to 2.13 (banker's? no — Math.round goes up at .5)
  assertEquals(contribs.aesthetic, 1.5);

  const sum = contribs.technical + contribs.lighting + contribs.composition + contribs.aesthetic;
  // Total ~= 2.0 + 2.1 + 2.13 + 1.5 = 7.73; computeWeightedScore returns 7.73 (rounded)
  // (exact 0.25*8 + 0.30*7 + 0.25*8.5 + 0.20*7.5 = 7.725 → rounds to 7.73 with Math.round)
  // Note: 7.725 * 100 = 772.5; Math.round(772.5) = 773 in browser (banker's rounding varies);
  // in Deno V8 Math.round(772.5) = 773 (half-up); so 7.73 expected.
  assertAlmostEquals(sum, computeWeightedScore(s, DEFAULT_DIMENSION_WEIGHTS), 0.02);
});

// ─── validateDimensionWeights ─────────────────────────────────────────────────

Deno.test('validateDimensionWeights: v1 default weights are valid (sum = 1.0)', () => {
  const r = validateDimensionWeights(DEFAULT_DIMENSION_WEIGHTS);
  assertEquals(r.valid, true);
  assertStrictEquals(r.error, null);
  assertAlmostEquals(r.sum, 1.0, 0.001);
});

Deno.test('validateDimensionWeights: balanced weights are valid', () => {
  const r = validateDimensionWeights(BALANCED_DIMENSION_WEIGHTS);
  assertEquals(r.valid, true);
});

Deno.test('validateDimensionWeights: missing key fails', () => {
  const r = validateDimensionWeights({ technical: 0.25, lighting: 0.30, composition: 0.45 } as never);
  assertEquals(r.valid, false);
  assert(r.error?.includes('aesthetic'));
});

Deno.test('validateDimensionWeights: sum mismatch fails outside tolerance', () => {
  const r = validateDimensionWeights({
    technical: 0.20,
    lighting: 0.30,
    composition: 0.25,
    aesthetic: 0.20, // sum = 0.95
  });
  assertEquals(r.valid, false);
  assert(r.error?.includes('sum to 1.0'));
});

Deno.test('validateDimensionWeights: sum within 0.001 tolerance passes', () => {
  // 0.2501 + 0.3 + 0.25 + 0.2 = 1.0001 — within tolerance
  const r = validateDimensionWeights({
    technical: 0.2501,
    lighting: 0.30,
    composition: 0.25,
    aesthetic: 0.20,
  });
  assertEquals(r.valid, true);
});

Deno.test('validateDimensionWeights: out-of-range value fails', () => {
  const r = validateDimensionWeights({
    technical: -0.5,
    lighting: 0.50,
    composition: 0.50,
    aesthetic: 0.50,
  });
  assertEquals(r.valid, false);
  assert(r.error?.includes('out of range'));
});

Deno.test('validateDimensionWeights: NaN value fails', () => {
  const r = validateDimensionWeights({
    technical: NaN,
    lighting: 0.30,
    composition: 0.25,
    aesthetic: 0.20,
  });
  assertEquals(r.valid, false);
  assert(r.error?.includes('finite'));
});

Deno.test('validateDimensionWeights: null/non-object fails gracefully', () => {
  assertEquals(validateDimensionWeights(null).valid, false);
  assertEquals(validateDimensionWeights(undefined).valid, false);
});

Deno.test('validateDimensionWeights: custom tolerance', () => {
  // 0.2 + 0.3 + 0.25 + 0.20 = 0.95 — fails default 0.001 tolerance
  const r1 = validateDimensionWeights({
    technical: 0.20, lighting: 0.30, composition: 0.25, aesthetic: 0.20,
  });
  assertEquals(r1.valid, false);

  // Same input, tolerance widened to 0.1 — passes
  const r2 = validateDimensionWeights({
    technical: 0.20, lighting: 0.30, composition: 0.25, aesthetic: 0.20,
  }, 0.1);
  assertEquals(r2.valid, true);
});

// ─── computeWeightedSignalScore (W11 forward-compat) ─────────────────────────

Deno.test('computeWeightedSignalScore: uniform weights produce simple average', () => {
  const signals = { a: 8, b: 7, c: 9 };
  const weights = { a: 1, b: 1, c: 1 };
  // (8 + 7 + 9) / 3 = 8.0
  assertEquals(computeWeightedSignalScore(signals, weights), 8);
});

Deno.test('computeWeightedSignalScore: weighted average', () => {
  const signals = { a: 10, b: 5 };
  // 2x weight on b means b dominates
  const weights = { a: 1, b: 3 };
  // (10*1 + 5*3) / (1+3) = (10 + 15) / 4 = 6.25
  assertEquals(computeWeightedSignalScore(signals, weights), 6.25);
});

Deno.test('computeWeightedSignalScore: missing signal key defaults to 0', () => {
  const signals = { a: 10 };
  const weights = { a: 1, b: 1 };
  // (10*1 + 0*1) / 2 = 5.0
  assertEquals(computeWeightedSignalScore(signals, weights), 5);
});

Deno.test('computeWeightedSignalScore: empty weights returns NaN', () => {
  // Caller falls back to dimension_weights rollup when this returns NaN.
  const result = computeWeightedSignalScore({}, {});
  assert(Number.isNaN(result));
});

Deno.test('computeWeightedSignalScore: zero/negative weights are skipped', () => {
  const signals = { a: 10, b: 5 };
  const weights = { a: 1, b: 0 }; // b weight is 0 → skip
  // Only a contributes: 10
  assertEquals(computeWeightedSignalScore(signals, weights), 10);
});

Deno.test('computeWeightedSignalScore: round to 2 decimals', () => {
  const signals = { a: 7.123, b: 7.456 };
  const weights = { a: 1, b: 1 };
  // (7.123 + 7.456) / 2 = 7.2895 → 7.29
  assertEquals(computeWeightedSignalScore(signals, weights), 7.29);
});
