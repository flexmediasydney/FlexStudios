/**
 * normaliseSignalScores.test.ts — Wave 11.2 unit coverage.
 *
 * Run: deno test --no-check --allow-all \
 *   supabase/functions/_shared/visionPrompts/blocks/normaliseSignalScores.test.ts
 *
 * Covers:
 *  1. Happy path: 22 numeric values pass through unchanged.
 *  2. String-numeric coercion: "8.5" → 8.5.
 *  3. Non-numeric values become null (not failure).
 *  4. Missing signal_scores → null result + warning string.
 *  5. signal_scores=null → null result + warning string.
 *  6. signal_scores=array (malformed) → null result + warning string.
 *  7. Partial payload (subset of keys) → those keys persist; no warning.
 *  8. NaN / Infinity / non-finite numbers → null (defensive).
 */

import { assertEquals, assertExists } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { normaliseSignalScores } from './normaliseSignalScores.ts';

const FULL_PAYLOAD = {
  exposure_balance: 8,
  color_cast: 9,
  sharpness_subject: 9,
  sharpness_corners: 7,
  depth_layering: 8,
  composition_geometry: 8,
  vantage_quality: 7,
  framing_quality: 8,
  leading_lines: 6,
  negative_space: 7,
  symmetry_quality: 7,
  perspective_distortion: 9,
  plumb_verticals: 8,
  material_specificity: 7,
  period_reading: 6,
  styling_quality: 7,
  distraction_freeness: 9,
  retouch_debt: 8,
  gallery_arc_position: 7,
  social_crop_survival: 8,
  brochure_print_survival: 8,
  reading_grade_match: 7,
};

const CTX = { groupId: 'group-abc', stem: 'IMG_0123' };

Deno.test('W11.2: full 22-key numeric payload passes through unchanged + no warning', () => {
  const result = normaliseSignalScores(FULL_PAYLOAD, CTX);
  assertExists(result.signalScores);
  assertEquals(result.warning, null);
  assertEquals(Object.keys(result.signalScores).length, 22);
  assertEquals(result.signalScores.exposure_balance, 8);
  assertEquals(result.signalScores.reading_grade_match, 7);
});

Deno.test('W11.2: string-numeric values are coerced to numbers', () => {
  const result = normaliseSignalScores(
    { exposure_balance: '8.5', color_cast: '9', sharpness_subject: '7.25' },
    CTX,
  );
  assertExists(result.signalScores);
  assertEquals(result.signalScores.exposure_balance, 8.5);
  assertEquals(result.signalScores.color_cast, 9);
  assertEquals(result.signalScores.sharpness_subject, 7.25);
  assertEquals(result.warning, null);
});

Deno.test('W11.2: non-numeric values become null (graceful, not error)', () => {
  const result = normaliseSignalScores(
    { exposure_balance: 'high', color_cast: null, sharpness_subject: { weird: true } },
    CTX,
  );
  assertExists(result.signalScores);
  assertEquals(result.signalScores.exposure_balance, null);
  assertEquals(result.signalScores.color_cast, null);
  assertEquals(result.signalScores.sharpness_subject, null);
  assertEquals(result.warning, null);
});

Deno.test('W11.2: signal_scores=undefined → null result + warning', () => {
  const result = normaliseSignalScores(undefined, CTX);
  assertEquals(result.signalScores, null);
  assertExists(result.warning);
  if (!result.warning?.includes('group-abc')) {
    throw new Error('warning must reference group_id');
  }
  if (!result.warning?.includes('IMG_0123')) {
    throw new Error('warning must reference stem');
  }
  if (!result.warning?.includes('22 keys')) {
    throw new Error('warning must reference 22-keys expectation');
  }
});

Deno.test('W11.2: signal_scores=null → null result + warning (legacy engine_mode)', () => {
  const result = normaliseSignalScores(null, CTX);
  assertEquals(result.signalScores, null);
  assertExists(result.warning);
});

Deno.test('W11.2: signal_scores=array (malformed) → null result + warning', () => {
  const result = normaliseSignalScores([8, 9, 7], CTX);
  assertEquals(result.signalScores, null);
  assertExists(result.warning);
});

Deno.test('W11.2: partial payload (subset of keys) is persisted as-is, no warning', () => {
  const result = normaliseSignalScores(
    { exposure_balance: 8, color_cast: 9 },
    CTX,
  );
  assertExists(result.signalScores);
  assertEquals(Object.keys(result.signalScores).length, 2);
  assertEquals(result.signalScores.exposure_balance, 8);
  assertEquals(result.warning, null);
});

Deno.test('W11.2: non-finite numbers (NaN, Infinity) become null', () => {
  const result = normaliseSignalScores(
    { exposure_balance: NaN, color_cast: Infinity, sharpness_subject: -Infinity },
    CTX,
  );
  assertExists(result.signalScores);
  assertEquals(result.signalScores.exposure_balance, null);
  assertEquals(result.signalScores.color_cast, null);
  assertEquals(result.signalScores.sharpness_subject, null);
});
