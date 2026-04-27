import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import type { Pass2ClassificationRow } from '../../pass2Prompt.ts';
import {
  CLASSIFICATIONS_TABLE_BLOCK_VERSION,
  classificationsTableBlock,
  formatClassificationLine,
} from './classificationsTable.ts';

const fakeRow = (
  group_index: number,
  overrides: Partial<Pass2ClassificationRow> = {},
): Pass2ClassificationRow => ({
  stem: `s_${group_index}`,
  group_id: `g-${group_index}`,
  group_index,
  room_type: 'living_room',
  composition_type: 'hero_wide',
  vantage_point: 'neutral',
  technical_score: 8,
  lighting_score: 8,
  composition_score: 8,
  aesthetic_score: 8,
  combined_score: 8,
  is_styled: true,
  indoor_outdoor_visible: false,
  is_drone: false,
  is_exterior: false,
  eligible_for_exterior_rear: false,
  clutter_severity: 'none',
  flag_for_retouching: false,
  analysis: 'Test analysis',
  ...overrides,
});

Deno.test('classificationsTableBlock: sorts by group_index ascending', () => {
  const txt = classificationsTableBlock({
    classifications: [fakeRow(3), fakeRow(1), fakeRow(2)],
  });
  const lines = txt.split('\n');
  // Header lines first, then data lines in capture order.
  const stems = lines.filter((l) => l.startsWith('s_')).map((l) => l.split(' ')[0]);
  assertEquals(stems, ['s_1', 's_2', 's_3']);
});

Deno.test('classificationsTableBlock: includes header + format documentation', () => {
  const txt = classificationsTableBlock({ classifications: [fakeRow(1)] });
  assertStringIncludes(txt, 'ALL CLASSIFICATIONS');
  assertStringIncludes(txt, 'Format:');
  assertStringIncludes(txt, '1 compositions');
});

Deno.test('formatClassificationLine: badges fire for eligXR / retouch / clutter / drone', () => {
  const line = formatClassificationLine(
    fakeRow(7, {
      eligible_for_exterior_rear: true,
      flag_for_retouching: true,
      clutter_severity: 'minor_photoshoppable',
      is_drone: true,
    }),
  );
  assertStringIncludes(line, 'eligXR');
  assertStringIncludes(line, 'retouch');
  assertStringIncludes(line, 'clutter=minor_photoshoppable');
  assertStringIncludes(line, 'drone');
});

Deno.test('formatClassificationLine: nulls render as ? and analysis trimmed to 80 chars', () => {
  const longText = 'a'.repeat(120);
  const line = formatClassificationLine(
    fakeRow(0, {
      stem: '',
      technical_score: null,
      lighting_score: null,
      composition_score: null,
      aesthetic_score: null,
      combined_score: null,
      is_styled: null,
      indoor_outdoor_visible: null,
      analysis: longText,
    }),
  );
  assertStringIncludes(line, 'group_0'); // stem fallback
  assertStringIncludes(line, 'C=? L=? T=? A=? avg=?');
  assertStringIncludes(line, 'styled=? io=?');
  // Analysis cap = 80 chars
  const after = line.split(' | ').pop()!;
  assertEquals(after.length, 80);
});

Deno.test('classificationsTableBlock: version constant is the v1.0 baseline', () => {
  assertEquals(CLASSIFICATIONS_TABLE_BLOCK_VERSION, 'v1.0');
});
