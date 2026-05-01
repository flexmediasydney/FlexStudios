/**
 * Unit tests for spaceZoneTaxonomy block (W11.6.13).
 * Run: deno test supabase/functions/_shared/visionPrompts/blocks/spaceZoneTaxonomy.test.ts --no-check --allow-all
 */

import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  SPACE_ZONE_TAXONOMY_BLOCK_VERSION,
  spaceZoneTaxonomyBlock,
} from './spaceZoneTaxonomy.ts';

Deno.test('spaceZoneTaxonomyBlock: renders the SPACE/ZONE heading', () => {
  const txt = spaceZoneTaxonomyBlock();
  assertStringIncludes(txt, 'SPACE / ZONE SEPARATION');
  assertStringIncludes(txt, 'space_type');
  assertStringIncludes(txt, 'zone_focus');
  assertStringIncludes(txt, 'space_zone_count');
});

Deno.test('spaceZoneTaxonomyBlock: includes the IMG_034A7916 motivating example', () => {
  const txt = spaceZoneTaxonomyBlock();
  // The block should teach the model the dining-zone-in-living-dining
  // distinction that motivated the wave.
  assertStringIncludes(txt, 'living_dining_combined');
  assertStringIncludes(txt, 'dining_table');
});

Deno.test('spaceZoneTaxonomyBlock: includes the entry_foyer + door_threshold tokens', () => {
  const txt = spaceZoneTaxonomyBlock();
  // Required for the entry_hero verification scenario.
  assertStringIncludes(txt, 'entry_foyer');
  assertStringIncludes(txt, 'door_threshold');
  assertStringIncludes(txt, 'full_facade');
});

Deno.test('spaceZoneTaxonomyBlock: integer hint scale documented', () => {
  const txt = spaceZoneTaxonomyBlock();
  assertStringIncludes(txt, 'single-purpose');
  assertStringIncludes(txt, 'multi-zone open plan');
  assertStringIncludes(txt, 'studio-style');
});

Deno.test('spaceZoneTaxonomyBlock: version constant is v1.0', () => {
  assertEquals(SPACE_ZONE_TAXONOMY_BLOCK_VERSION, 'v1.0');
});

Deno.test('spaceZoneTaxonomyBlock: master_bedroom + bed_focal both appear (single-zone example)', () => {
  const txt = spaceZoneTaxonomyBlock();
  assertStringIncludes(txt, 'master_bedroom');
  assertStringIncludes(txt, 'bed_focal');
  assertStringIncludes(txt, 'wardrobe_built_in');
});
