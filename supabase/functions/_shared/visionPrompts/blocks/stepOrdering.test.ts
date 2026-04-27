import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  STEP_ORDERING_BLOCK_VERSION,
  stepOrderingBlock,
} from './stepOrdering.ts';

Deno.test('stepOrderingBlock: defaults to system placement', () => {
  const def = stepOrderingBlock();
  const sys = stepOrderingBlock({ placement: 'system' });
  assertEquals(def, sys);
});

Deno.test('stepOrderingBlock: system placement includes the contract framing', () => {
  const txt = stepOrderingBlock({ placement: 'system' });
  assertStringIncludes(txt, 'two strict steps');
  assertStringIncludes(txt, 'NOT making shortlisting decisions');
});

Deno.test('stepOrderingBlock: user placement includes the imperative bullets', () => {
  const txt = stepOrderingBlock({ placement: 'user' });
  assertStringIncludes(txt, 'WRITE YOUR ANALYSIS FIRST');
  assertStringIncludes(txt, 'Minimum 3 sentences');
  assertStringIncludes(txt, 'DERIVE SCORES');
});

Deno.test('stepOrderingBlock: version constant is the v1.0 baseline', () => {
  assertEquals(STEP_ORDERING_BLOCK_VERSION, 'v1.0');
});
