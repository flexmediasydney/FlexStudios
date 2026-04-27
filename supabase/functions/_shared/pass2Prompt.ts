/**
 * pass2Prompt.ts — pure Pass 2 shortlisting prompt builder.
 *
 * Constructs the single-call, full-universe-context shortlisting prompt for
 * Pass 2. Verbatim structure from spec §6 with Stream B SCORING ANCHORS injected
 * via streamBInjector.buildScoringReferenceBlock().
 *
 * Critical v2 architectural rules baked into this prompt (DO NOT REMOVE):
 *
 *   1. SINGLE SONNET CALL WITH FULL UNIVERSE CONTEXT (spec L4). Pass 2 is NOT
 *      concurrent. The model receives every Pass 1 classification as one
 *      packed text block and makes shortlisting decisions across the whole
 *      shoot at once. Without the full universe, the model cannot make
 *      relative selection decisions and grade-inflates every image.
 *
 *   2. THREE-PHASE ARCHITECTURE (spec L5, §6). Phase 1 = mandatory always-fill,
 *      Phase 2 = conditional fills (only when room confirmed in classifications),
 *      Phase 3 = AI free recommendations bounded by package ceiling. The prompt
 *      enumerates phase-1 + phase-2 slots from the slot_definitions table; phase
 *      3 is unbounded prose ("free choice up to ceiling").
 *
 *   3. TOP-3 ALTERNATIVES PER SLOT (spec L13). Every slot output includes a
 *      winner + 2 alternatives so the swimlane UI can offer tap-to-swap. The
 *      JSON schema explicitly demands `slot_alternatives: { slot_id: [r2, r3] }`.
 *
 *   4. NEAR-DUPLICATE CULLING SCOPE WITHIN-ROOM (spec L7). Two compositions
 *      are duplicates ONLY if same room_type AND angle delta < 15° AND key
 *      element overlap > 80%. Different rooms with same label (e.g. living_room
 *      ground vs living_secondary upstairs) are NOT duplicates.
 *
 *   5. BEDROOM SPLIT SCORING (spec §6). master_bedroom_hero = highest
 *      combined; bedroom_secondary = highest AESTHETIC. Two different
 *      selection criteria.
 *
 *   6. ENSUITE SECOND ANGLE (spec L19). ensuite_primary slot allows up to
 *      2 images IF angle delta > 30° (shower-side + vanity-side complementary).
 *
 *   7. ALFRESCO + EXTERIOR_LOOKING_IN ELIGIBILITY (spec L6). composition is
 *      eligible for exterior_rear slot (not just alfresco_hero) when this
 *      vantage applies. Pass 1 pre-computes this on the eligible_for_exterior_rear
 *      column.
 *
 *   8. STREAM B INJECTION (spec L8). Same anchors as Pass 1 — the shortlisting
 *      decision references Tier S/P/A names so the model has consistent scale.
 *
 * Wave 7 P1-10 (W7.6): the prompt is now assembled from named, versioned
 * blocks under `visionPrompts/blocks/`. The text content is byte-stable with
 * the previous monolith — see `visionPrompts/__snapshots__/pass2Prompt.snap.txt`
 * for the regression gate.
 *
 * Single export: `buildPass2Prompt(opts)` → `AssembledPrompt` (system,
 * userPrefix, blockVersions). The caller does NOT pass an image — Pass 2 is
 * text-only with summarised classifications. Caller dispatches via
 * `callClaudeVision` with model=claude-sonnet-4-6, max_tokens=4000,
 * temperature=0.
 */

import type { StreamBAnchors } from './streamBInjector.ts';
import { type AssembledPrompt, assemble } from './visionPrompts/assemble.ts';
import { HEADER_BLOCK_VERSION, headerBlock } from './visionPrompts/blocks/header.ts';
import {
  PASS2_PHASES_BLOCK_VERSION,
  pass2PhasesBlock,
} from './visionPrompts/blocks/pass2Phases.ts';
import {
  STREAM_B_ANCHORS_BLOCK_VERSION,
  streamBAnchorsBlock,
} from './visionPrompts/blocks/streamBAnchors.ts';
import {
  PASS2_OUTPUT_SCHEMA_BLOCK_VERSION,
  pass2OutputSchemaBlock,
} from './visionPrompts/blocks/pass2OutputSchema.ts';
import {
  SLOT_ENUMERATION_BLOCK_VERSION,
  slotEnumerationBlock,
} from './visionPrompts/blocks/slotEnumeration.ts';
import {
  CLASSIFICATIONS_TABLE_BLOCK_VERSION,
  classificationsTableBlock,
} from './visionPrompts/blocks/classificationsTable.ts';
import {
  NEAR_DUPLICATE_CULLING_BLOCK_VERSION,
  nearDuplicateCullingBlock,
} from './visionPrompts/blocks/nearDuplicateCulling.ts';
import {
  BEDROOM_SPLIT_BLOCK_VERSION,
  bedroomSplitBlock,
} from './visionPrompts/blocks/bedroomSplit.ts';
import {
  ENSUITE_SECOND_ANGLE_BLOCK_VERSION,
  ensuiteSecondAngleBlock,
} from './visionPrompts/blocks/ensuiteSecondAngle.ts';
import {
  ALFRESCO_EXTERIOR_REAR_BLOCK_VERSION,
  alfrescoExteriorRearBlock,
} from './visionPrompts/blocks/alfrescoExteriorRear.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Pass2SlotDefinition {
  slot_id: string;
  display_name: string;
  phase: 1 | 2 | 3;
  eligible_room_types: string[];
  max_images: number;
  min_images: number;
  notes: string | null;
}

/**
 * One classification row, projected to the fields Pass 2 actually needs.
 * The orchestrator joins composition_classifications with composition_groups
 * and produces this shape.
 */
export interface Pass2ClassificationRow {
  /** delivery_reference_stem from composition_groups (or best_bracket_stem
   *  fallback) — this is the canonical filename the model emits in JSON. */
  stem: string;
  group_id: string;
  group_index: number;
  room_type: string | null;
  composition_type: string | null;
  vantage_point: string | null;
  technical_score: number | null;
  lighting_score: number | null;
  composition_score: number | null;
  aesthetic_score: number | null;
  combined_score: number | null;
  is_styled: boolean | null;
  indoor_outdoor_visible: boolean | null;
  is_drone: boolean | null;
  is_exterior: boolean | null;
  eligible_for_exterior_rear: boolean | null;
  clutter_severity: string | null;
  flag_for_retouching: boolean | null;
  analysis: string | null;
}

export interface Pass2PromptOptions {
  /** Resolved street/property address — surfaced in the SHORTLISTING CONTEXT
   *  block. Falls back to "Unknown property" if absent. */
  propertyAddress: string | null;
  /** 'Gold' | 'Day to Dusk' | 'Premium' | other text from shortlisting_rounds.package_type */
  packageType: string;
  /** 24 (Gold) | 31 (Day to Dusk) | 38 (Premium) — hard upper bound on shortlist size. */
  packageCeiling: number;
  /** 'standard' | 'premium' (mostly informational — Stream B handles the heavy lifting). */
  tier: 'standard' | 'premium' | string;
  /** Active slot definitions for this package_type (filtered by orchestrator). */
  slotDefinitions: Pass2SlotDefinition[];
  /** Stream B tier anchors loaded from streamBInjector. */
  streamBAnchors: StreamBAnchors;
  /** All Pass 1 classifications for the round (one per composition). */
  classifications: Pass2ClassificationRow[];
}

/**
 * Legacy alias retained for any existing callers that import `Pass2Prompt`.
 * New callers should use `AssembledPrompt` directly.
 */
export type Pass2Prompt = AssembledPrompt;

// Re-export the canonical line formatter so existing benchmark/diagnostics
// callers (if any) can continue to import it from this module path.
export { formatClassificationLine } from './visionPrompts/blocks/classificationsTable.ts';

// ─── Builder ─────────────────────────────────────────────────────────────────

export function buildPass2Prompt(opts: Pass2PromptOptions): AssembledPrompt {
  const {
    propertyAddress,
    packageType,
    packageCeiling,
    tier,
    slotDefinitions,
    streamBAnchors,
    classifications,
  } = opts;

  return assemble({
    systemBlocks: [
      {
        name: 'header',
        version: HEADER_BLOCK_VERSION,
        text: headerBlock({ pass: 2, source: 'raw' }),
      },
      {
        name: 'pass2Phases',
        version: PASS2_PHASES_BLOCK_VERSION,
        text: pass2PhasesBlock(),
      },
    ],
    userBlocks: [
      {
        name: 'slotEnumeration',
        version: SLOT_ENUMERATION_BLOCK_VERSION,
        text: slotEnumerationBlock({
          propertyAddress,
          packageType,
          packageCeiling,
          tier,
          totalCompositions: classifications.length,
          slotDefinitions,
        }),
      },
      {
        name: 'nearDuplicateCulling',
        version: NEAR_DUPLICATE_CULLING_BLOCK_VERSION,
        text: nearDuplicateCullingBlock(),
      },
      {
        name: 'bedroomSplit',
        version: BEDROOM_SPLIT_BLOCK_VERSION,
        text: bedroomSplitBlock(),
      },
      {
        name: 'ensuiteSecondAngle',
        version: ENSUITE_SECOND_ANGLE_BLOCK_VERSION,
        text: ensuiteSecondAngleBlock(),
      },
      {
        name: 'alfrescoExteriorRear',
        version: ALFRESCO_EXTERIOR_REAR_BLOCK_VERSION,
        text: alfrescoExteriorRearBlock(),
      },
      {
        name: 'streamBAnchors',
        version: STREAM_B_ANCHORS_BLOCK_VERSION,
        text: streamBAnchorsBlock({ anchors: streamBAnchors }),
      },
      {
        name: 'classificationsTable',
        version: CLASSIFICATIONS_TABLE_BLOCK_VERSION,
        text: classificationsTableBlock({ classifications }),
      },
      {
        name: 'pass2OutputSchema',
        version: PASS2_OUTPUT_SCHEMA_BLOCK_VERSION,
        text: pass2OutputSchemaBlock(),
      },
    ],
  });
}
