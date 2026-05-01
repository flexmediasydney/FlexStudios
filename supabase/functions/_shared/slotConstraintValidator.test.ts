/**
 * slotConstraintValidator.test.ts — Wave 11.6.7 P1-4 + P1-5 unit tests.
 *
 * Run: deno test supabase/functions/_shared/slotConstraintValidator.test.ts --no-check --allow-all
 */

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  validateSlotConstraints,
  type SlotDecisionInput,
  type SlotDefinitionConstraints,
  type ClassificationContext,
} from './slotConstraintValidator.ts';

function mkSlot(over: Partial<SlotDefinitionConstraints>): SlotDefinitionConstraints {
  return {
    id: over.id || 'slot-uuid-1',
    slot_id: over.slot_id || 'kitchen_hero',
    lens_class_constraint: over.lens_class_constraint ?? null,
    eligible_composition_types: over.eligible_composition_types ?? null,
    same_room_as_slot: over.same_room_as_slot ?? null,
  };
}

function mkCls(over: Partial<ClassificationContext>): ClassificationContext {
  return {
    group_id: over.group_id || 'g1',
    lens_class: over.lens_class ?? null,
    composition_type: over.composition_type ?? null,
    room_type: over.room_type ?? null,
  };
}

function mkDec(over: Partial<SlotDecisionInput>): SlotDecisionInput {
  return {
    slot_id: over.slot_id || 'kitchen_hero',
    winner_group_id: over.winner_group_id ?? 'g1',
    winner_stem: over.winner_stem ?? 'IMG_001',
    raw: over.raw ?? { slot_id: over.slot_id || 'kitchen_hero' },
  };
}

// ─── lens_class_constraint (P1-4) ───────────────────────────────────────────

Deno.test('lens_class: matching constraint passes', () => {
  const slots = new Map<string, SlotDefinitionConstraints>();
  slots.set('kitchen_hero', mkSlot({ lens_class_constraint: 'wide_angle' }));
  const cls = new Map<string, ClassificationContext>();
  cls.set('g1', mkCls({ lens_class: 'wide_angle' }));
  const result = validateSlotConstraints({
    decisions: [mkDec({})],
    slotsBySlotId: slots,
    classificationsByGroupId: cls,
  });
  assertEquals(result.rejections.length, 0);
  assertEquals(result.acceptedDecisions.length, 1);
});

Deno.test('lens_class: mismatched constraint rejects + emits override', () => {
  const slots = new Map<string, SlotDefinitionConstraints>();
  slots.set('kitchen_hero', mkSlot({ lens_class_constraint: 'wide_angle' }));
  const cls = new Map<string, ClassificationContext>();
  cls.set('g1', mkCls({ lens_class: 'telephoto' }));
  const result = validateSlotConstraints({
    decisions: [mkDec({})],
    slotsBySlotId: slots,
    classificationsByGroupId: cls,
  });
  assertEquals(result.rejections.length, 1);
  assertEquals(result.acceptedDecisions.length, 0);
  assertEquals(result.rejections[0].field, 'slot_decision');
  assertEquals(result.rejections[0].stage_4_value, 'rejected');
  assert(result.rejections[0].reason.includes('wide_angle'));
  assert(result.rejections[0].reason.includes('telephoto'));
});

Deno.test('lens_class: null constraint passes regardless of winner lens_class', () => {
  const slots = new Map<string, SlotDefinitionConstraints>();
  slots.set('kitchen_hero', mkSlot({ lens_class_constraint: null }));
  const cls = new Map<string, ClassificationContext>();
  cls.set('g1', mkCls({ lens_class: 'telephoto' }));
  const result = validateSlotConstraints({
    decisions: [mkDec({})],
    slotsBySlotId: slots,
    classificationsByGroupId: cls,
  });
  assertEquals(result.rejections.length, 0);
});

// ─── eligible_composition_types (P1-5) ──────────────────────────────────────

Deno.test('composition_type: matching allow-list passes', () => {
  const slots = new Map<string, SlotDefinitionConstraints>();
  slots.set('kitchen_hero', mkSlot({ eligible_composition_types: ['hero_wide', 'corner_two_point'] }));
  const cls = new Map<string, ClassificationContext>();
  cls.set('g1', mkCls({ composition_type: 'hero_wide' }));
  const result = validateSlotConstraints({
    decisions: [mkDec({})],
    slotsBySlotId: slots,
    classificationsByGroupId: cls,
  });
  assertEquals(result.rejections.length, 0);
});

Deno.test('composition_type: not-in-list rejects', () => {
  const slots = new Map<string, SlotDefinitionConstraints>();
  slots.set('kitchen_hero', mkSlot({ eligible_composition_types: ['hero_wide'] }));
  const cls = new Map<string, ClassificationContext>();
  cls.set('g1', mkCls({ composition_type: 'detail_corner' }));
  const result = validateSlotConstraints({
    decisions: [mkDec({})],
    slotsBySlotId: slots,
    classificationsByGroupId: cls,
  });
  assertEquals(result.rejections.length, 1);
  assert(result.rejections[0].reason.includes('hero_wide'));
  assert(result.rejections[0].reason.includes('detail_corner'));
});

Deno.test('composition_type: empty array treated as no constraint', () => {
  const slots = new Map<string, SlotDefinitionConstraints>();
  slots.set('kitchen_hero', mkSlot({ eligible_composition_types: [] }));
  const cls = new Map<string, ClassificationContext>();
  cls.set('g1', mkCls({ composition_type: 'anything' }));
  const result = validateSlotConstraints({
    decisions: [mkDec({})],
    slotsBySlotId: slots,
    classificationsByGroupId: cls,
  });
  assertEquals(result.rejections.length, 0);
});

// ─── same_room_as_slot (P1-5) ───────────────────────────────────────────────

Deno.test('same_room_as_slot: matching room_type passes', () => {
  const slots = new Map<string, SlotDefinitionConstraints>();
  slots.set('bathroom_main', mkSlot({ id: 'main-uuid', slot_id: 'bathroom_main' }));
  slots.set('bathroom_detail', mkSlot({ id: 'detail-uuid', slot_id: 'bathroom_detail', same_room_as_slot: 'main-uuid' }));
  const cls = new Map<string, ClassificationContext>();
  cls.set('g1', mkCls({ group_id: 'g1', room_type: 'bathroom' })); // main winner
  cls.set('g2', mkCls({ group_id: 'g2', room_type: 'bathroom' })); // detail winner — same room_type
  const result = validateSlotConstraints({
    decisions: [
      mkDec({ slot_id: 'bathroom_main', winner_group_id: 'g1' }),
      mkDec({ slot_id: 'bathroom_detail', winner_group_id: 'g2' }),
    ],
    slotsBySlotId: slots,
    classificationsByGroupId: cls,
  });
  assertEquals(result.rejections.length, 0);
  assertEquals(result.acceptedDecisions.length, 2);
});

Deno.test('same_room_as_slot: mismatched room_type rejects detail slot', () => {
  const slots = new Map<string, SlotDefinitionConstraints>();
  slots.set('bathroom_main', mkSlot({ id: 'main-uuid', slot_id: 'bathroom_main' }));
  slots.set('bathroom_detail', mkSlot({ id: 'detail-uuid', slot_id: 'bathroom_detail', same_room_as_slot: 'main-uuid' }));
  const cls = new Map<string, ClassificationContext>();
  cls.set('g1', mkCls({ group_id: 'g1', room_type: 'bathroom' }));
  cls.set('g2', mkCls({ group_id: 'g2', room_type: 'ensuite_primary' })); // different room
  const result = validateSlotConstraints({
    decisions: [
      mkDec({ slot_id: 'bathroom_main', winner_group_id: 'g1' }),
      mkDec({ slot_id: 'bathroom_detail', winner_group_id: 'g2', winner_stem: 'IMG_002' }),
    ],
    slotsBySlotId: slots,
    classificationsByGroupId: cls,
  });
  assertEquals(result.rejections.length, 1);
  assertEquals(result.acceptedDecisions.length, 1); // main passes, detail rejected
  assertEquals(result.rejections[0].stem, 'IMG_002');
  assert(result.rejections[0].reason.includes('bathroom_main'));
  assert(result.rejections[0].reason.includes('ensuite_primary'));
});

Deno.test('same_room_as_slot: linked slot missing winner skips check (no reject)', () => {
  const slots = new Map<string, SlotDefinitionConstraints>();
  slots.set('bathroom_main', mkSlot({ id: 'main-uuid', slot_id: 'bathroom_main' }));
  slots.set('bathroom_detail', mkSlot({ id: 'detail-uuid', slot_id: 'bathroom_detail', same_room_as_slot: 'main-uuid' }));
  const cls = new Map<string, ClassificationContext>();
  cls.set('g2', mkCls({ group_id: 'g2', room_type: 'ensuite_primary' }));
  // ONLY the detail decision is in the batch — main wasn't decided.
  const result = validateSlotConstraints({
    decisions: [mkDec({ slot_id: 'bathroom_detail', winner_group_id: 'g2' })],
    slotsBySlotId: slots,
    classificationsByGroupId: cls,
  });
  assertEquals(result.rejections.length, 0); // soft constraint — no reject when anchor missing
});

Deno.test('same_room_as_slot: linked slot id no longer in slots map skips check', () => {
  const slots = new Map<string, SlotDefinitionConstraints>();
  // bathroom_main is referenced by FK but is missing from the slots map
  // (e.g. was deleted; ON DELETE SET NULL hasn't propagated to in-memory).
  slots.set('bathroom_detail', mkSlot({ id: 'detail-uuid', slot_id: 'bathroom_detail', same_room_as_slot: 'main-uuid-deleted' }));
  const cls = new Map<string, ClassificationContext>();
  cls.set('g2', mkCls({ group_id: 'g2', room_type: 'ensuite_primary' }));
  const result = validateSlotConstraints({
    decisions: [mkDec({ slot_id: 'bathroom_detail', winner_group_id: 'g2' })],
    slotsBySlotId: slots,
    classificationsByGroupId: cls,
  });
  assertEquals(result.rejections.length, 0);
});

// ─── multi-constraint cases ─────────────────────────────────────────────────

Deno.test('multi: lens_class fails first → reject; composition_type not checked', () => {
  const slots = new Map<string, SlotDefinitionConstraints>();
  slots.set('kitchen_hero', mkSlot({
    lens_class_constraint: 'wide_angle',
    eligible_composition_types: ['detail_corner'],
  }));
  const cls = new Map<string, ClassificationContext>();
  cls.set('g1', mkCls({ lens_class: 'telephoto', composition_type: 'detail_corner' }));
  const result = validateSlotConstraints({
    decisions: [mkDec({})],
    slotsBySlotId: slots,
    classificationsByGroupId: cls,
  });
  assertEquals(result.rejections.length, 1);
  // Only the lens_class violation surfaces; the composition_type check is
  // short-circuited by the early continue.
  assert(result.rejections[0].reason.includes('lens_class'));
});

Deno.test('decision with no winner_group_id is passed through unchanged', () => {
  const slots = new Map<string, SlotDefinitionConstraints>();
  slots.set('kitchen_hero', mkSlot({ lens_class_constraint: 'wide_angle' }));
  const cls = new Map<string, ClassificationContext>();
  const result = validateSlotConstraints({
    decisions: [mkDec({ winner_group_id: null })],
    slotsBySlotId: slots,
    classificationsByGroupId: cls,
  });
  assertEquals(result.rejections.length, 0);
  assertEquals(result.acceptedDecisions.length, 1);
});

Deno.test('decision for unknown slot_id is passed through (caller handles)', () => {
  const slots = new Map<string, SlotDefinitionConstraints>();
  // No 'unknown_slot' entry.
  const cls = new Map<string, ClassificationContext>();
  cls.set('g1', mkCls({ lens_class: 'wide_angle' }));
  const result = validateSlotConstraints({
    decisions: [mkDec({ slot_id: 'unknown_slot' })],
    slotsBySlotId: slots,
    classificationsByGroupId: cls,
  });
  assertEquals(result.rejections.length, 0);
  assertEquals(result.acceptedDecisions.length, 1);
});
