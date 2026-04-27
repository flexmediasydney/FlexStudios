/**
 * Unit tests for pass2Validator (Wave 0 burst 0.3).
 * Run: deno test supabase/functions/_shared/pass2Validator.test.ts
 *
 * Covers: mutual exclusivity (L12 + burst 7 M3/M4), package ceiling (L16),
 * mandatory slot detection, alternative-vs-winner deduplication, hallucinated
 * stem filtering, defensive type coercion, coverage_notes warning.
 */

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { validatePass2Output, type Pass2Output, type Pass2ValidatorConfig } from './pass2Validator.ts';

// ─── Fixture builder ─────────────────────────────────────────────────────────

const UNIVERSE = ['IMG_001', 'IMG_002', 'IMG_003', 'IMG_004', 'IMG_005', 'IMG_006', 'IMG_007', 'IMG_008'];

function defaultConfig(o: Partial<Pass2ValidatorConfig> = {}): Pass2ValidatorConfig {
  return {
    packageCeiling: 24,
    mandatorySlotIds: ['exterior_front_hero', 'kitchen_hero', 'master_bedroom_hero', 'open_plan_hero'],
    allFileStems: UNIVERSE,
    ...o,
  };
}

function emptyOutput(o: Partial<Pass2Output> = {}): Pass2Output {
  return {
    shortlist: [],
    slot_assignments: {},
    slot_alternatives: {},
    phase3_recommendations: [],
    unfilled_slots: [],
    rejected_near_duplicates: [],
    coverage_notes: 'A non-trivial coverage notes paragraph that is at least twenty characters long.',
    ...o,
  };
}

// ─── 1. Empty + happy path ───────────────────────────────────────────────────

Deno.test('validatePass2Output: empty universe + empty output → valid (no mandatory check fails)', () => {
  const r = validatePass2Output(emptyOutput(), defaultConfig({ mandatorySlotIds: [] }));
  assertEquals(r.valid, true);
  assertEquals(r.errors.length, 0);
});

Deno.test('validatePass2Output: clean output with all mandatory slots filled → valid', () => {
  const r = validatePass2Output(
    emptyOutput({
      shortlist: ['IMG_001', 'IMG_002', 'IMG_003', 'IMG_004'],
      slot_assignments: {
        exterior_front_hero: 'IMG_001',
        kitchen_hero: 'IMG_002',
        master_bedroom_hero: 'IMG_003',
        open_plan_hero: 'IMG_004',
      },
    }),
    defaultConfig(),
  );
  assertEquals(r.valid, true);
  assertEquals(r.errors.length, 0);
  // Mandatory slots filled → no warning about that
  assert(!r.warnings.some((w) => w.includes('mandatory_slots_unfilled')));
});

// ─── 2. Mutual exclusivity (L12 + burst 7 M3/M4) ─────────────────────────────

Deno.test('mutual_exclusivity: stem in shortlist AND rejected_near_duplicates → removed from rejected', () => {
  const r = validatePass2Output(
    emptyOutput({
      shortlist: ['IMG_001', 'IMG_002'],
      rejected_near_duplicates: ['IMG_002', 'IMG_003'],
    }),
    defaultConfig({ mandatorySlotIds: [] }),
  );
  assertEquals(r.fixed.rejected_near_duplicates, ['IMG_003']);
  assert(r.warnings.some((w) => w.includes('mutual_exclusivity_fix')));
});

Deno.test('mutual_exclusivity (M3): slot winner AND rejected → removed from rejected', () => {
  const r = validatePass2Output(
    emptyOutput({
      slot_assignments: { kitchen_hero: 'IMG_001' },
      rejected_near_duplicates: ['IMG_001'],
    }),
    defaultConfig({ mandatorySlotIds: [] }),
  );
  assertEquals(r.fixed.rejected_near_duplicates, []);
  assert(r.warnings.some((w) => w.includes('mutual_exclusivity_fix')));
});

Deno.test('mutual_exclusivity (M4): phase3 file AND rejected → removed from rejected', () => {
  const r = validatePass2Output(
    emptyOutput({
      phase3_recommendations: [{ file: 'IMG_001', rank: 1, justification: 'great' }],
      rejected_near_duplicates: ['IMG_001'],
    }),
    defaultConfig({ mandatorySlotIds: [] }),
  );
  assertEquals(r.fixed.rejected_near_duplicates, []);
});

Deno.test('mutual_exclusivity: alternatives ARE allowed in rejected_near_duplicates (intentional)', () => {
  // Alternatives ARE often near-duplicates of the winner — that's why they're alternatives.
  // The validator does NOT remove them.
  const r = validatePass2Output(
    emptyOutput({
      slot_assignments: { kitchen_hero: 'IMG_001' },
      slot_alternatives: { kitchen_hero: ['IMG_002', 'IMG_003'] },
      rejected_near_duplicates: ['IMG_002', 'IMG_003'],
    }),
    defaultConfig({ mandatorySlotIds: [] }),
  );
  assertEquals(r.fixed.rejected_near_duplicates.sort(), ['IMG_002', 'IMG_003']);
});

// ─── 3. Package ceiling (L16) ────────────────────────────────────────────────

Deno.test('package_ceiling: shortlist within ceiling → valid', () => {
  const longList = UNIVERSE.slice(0, 5); // 5 < 24 ceiling
  const r = validatePass2Output(emptyOutput({ shortlist: longList }), defaultConfig({ mandatorySlotIds: [] }));
  assertEquals(r.valid, true);
});

Deno.test('package_ceiling: shortlist exceeds ceiling → valid=false, error recorded', () => {
  const overflow = UNIVERSE.slice(0, 8); // 8 stems
  const r = validatePass2Output(
    emptyOutput({ shortlist: overflow }),
    defaultConfig({ packageCeiling: 5, mandatorySlotIds: [] }), // ceiling = 5 < 8
  );
  assertEquals(r.valid, false);
  assert(r.errors.some((e) => e.includes('package_ceiling_exceeded')));
});

// ─── 4. Mandatory slot detection ─────────────────────────────────────────────

Deno.test('mandatory_slots: missing mandatory slot → appended to unfilled_slots + warning', () => {
  const r = validatePass2Output(
    emptyOutput({
      slot_assignments: {
        exterior_front_hero: 'IMG_001',
        kitchen_hero: 'IMG_002',
        // master_bedroom_hero and open_plan_hero MISSING from mandatory list
      },
    }),
    defaultConfig(),
  );
  assert(r.fixed.unfilled_slots.includes('master_bedroom_hero'));
  assert(r.fixed.unfilled_slots.includes('open_plan_hero'));
  assert(r.warnings.some((w) => w.includes('mandatory_slots_unfilled')));
  // Still valid — auto-fixable warning, not error
  assertEquals(r.valid, true);
});

// ─── 5. Alternative dedup (winner appears in alts) ───────────────────────────

Deno.test('alternative_dedup: alt list contains winner → winner removed from alts', () => {
  const r = validatePass2Output(
    emptyOutput({
      slot_assignments: { kitchen_hero: 'IMG_001' },
      slot_alternatives: { kitchen_hero: ['IMG_001', 'IMG_002', 'IMG_003'] },
    }),
    defaultConfig({ mandatorySlotIds: [] }),
  );
  assertEquals(r.fixed.slot_alternatives.kitchen_hero, ['IMG_002', 'IMG_003']);
  assert(r.warnings.some((w) => w.includes('contained the winner stem')));
});

Deno.test('alternative_dedup: alt list ONLY contained winner → key deleted', () => {
  const r = validatePass2Output(
    emptyOutput({
      slot_assignments: { kitchen_hero: 'IMG_001' },
      slot_alternatives: { kitchen_hero: ['IMG_001'] },
    }),
    defaultConfig({ mandatorySlotIds: [] }),
  );
  assertEquals(r.fixed.slot_alternatives.kitchen_hero, undefined);
});

// ─── 6. Hallucinated stems ───────────────────────────────────────────────────

Deno.test('hallucinated_stems: shortlist contains stem not in universe → dropped + warning', () => {
  const r = validatePass2Output(
    emptyOutput({
      shortlist: ['IMG_001', 'IMG_999_FAKE'],
    }),
    defaultConfig({ mandatorySlotIds: [] }),
  );
  assertEquals(r.fixed.shortlist, ['IMG_001']);
  assert(r.warnings.some((w) => w.includes('hallucinated')));
});

Deno.test('hallucinated_stems: slot_assignments stem not in universe → key dropped', () => {
  const r = validatePass2Output(
    emptyOutput({
      slot_assignments: { kitchen_hero: 'IMG_FAKE' },
    }),
    defaultConfig({ mandatorySlotIds: [] }),
  );
  assertEquals(r.fixed.slot_assignments.kitchen_hero, undefined);
});

Deno.test('hallucinated_stems: phase3 stem not in universe → recommendation dropped', () => {
  const r = validatePass2Output(
    emptyOutput({
      phase3_recommendations: [
        { file: 'IMG_001', rank: 1, justification: 'real' },
        { file: 'IMG_FAKE', rank: 2, justification: 'fake' },
      ],
    }),
    defaultConfig({ mandatorySlotIds: [] }),
  );
  assertEquals(r.fixed.phase3_recommendations.length, 1);
  assertEquals(r.fixed.phase3_recommendations[0].file, 'IMG_001');
});

// ─── 7. Defensive coercion ───────────────────────────────────────────────────

Deno.test('coercion: null/undefined fields don\'t crash, default to empty', () => {
  // Deliberately construct a "bad" output with mistyped fields
  // deno-lint-ignore no-explicit-any
  const malformed: any = {
    shortlist: null,
    slot_assignments: null,
    slot_alternatives: undefined,
    phase3_recommendations: 'not_an_array',
    unfilled_slots: 42,
    rejected_near_duplicates: { not: 'an array' },
    coverage_notes: null,
  };
  const r = validatePass2Output(malformed, defaultConfig({ mandatorySlotIds: [] }));
  assertEquals(r.fixed.shortlist, []);
  assertEquals(r.fixed.slot_assignments, {});
  assertEquals(r.fixed.slot_alternatives, {});
  assertEquals(r.fixed.phase3_recommendations, []);
  assertEquals(r.fixed.unfilled_slots, []);
  assertEquals(r.fixed.rejected_near_duplicates, []);
  // Coverage notes warning fires for empty
  assert(r.warnings.some((w) => w.includes('coverage_notes')));
});

Deno.test('coercion: slot_assignments single-element array → unwrapped to string', () => {
  const r = validatePass2Output(
    emptyOutput({
      // deno-lint-ignore no-explicit-any
      slot_assignments: { kitchen_hero: ['IMG_001'] as any },
    }),
    defaultConfig({ mandatorySlotIds: [] }),
  );
  assertEquals(r.fixed.slot_assignments.kitchen_hero, 'IMG_001');
});

Deno.test('coercion: slot_assignments multi-element array preserved (multi-image slots)', () => {
  const r = validatePass2Output(
    emptyOutput({
      slot_assignments: { ensuite_hero: ['IMG_001', 'IMG_002'] },
    }),
    defaultConfig({ mandatorySlotIds: [] }),
  );
  assertEquals(r.fixed.slot_assignments.ensuite_hero, ['IMG_001', 'IMG_002']);
});

Deno.test('coercion: dedup preserves order', () => {
  const r = validatePass2Output(
    emptyOutput({
      shortlist: ['IMG_001', 'IMG_002', 'IMG_001', 'IMG_003'],
    }),
    defaultConfig({ mandatorySlotIds: [] }),
  );
  assertEquals(r.fixed.shortlist, ['IMG_001', 'IMG_002', 'IMG_003']);
});

// ─── 8. Coverage notes ───────────────────────────────────────────────────────

Deno.test('coverage_notes: under 20 chars → warning but still valid', () => {
  const r = validatePass2Output(
    emptyOutput({ coverage_notes: 'too short' }),
    defaultConfig({ mandatorySlotIds: [] }),
  );
  assertEquals(r.valid, true);
  assert(r.warnings.some((w) => w.includes('coverage_notes')));
});

Deno.test('coverage_notes: empty string → warning', () => {
  const r = validatePass2Output(
    emptyOutput({ coverage_notes: '' }),
    defaultConfig({ mandatorySlotIds: [] }),
  );
  assert(r.warnings.some((w) => w.includes('coverage_notes')));
});

// ─── 9. Combined / realistic scenario ────────────────────────────────────────

Deno.test('combined: realistic Pass 2 output with multiple defects auto-corrects cleanly', () => {
  const r = validatePass2Output(
    emptyOutput({
      shortlist: ['IMG_001', 'IMG_002', 'IMG_001', 'IMG_FAKE', 'IMG_003'], // dup + fake
      slot_assignments: {
        kitchen_hero: 'IMG_004',
        // exterior_front_hero, master_bedroom_hero, open_plan_hero MISSING
      },
      slot_alternatives: {
        kitchen_hero: ['IMG_004', 'IMG_005'], // contains the winner
      },
      phase3_recommendations: [
        { file: 'IMG_006', rank: 1, justification: 'good' },
      ],
      rejected_near_duplicates: ['IMG_002', 'IMG_007'], // IMG_002 also in shortlist
    }),
    defaultConfig(),
  );
  // shortlist deduped + cleaned
  assertEquals(r.fixed.shortlist, ['IMG_001', 'IMG_002', 'IMG_003']);
  // Mutual exclusivity removed IMG_002 from rejected
  assertEquals(r.fixed.rejected_near_duplicates, ['IMG_007']);
  // Winner removed from alternatives
  assertEquals(r.fixed.slot_alternatives.kitchen_hero, ['IMG_005']);
  // Mandatory unfilled
  assert(r.fixed.unfilled_slots.includes('exterior_front_hero'));
  // Still valid (no errors, just warnings)
  assertEquals(r.valid, true);
  assert(r.warnings.length >= 3); // hallucinated + mutual_exclusivity + alt_winner + mandatory
});
