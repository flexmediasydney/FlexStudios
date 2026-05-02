/**
 * W11.6.25 — applyRecipeToSlots unit tests.
 *
 * Run: deno test --no-check --allow-all \
 *   supabase/functions/shortlisting-shape-d-stage4/applyRecipeToSlots.test.ts
 *
 * Verifies that Stage 4 reads the frozen recipe snapshot (NOT live tables)
 * when overriding per-slot allocated_count / max_count, so mid-round edits
 * to allocations do NOT change in-flight rounds.
 */

import {
  assertEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { applyRecipeToSlots } from './index.ts';
import type { Pass2SlotDefinition } from '../_shared/pass2Prompt.ts';

const BASE_SLOTS: Pass2SlotDefinition[] = [
  {
    slot_id: 'kitchen_hero',
    display_name: 'Kitchen Hero',
    phase: 1,
    eligible_room_types: ['kitchen_main'],
    min_images: 1,
    max_images: 2,
    notes: null,
    selection_mode: 'ai_decides' as const,
  } as Pass2SlotDefinition,
  {
    slot_id: 'living_hero',
    display_name: 'Living Hero',
    phase: 1,
    eligible_room_types: ['living_room'],
    min_images: 1,
    max_images: 2,
    notes: null,
    selection_mode: 'ai_decides' as const,
  } as Pass2SlotDefinition,
];

Deno.test('applyRecipeToSlots: NULL recipe returns slots unchanged', () => {
  const result = applyRecipeToSlots(BASE_SLOTS, null);
  assertEquals(result, BASE_SLOTS);
});

Deno.test('applyRecipeToSlots: empty entries returns slots unchanged', () => {
  // deno-lint-ignore no-explicit-any
  const recipe: any = { entries: [] };
  const result = applyRecipeToSlots(BASE_SLOTS, recipe);
  assertEquals(result, BASE_SLOTS);
});

Deno.test('applyRecipeToSlots: recipe overrides per-slot min/max', () => {
  const recipe = {
    entries: [
      {
        slot_id: 'kitchen_hero',
        classification: 'mandatory' as const,
        allocated_count: 3,
        max_count: 5,
        priority_rank: 50,
        notes: null,
      },
    ],
  };
  const result = applyRecipeToSlots(BASE_SLOTS, recipe);
  const k = result.find((s) => s.slot_id === 'kitchen_hero')!;
  const l = result.find((s) => s.slot_id === 'living_hero')!;
  assertEquals(k.min_images, 3);
  assertEquals(k.max_images, 5);
  // Living unchanged — not in the recipe.
  assertEquals(l.min_images, 1);
  assertEquals(l.max_images, 2);
});

Deno.test('applyRecipeToSlots: snapshot semantics — function only sees what was passed', () => {
  // Confirms Stage 4 sees the snapshot and not the live table values.
  const recipe = {
    entries: [
      {
        slot_id: 'kitchen_hero',
        classification: 'mandatory' as const,
        allocated_count: 7, // very different from live slot.min_images=1
        max_count: 9,
        priority_rank: 1,
        notes: 'frozen at ingest',
      },
    ],
  };
  const result = applyRecipeToSlots(BASE_SLOTS, recipe);
  const k = result.find((s) => s.slot_id === 'kitchen_hero')!;
  assertEquals(k.min_images, 7);
  assertEquals(k.max_images, 9);
});

Deno.test('applyRecipeToSlots: original input is not mutated', () => {
  const recipe = {
    entries: [
      {
        slot_id: 'kitchen_hero',
        classification: 'mandatory' as const,
        allocated_count: 5,
        max_count: 8,
        priority_rank: 1,
        notes: null,
      },
    ],
  };
  applyRecipeToSlots(BASE_SLOTS, recipe);
  const k = BASE_SLOTS.find((s) => s.slot_id === 'kitchen_hero')!;
  assertEquals(k.min_images, 1); // unchanged
  assertEquals(k.max_images, 2); // unchanged
});
