import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  PASS2_OUTPUT_SCHEMA_BLOCK_VERSION,
  pass2OutputSchemaBlock,
} from './pass2OutputSchema.ts';

Deno.test('pass2OutputSchemaBlock: includes instructions list + JSON shape + closing reminder', () => {
  const txt = pass2OutputSchemaBlock();
  assertStringIncludes(txt, 'INSTRUCTIONS');
  assertStringIncludes(txt, 'slot_assignments');
  assertStringIncludes(txt, 'slot_alternatives');
  assertStringIncludes(txt, 'phase3_recommendations');
  assertStringIncludes(txt, 'rejected_near_duplicates');
  assertStringIncludes(txt, 'coverage_notes');
  assertStringIncludes(txt, 'case-sensitive');
});

Deno.test('pass2OutputSchemaBlock: version constant is the v1.0 baseline', () => {
  assertEquals(PASS2_OUTPUT_SCHEMA_BLOCK_VERSION, 'v1.0');
});
