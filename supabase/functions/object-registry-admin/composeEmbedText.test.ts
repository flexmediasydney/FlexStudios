/**
 * Unit tests for object-registry-admin composeEmbedText.
 * Run: deno test --no-check --allow-all supabase/functions/object-registry-admin/composeEmbedText.test.ts
 *
 * F-B-013 (W11.QC-iter2-W4 P1): the approve_candidate path now re-embeds
 * from CURATED text via composeEmbedText (display_name + description +
 * level concat + aliases) — same helper used by backfill_embeddings, so the
 * two re-embed paths stay byte-identical.
 *
 * These tests pin:
 *   1. Curated text differs from raw observed-label text → guarantees that
 *      the embedding from composeEmbedText would differ from the candidate's
 *      raw-label embedding (the bug F-B-013 was about).
 *   2. composeEmbedText output is stable / deterministic / order-preserving.
 *   3. Optional fields (description, levels, aliases) are dropped cleanly
 *      when null / empty without breaking the structure.
 */

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { composeEmbedText } from './index.ts';

// ─── 1. Curated text differs from a raw observed label ──────────────────────

Deno.test('composeEmbedText: curated text differs from raw observed label (F-B-013)', () => {
  // The candidate observation might be "couch" (raw label).
  // The curated canonical row has display_name "Sectional Sofa", a description,
  // levels, and aliases. The composed text must contain the curated content
  // beyond the raw label, so re-embedding produces a different vector.
  const rawLabel = 'couch';
  const curated = composeEmbedText({
    display_name: 'Sectional Sofa',
    description: 'L-shaped multi-seat upholstered sofa with chaise',
    level_0_class: 'object',
    level_1_functional: 'seating',
    level_2_material: 'upholstered',
    level_3_specific: 'sectional',
    level_4_detail: 'L-shape',
    aliases: ['couch', 'sofa', 'chesterfield'],
  });

  assertNotEquals(curated, rawLabel);
  assertStringIncludes(curated, 'Sectional Sofa');
  assertStringIncludes(curated, 'L-shaped multi-seat upholstered sofa with chaise');
  assertStringIncludes(curated, 'object / seating / upholstered / sectional / L-shape');
  assertStringIncludes(curated, 'couch, sofa, chesterfield');
});

// ─── 2. Order + separator stability ─────────────────────────────────────────

Deno.test('composeEmbedText: parts joined by em-dash separator in order', () => {
  const text = composeEmbedText({
    display_name: 'Pendant Light',
    description: 'Hanging ceiling fixture',
    level_0_class: 'object',
    level_1_functional: 'lighting',
    level_2_material: null,
    level_3_specific: null,
    level_4_detail: null,
    aliases: ['pendant'],
  });

  // Expected: "Pendant Light — Hanging ceiling fixture — object / lighting — pendant"
  assertEquals(
    text,
    'Pendant Light — Hanging ceiling fixture — object / lighting — pendant',
  );
});

// ─── 3. Optional fields drop cleanly ────────────────────────────────────────

Deno.test('composeEmbedText: null description / no levels / no aliases → just display_name', () => {
  const text = composeEmbedText({
    display_name: 'Minimal Row',
    description: null,
    level_0_class: null,
    level_1_functional: null,
    level_2_material: null,
    level_3_specific: null,
    level_4_detail: null,
    aliases: null,
  });
  assertEquals(text, 'Minimal Row');
});

Deno.test('composeEmbedText: empty aliases array does not append separator', () => {
  const text = composeEmbedText({
    display_name: 'X',
    description: 'desc',
    level_0_class: 'object',
    level_1_functional: null,
    level_2_material: null,
    level_3_specific: null,
    level_4_detail: null,
    aliases: [],
  });
  // No trailing " — " for empty aliases
  assert(!text.endsWith(' — '));
  assertEquals(text, 'X — desc — object');
});

Deno.test('composeEmbedText: only some levels present → joined with " / "', () => {
  const text = composeEmbedText({
    display_name: 'Y',
    description: null,
    level_0_class: 'object',
    level_1_functional: null,
    level_2_material: 'wood',
    level_3_specific: null,
    level_4_detail: null,
    aliases: null,
  });
  assertEquals(text, 'Y — object / wood');
});

// ─── 4. Determinism ─────────────────────────────────────────────────────────

Deno.test('composeEmbedText: deterministic — same input → identical output', () => {
  const input = {
    display_name: 'Coffee Table',
    description: 'Low table for the living room',
    level_0_class: 'object',
    level_1_functional: 'table',
    level_2_material: 'wood',
    level_3_specific: 'coffee_table',
    level_4_detail: null,
    aliases: ['low table', 'cocktail table'],
  };
  const a = composeEmbedText(input);
  const b = composeEmbedText({ ...input });
  assertEquals(a, b);
});
