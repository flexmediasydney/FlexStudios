import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { PASS2_PHASES_BLOCK_VERSION, pass2PhasesBlock } from './pass2Phases.ts';

Deno.test('pass2PhasesBlock: includes three-phase + no-hallucination contract', () => {
  const txt = pass2PhasesBlock();
  assertStringIncludes(txt, 'three-phase shortlist');
  assertStringIncludes(txt, 'top-3 alternatives');
  assertStringIncludes(txt, 'do not hallucinate');
});

Deno.test('pass2PhasesBlock: version constant is the v1.0 baseline', () => {
  assertEquals(PASS2_PHASES_BLOCK_VERSION, 'v1.0');
});
