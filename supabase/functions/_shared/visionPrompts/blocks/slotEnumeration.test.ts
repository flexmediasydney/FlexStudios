import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import type { Pass2SlotDefinition } from '../../pass2Prompt.ts';
import {
  SLOT_ENUMERATION_BLOCK_VERSION,
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

Deno.test('slotEnumerationBlock: version bumped to v1.1 (W7.7 field rename + describeCeiling drop)', () => {
  assertEquals(SLOT_ENUMERATION_BLOCK_VERSION, 'v1.1');
});
