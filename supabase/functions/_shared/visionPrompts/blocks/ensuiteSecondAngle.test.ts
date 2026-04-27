import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  ENSUITE_SECOND_ANGLE_BLOCK_VERSION,
  ensuiteSecondAngleBlock,
} from './ensuiteSecondAngle.ts';

Deno.test('ensuiteSecondAngleBlock: includes 2-image angle rule', () => {
  const txt = ensuiteSecondAngleBlock();
  assertStringIncludes(txt, 'ensuite_hero');
  assertStringIncludes(txt, 'up to 2 images');
  assertStringIncludes(txt, 'angle delta > 30');
  assertStringIncludes(txt, 'bathroom_main');
});

Deno.test('ensuiteSecondAngleBlock: version constant is the v1.0 baseline', () => {
  assertEquals(ENSUITE_SECOND_ANGLE_BLOCK_VERSION, 'v1.0');
});
