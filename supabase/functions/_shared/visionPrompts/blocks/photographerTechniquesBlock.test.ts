import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import {
  PHOTOGRAPHER_TECHNIQUES_BLOCK_VERSION,
  photographerTechniquesBlock,
} from './photographerTechniquesBlock.ts';

Deno.test('photographerTechniquesBlock: lists the fingers-over-sun technique with explicit non-penalise rule', () => {
  const txt = photographerTechniquesBlock();
  assertStringIncludes(txt, 'FINGERS / HAND BLOCKING THE SUN');
  // The model must understand this is NOT a clutter trigger
  assertStringIncludes(txt, 'major_reject');
  // The model must be told to score AS IF the technique-object weren’t in frame
  assertStringIncludes(txt, 'AS IF the technique-object were');
});

Deno.test('photographerTechniquesBlock: forbids photographer_error overrides for these techniques', () => {
  const txt = photographerTechniquesBlock();
  assertStringIncludes(txt, 'photographer_error');
  assertStringIncludes(txt, 'requires_reshoot');
});

Deno.test('photographerTechniquesBlock: covers leg/foot-in-frame, tripod shadow, flag/gobo, intentional window bloom', () => {
  const txt = photographerTechniquesBlock();
  assertStringIncludes(txt, 'LEG / FOOT / SHADOW IN FRAME');
  assertStringIncludes(txt, 'TRIPOD SHADOW');
  assertStringIncludes(txt, 'FLAG / GOBO / DIFFUSER');
  assertStringIncludes(txt, 'INTENTIONAL OVEREXPOSURE');
});

Deno.test('photographerTechniquesBlock: gives the model a positive label to surface the technique', () => {
  const txt = photographerTechniquesBlock();
  assertStringIncludes(txt, 'deliberate_sunflare_block');
});

Deno.test('photographerTechniquesBlock: closes with the general decision rule', () => {
  const txt = photographerTechniquesBlock();
  assertStringIncludes(txt, 'would removing this object in post');
});

Deno.test('photographerTechniquesBlock: version constant is the v1.0 baseline', () => {
  assertEquals(PHOTOGRAPHER_TECHNIQUES_BLOCK_VERSION, 'v1.0');
});
