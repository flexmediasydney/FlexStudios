import { assert, assertEquals, assertStringIncludes } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import type { Pass2SlotDefinition } from '../../pass2Prompt.ts';
import {
  CANONICAL_SLOT_IDS,
  isCanonicalSlotId,
  normaliseSlotId,
  SLOT_ENUMERATION_BLOCK_VERSION,
  SLOT_ID_ALIASES,
  slotEnumerationBlock,
} from './slotEnumeration.ts';

const fakeSlot = (
  slot_id: string,
  phase: 1 | 2 | 3,
  eligible: string[] = ['exterior_front'],
): Pass2SlotDefinition => ({
  slot_id,
  display_name: slot_id,
  phase,
  eligible_room_types: eligible,
  max_images: 1,
  min_images: 1,
  notes: null,
});

Deno.test('slotEnumerationBlock: includes context + phase 1/2/3 sections', () => {
  const txt = slotEnumerationBlock({
    propertyAddress: '1 Test Lane',
    packageType: 'Premium Package',
    packageDisplayName: 'Premium Package',
    packageCeiling: 38,
    pricingTier: 'premium',
    engineRoles: ['photo_day_shortlist', 'photo_dusk_shortlist'],
    totalCompositions: 60,
    slotDefinitions: [fakeSlot('hero', 1), fakeSlot('living', 2)],
  });
  assertStringIncludes(txt, 'SHORTLISTING CONTEXT');
  assertStringIncludes(txt, '1 Test Lane');
  assertStringIncludes(txt, 'Total compositions available: 60');
  assertStringIncludes(txt, 'Package ceiling: 38');
  assertStringIncludes(txt, 'Premium Package maximum');
  assertStringIncludes(txt, 'PHASE 1 — MANDATORY SLOTS');
  assertStringIncludes(txt, 'PHASE 2 — CONDITIONAL SLOTS');
  assertStringIncludes(txt, 'PHASE 3 — FREE RECOMMENDATIONS');
  assertStringIncludes(txt, '- hero');
  assertStringIncludes(txt, '- living');
});

Deno.test('slotEnumerationBlock: empty phase 1 surfaces escalate-to-ops note', () => {
  const txt = slotEnumerationBlock({
    propertyAddress: null,
    packageType: 'Gold Package',
    packageDisplayName: 'Gold Package',
    packageCeiling: 24,
    pricingTier: 'standard',
    engineRoles: ['photo_day_shortlist'],
    totalCompositions: 30,
    slotDefinitions: [],
  });
  assertStringIncludes(txt, 'Unknown property');
  assertStringIncludes(txt, 'escalate to ops');
});

Deno.test('slotEnumerationBlock: surfaces engine roles in scope', () => {
  const txt = slotEnumerationBlock({
    propertyAddress: 'X',
    packageType: 'Gold Package',
    packageDisplayName: 'Gold Package',
    packageCeiling: 24,
    pricingTier: 'standard',
    engineRoles: ['photo_day_shortlist', 'drone_shortlist'],
    totalCompositions: 30,
    slotDefinitions: [],
  });
  assertStringIncludes(txt, 'Engine roles in scope: photo_day_shortlist, drone_shortlist');
});

Deno.test('slotEnumerationBlock: empty engineRoles renders explanatory placeholder', () => {
  const txt = slotEnumerationBlock({
    propertyAddress: 'X',
    packageType: 'Unknown',
    packageDisplayName: 'Unknown',
    packageCeiling: 0,
    pricingTier: 'standard',
    engineRoles: [],
    totalCompositions: 0,
    slotDefinitions: [],
  });
  assertStringIncludes(txt, 'Engine roles in scope: (none');
});

Deno.test('slotEnumerationBlock: uses caller-supplied packageDisplayName for ceiling label (no hardcoded mapping)', () => {
  // Custom à la carte tier — caller hands the prompt a meaningful label even
  // when the count doesn't match a legacy bucket.
  const txt = slotEnumerationBlock({
    propertyAddress: 'X',
    packageType: 'Custom à la carte',
    packageDisplayName: 'Custom à la carte',
    packageCeiling: 17, // not 24/31/38 — would have been mislabelled by legacy describeCeiling
    pricingTier: 'standard',
    engineRoles: ['photo_day_shortlist'],
    totalCompositions: 25,
    slotDefinitions: [],
  });
  assertStringIncludes(txt, 'Package ceiling: 17 images (Custom à la carte maximum)');
});

Deno.test('slotEnumerationBlock: version bumped to v1.3 (W11.6.22 curated positions)', () => {
  assertEquals(SLOT_ENUMERATION_BLOCK_VERSION, 'v1.3');
});

Deno.test('slotEnumerationBlock W11.6.22: curated footer appears when any slot uses curated_positions', () => {
  const slot: Pass2SlotDefinition = {
    slot_id: 'kitchen_hero',
    display_name: 'Kitchen',
    phase: 1,
    eligible_room_types: ['kitchen_main'],
    max_images: 3,
    min_images: 3,
    notes: null,
    selection_mode: 'curated_positions',
    curated_positions: [],
  };
  const txt = slotEnumerationBlock({
    propertyAddress: 'X',
    packageType: 'Premium',
    packageDisplayName: 'Premium',
    packageCeiling: 38,
    pricingTier: 'premium',
    engineRoles: ['photo_day_shortlist'],
    totalCompositions: 60,
    slotDefinitions: [slot],
  });
  assertStringIncludes(txt, 'CURATED POSITION CONTRACT (W11.6.22)');
  assertStringIncludes(txt, 'position_filled_via');
  assertStringIncludes(txt, 'curated_match');
  assertStringIncludes(txt, 'ai_backfill');
});

Deno.test('slotEnumerationBlock W11.6.22: footer absent when all slots are ai_decides', () => {
  const slot: Pass2SlotDefinition = {
    slot_id: 'living_hero',
    display_name: 'Living',
    phase: 1,
    eligible_room_types: ['living'],
    max_images: 1,
    min_images: 1,
    notes: null,
    selection_mode: 'ai_decides',
  };
  const txt = slotEnumerationBlock({
    propertyAddress: 'X',
    packageType: 'Standard',
    packageDisplayName: 'Standard',
    packageCeiling: 24,
    pricingTier: 'standard',
    engineRoles: ['photo_day_shortlist'],
    totalCompositions: 30,
    slotDefinitions: [slot],
  });
  assert(!txt.includes('CURATED POSITION CONTRACT'));
});

// ─── W11.7.1 hygiene: canonical slot vocabulary tests ───────────────────────

Deno.test('CANONICAL_SLOT_IDS: closed list, no duplicates, ~25 entries', () => {
  // Sanity: list isn't empty and has stayed within an order-of-magnitude of
  // the ~25-slot lattice we agreed on. If we exceed 35 the lattice is
  // fragmenting again.
  assert(CANONICAL_SLOT_IDS.length >= 20, `expected >= 20 canonical slots, got ${CANONICAL_SLOT_IDS.length}`);
  assert(CANONICAL_SLOT_IDS.length <= 35, `expected <= 35 canonical slots, got ${CANONICAL_SLOT_IDS.length}`);
  assertEquals(
    new Set(CANONICAL_SLOT_IDS).size,
    CANONICAL_SLOT_IDS.length,
    'CANONICAL_SLOT_IDS must not contain duplicates',
  );
  // Every entry must be lowercase snake_case.
  for (const s of CANONICAL_SLOT_IDS) {
    assert(
      /^[a-z][a-z0-9_]*$/.test(s),
      `slot_id "${s}" is not lowercase snake_case`,
    );
  }
  // Phase 1 lead heroes must all be present.
  for (
    const required of [
      'exterior_facade_hero',
      'kitchen_hero',
      'living_hero',
      'master_bedroom_hero',
      'alfresco_hero',
    ]
  ) {
    assert(isCanonicalSlotId(required), `missing canonical slot: ${required}`);
  }
});

Deno.test('SLOT_ID_ALIASES: every alias resolves to a canonical slot_id', () => {
  for (const [alias, target] of Object.entries(SLOT_ID_ALIASES)) {
    assert(
      isCanonicalSlotId(target),
      `alias "${alias}" → "${target}" but target is not in CANONICAL_SLOT_IDS`,
    );
    // Aliases MUST NOT collide with canonical names — that would hide drift.
    assert(
      !(CANONICAL_SLOT_IDS as readonly string[]).includes(alias),
      `alias key "${alias}" collides with a canonical slot_id (would hide drift)`,
    );
  }
});

Deno.test('normaliseSlotId: canonical hits pass through unchanged', () => {
  assertEquals(normaliseSlotId('kitchen_hero'), 'kitchen_hero');
  assertEquals(normaliseSlotId('master_bedroom_hero'), 'master_bedroom_hero');
  assertEquals(normaliseSlotId('alfresco_hero'), 'alfresco_hero');
  assertEquals(normaliseSlotId('ai_recommended'), 'ai_recommended');
});

Deno.test('normaliseSlotId: drift patterns observed in prod resolve via alias map', () => {
  // Real drift Joseph saw on Rainbow Cres + the wider survey:
  assertEquals(normaliseSlotId('master_bedroom'), 'master_bedroom_hero');
  assertEquals(normaliseSlotId('exterior_rear_hero'), 'exterior_rear');
  assertEquals(normaliseSlotId('living_dining_hero'), 'living_hero');
  assertEquals(normaliseSlotId('alfresco_outdoor_hero'), 'alfresco_hero');
  assertEquals(normaliseSlotId('exterior_front_hero'), 'exterior_facade_hero');
  assertEquals(normaliseSlotId('open_plan_hero'), 'living_hero');
  assertEquals(normaliseSlotId('balcony_terrace_hero'), 'balcony_terrace');
  assertEquals(normaliseSlotId('study_office'), 'study_hero');
});

Deno.test('normaliseSlotId: case-insensitive, trims whitespace', () => {
  assertEquals(normaliseSlotId('  KITCHEN_HERO  '), 'kitchen_hero');
  assertEquals(normaliseSlotId('Master_Bedroom'), 'master_bedroom_hero');
});

Deno.test('normaliseSlotId: unknown slot_ids return null (caller drops the row)', () => {
  // Genuine garbage / future drift the alias map doesn't cover: must return
  // null so the persist layer drops the row + warns. This is the strict
  // contract — never silently pass through unrecognised values.
  assertEquals(normaliseSlotId('completely_unknown_slot'), null);
  assertEquals(normaliseSlotId(''), null);
  assertEquals(normaliseSlotId('   '), null);
  assertEquals(normaliseSlotId(null), null);
  assertEquals(normaliseSlotId(undefined), null);
  assertEquals(normaliseSlotId(42), null);
  assertEquals(normaliseSlotId({}), null);
});

Deno.test('normaliseSlotId: persist-time normalisation matches Stage 4 schema enum', () => {
  // The contract Part B relies on: every value the persist layer will accept
  // (canonical hit OR aliased hit) ends up as a member of CANONICAL_SLOT_IDS.
  // This is the load-bearing invariant — the swimlane keys off slot_id, so
  // every ai_proposed_slot_id row written must be in this closed set.
  for (const slotId of CANONICAL_SLOT_IDS) {
    assertEquals(normaliseSlotId(slotId), slotId);
  }
  for (const aliasKey of Object.keys(SLOT_ID_ALIASES)) {
    const result = normaliseSlotId(aliasKey);
    assert(result !== null, `alias "${aliasKey}" should normalise to a canonical slot`);
    assert(
      isCanonicalSlotId(result),
      `alias "${aliasKey}" normalised to "${result}" which is NOT canonical`,
    );
  }
});
