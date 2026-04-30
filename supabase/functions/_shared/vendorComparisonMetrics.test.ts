/**
 * vendorComparisonMetrics.test.ts — Wave 11.8 unit tests for the comparison
 * metrics + markdown report generator.
 *
 * Run: deno test --no-check --allow-all supabase/functions/_shared/vendorComparisonMetrics.test.ts
 */

import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertStringIncludes,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  computeAgreementMatrix,
  computeObjectOverlap,
  computeRoomTypeAgreement,
  computeScoreDelta,
  generateMarkdownReport,
  type CompositionResult,
  type ComparisonInputs,
  type VendorRunSummary,
} from './vendorComparisonMetrics.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function comp(
  group_id: string,
  stem: string,
  out: Record<string, unknown>,
): CompositionResult {
  return { group_id, stem, output: out };
}

function makeSummary(
  label: string,
  vendor: 'anthropic' | 'google',
  model: string,
  results: CompositionResult[],
  cost = 0.5,
): VendorRunSummary {
  return {
    label,
    vendor,
    model,
    total_cost_usd: cost,
    total_elapsed_ms: 12_000,
    composition_count: results.length,
    failure_count: 0,
    results,
  };
}

// ─── computeAgreementMatrix (v1 stub returns null) ──────────────────────────

Deno.test('computeAgreementMatrix — v1 returns null agreement (slot data unavailable)', () => {
  const a = computeAgreementMatrix([], []);
  assertEquals(a.agreement_rate, null);
  assertEquals(a.slots.length, 0);
});

// ─── computeScoreDelta ───────────────────────────────────────────────────────

Deno.test('computeScoreDelta — perfect agreement on identical scores', () => {
  const out = { technical_score: 7, lighting_score: 8, composition_score: 7, aesthetic_score: 6 };
  const p = [comp('g1', 's1', out), comp('g2', 's2', out)];
  const s = [comp('g1', 's1', out), comp('g2', 's2', out)];
  const delta = computeScoreDelta(p, s);
  assertEquals(delta.mean_abs_delta, 0);
  // With identical scores correlation is undefined (zero variance) → null
  assertEquals(delta.correlation, null);
  assertEquals(delta.overlap_count, 2);
  assertEquals(delta.primary_distribution.count, 2);
});

Deno.test('computeScoreDelta — strict positive correlation on monotone-increasing pair', () => {
  const p = [
    comp('g1', 's1', { technical_score: 4, lighting_score: 4, composition_score: 4, aesthetic_score: 4 }),
    comp('g2', 's2', { technical_score: 6, lighting_score: 6, composition_score: 6, aesthetic_score: 6 }),
    comp('g3', 's3', { technical_score: 9, lighting_score: 9, composition_score: 9, aesthetic_score: 9 }),
  ];
  const s = [
    comp('g1', 's1', { technical_score: 5, lighting_score: 5, composition_score: 5, aesthetic_score: 5 }),
    comp('g2', 's2', { technical_score: 7, lighting_score: 7, composition_score: 7, aesthetic_score: 7 }),
    comp('g3', 's3', { technical_score: 8, lighting_score: 8, composition_score: 8, aesthetic_score: 8 }),
  ];
  const delta = computeScoreDelta(p, s);
  // Pearson on monotone-increasing-but-not-proportional sequences yields
  // strong positive correlation (>0.9) without being a perfect 1.0.
  assert(delta.correlation !== null && delta.correlation > 0.9);
  assert(delta.mean_abs_delta !== null && delta.mean_abs_delta > 0);
  assertEquals(delta.overlap_count, 3);
});

Deno.test('computeScoreDelta — only overlapping group_ids are included', () => {
  const p = [
    comp('g1', 's1', { technical_score: 5, lighting_score: 5, composition_score: 5, aesthetic_score: 5 }),
    comp('g2', 's2', { technical_score: 7, lighting_score: 7, composition_score: 7, aesthetic_score: 7 }),
  ];
  const s = [
    comp('g1', 's1', { technical_score: 5, lighting_score: 5, composition_score: 5, aesthetic_score: 5 }),
    comp('g3', 's3', { technical_score: 8, lighting_score: 8, composition_score: 8, aesthetic_score: 8 }),
  ];
  const delta = computeScoreDelta(p, s);
  assertEquals(delta.overlap_count, 1);
  // distribution counts include all rows in each set, not just overlap
  assertEquals(delta.primary_distribution.count, 2);
  assertEquals(delta.shadow_distribution.count, 2);
});

Deno.test('computeScoreDelta — non-numeric scores skip the composition', () => {
  const p = [
    comp('g1', 's1', { technical_score: 'oops', lighting_score: 5, composition_score: 5, aesthetic_score: 5 }),
    comp('g2', 's2', { technical_score: 7, lighting_score: 7, composition_score: 7, aesthetic_score: 7 }),
  ];
  const s = [
    comp('g1', 's1', { technical_score: 5, lighting_score: 5, composition_score: 5, aesthetic_score: 5 }),
    comp('g2', 's2', { technical_score: 7, lighting_score: 7, composition_score: 7, aesthetic_score: 7 }),
  ];
  const delta = computeScoreDelta(p, s);
  assertEquals(delta.overlap_count, 1);
  assertEquals(delta.mean_abs_delta, 0);
});

Deno.test('computeScoreDelta — empty inputs return null delta + null correlation', () => {
  const delta = computeScoreDelta([], []);
  assertEquals(delta.mean_abs_delta, null);
  assertEquals(delta.correlation, null);
  assertEquals(delta.overlap_count, 0);
});

Deno.test('computeScoreDelta — distribution stats reflect score range', () => {
  const p = [
    comp('g1', 's1', { technical_score: 2, lighting_score: 2, composition_score: 2, aesthetic_score: 2 }),
    comp('g2', 's2', { technical_score: 8, lighting_score: 8, composition_score: 8, aesthetic_score: 8 }),
  ];
  const delta = computeScoreDelta(p, []);
  // primary distribution: combined scores are 2 and 8.
  assertEquals(delta.primary_distribution.min, 2);
  assertEquals(delta.primary_distribution.max, 8);
  assertEquals(delta.primary_distribution.mean, 5);
  // stddev = sqrt(((2-5)^2 + (8-5)^2) / 2) = sqrt(18/2) = 3
  assertAlmostEquals(delta.primary_distribution.stddev!, 3, 1e-9);
});

// ─── computeObjectOverlap (Jaccard on key_elements) ─────────────────────────

Deno.test('computeObjectOverlap — identical key_elements → Jaccard 1.0', () => {
  const p = [comp('g1', 's1', { key_elements: ['kitchen island', 'pendant lights'] })];
  const s = [comp('g1', 's1', { key_elements: ['kitchen island', 'pendant lights'] })];
  const o = computeObjectOverlap(p, s);
  assertEquals(o.jaccard, 1);
  assertEquals(o.per_composition[0].primary_only.length, 0);
  assertEquals(o.per_composition[0].shadow_only.length, 0);
});

Deno.test('computeObjectOverlap — disjoint key_elements → Jaccard 0.0', () => {
  const p = [comp('g1', 's1', { key_elements: ['a', 'b'] })];
  const s = [comp('g1', 's1', { key_elements: ['c', 'd'] })];
  const o = computeObjectOverlap(p, s);
  assertEquals(o.jaccard, 0);
  assertEquals(o.per_composition[0].primary_only, ['a', 'b']);
  assertEquals(o.per_composition[0].shadow_only, ['c', 'd']);
});

Deno.test('computeObjectOverlap — case-insensitive matching', () => {
  const p = [comp('g1', 's1', { key_elements: ['Kitchen Island', 'PENDANT LIGHTS'] })];
  const s = [comp('g1', 's1', { key_elements: ['kitchen island', 'pendant lights'] })];
  const o = computeObjectOverlap(p, s);
  assertEquals(o.jaccard, 1);
});

Deno.test('computeObjectOverlap — partial overlap → 1/3 = 0.333', () => {
  const p = [comp('g1', 's1', { key_elements: ['a', 'b'] })];
  const s = [comp('g1', 's1', { key_elements: ['b', 'c'] })];
  const o = computeObjectOverlap(p, s);
  // intersection {b} = 1; union {a,b,c} = 3
  assertAlmostEquals(o.jaccard!, 1 / 3, 1e-9);
});

Deno.test('computeObjectOverlap — empty arrays both sides → Jaccard 1.0 (vacuous)', () => {
  const p = [comp('g1', 's1', { key_elements: [] })];
  const s = [comp('g1', 's1', { key_elements: [] })];
  const o = computeObjectOverlap(p, s);
  assertEquals(o.jaccard, 1);
});

Deno.test('computeObjectOverlap — averages across multiple compositions', () => {
  const p = [
    comp('g1', 's1', { key_elements: ['a'] }),
    comp('g2', 's2', { key_elements: ['x', 'y'] }),
  ];
  const s = [
    comp('g1', 's1', { key_elements: ['a', 'b'] }),    // jaccard 1/2 = 0.5
    comp('g2', 's2', { key_elements: ['x', 'y', 'z'] }), // jaccard 2/3 ≈ 0.667
  ];
  const o = computeObjectOverlap(p, s);
  // mean of 0.5 + 0.6667 ≈ 0.5833
  assertAlmostEquals(o.jaccard!, (0.5 + 2 / 3) / 2, 1e-9);
});

Deno.test('computeObjectOverlap — no overlapping group_ids → null', () => {
  const p = [comp('g1', 's1', { key_elements: ['a'] })];
  const s = [comp('g2', 's2', { key_elements: ['a'] })];
  const o = computeObjectOverlap(p, s);
  assertEquals(o.jaccard, null);
  assertEquals(o.per_composition.length, 0);
});

// ─── computeRoomTypeAgreement ────────────────────────────────────────────────

Deno.test('computeRoomTypeAgreement — perfect agreement', () => {
  const p = [
    comp('g1', 's1', { room_type: 'kitchen' }),
    comp('g2', 's2', { room_type: 'living_room' }),
  ];
  const s = [
    comp('g1', 's1', { room_type: 'kitchen' }),
    comp('g2', 's2', { room_type: 'living_room' }),
  ];
  const r = computeRoomTypeAgreement(p, s);
  assertEquals(r.agreement_rate, 1);
  assertEquals(r.matches, 2);
  assertEquals(r.total, 2);
  assertEquals(r.disagreements.length, 0);
});

Deno.test('computeRoomTypeAgreement — tracks disagreement entries', () => {
  const p = [
    comp('g1', 's1', { room_type: 'exterior_front' }),
    comp('g2', 's2', { room_type: 'kitchen' }),
  ];
  const s = [
    comp('g1', 's1', { room_type: 'exterior_rear' }),
    comp('g2', 's2', { room_type: 'kitchen' }),
  ];
  const r = computeRoomTypeAgreement(p, s);
  assertEquals(r.matches, 1);
  assertEquals(r.total, 2);
  assertEquals(r.agreement_rate, 0.5);
  assertEquals(r.disagreements.length, 1);
  assertEquals(r.disagreements[0].stem, 's1');
  assertEquals(r.disagreements[0].primary_room_type, 'exterior_front');
  assertEquals(r.disagreements[0].shadow_room_type, 'exterior_rear');
});

Deno.test('computeRoomTypeAgreement — missing room_type on either side skips composition', () => {
  const p = [comp('g1', 's1', { room_type: 'kitchen' })];
  const s = [comp('g1', 's1', {})];
  const r = computeRoomTypeAgreement(p, s);
  assertEquals(r.total, 0);
  assertEquals(r.agreement_rate, null);
});

// ─── generateMarkdownReport ──────────────────────────────────────────────────

function mkComparison(): ComparisonInputs {
  const p = [
    comp('g1', 'IMG_001', {
      room_type: 'kitchen',
      technical_score: 7,
      lighting_score: 8,
      composition_score: 7,
      aesthetic_score: 6,
      key_elements: ['island', 'pendants'],
    }),
    comp('g2', 'IMG_002', {
      room_type: 'living_room',
      technical_score: 9,
      lighting_score: 9,
      composition_score: 9,
      aesthetic_score: 8,
      key_elements: ['sofa', 'fireplace'],
    }),
  ];
  const s = [
    comp('g1', 'IMG_001', {
      room_type: 'kitchen',
      technical_score: 8,
      lighting_score: 8,
      composition_score: 7,
      aesthetic_score: 7,
      key_elements: ['island', 'bar stools'],
    }),
    comp('g2', 'IMG_002', {
      room_type: 'lounge',
      technical_score: 7,
      lighting_score: 7,
      composition_score: 7,
      aesthetic_score: 6,
      key_elements: ['sofa', 'rug'],
    }),
  ];
  return {
    primary: makeSummary('anthropic-opus', 'anthropic', 'claude-opus-4-7', p, 1.0),
    shadow: makeSummary('google-pro', 'google', 'gemini-2.0-pro', s, 0.30),
    agreement: computeAgreementMatrix(p, s),
    score: computeScoreDelta(p, s),
    obj: computeObjectOverlap(p, s),
    room: computeRoomTypeAgreement(p, s),
  };
}

Deno.test('generateMarkdownReport — emits all 7 spec sections', () => {
  const c = mkComparison();
  const md = generateMarkdownReport('round-abc', [c]);
  assertStringIncludes(md, '# Vendor Comparison Report');
  assertStringIncludes(md, '`round-abc`');
  assertStringIncludes(md, '## 1. anthropic-opus vs google-pro');
  assertStringIncludes(md, '### Summary');
  assertStringIncludes(md, '### Slot Decision Agreement Matrix');
  assertStringIncludes(md, '### Score Distribution');
  assertStringIncludes(md, '### Room-Type Agreement');
  assertStringIncludes(md, '### Object Detection Overlap');
  assertStringIncludes(md, '### Cost Comparison');
  assertStringIncludes(md, '### Editorial Recommendation');
});

Deno.test('generateMarkdownReport — surfaces room-type disagreements in the disagreements table', () => {
  const c = mkComparison();
  const md = generateMarkdownReport('round-abc', [c]);
  // g2 disagreed: living_room vs lounge → table row should exist
  assertStringIncludes(md, '`IMG_002`');
  assertStringIncludes(md, 'living_room');
  assertStringIncludes(md, 'lounge');
});

Deno.test('generateMarkdownReport — empty comparisons handled gracefully', () => {
  const md = generateMarkdownReport('round-empty', []);
  assertStringIncludes(md, 'round-empty');
  assertStringIncludes(md, 'No comparisons provided');
});

Deno.test('generateMarkdownReport — slot decision section renders n/a in v1', () => {
  const c = mkComparison();
  const md = generateMarkdownReport('round-abc', [c]);
  assertStringIncludes(md, 'Slot decisions not available in unified comparison mode');
});

Deno.test('generateMarkdownReport — emits cost comparison + per-composition cost', () => {
  const c = mkComparison();
  const md = generateMarkdownReport('round-abc', [c]);
  assertStringIncludes(md, '$1.0000');
  assertStringIncludes(md, '$0.3000');
  // Per composition cost = 1.0 / 2 = 0.5; 0.30 / 2 = 0.15
  assertStringIncludes(md, '$0.5000');
  assertStringIncludes(md, '$0.1500');
});

Deno.test('generateMarkdownReport — editorial recommendation includes correlation interpretation', () => {
  const c = mkComparison();
  const md = generateMarkdownReport('round-abc', [c]);
  // With our small fixture pearson is undefined or +1; the recommendation
  // must mention correlation with one of the descriptive bands.
  assert(
    md.includes('Combined-score correlation') ||
      md.includes('Insufficient overlapping compositions'),
    'expected recommendation to mention correlation or insufficient samples',
  );
});

Deno.test('generateMarkdownReport — multiple comparisons render distinct sections', () => {
  const c1 = mkComparison();
  const c2 = mkComparison();
  c2.primary.label = 'anthropic-sonnet';
  c2.shadow.label = 'google-flash';
  const md = generateMarkdownReport('round-abc', [c1, c2]);
  assertStringIncludes(md, '## 1. anthropic-opus vs google-pro');
  assertStringIncludes(md, '## 2. anthropic-sonnet vs google-flash');
});
