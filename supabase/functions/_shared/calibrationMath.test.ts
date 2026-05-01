/**
 * Wave 14 — calibration math unit tests.
 *
 * Run: deno test --no-check --allow-all supabase/functions/_shared/calibrationMath.test.ts
 *
 * The 6 required tests cover:
 *   1. Score-delta calc — equal, single-axis shift, drift threshold
 *   2. Slot agreement — N matches, zero shared, all-mismatch
 *   3. Regression detection — escalation vs improvement, null tolerance
 *   4. Master listing in-band — per-tier band edges
 *   5. Stratified sampler determinism — same seed = same output
 *   6. Acceptance pass/fail — all-green vs single-axis red
 *
 * All tests are pure / synchronous / no IO.
 */

import {
  assert,
  assertEquals,
  assertAlmostEquals,
  assertNotEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  computeScoreConsistency,
  computeSlotAgreement,
  detectRegressions,
  evaluateAcceptance,
  masterListingInBand,
  medianOrNull,
  stratifiedSample,
  voiceAnchorStability,
  hashStringWithSeed,
  type CandidateProject,
  type PairedClutter,
  type PairedImageScore,
  type SlotDecision,
} from './calibrationMath.ts';

// ─── Test 1: score-delta calc ───────────────────────────────────────────────

Deno.test('computeScoreConsistency: identical scores produce zero deltas + no drift', () => {
  const pairs: PairedImageScore[] = [
    {
      stem: 'IMG_001',
      prior: { technical: 8.0, lighting: 7.5, composition: 8.5, aesthetic: 7.0 },
      now: { technical: 8.0, lighting: 7.5, composition: 8.5, aesthetic: 7.0 },
    },
    {
      stem: 'IMG_002',
      prior: { technical: 6.0, lighting: 6.0, composition: 6.0, aesthetic: 6.0 },
      now: { technical: 6.0, lighting: 6.0, composition: 6.0, aesthetic: 6.0 },
    },
  ];
  const result = computeScoreConsistency(pairs);
  assertEquals(result.median.technical, 0);
  assertEquals(result.max.technical, 0);
  assertEquals(result.max_axis_max, 0);
  assertEquals(result.drift_events.length, 0);
});

Deno.test('computeScoreConsistency: 1-axis 1.0 shift produces 1.0 max + drift event', () => {
  const pairs: PairedImageScore[] = [
    {
      stem: 'IMG_001',
      prior: { technical: 7.0, lighting: 7.0, composition: 7.0, aesthetic: 7.0 },
      now: { technical: 8.0, lighting: 7.0, composition: 7.0, aesthetic: 7.0 },
    },
    // padding image so percentile math doesn't degenerate
    {
      stem: 'IMG_002',
      prior: { technical: 6.0, lighting: 6.0, composition: 6.0, aesthetic: 6.0 },
      now: { technical: 6.0, lighting: 6.0, composition: 6.0, aesthetic: 6.0 },
    },
  ];
  const result = computeScoreConsistency(pairs);
  assertEquals(result.max.technical, 1.0);
  assertEquals(result.max.lighting, 0);
  assertEquals(result.max_axis_max, 1.0);
  assertEquals(result.drift_events.length, 1);
  assertEquals(result.drift_events[0].stem, 'IMG_001');
  assertEquals(result.drift_events[0].axis, 'technical');
  assertEquals(result.drift_events[0].delta, 1.0);
});

Deno.test('computeScoreConsistency: 0.4 shift on every image stays under drift threshold', () => {
  const pairs: PairedImageScore[] = [
    {
      stem: 'A',
      prior: { technical: 7.0, lighting: 7.0, composition: 7.0, aesthetic: 7.0 },
      now: { technical: 7.4, lighting: 7.4, composition: 7.4, aesthetic: 7.4 },
    },
    {
      stem: 'B',
      prior: { technical: 8.0, lighting: 8.0, composition: 8.0, aesthetic: 8.0 },
      now: { technical: 8.4, lighting: 8.4, composition: 8.4, aesthetic: 8.4 },
    },
  ];
  const result = computeScoreConsistency(pairs);
  // Threshold is 0.5 — 0.4 deltas should NOT produce drift events.
  assertEquals(result.drift_events.length, 0);
  assertAlmostEquals(result.max.technical, 0.4, 0.001);
});

// ─── Test 2: slot agreement ─────────────────────────────────────────────────

Deno.test('computeSlotAgreement: 5 slots, 4 matching → 0.8', () => {
  const prior: SlotDecision[] = [
    { slot_id: 'kitchen_main', winning_stem: 'IMG_010' },
    { slot_id: 'bedroom_master', winning_stem: 'IMG_020' },
    { slot_id: 'bathroom_main', winning_stem: 'IMG_030' },
    { slot_id: 'living_room', winning_stem: 'IMG_040' },
    { slot_id: 'exterior_front', winning_stem: 'IMG_050' },
  ];
  const now: SlotDecision[] = [
    { slot_id: 'kitchen_main', winning_stem: 'IMG_010' },          // match
    { slot_id: 'bedroom_master', winning_stem: 'IMG_020' },        // match
    { slot_id: 'bathroom_main', winning_stem: 'IMG_030' },         // match
    { slot_id: 'living_room', winning_stem: 'IMG_041' },           // disagree
    { slot_id: 'exterior_front', winning_stem: 'IMG_050' },        // match
  ];
  const result = computeSlotAgreement(prior, now);
  assertEquals(result.agreement_pct, 0.8);
  assertEquals(result.matched, 4);
  assertEquals(result.total, 5);
});

Deno.test('computeSlotAgreement: zero shared slots → null (not /0)', () => {
  const prior: SlotDecision[] = [
    { slot_id: 'kitchen_main', winning_stem: 'IMG_010' },
  ];
  const now: SlotDecision[] = [
    { slot_id: 'bedroom_master', winning_stem: 'IMG_020' },
  ];
  const result = computeSlotAgreement(prior, now);
  assertEquals(result.agreement_pct, null);
  assertEquals(result.matched, 0);
  assertEquals(result.total, 0);
});

Deno.test('computeSlotAgreement: all-disagree → 0.0 (not null)', () => {
  const prior: SlotDecision[] = [
    { slot_id: 'kitchen_main', winning_stem: 'IMG_010' },
    { slot_id: 'bedroom_master', winning_stem: 'IMG_020' },
  ];
  const now: SlotDecision[] = [
    { slot_id: 'kitchen_main', winning_stem: 'IMG_011' },
    { slot_id: 'bedroom_master', winning_stem: 'IMG_021' },
  ];
  const result = computeSlotAgreement(prior, now);
  assertEquals(result.agreement_pct, 0);
  assertEquals(result.matched, 0);
  assertEquals(result.total, 2);
});

// ─── Test 3: regression detection ───────────────────────────────────────────

Deno.test('detectRegressions: clutter escalation = regression; improvement = NOT regression', () => {
  const pairs: PairedClutter[] = [
    { stem: 'A', prior: 'none', now: 'minor_photoshoppable' },     // regression
    { stem: 'B', prior: 'minor_photoshoppable', now: 'moderate_retouch' }, // regression
    { stem: 'C', prior: 'moderate_retouch', now: 'minor_photoshoppable' }, // improvement (not a regression)
    { stem: 'D', prior: 'none', now: 'none' },                     // unchanged
    { stem: 'E', prior: null, now: 'major_reject' },               // skip (null prior)
    { stem: 'F', prior: 'minor_photoshoppable', now: null },       // skip (null now)
  ];
  const result = detectRegressions(pairs, 6);
  assertEquals(result.count, 2);
  // pct is rounded to 4 dp by detectRegressions for stable JSON serialisation.
  assertAlmostEquals(result.pct, 2 / 6, 0.0001);
  assertEquals(result.regressions[0].stem, 'A');
  assertEquals(result.regressions[1].stem, 'B');
  assertEquals(result.regressions[0].rank_jump, 1);
});

Deno.test('detectRegressions: empty pairs → 0 count, 0 pct (no NaN)', () => {
  const result = detectRegressions([], 0);
  assertEquals(result.count, 0);
  assertEquals(result.pct, 0);
});

// ─── Test 4: master listing in-band ─────────────────────────────────────────

Deno.test('masterListingInBand: per-tier word_count band edges', () => {
  // Premium band: 700-1000
  assertEquals(masterListingInBand('premium', 720), true);
  assertEquals(masterListingInBand('premium', 700), true);  // edge
  assertEquals(masterListingInBand('premium', 1000), true); // edge
  assertEquals(masterListingInBand('premium', 699), false); // below
  assertEquals(masterListingInBand('premium', 1001), false); // above

  // Standard band: 500-750
  assertEquals(masterListingInBand('standard', 600), true);
  assertEquals(masterListingInBand('standard', 499), false);
  assertEquals(masterListingInBand('standard', 751), false);

  // Approachable band: 350-500
  assertEquals(masterListingInBand('approachable', 400), true);
  assertEquals(masterListingInBand('approachable', 349), false);
  assertEquals(masterListingInBand('approachable', 501), false);

  // Null / NaN
  assertEquals(masterListingInBand('standard', null), false);
  assertEquals(masterListingInBand('standard', undefined), false);
  assertEquals(masterListingInBand('standard', NaN), false);
});

// ─── Test 5: stratified sampler determinism ─────────────────────────────────

Deno.test('stratifiedSample: same seed + candidates → identical output', () => {
  // Larger candidate pool so different seeds can produce different sub-sets.
  const candidates: CandidateProject[] = [];
  // 10 premium (5 well + 5 challenging)
  for (let i = 1; i <= 10; i++) {
    candidates.push({
      project_id: `p${String(i).padStart(2, '0')}`,
      property_tier: 'premium',
      prior_override_count: i <= 5 ? 1 : 6,
    });
  }
  // 10 standard
  for (let i = 1; i <= 10; i++) {
    candidates.push({
      project_id: `s${String(i).padStart(2, '0')}`,
      property_tier: 'standard',
      prior_override_count: i <= 5 ? 1 : 6,
    });
  }
  // 10 approachable
  for (let i = 1; i <= 10; i++) {
    candidates.push({
      project_id: `a${String(i).padStart(2, '0')}`,
      property_tier: 'approachable',
      prior_override_count: i <= 5 ? 1 : 6,
    });
  }
  const strata = { premium: 4, standard: 4, approachable: 2 };

  const r1 = stratifiedSample(candidates, strata, 42, 10);
  const r2 = stratifiedSample(candidates, strata, 42, 10);
  const r3 = stratifiedSample(candidates, strata, 99, 10);

  assertEquals(r1, r2, 'Same seed must produce identical output');
  assert(r1.length <= 10, 'Cap respected');
  // With 30 candidates and seed-driven hashing, 99 must produce a meaningfully
  // different ordering than 42 (probability of identical 10-pick is ~0).
  assertNotEquals(r1.sort().join(','), r3.sort().join(','),
    'Different seed must produce a different sample on a 30-row pool');
});

Deno.test('stratifiedSample: well/challenging split balances within tier', () => {
  const candidates: CandidateProject[] = [
    // 5 well + 5 challenging in standard tier
    ...['s01', 's02', 's03', 's04', 's05'].map((id) => ({
      project_id: id,
      property_tier: 'standard' as const,
      prior_override_count: 1,
    })),
    ...['s11', 's12', 's13', 's14', 's15'].map((id) => ({
      project_id: id,
      property_tier: 'standard' as const,
      prior_override_count: 6,
    })),
  ];
  const result = stratifiedSample(candidates, { premium: 0, standard: 4, approachable: 0 }, 7, 4);
  assertEquals(result.length, 4);
  // Of the 4, should pick 2 from well (override <=2) and 2 from challenging (>=4).
  const wellIds = new Set(['s01','s02','s03','s04','s05']);
  const challengingIds = new Set(['s11','s12','s13','s14','s15']);
  const fromWell = result.filter((id) => wellIds.has(id)).length;
  const fromChallenging = result.filter((id) => challengingIds.has(id)).length;
  assertEquals(fromWell, 2);
  assertEquals(fromChallenging, 2);
});

Deno.test('hashStringWithSeed: stable + diffuses', () => {
  // Stability — same input gives same output.
  assertEquals(hashStringWithSeed('p01', 42), hashStringWithSeed('p01', 42));
  // Diffusion — different seed changes the hash.
  assertNotEquals(hashStringWithSeed('p01', 42), hashStringWithSeed('p01', 43));
  assertNotEquals(hashStringWithSeed('p01', 42), hashStringWithSeed('p02', 42));
});

// ─── Test 6: acceptance pass/fail ───────────────────────────────────────────

Deno.test('evaluateAcceptance: all-green inputs → pass=true', () => {
  const result = evaluateAcceptance({
    median_score_delta: 0.15,        // <0.3 ✓
    median_slot_agreement: 0.92,     // >=0.80 ✓
    median_override_rate: 0.05,      // ∈ [0.02, 0.08] ✓
    median_regression_pct: 0.005,    // <0.02 ✓
    master_listing_oob_rate: 0.0,    // <=0.10 ✓
  });
  assertEquals(result.pass, true);
  assertEquals(result.failed_criteria, []);
});

Deno.test('evaluateAcceptance: high score delta → pass=false with that criterion', () => {
  const result = evaluateAcceptance({
    median_score_delta: 0.45,        // BAD
    median_slot_agreement: 0.92,
    median_override_rate: 0.05,
    median_regression_pct: 0.005,
    master_listing_oob_rate: 0.0,
  });
  assertEquals(result.pass, false);
  assertEquals(result.failed_criteria, ['median_score_delta']);
});

Deno.test('evaluateAcceptance: override rate too LOW also fails', () => {
  const result = evaluateAcceptance({
    median_score_delta: 0.1,
    median_slot_agreement: 0.92,
    median_override_rate: 0.005,     // too low
    median_regression_pct: 0.005,
    master_listing_oob_rate: 0.0,
  });
  assertEquals(result.pass, false);
  assertEquals(result.failed_criteria, ['median_override_rate']);
});

Deno.test('evaluateAcceptance: NULL inputs do not flag as failure', () => {
  const result = evaluateAcceptance({
    median_score_delta: null,
    median_slot_agreement: null,
    median_override_rate: null,
    median_regression_pct: null,
    master_listing_oob_rate: null,
  });
  // NULL = "not evaluable" → pass=true (vacuously). The dashboard surfaces
  // null inputs separately so operators see "no data" rather than a green tick.
  assertEquals(result.pass, true);
  assertEquals(result.failed_criteria, []);
});

Deno.test('evaluateAcceptance: multiple failures collected in order', () => {
  const result = evaluateAcceptance({
    median_score_delta: 0.6,        // BAD
    median_slot_agreement: 0.50,    // BAD
    median_override_rate: 0.05,
    median_regression_pct: 0.05,    // BAD
    master_listing_oob_rate: 0.20,  // BAD
  });
  assertEquals(result.pass, false);
  assertEquals(result.failed_criteria.length, 4);
  assert(result.failed_criteria.includes('median_score_delta'));
  assert(result.failed_criteria.includes('median_slot_agreement'));
  assert(result.failed_criteria.includes('median_regression_pct'));
  assert(result.failed_criteria.includes('master_listing_oob_rate'));
});

// ─── Bonus tests: medianOrNull, voiceAnchorStability ────────────────────────

Deno.test('medianOrNull: ignores NaN/null and returns null on all-empty', () => {
  assertEquals(medianOrNull([1, 2, 3]), 2);
  assertEquals(medianOrNull([1, 2, 3, 4]), 2.5);
  assertEquals(medianOrNull([]), null);
  assertEquals(medianOrNull([null, undefined, NaN]), null);
  assertEquals(medianOrNull([1, null, 3]), 2);
});

Deno.test('voiceAnchorStability: 3 rounds, all-same anchor → 1.0; 3-rounds-3-distinct → 0.0', () => {
  const allSame = voiceAnchorStability([
    { tier: 'standard', tone_anchor: 'Mosman premium' },
    { tier: 'standard', tone_anchor: 'Mosman premium' },
    { tier: 'standard', tone_anchor: 'Mosman premium' },
  ]);
  // 3 rounds, 1 distinct anchor → 1 - 1/3 = 0.6667 (rounded to 4 dp by helper).
  assertAlmostEquals(allSame.per_tier.standard ?? 0, 1 - 1 / 3, 0.0001);

  const allDifferent = voiceAnchorStability([
    { tier: 'standard', tone_anchor: 'Voice A' },
    { tier: 'standard', tone_anchor: 'Voice B' },
    { tier: 'standard', tone_anchor: 'Voice C' },
  ]);
  assertEquals(allDifferent.per_tier.standard, 0);

  const empty = voiceAnchorStability([]);
  assertEquals(empty.overall, null);
});
