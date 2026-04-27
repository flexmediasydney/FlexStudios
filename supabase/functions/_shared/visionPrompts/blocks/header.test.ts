import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { HEADER_BLOCK_VERSION, headerBlock } from './header.ts';

Deno.test('headerBlock: pass=1 returns role + HDR explainer', () => {
  const txt = headerBlock({ pass: 1 });
  assertStringIncludes(txt, 'classifying a real estate photography image');
  assertStringIncludes(txt, 'RAW HDR bracket');
});

Deno.test('headerBlock: pass=2 returns shortlister role', () => {
  const txt = headerBlock({ pass: 2 });
  assertStringIncludes(txt, 'shortlisting decision engine');
  assertStringIncludes(txt, 'human editor');
});

Deno.test('headerBlock: version constant is the v1.0 baseline', () => {
  assertEquals(HEADER_BLOCK_VERSION, 'v1.0');
});
