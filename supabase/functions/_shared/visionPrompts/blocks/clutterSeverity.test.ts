import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  CLUTTER_SEVERITY_BLOCK_VERSION,
  clutterSeverityBlock,
} from './clutterSeverity.ts';

Deno.test('clutterSeverityBlock: includes graduated levels + flag rule', () => {
  const txt = clutterSeverityBlock();
  assertStringIncludes(txt, 'minor_photoshoppable');
  assertStringIncludes(txt, 'moderate_retouch');
  assertStringIncludes(txt, 'major_reject');
  assertStringIncludes(txt, 'flag_for_retouching');
});

Deno.test('clutterSeverityBlock: closes with the JSON-only output reminder', () => {
  const txt = clutterSeverityBlock();
  assertStringIncludes(txt, 'respond with the JSON object only');
});

Deno.test('clutterSeverityBlock: version constant is the v1.0 baseline', () => {
  assertEquals(CLUTTER_SEVERITY_BLOCK_VERSION, 'v1.0');
});
