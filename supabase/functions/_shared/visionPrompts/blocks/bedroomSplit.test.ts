import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { BEDROOM_SPLIT_BLOCK_VERSION, bedroomSplitBlock } from './bedroomSplit.ts';

Deno.test('bedroomSplitBlock: includes master combined + secondary aesthetic rules', () => {
  const txt = bedroomSplitBlock();
  assertStringIncludes(txt, 'master_bedroom_hero');
  assertStringIncludes(txt, 'HIGHEST COMBINED score');
  assertStringIncludes(txt, 'bedroom_secondary');
  assertStringIncludes(txt, 'HIGHEST AESTHETIC');
});

Deno.test('bedroomSplitBlock: version constant is the v1.0 baseline', () => {
  assertEquals(BEDROOM_SPLIT_BLOCK_VERSION, 'v1.0');
});
