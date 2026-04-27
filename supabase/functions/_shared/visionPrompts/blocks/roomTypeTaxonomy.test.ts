import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  ROOM_TYPE_TAXONOMY_BLOCK_VERSION,
  roomTypeTaxonomyBlock,
} from './roomTypeTaxonomy.ts';

Deno.test('roomTypeTaxonomyBlock: includes the heading and the L18 disambiguation note', () => {
  const txt = roomTypeTaxonomyBlock();
  assertStringIncludes(txt, 'ROOM TYPE TAXONOMY');
  assertStringIncludes(txt, 'living_secondary');
  assertStringIncludes(txt, 'upstairs lounges');
});

Deno.test('roomTypeTaxonomyBlock: includes drone + outdoor kitchen + special_feature', () => {
  const txt = roomTypeTaxonomyBlock();
  assertStringIncludes(txt, 'drone_oblique');
  assertStringIncludes(txt, 'outdoor_kitchen');
  assertStringIncludes(txt, 'special_feature');
});

Deno.test('roomTypeTaxonomyBlock: version constant is the v1.0 baseline', () => {
  assertEquals(ROOM_TYPE_TAXONOMY_BLOCK_VERSION, 'v1.0');
});
