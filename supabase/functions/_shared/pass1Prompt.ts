/**
 * pass1Prompt.ts — pure Pass 1 classification prompt builder.
 *
 * Constructs the reasoning-FIRST prompt for the Pass 1 vision call. Verbatim
 * from spec §5.1 with the Stream B SCORING ANCHORS block injected from
 * `streamBInjector.buildScoringReferenceBlock()`.
 *
 * Two critical v2 architectural rules baked into this prompt (DO NOT REMOVE):
 *
 *   1. STEP 1 / STEP 2 ordering (spec L9 reasoning-first). The model writes
 *      the full `analysis` paragraph BEFORE producing any scores. Scores are
 *      derived from the analysis, not generated alongside it. Without this,
 *      the prose becomes post-hoc justification of an arbitrary number and
 *      score/text consistency drops.
 *
 *   2. STREAM B SCORING ANCHORS injection (spec L8). Without explicit tier
 *      definitions, Sonnet clusters all scores 7–9. The anchors give the
 *      model concrete reference points (5=Tier S floor, 8=Tier P, 9.5+=Tier A)
 *      and the score distribution actually spreads.
 *
 * Wave 7 P1-10 (W7.6): the prompt is now assembled from named, versioned
 * blocks under `visionPrompts/blocks/`. The text content is byte-stable with
 * the previous monolith — see `visionPrompts/__snapshots__/pass1Prompt.snap.txt`
 * for the regression gate.
 *
 * Single export: `buildPass1Prompt(anchors)` → `AssembledPrompt` (system,
 * userPrefix, blockVersions). The caller appends the image as a separate
 * content part after `userPrefix`.
 *
 * Temperature is set to 0 by the calling edge function — this builder is
 * temperature-agnostic.
 */

import type { StreamBAnchors } from './streamBInjector.ts';
import { type AssembledPrompt, assemble } from './visionPrompts/assemble.ts';
import { HEADER_BLOCK_VERSION, headerBlock } from './visionPrompts/blocks/header.ts';
import {
  STEP_ORDERING_BLOCK_VERSION,
  stepOrderingBlock,
} from './visionPrompts/blocks/stepOrdering.ts';
import {
  STREAM_B_ANCHORS_BLOCK_VERSION,
  streamBAnchorsBlock,
} from './visionPrompts/blocks/streamBAnchors.ts';
import {
  PASS1_OUTPUT_SCHEMA_BLOCK_VERSION,
  pass1OutputSchemaBlock,
} from './visionPrompts/blocks/pass1OutputSchema.ts';
import {
  ROOM_TYPE_TAXONOMY_BLOCK_VERSION,
  roomTypeTaxonomyBlock,
} from './visionPrompts/blocks/roomTypeTaxonomy.ts';
import {
  SPACE_ZONE_TAXONOMY_BLOCK_VERSION,
  spaceZoneTaxonomyBlock,
} from './visionPrompts/blocks/spaceZoneTaxonomy.ts';
import {
  COMPOSITION_TYPE_TAXONOMY_BLOCK_VERSION,
  compositionTypeTaxonomyBlock,
} from './visionPrompts/blocks/compositionTypeTaxonomy.ts';
import {
  VANTAGE_POINT_BLOCK_VERSION,
  vantagePointBlock,
} from './visionPrompts/blocks/vantagePoint.ts';
import {
  CLUTTER_SEVERITY_BLOCK_VERSION,
  clutterSeverityBlock,
} from './visionPrompts/blocks/clutterSeverity.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Legacy alias retained for any existing callers that import `Pass1Prompt`.
 * New callers should use `AssembledPrompt` directly.
 */
export type Pass1Prompt = AssembledPrompt;

// ─── Builder ─────────────────────────────────────────────────────────────────

export function buildPass1Prompt(anchors: StreamBAnchors): AssembledPrompt {
  return assemble({
    systemBlocks: [
      {
        name: 'header',
        version: HEADER_BLOCK_VERSION,
        text: headerBlock({ pass: 1, source: 'raw' }),
      },
      {
        name: 'stepOrdering',
        version: STEP_ORDERING_BLOCK_VERSION,
        text: stepOrderingBlock({ placement: 'system' }),
      },
    ],
    userBlocks: [
      // STEP 1 / STEP 2 user-side imperative — placement: 'user' returns the
      // imperative bullets (analysis-first, then scores) for the per-image task.
      {
        name: 'stepOrdering',
        version: STEP_ORDERING_BLOCK_VERSION,
        text: stepOrderingBlock({ placement: 'user' }),
      },
      {
        name: 'streamBAnchors',
        version: STREAM_B_ANCHORS_BLOCK_VERSION,
        text: streamBAnchorsBlock({ anchors }),
      },
      {
        name: 'pass1OutputSchema',
        version: PASS1_OUTPUT_SCHEMA_BLOCK_VERSION,
        text: pass1OutputSchemaBlock(),
      },
      {
        name: 'roomTypeTaxonomy',
        version: ROOM_TYPE_TAXONOMY_BLOCK_VERSION,
        text: roomTypeTaxonomyBlock(),
      },
      // W11.6.13 — orthogonal SPACE/ZONE taxonomy. The legacy room_type
      // block above continues to populate the compatibility-alias field;
      // this new block teaches the model to ALSO emit space_type +
      // zone_focus + space_zone_count alongside it.
      {
        name: 'spaceZoneTaxonomy',
        version: SPACE_ZONE_TAXONOMY_BLOCK_VERSION,
        text: spaceZoneTaxonomyBlock(),
      },
      {
        name: 'compositionTypeTaxonomy',
        version: COMPOSITION_TYPE_TAXONOMY_BLOCK_VERSION,
        text: compositionTypeTaxonomyBlock(),
      },
      {
        name: 'vantagePoint',
        version: VANTAGE_POINT_BLOCK_VERSION,
        text: vantagePointBlock(),
      },
      {
        name: 'clutterSeverity',
        version: CLUTTER_SEVERITY_BLOCK_VERSION,
        text: clutterSeverityBlock(),
      },
    ],
  });
}
