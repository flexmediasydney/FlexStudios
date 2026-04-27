import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  PASS1_OUTPUT_SCHEMA_BLOCK_VERSION,
  pass1OutputSchemaBlock,
} from './pass1OutputSchema.ts';

Deno.test('pass1OutputSchemaBlock: includes the JSON-only directive + 22-field schema', () => {
  const txt = pass1OutputSchemaBlock();
  assertStringIncludes(txt, 'Return ONLY valid JSON');
  assertStringIncludes(txt, '"analysis"');
  assertStringIncludes(txt, '"room_type"');
  assertStringIncludes(txt, '"room_type_confidence"');
  assertStringIncludes(txt, '"composition_type"');
  assertStringIncludes(txt, '"vantage_point"');
  assertStringIncludes(txt, '"technical_score"');
  assertStringIncludes(txt, '"aesthetic_score"');
});

Deno.test('pass1OutputSchemaBlock: version constant is the v1.0 baseline', () => {
  assertEquals(PASS1_OUTPUT_SCHEMA_BLOCK_VERSION, 'v1.0');
});
