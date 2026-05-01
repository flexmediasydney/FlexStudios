/**
 * roomTypesFromDb.test.ts — Wave 11.6.7 P1-3 unit tests.
 *
 * Run: deno test supabase/functions/_shared/visionPrompts/blocks/roomTypesFromDb.test.ts --no-check --allow-all
 */

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { renderBlock, _resetRoomTypesFromDbCache } from './roomTypesFromDb.ts';

Deno.test('renderBlock: includes the heading + canonical key line + L18 note', () => {
  const rows = [
    {
      key: 'kitchen_main',
      display_name: 'Kitchen — main',
      description: 'Primary kitchen.',
      detection_hints: ['benchtop', 'island'],
      category: 'interior_living',
    },
    {
      key: 'living_secondary',
      display_name: 'Living — secondary',
      description: 'Upstairs lounge.',
      detection_hints: ['rumpus'],
      category: 'interior_living',
    },
  ];
  const txt = renderBlock(rows);
  assert(txt.includes('ROOM TYPE TAXONOMY'));
  assert(txt.includes('kitchen_main | living_secondary'));
  assert(txt.includes('Note on living_secondary (spec L18)'));
});

Deno.test('renderBlock: groups by category in known order', () => {
  const rows = [
    { key: 'drone_nadir', display_name: 'Drone — nadir', description: null, detection_hints: [], category: 'aerial' },
    { key: 'kitchen_main', display_name: 'Kitchen — main', description: null, detection_hints: [], category: 'interior_living' },
    { key: 'master_bedroom', display_name: 'Master', description: null, detection_hints: [], category: 'interior_private' },
  ];
  const txt = renderBlock(rows);
  const ilIdx = txt.indexOf('[interior_living]');
  const ipIdx = txt.indexOf('[interior_private]');
  const aIdx = txt.indexOf('[aerial]');
  assert(ilIdx >= 0 && ipIdx >= 0 && aIdx >= 0);
  assert(ilIdx < ipIdx);
  assert(ipIdx < aIdx);
});

Deno.test('renderBlock: rows without category bucket into other', () => {
  const rows = [
    { key: 'mystery_room', display_name: 'Mystery', description: null, detection_hints: [], category: null },
  ];
  const txt = renderBlock(rows);
  assert(txt.includes('[other]'));
  assert(txt.includes('mystery_room'));
});

Deno.test('renderBlock: includes detection_hints when present', () => {
  const rows = [
    { key: 'kitchen_main', display_name: 'Kitchen', description: 'Primary kitchen.', detection_hints: ['benchtop', 'island', 'cooktop'], category: 'interior_living' },
  ];
  const txt = renderBlock(rows);
  assert(txt.includes('Hints: benchtop, island, cooktop'));
});

Deno.test('renderBlock: empty hints does not emit Hints:', () => {
  const rows = [
    { key: 'kitchen_main', display_name: 'Kitchen', description: 'X.', detection_hints: [], category: 'interior_living' },
  ];
  const txt = renderBlock(rows);
  assert(!txt.includes('Hints:'));
});

Deno.test('renderBlock: unknown categories alphabetical after knownOrder', () => {
  const rows = [
    { key: 'a_zebra', display_name: 'Zebra', description: null, detection_hints: [], category: 'zzz_custom' },
    { key: 'b_alpha', display_name: 'Alpha', description: null, detection_hints: [], category: 'aaa_custom' },
  ];
  const txt = renderBlock(rows);
  const aaIdx = txt.indexOf('[aaa_custom]');
  const zzIdx = txt.indexOf('[zzz_custom]');
  assert(aaIdx >= 0 && zzIdx >= 0);
  assert(aaIdx < zzIdx);
});

Deno.test('_resetRoomTypesFromDbCache: callable returns void', () => {
  const result = _resetRoomTypesFromDbCache();
  assertEquals(result, undefined);
});
