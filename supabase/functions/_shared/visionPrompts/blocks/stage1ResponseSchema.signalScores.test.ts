/**
 * stage1ResponseSchema.signalScores.test.ts — Wave 11.2 unit coverage.
 *
 * Verifies:
 *   1. STAGE1_SIGNAL_KEYS exports 22 keys in the order documented in
 *      docs/WAVE_PLAN.md (W11 design v2).
 *   2. Schema declares signal_scores as a required object property.
 *   3. signal_scores.required[] enumerates all 22 keys.
 *   4. Every signal key has a non-empty description (the per-signal
 *      measurement prompt the model reads).
 *   5. Schema version was bumped to v1.2 to invalidate prompt cache.
 *   6. The 4 aggregate axis scores remain in the schema (authoritative).
 *   7. Each signal property is type=number (0-10 numeric scoring).
 */

import {
  assertEquals,
  assertExists,
  assertStringIncludes,
} from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  STAGE1_RESPONSE_SCHEMA,
  STAGE1_RESPONSE_SCHEMA_VERSION,
  STAGE1_SIGNAL_KEYS,
} from './stage1ResponseSchema.ts';

const EXPECTED_KEYS = [
  'exposure_balance',
  'color_cast',
  'sharpness_subject',
  'sharpness_corners',
  'depth_layering',
  'composition_geometry',
  'vantage_quality',
  'framing_quality',
  'leading_lines',
  'negative_space',
  'symmetry_quality',
  'perspective_distortion',
  'plumb_verticals',
  'material_specificity',
  'period_reading',
  'styling_quality',
  'distraction_freeness',
  'retouch_debt',
  'gallery_arc_position',
  'social_crop_survival',
  'brochure_print_survival',
  'reading_grade_match',
];

Deno.test('W11.2: STAGE1_SIGNAL_KEYS exports the 22 canonical keys in order', () => {
  assertEquals(STAGE1_SIGNAL_KEYS.length, 22);
  assertEquals([...STAGE1_SIGNAL_KEYS], EXPECTED_KEYS);
});

Deno.test('W11.2: schema declares signal_scores as a required top-level field', () => {
  const required = (STAGE1_RESPONSE_SCHEMA as { required: string[] }).required;
  if (!Array.isArray(required)) {
    throw new Error('schema.required[] missing');
  }
  if (!required.includes('signal_scores')) {
    throw new Error('signal_scores must be in top-level required[]');
  }
});

Deno.test('W11.2: signal_scores property declares all 22 sub-keys as required', () => {
  const props = (STAGE1_RESPONSE_SCHEMA as {
    properties: Record<string, unknown>;
  }).properties;
  const sigScores = props.signal_scores as {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
    description: string;
  };
  assertExists(sigScores, 'signal_scores property must exist');
  assertEquals(sigScores.type, 'object');
  assertEquals(sigScores.required.length, 22);
  for (const key of EXPECTED_KEYS) {
    if (!sigScores.required.includes(key)) {
      throw new Error(`signal_scores.required missing key: ${key}`);
    }
  }
});

Deno.test('W11.2: every signal key has a numeric type and a non-empty description', () => {
  const props = (STAGE1_RESPONSE_SCHEMA as {
    properties: Record<string, unknown>;
  }).properties;
  const sigScores = props.signal_scores as {
    properties: Record<string, { type?: string; description?: string }>;
  };
  for (const key of EXPECTED_KEYS) {
    const prop = sigScores.properties[key];
    assertExists(prop, `signal_scores.properties.${key} must exist`);
    assertEquals(prop.type, 'number', `signal_scores.${key} must be type=number`);
    if (!prop.description || prop.description.length < 30) {
      throw new Error(
        `signal_scores.${key}.description is missing or too short (need >=30 chars to act as measurement prompt)`,
      );
    }
    // Every signal description must mention the 0-10 range so the model
    // doesn't drift into a different scale.
    assertStringIncludes(
      prop.description,
      '0-10',
      `signal_scores.${key}.description must reference 0-10 scale`,
    );
  }
});

Deno.test('W11.2: schema version was bumped to v1.2 (cache invalidation)', () => {
  assertEquals(STAGE1_RESPONSE_SCHEMA_VERSION, 'v1.2');
});

Deno.test('W11.2: 4 aggregate axis scores remain authoritative (not removed)', () => {
  const props = (STAGE1_RESPONSE_SCHEMA as {
    properties: Record<string, unknown>;
  }).properties;
  for (const axis of [
    'technical_score',
    'lighting_score',
    'composition_score',
    'aesthetic_score',
  ]) {
    assertExists(props[axis], `aggregate axis ${axis} must remain in schema`);
  }
  const required = (STAGE1_RESPONSE_SCHEMA as { required: string[] }).required;
  for (const axis of [
    'technical_score',
    'lighting_score',
    'composition_score',
    'aesthetic_score',
  ]) {
    if (!required.includes(axis)) {
      throw new Error(`aggregate axis ${axis} must remain in required[]`);
    }
  }
});

Deno.test('W11.2: signal_scores.description references the rollup relationship', () => {
  const props = (STAGE1_RESPONSE_SCHEMA as {
    properties: Record<string, unknown>;
  }).properties;
  const sigScores = props.signal_scores as { description: string };
  assertStringIncludes(sigScores.description, 'rollup');
  assertStringIncludes(sigScores.description, 'technical');
  assertStringIncludes(sigScores.description, 'composition');
});
