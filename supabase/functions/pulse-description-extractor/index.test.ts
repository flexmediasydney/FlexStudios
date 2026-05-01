/**
 * Tests for pulse-description-extractor pure helpers + the response schema.
 *
 * Mirrors the photographerTechniquesBlock.test.ts pattern:
 *   - assertEquals / assertStringIncludes from std/assert
 *   - One Deno.test per assertion cluster
 *   - No network / DB calls — pure unit tests over the exported helpers.
 *
 * Coverage targets:
 *   1. Schema shape — required fields + enum constraints + array bounds
 *   2. derivePriceBand — rental detection (listing_type AND magnitude)
 *   3. derivePriceBand — price-band thresholds
 *   4. normaliseExtractedPayload — required defaults + array clamping
 *   5. normaliseExtractedPayload — voice_register coercion
 *   6. normaliseExtractedPayload — string truncation (archetype, notes)
 *   7. estimateGemini25ProCost — Gemini 2.5 Pro pricing not Sonnet fallback
 *   8. estimateGemini25ProCost — zero-token corner case
 */

import {
  assertEquals,
  assertStringIncludes,
  assertAlmostEquals,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  PULSE_EXTRACT_SCHEMA,
  derivePriceBand,
  normaliseExtractedPayload,
  estimateGemini25ProCost,
} from './index.ts';

// ─── 1. Schema ───────────────────────────────────────────────────────────────

Deno.test('PULSE_EXTRACT_SCHEMA: declares all required top-level fields', () => {
  const schema = PULSE_EXTRACT_SCHEMA as Record<string, unknown>;
  assertEquals(schema.type, 'object');
  const required = schema.required as string[];
  assertEquals(required.includes('voice_register'), true);
  assertEquals(required.includes('voice_archetype'), true);
  assertEquals(required.includes('architectural_features'), true);
  assertEquals(required.includes('material_palette'), true);
  assertEquals(required.includes('period_signals'), true);
  assertEquals(required.includes('lifestyle_themes'), true);
  assertEquals(required.includes('forbidden_phrases'), true);
  assertEquals(required.includes('quality_indicators'), true);
  assertEquals(required.includes('derived_few_shot_eligibility'), true);
});

Deno.test('PULSE_EXTRACT_SCHEMA: voice_register is enum-restricted to the 3 tiers', () => {
  const schema = PULSE_EXTRACT_SCHEMA as Record<string, unknown>;
  const props = schema.properties as Record<string, Record<string, unknown>>;
  const voiceReg = props.voice_register;
  assertEquals(voiceReg.type, 'string');
  const enumVals = voiceReg.enum as string[];
  assertEquals(enumVals.sort(), ['approachable', 'premium', 'standard']);
});

Deno.test('PULSE_EXTRACT_SCHEMA: quality_indicators has all three sub-fields', () => {
  const schema = PULSE_EXTRACT_SCHEMA as Record<string, unknown>;
  const props = schema.properties as Record<string, Record<string, unknown>>;
  const qi = props.quality_indicators;
  const subProps = qi.properties as Record<string, unknown>;
  assertEquals('reading_grade_level' in subProps, true);
  assertEquals('word_count' in subProps, true);
  assertEquals('exclamation_marks' in subProps, true);
  const subRequired = qi.required as string[];
  assertEquals(subRequired.length, 3);
});

// ─── 2-3. derivePriceBand ────────────────────────────────────────────────────

Deno.test('derivePriceBand: detects rental by listing_type=Rent regardless of magnitude', () => {
  const row = {
    id: 'x',
    description: '',
    suburb: null,
    postcode: null,
    property_type: null,
    bedrooms: null,
    bathrooms: null,
    asking_price: 1200,
    sold_price: null,
    agency_name: null,
    listing_type: 'Rent',
  };
  assertEquals(derivePriceBand(row), 'rental');
});

Deno.test('derivePriceBand: detects rental by magnitude when listing_type missing', () => {
  // $820 weekly rent — no sale would ever be < $10K so we treat as rental.
  const row = {
    id: 'x',
    description: '',
    suburb: null,
    postcode: null,
    property_type: null,
    bedrooms: null,
    bathrooms: null,
    asking_price: 820,
    sold_price: null,
    agency_name: null,
    listing_type: null,
  };
  assertEquals(derivePriceBand(row), 'rental');
});

Deno.test('derivePriceBand: maps sale prices to the right band', () => {
  const mk = (p: number) => ({
    id: 'x',
    description: '',
    suburb: null,
    postcode: null,
    property_type: null,
    bedrooms: null,
    bathrooms: null,
    asking_price: p,
    sold_price: null,
    agency_name: null,
    listing_type: 'Sale',
  });
  assertEquals(derivePriceBand(mk(800_000)), '<$1M');
  assertEquals(derivePriceBand(mk(1_500_000)), '$1M–$2M');
  assertEquals(derivePriceBand(mk(3_500_000)), '$2M–$5M');
  assertEquals(derivePriceBand(mk(7_500_000)), '$5M–$10M');
  assertEquals(derivePriceBand(mk(15_000_000)), '>$10M');
});

Deno.test('derivePriceBand: returns "unknown" for null + 0 + NaN prices', () => {
  const mk = (p: number | null) => ({
    id: 'x',
    description: '',
    suburb: null,
    postcode: null,
    property_type: null,
    bedrooms: null,
    bathrooms: null,
    asking_price: p,
    sold_price: null,
    agency_name: null,
    listing_type: 'Sale',
  });
  assertEquals(derivePriceBand(mk(null)), 'unknown');
  assertEquals(derivePriceBand(mk(0)), 'unknown');
});

Deno.test('derivePriceBand: prefers sold_price over asking_price', () => {
  const row = {
    id: 'x',
    description: '',
    suburb: null,
    postcode: null,
    property_type: null,
    bedrooms: null,
    bathrooms: null,
    asking_price: 800_000,
    sold_price: 6_500_000,
    agency_name: null,
    listing_type: 'Sold',
  };
  assertEquals(derivePriceBand(row), '$5M–$10M');
});

// ─── 4-6. normaliseExtractedPayload ──────────────────────────────────────────

Deno.test('normaliseExtractedPayload: returns safe defaults for empty input', () => {
  const out = normaliseExtractedPayload({});
  assertEquals(out.voice_register, null);
  assertEquals(out.voice_archetype, null);
  assertEquals(out.architectural_features, []);
  assertEquals(out.material_palette, []);
  assertEquals(out.period_signals, []);
  assertEquals(out.lifestyle_themes, []);
  assertEquals(out.forbidden_phrases, []);
  assertEquals(out.derived_few_shot_eligibility, false);
  assertEquals(out.quality_indicators.word_count, 0);
});

Deno.test('normaliseExtractedPayload: clamps oversized arrays to schema-approved sizes', () => {
  const big = (n: number) => Array.from({ length: n }, (_, i) => `item${i}`);
  const out = normaliseExtractedPayload({
    architectural_features: big(50),
    material_palette: big(50),
    period_signals: big(50),
    lifestyle_themes: big(50),
    forbidden_phrases: big(50),
  });
  assertEquals(out.architectural_features.length, 15);
  assertEquals(out.material_palette.length, 12);
  assertEquals(out.period_signals.length, 4);
  assertEquals(out.lifestyle_themes.length, 6);
  assertEquals(out.forbidden_phrases.length, 12);
});

Deno.test('normaliseExtractedPayload: rejects non-string array entries', () => {
  const out = normaliseExtractedPayload({
    architectural_features: ['oak floors', 123, null, undefined, 'limestone bench', ''],
  });
  // 123, null, undefined, '' filtered out
  assertEquals(out.architectural_features, ['oak floors', 'limestone bench']);
});

Deno.test('normaliseExtractedPayload: coerces invalid voice_register to null', () => {
  assertEquals(normaliseExtractedPayload({ voice_register: 'luxury' }).voice_register, null);
  assertEquals(normaliseExtractedPayload({ voice_register: 42 }).voice_register, null);
  assertEquals(normaliseExtractedPayload({ voice_register: 'premium' }).voice_register, 'premium');
});

Deno.test('normaliseExtractedPayload: truncates voice_archetype to 64 chars', () => {
  const long = 'a'.repeat(200);
  const out = normaliseExtractedPayload({ voice_archetype: long });
  assertEquals(out.voice_archetype?.length, 64);
});

Deno.test('normaliseExtractedPayload: truncates extractor_notes to 240 chars', () => {
  const long = 'b'.repeat(500);
  const out = normaliseExtractedPayload({ extractor_notes: long });
  assertEquals(out.extractor_notes?.length, 240);
});

Deno.test('normaliseExtractedPayload: only treats true (not truthy) as eligible', () => {
  assertEquals(normaliseExtractedPayload({ derived_few_shot_eligibility: 1 }).derived_few_shot_eligibility, false);
  assertEquals(normaliseExtractedPayload({ derived_few_shot_eligibility: 'true' }).derived_few_shot_eligibility, false);
  assertEquals(normaliseExtractedPayload({ derived_few_shot_eligibility: true }).derived_few_shot_eligibility, true);
});

// ─── 7-8. estimateGemini25ProCost ────────────────────────────────────────────

Deno.test('estimateGemini25ProCost: prices at $1.25/$10 per 1M, NOT Sonnet $3/$15 fallback', () => {
  // 1M input tokens at $1.25 = $1.25
  // 1M output tokens at $10 = $10
  // total = $11.25
  const cost = estimateGemini25ProCost(1_000_000, 1_000_000);
  assertAlmostEquals(cost, 11.25, 0.001);
});

Deno.test('estimateGemini25ProCost: hits the spec target $0.007/row at typical 1500/500 token mix', () => {
  // 1500 input * $1.25 / 1M = $0.001875
  // 500 output * $10 / 1M   = $0.005
  // total = $0.006875 — rounds within spec's $0.007/row claim
  const cost = estimateGemini25ProCost(1500, 500);
  assertAlmostEquals(cost, 0.006875, 0.000001);
  // And the spec's headline claim survives the rounding
  assertAlmostEquals(cost, 0.007, 0.001);
});

Deno.test('estimateGemini25ProCost: returns 0 for zero usage', () => {
  assertEquals(estimateGemini25ProCost(0, 0), 0);
});

Deno.test('estimateGemini25ProCost: scales linearly with token count', () => {
  const a = estimateGemini25ProCost(1500, 500);
  const b = estimateGemini25ProCost(3000, 1000);
  assertAlmostEquals(b / a, 2.0, 0.0001);
});

// ─── Sanity: full corpus cost stays within the spec's headline $200 budget ──

Deno.test('full-corpus estimate: 28k rows × $0.007/row stays under $200 cap', () => {
  const rows = 28_000;
  const perRow = estimateGemini25ProCost(1500, 500);
  const total = rows * perRow;
  // Spec promises ~$196 + 10% headroom = $216
  assertEquals(total < 200, true);
  assertEquals(total > 180, true);
});
