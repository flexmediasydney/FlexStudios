import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  COMPOSITION_TYPE_TAXONOMY_BLOCK_VERSION,
  compositionTypeTaxonomyBlock,
} from './compositionTypeTaxonomy.ts';

Deno.test('compositionTypeTaxonomyBlock: includes the canonical 11 values', () => {
  const txt = compositionTypeTaxonomyBlock();
  assertStringIncludes(txt, 'hero_wide');
  assertStringIncludes(txt, 'corner_two_point');
  assertStringIncludes(txt, 'architectural_abstract');
  assertStringIncludes(txt, 'drone_nadir');
});

Deno.test('compositionTypeTaxonomyBlock: version constant is the v1.0 baseline', () => {
  assertEquals(COMPOSITION_TYPE_TAXONOMY_BLOCK_VERSION, 'v1.0');
});
