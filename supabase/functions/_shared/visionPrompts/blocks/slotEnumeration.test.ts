import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import type { Pass2SlotDefinition } from '../../pass2Prompt.ts';
import {
  SLOT_ENUMERATION_BLOCK_VERSION,
  describeCeiling,
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
    packageType: 'Premium',
    packageCeiling: 38,
    tier: 'premium',
    totalCompositions: 60,
    slotDefinitions: [fakeSlot('hero', 1), fakeSlot('living', 2)],
  });
  assertStringIncludes(txt, 'SHORTLISTING CONTEXT');
  assertStringIncludes(txt, '1 Test Lane');
  assertStringIncludes(txt, 'Total compositions available: 60');
  assertStringIncludes(txt, 'Package ceiling: 38');
  assertStringIncludes(txt, 'PHASE 1 — MANDATORY SLOTS');
  assertStringIncludes(txt, 'PHASE 2 — CONDITIONAL SLOTS');
  assertStringIncludes(txt, 'PHASE 3 — FREE RECOMMENDATIONS');
  assertStringIncludes(txt, '- hero');
  assertStringIncludes(txt, '- living');
});

Deno.test('slotEnumerationBlock: empty phase 1 surfaces escalate-to-ops note', () => {
  const txt = slotEnumerationBlock({
    propertyAddress: null,
    packageType: 'Gold',
    packageCeiling: 24,
    tier: 'standard',
    totalCompositions: 30,
    slotDefinitions: [],
  });
  assertStringIncludes(txt, 'Unknown property');
  assertStringIncludes(txt, 'escalate to ops');
});

Deno.test('describeCeiling: maps known ceilings to package labels', () => {
  assertEquals(describeCeiling(24), 'Gold maximum');
  assertEquals(describeCeiling(31), 'Day to Dusk maximum');
  assertEquals(describeCeiling(38), 'Premium maximum');
  assertEquals(describeCeiling(99), 'package maximum');
});

Deno.test('slotEnumerationBlock: version constant is the v1.0 baseline', () => {
  assertEquals(SLOT_ENUMERATION_BLOCK_VERSION, 'v1.0');
});
