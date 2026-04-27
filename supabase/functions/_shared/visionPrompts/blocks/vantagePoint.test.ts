import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { VANTAGE_POINT_BLOCK_VERSION, vantagePointBlock } from './vantagePoint.ts';

Deno.test('vantagePointBlock: includes the three vantages + alfresco rule', () => {
  const txt = vantagePointBlock();
  assertStringIncludes(txt, 'interior_looking_out');
  assertStringIncludes(txt, 'exterior_looking_in');
  assertStringIncludes(txt, 'alfresco');
  assertStringIncludes(txt, 'exterior_rear');
});

Deno.test('vantagePointBlock: version constant is the v1.0 baseline', () => {
  assertEquals(VANTAGE_POINT_BLOCK_VERSION, 'v1.0');
});
