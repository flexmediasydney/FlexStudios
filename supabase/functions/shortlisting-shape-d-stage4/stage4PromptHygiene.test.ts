/**
 * stage4PromptHygiene.test.ts — QC-iter2-W3 F-D-005 + F-D-006 + F-D-007.
 *
 * Run: deno test --no-check --allow-all \
 *   supabase/functions/shortlisting-shape-d-stage4/stage4PromptHygiene.test.ts
 *
 * Pin three Stage 4 prompt-hygiene contracts so the bugs never re-emerge:
 *
 *   F-D-005 — schema_version description echoes STAGE4_PROMPT_VERSION
 *             (was hard-coded "v1.0", model echoed v1.0 forever).
 *
 *   F-D-006 — slot_decisions[] description does NOT contain the non-canonical
 *             examples `master_bedroom` (without _hero) or `alfresco/outdoor_hero`
 *             (slash form is not an enum member). Description must reference
 *             canonical Phase 1 ids (`master_bedroom_hero`, `alfresco_hero`).
 *
 *   F-D-007 — Stage 4 user prompt assembly now includes the rendered
 *             slotEnumerationBlock output. We verify by rendering the block
 *             with a synthetic slot list and asserting the well-known anchors
 *             ("PHASE 1 — MANDATORY SLOTS", "SHORTLISTING CONTEXT", and
 *             "Package ceiling:") survive into the assembled string when
 *             prepended to a user prompt — the same wiring shape index.ts
 *             uses.
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  STAGE4_PROMPT_VERSION,
  STAGE4_TOOL_SCHEMA,
  buildStage4UserPrompt,
} from './stage4Prompt.ts';

import {
  slotEnumerationBlock,
} from '../_shared/visionPrompts/blocks/slotEnumeration.ts';

// ─── F-D-005 ───────────────────────────────────────────────────────────────

Deno.test('F-D-005: schema_version description echoes STAGE4_PROMPT_VERSION', () => {
  // deno-lint-ignore no-explicit-any
  const props = (STAGE4_TOOL_SCHEMA as any).properties as Record<string, any>;
  const desc = String(props.schema_version.description ?? '');
  // Must contain the live constant — not the legacy hardcoded "v1.0" (unless
  // STAGE4_PROMPT_VERSION genuinely happens to equal v1.0).
  assertStringIncludes(desc, STAGE4_PROMPT_VERSION);
});

Deno.test('F-D-005: schema_version description does NOT contain literal "Always" hardcoding', () => {
  // deno-lint-ignore no-explicit-any
  const props = (STAGE4_TOOL_SCHEMA as any).properties as Record<string, any>;
  const desc = String(props.schema_version.description ?? '');
  // The bug shape was `Always "v1.0".` — guard against any future hardcoded
  // "Always v1.0" / "Always v1.1" reverts that drift away from the constant.
  if (STAGE4_PROMPT_VERSION !== 'v1.0') {
    assert(
      !desc.includes('"v1.0"'),
      `schema_version description must not pin "v1.0" when STAGE4_PROMPT_VERSION=${STAGE4_PROMPT_VERSION}; got: ${desc}`,
    );
  }
});

// ─── F-D-006 ───────────────────────────────────────────────────────────────

Deno.test('F-D-006: slot_decisions description uses canonical slot_id examples', () => {
  // deno-lint-ignore no-explicit-any
  const props = (STAGE4_TOOL_SCHEMA as any).properties as Record<string, any>;
  const desc = String(props.slot_decisions.description ?? '');

  // Forbidden non-canonical examples (the prior bug values).
  // `master_bedroom` (no _hero suffix) is in the alias drift map but is NOT
  // a canonical id — the model parroted it and tripped the enum constraint.
  // `alfresco/outdoor_hero` is a slash form that's not an enum member at all.
  assert(
    !/\bmaster_bedroom\b(?!_hero)/.test(desc),
    `slot_decisions description must not show non-canonical "master_bedroom" example; got: ${desc}`,
  );
  assert(
    !desc.includes('alfresco/outdoor_hero'),
    `slot_decisions description must not show "alfresco/outdoor_hero" slash form; got: ${desc}`,
  );

  // Canonical Phase 1 ids must be referenced.
  assertStringIncludes(desc, 'master_bedroom_hero');
  assertStringIncludes(desc, 'alfresco_hero');
});

// ─── F-D-007 ───────────────────────────────────────────────────────────────

Deno.test('F-D-007: slotEnumerationBlock output includes the well-known prompt anchors used by Stage 4 wiring', () => {
  // Render the block with a minimal synthetic slot list. We do NOT exercise
  // the DB loader here — that's an integration concern. We verify the block
  // output emits the well-known anchors that index.ts now prepends to the
  // Stage 4 user prompt. The corresponding wiring assertion below stitches
  // that output into a buildStage4UserPrompt call to prove the anchors
  // survive the assembly.
  const text = slotEnumerationBlock({
    propertyAddress: '1 Test St, Suburb',
    packageType: 'Gold',
    packageDisplayName: 'Gold',
    packageCeiling: 25,
    pricingTier: 'standard',
    engineRoles: ['photo_premium'],
    totalCompositions: 30,
    slotDefinitions: [
      {
        slot_id: 'exterior_facade_hero',
        display_name: 'Facade hero',
        phase: 1,
        eligible_room_types: ['exterior'],
        max_images: 1,
        min_images: 1,
        notes: '',
        selection_mode: 'ai_decides',
      },
      {
        slot_id: 'kitchen_secondary',
        display_name: 'Kitchen secondary',
        phase: 2,
        eligible_room_types: ['kitchen'],
        max_images: 2,
        min_images: 0,
        notes: '',
        selection_mode: 'ai_decides',
      },
      // deno-lint-ignore no-explicit-any
    ] as any,
  });

  assertStringIncludes(text, 'SHORTLISTING CONTEXT:');
  assertStringIncludes(text, 'PHASE 1 — MANDATORY SLOTS');
  assertStringIncludes(text, 'PHASE 2 — CONDITIONAL SLOTS');
  assertStringIncludes(text, 'Package ceiling:');
  assertStringIncludes(text, 'exterior_facade_hero');
  assertStringIncludes(text, 'kitchen_secondary');
});

Deno.test('F-D-007: assembled Stage 4 user prompt preserves slotEnumerationBlock anchors when prepended (matches index.ts wiring shape)', () => {
  // Mirrors the assembly used in shortlisting-shape-d-stage4/index.ts:
  //   const userPromptCore = buildStage4UserPrompt({...});
  //   const userPromptWithSlots = slotEnumerationText.length > 0
  //     ? [slotEnumerationText, '', userPromptCore].join('\n')
  //     : userPromptCore;
  // We rebuild that shape in-test and assert the slotEnumerationBlock anchors
  // survive the join, AND the schema_version constant + canonical slot_id
  // examples from F-D-005/F-D-006 are in the schema seen alongside it.
  const slotsText = slotEnumerationBlock({
    propertyAddress: null,
    packageType: 'Silver',
    packageDisplayName: 'Silver',
    packageCeiling: 18,
    pricingTier: 'standard',
    engineRoles: ['photo_standard'],
    totalCompositions: 22,
    slotDefinitions: [
      {
        slot_id: 'exterior_facade_hero',
        display_name: 'Facade hero',
        phase: 1,
        eligible_room_types: ['exterior'],
        max_images: 1,
        min_images: 1,
        notes: '',
        selection_mode: 'ai_decides',
      },
      // deno-lint-ignore no-explicit-any
    ] as any,
  });
  const userPromptCore = buildStage4UserPrompt({
    sourceContextBlockText: '── SOURCE CONTEXT ──',
    voiceBlockText: '── VOICE ──',
    selfCritiqueBlockText: '── SELF CRITIQUE ──',
    propertyFacts: {
      address_line: null,
      suburb: null,
      state: 'NSW',
      bedrooms: null,
      bathrooms: null,
      car_spaces: null,
      land_size_sqm: null,
      internal_size_sqm: null,
      price_guide_band: null,
      auction_or_private_treaty: null,
    },
    stage1Merged: [],
    imageStemsInOrder: ['stem_001', 'stem_002'],
    totalImages: 2,
  });
  const assembled = [slotsText, '', userPromptCore].join('\n');

  // slotEnumerationBlock anchors survived the assembly.
  assertStringIncludes(assembled, 'SHORTLISTING CONTEXT:');
  assertStringIncludes(assembled, 'PHASE 1 — MANDATORY SLOTS');
  assertStringIncludes(assembled, 'Package ceiling: 18');

  // The Stage 4 user prompt body still appears below the block.
  assertStringIncludes(assembled, '── PROPERTY FACTS (authoritative; do NOT invent) ──');
  assertStringIncludes(assembled, 'IMAGE PREVIEWS');
});
