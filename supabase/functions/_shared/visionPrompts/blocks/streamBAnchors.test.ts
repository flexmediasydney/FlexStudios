import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  STREAM_B_ANCHORS_BLOCK_VERSION,
  streamBAnchorsBlock,
} from './streamBAnchors.ts';

Deno.test('streamBAnchorsBlock: includes the anchors heading + tier labels', () => {
  const txt = streamBAnchorsBlock({
    anchors: { tierS: 'S text', tierP: 'P text', tierA: 'A text', version: 1 },
  });
  assertStringIncludes(txt, 'STREAM B SCORING ANCHORS');
  assertStringIncludes(txt, 'S text');
  assertStringIncludes(txt, 'P text');
  assertStringIncludes(txt, 'A text');
  assertStringIncludes(txt, 'Score distribution guidance');
});

Deno.test('streamBAnchorsBlock: version constant is the v1.0 baseline', () => {
  assertEquals(STREAM_B_ANCHORS_BLOCK_VERSION, 'v1.0');
});
