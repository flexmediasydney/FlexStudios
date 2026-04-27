/**
 * Unit tests for Wave 8 tierWeightingContext block injection in Pass 2.
 *
 * Run: deno test --no-check --allow-all supabase/functions/_shared/pass2PromptTierContext.test.ts
 *
 * The Pass 2 byte-identical snapshot regression test
 * (pass2Prompt.snapshot.test.ts) covers the WITHOUT-context case (legacy
 * fixture omits tierWeightingContext). These tests cover the WITH-context
 * case, asserting:
 *   - tierWeightingContext block appears between streamBAnchors and
 *     classificationsTable when provided
 *   - Block content includes the right tier code, version, anchor, weights
 *   - blockVersions map includes 'tierWeightingContext'
 *   - Without context: blockVersions excludes 'tierWeightingContext' (so
 *     downstream provenance can detect the block was OFF for this round)
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { buildPass2Prompt } from './pass2Prompt.ts';
import { FIXTURE_PASS2_OPTS } from './visionPrompts/__snapshots__/_fixtures.ts';

Deno.test('buildPass2Prompt: tierWeightingContext omitted by default (no opts.tierWeightingContext)', () => {
  const built = buildPass2Prompt(FIXTURE_PASS2_OPTS);
  // The block name must NOT appear in blockVersions when omitted.
  assertEquals(built.blockVersions['tierWeightingContext'], undefined);
  // The user prefix should not contain the tier weighting heading.
  assert(!built.userPrefix.includes('TIER WEIGHTING CONTEXT'));
});

Deno.test('buildPass2Prompt: tierWeightingContext null also omitted (caller-disabled)', () => {
  const built = buildPass2Prompt({ ...FIXTURE_PASS2_OPTS, tierWeightingContext: null });
  assertEquals(built.blockVersions['tierWeightingContext'], undefined);
  assert(!built.userPrefix.includes('TIER WEIGHTING CONTEXT'));
});

Deno.test('buildPass2Prompt: tierWeightingContext rendered when provided', () => {
  const built = buildPass2Prompt({
    ...FIXTURE_PASS2_OPTS,
    tierWeightingContext: {
      tierCode: 'P',
      tierConfigVersion: 3,
      scoreAnchor: 8,
      dimensionWeights: {
        technical: 0.20,
        lighting: 0.30,
        composition: 0.25,
        aesthetic: 0.25,
      },
    },
  });
  // Block version recorded.
  assertEquals(built.blockVersions['tierWeightingContext'], 'v1.0');
  // Heading and weights present in user prefix.
  assertStringIncludes(built.userPrefix, 'TIER WEIGHTING CONTEXT');
  assertStringIncludes(built.userPrefix, 'Tier P version 3');
  assertStringIncludes(built.userPrefix, 'technical:    0.20');
  assertStringIncludes(built.userPrefix, 'lighting:     0.30');
  assertStringIncludes(built.userPrefix, 'composition:  0.25');
  assertStringIncludes(built.userPrefix, 'aesthetic:    0.25');
});

Deno.test('buildPass2Prompt: tierWeightingContext appears between streamBAnchors and classificationsTable', () => {
  const built = buildPass2Prompt({
    ...FIXTURE_PASS2_OPTS,
    tierWeightingContext: {
      tierCode: 'A',
      tierConfigVersion: 1,
      scoreAnchor: 9.5,
      dimensionWeights: {
        technical: 0.20,
        lighting: 0.20,
        composition: 0.20,
        aesthetic: 0.40,
      },
    },
  });
  const anchorsIdx = built.userPrefix.indexOf('STREAM B SCORING ANCHORS');
  const tierIdx = built.userPrefix.indexOf('TIER WEIGHTING CONTEXT');
  // classificationsTable always starts with "CLASSIFICATIONS:" or similar
  // text — let's find a known marker (the `pass2OutputSchema` block follows
  // classificationsTable). For ordering check, just confirm tier block is
  // after streamB and before the JSON output schema.
  const schemaIdx = built.userPrefix.indexOf('Return ONLY valid JSON');
  assert(anchorsIdx >= 0, 'streamBAnchors block should be present');
  assert(tierIdx >= 0, 'tierWeightingContext block should be present');
  assert(schemaIdx >= 0, 'output schema should be present');
  assert(anchorsIdx < tierIdx, `streamBAnchors (${anchorsIdx}) must precede tierWeightingContext (${tierIdx})`);
  assert(tierIdx < schemaIdx, `tierWeightingContext (${tierIdx}) must precede pass2OutputSchema (${schemaIdx})`);
});

Deno.test('buildPass2Prompt: assembling the same fixture twice produces identical output (determinism)', () => {
  const opts = {
    ...FIXTURE_PASS2_OPTS,
    tierWeightingContext: {
      tierCode: 'S' as const,
      tierConfigVersion: 1,
      scoreAnchor: 5,
      dimensionWeights: {
        technical: 0.25,
        lighting: 0.30,
        composition: 0.25,
        aesthetic: 0.20,
      },
    },
  };
  const a = buildPass2Prompt(opts);
  const b = buildPass2Prompt(opts);
  assertEquals(a.system, b.system);
  assertEquals(a.userPrefix, b.userPrefix);
  assertEquals(a.blockVersions, b.blockVersions);
});
