/**
 * Unit tests for tierWeightingContext block (Wave 8 / W7.6 composable block).
 *
 * Run: deno test --no-check --allow-all supabase/functions/_shared/visionPrompts/blocks/tierWeightingContext.test.ts
 */

import {
  assert,
  assertEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  TIER_WEIGHTING_CONTEXT_BLOCK_VERSION,
  tierWeightingContextBlock,
} from './tierWeightingContext.ts';

Deno.test('tierWeightingContextBlock: renders tier code + version + anchor + weights', () => {
  const text = tierWeightingContextBlock({
    tierCode: 'P',
    tierConfigVersion: 3,
    scoreAnchor: 8,
    dimensionWeights: {
      technical: 0.20,
      lighting: 0.30,
      composition: 0.25,
      aesthetic: 0.25,
    },
  });
  assert(text.includes('Tier P version 3'));
  assert(text.includes('Tier P anchor of'));
  assert(text.includes('8'));
  assert(text.includes('technical:    0.20'));
  assert(text.includes('lighting:     0.30'));
  assert(text.includes('composition:  0.25'));
  assert(text.includes('aesthetic:    0.25'));
});

Deno.test('tierWeightingContextBlock: weights formatted to 2 decimals (consistent display)', () => {
  const text = tierWeightingContextBlock({
    tierCode: 'A',
    tierConfigVersion: 1,
    scoreAnchor: 9.5,
    dimensionWeights: {
      technical: 0.123456,
      lighting: 0.3,
      composition: 0.276544,
      aesthetic: 0.3,
    },
  });
  // 0.123456 → "0.12"; 0.3 → "0.30"; 0.276544 → "0.28"
  assert(text.includes('technical:    0.12'));
  assert(text.includes('lighting:     0.30'));
  assert(text.includes('composition:  0.28'));
  assert(text.includes('aesthetic:    0.30'));
});

Deno.test('tierWeightingContextBlock: heading present for prompt scanning', () => {
  const text = tierWeightingContextBlock({
    tierCode: 'S',
    tierConfigVersion: 1,
    scoreAnchor: 5,
    dimensionWeights: { technical: 0.25, lighting: 0.30, composition: 0.25, aesthetic: 0.20 },
  });
  // The model scans for the all-caps heading.
  assert(text.startsWith('TIER WEIGHTING CONTEXT'));
});

Deno.test('tierWeightingContextBlock: version constant is the v1.0 baseline', () => {
  assertEquals(TIER_WEIGHTING_CONTEXT_BLOCK_VERSION, 'v1.0');
});
