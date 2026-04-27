import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  NEAR_DUPLICATE_CULLING_BLOCK_VERSION,
  nearDuplicateCullingBlock,
} from './nearDuplicateCulling.ts';

Deno.test('nearDuplicateCullingBlock: includes the within-room rule with the three conditions', () => {
  const txt = nearDuplicateCullingBlock();
  assertStringIncludes(txt, 'within-room only');
  assertStringIncludes(txt, 'angle delta < 15');
  assertStringIncludes(txt, 'Key element overlap > 80');
  assertStringIncludes(txt, 'living_secondary');
});

Deno.test('nearDuplicateCullingBlock: version constant is the v1.0 baseline', () => {
  assertEquals(NEAR_DUPLICATE_CULLING_BLOCK_VERSION, 'v1.0');
});
