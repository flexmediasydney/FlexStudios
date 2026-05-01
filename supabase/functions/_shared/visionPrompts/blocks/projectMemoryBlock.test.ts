/**
 * projectMemoryBlock.test.ts — Wave 11.6.19 unit tests for project_memory
 * cap + cluster + tier-aware truncation.
 *
 * Exercises the pure rendering layer via the `_renderOverridesForTest`
 * test-only export so the suite doesn't need a Supabase client. Tier-cap
 * resolution is exercised via `_resolveCapForTest`.
 *
 * Run: deno test supabase/functions/_shared/visionPrompts/blocks/projectMemoryBlock.test.ts --no-check --allow-all
 */

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  PROJECT_MEMORY_BLOCK_VERSION,
  _renderOverridesForTest,
  _resolveCapForTest,
  type ProjectMemoryTier,
} from './projectMemoryBlock.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface OverrideStub {
  stem: string;
  field: string;
  ai_value: string;
  human_value: string;
  reason?: string | null;
  recency_ts?: number;
}

function row(
  field: string,
  ai_value: string,
  human_value: string,
  stem: string,
  recency_ts: number = 0,
  reason: string | null = null,
): OverrideStub {
  return { stem, field, ai_value, human_value, reason, recency_ts };
}

// ─── Version stamp guard ─────────────────────────────────────────────────────

Deno.test('PROJECT_MEMORY_BLOCK_VERSION is v1.1 (W11.6.19 cap rev)', () => {
  // The version stamp's NAME must remain the same across waves so the
  // shortlisting-shape-d prompt assembly compiles. The VALUE bumps to
  // invalidate prompt cache when block semantics change.
  assertEquals(PROJECT_MEMORY_BLOCK_VERSION, 'v1.1');
});

// ─── 1. Empty project_memory → empty string (no header) ──────────────────────

Deno.test('empty overrides → returns empty string with no header', () => {
  const out = _renderOverridesForTest([], 30);
  assertEquals(out, '');
  // Important: no PROJECT MEMORY header when the list is empty. Prompt
  // assembly relies on this empty-string contract — the join('\n') above
  // collapses cleanly without a stray heading.
  assert(!out.includes('PROJECT MEMORY'));
});

// ─── 2. Single correction → renders verbatim ─────────────────────────────────

Deno.test('single override → renders verbatim, no clustering, no truncation', () => {
  const out = _renderOverridesForTest(
    [row('room_type', 'exterior_front', 'exterior_rear', 'IMG_6195', 1000, 'Hills Hoist visible')],
    30,
  );
  assert(out.includes('PROJECT MEMORY (prior operator corrections on this property):'));
  assert(out.includes('IMG_6195: AI room_type=exterior_front → operator corrected to exterior_rear.'));
  assert(out.includes('Reason: "Hills Hoist visible"'));
  // No PATTERN line for a single occurrence
  assert(!out.includes('PATTERN:'));
  // No truncation footer when count <= cap
  assert(!out.includes('older corrections truncated'));
  // Authoritative-treatment trailer must be present
  assert(out.includes('Treat these prior corrections as authoritative'));
});

// ─── 3. 5 corrections same pattern → ONE clustered line ──────────────────────

Deno.test('5 corrections same (field, ai, human) → one clustered PATTERN line', () => {
  const overrides: OverrideStub[] = [];
  for (let i = 0; i < 5; i++) {
    overrides.push(row('room_type', 'dining_room', 'living_dining_combined', `IMG_${i}`, 1000 + i));
  }
  const out = _renderOverridesForTest(overrides, 30);
  // One clustered line, not 5 individual lines
  const patternMatches = out.match(/PATTERN:/g) ?? [];
  assertEquals(patternMatches.length, 1);
  assert(out.includes('PATTERN: room_type dining_room → living_dining_combined (observed 5 times on this project)'));
  // No individual stem lines for the clustered group
  assert(!out.includes('IMG_0:'));
  assert(!out.includes('IMG_4:'));
  // Below-threshold (4) would NOT cluster — verify boundary
  const fourOverrides = overrides.slice(0, 4);
  const fourOut = _renderOverridesForTest(fourOverrides, 30);
  assert(!fourOut.includes('PATTERN:'));
  assert(fourOut.includes('IMG_0:'));
  assert(fourOut.includes('IMG_3:'));
});

// ─── 4. 50 corrections (mixed patterns + recency) → cap at 30 with clustering ─

Deno.test('50 mixed corrections at standard cap (30) → clusters apply, cap enforced', () => {
  const overrides: OverrideStub[] = [];
  // 8 rows of one cluster (dining_room → living_dining_combined)
  for (let i = 0; i < 8; i++) {
    overrides.push(row('room_type', 'dining_room', 'living_dining_combined', `IMG_DIN_${i}`, 5000 + i));
  }
  // 6 rows of another cluster (exterior_front → exterior_rear)
  for (let i = 0; i < 6; i++) {
    overrides.push(row('room_type', 'exterior_front', 'exterior_rear', `IMG_EXT_${i}`, 4000 + i));
  }
  // 36 unique individual corrections (no clustering)
  for (let i = 0; i < 36; i++) {
    overrides.push(row('vantage_point', `ai_${i}`, `human_${i}`, `IMG_UNIQ_${i}`, 100 + i));
  }
  const out = _renderOverridesForTest(overrides, 30);
  // Two clustered PATTERN lines (the unique ones don't cluster)
  const patternMatches = out.match(/PATTERN:/g) ?? [];
  assertEquals(patternMatches.length, 2);
  // Cap enforced: at most 30 entries total. Count only top-level entry lines
  // (start with "- ", excluding the "  Reason:" continuation lines).
  const entryLines = out.split('\n').filter((l) => l.startsWith('- '));
  assert(entryLines.length <= 30, `expected <=30 entries, got ${entryLines.length}`);
  // Truncation footer fires
  assert(out.includes('older corrections truncated'));
  assert(out.includes('Top patterns above represent recent operator intent'));
});

// ─── 5. Tier-aware caps: premium=50, standard=30, approachable=20 ────────────

Deno.test('tier-aware cap resolution: premium=50, standard=30, approachable=20', () => {
  const baseOpts = {
    project_id: 'p1',
    current_round_id: 'r1',
  };
  assertEquals(_resolveCapForTest({ ...baseOpts, tier: 'premium' as ProjectMemoryTier }), 50);
  assertEquals(_resolveCapForTest({ ...baseOpts, tier: 'standard' as ProjectMemoryTier }), 30);
  assertEquals(_resolveCapForTest({ ...baseOpts, tier: 'approachable' as ProjectMemoryTier }), 20);
  // Default (no tier) → standard
  assertEquals(_resolveCapForTest({ ...baseOpts }), 30);
  // Explicit max_overrides wins over tier
  assertEquals(_resolveCapForTest({ ...baseOpts, tier: 'premium' as ProjectMemoryTier, max_overrides: 7 }), 7);
});

Deno.test('tier-aware truncation: premium renders up to 50, standard 30, approachable 20', () => {
  // Build 60 unique individual corrections (no clustering possible).
  const overrides: OverrideStub[] = [];
  for (let i = 0; i < 60; i++) {
    overrides.push(row('vantage_point', `ai_${i}`, `human_${i}`, `IMG_${i}`, 1000 + i));
  }

  const premiumOut = _renderOverridesForTest(overrides, 50);
  const standardOut = _renderOverridesForTest(overrides, 30);
  const approachableOut = _renderOverridesForTest(overrides, 20);

  const countEntries = (txt: string) => txt.split('\n').filter((l) => l.startsWith('- ')).length;
  assertEquals(countEntries(premiumOut), 50);
  assertEquals(countEntries(standardOut), 30);
  assertEquals(countEntries(approachableOut), 20);

  // All three should fire the truncation footer (60 > each cap)
  assert(premiumOut.includes('older corrections truncated'));
  assert(standardOut.includes('older corrections truncated'));
  assert(approachableOut.includes('older corrections truncated'));

  // Truncation count must reflect each cap's drop
  assert(premiumOut.includes('and 10 older corrections truncated'));
  assert(standardOut.includes('and 30 older corrections truncated'));
  assert(approachableOut.includes('and 40 older corrections truncated'));
});

// ─── 6. Truncation footer appears only when > cap ────────────────────────────

Deno.test('truncation footer fires only when input exceeds cap', () => {
  // Exactly at cap → no footer
  const atCap: OverrideStub[] = [];
  for (let i = 0; i < 30; i++) {
    atCap.push(row('vantage_point', `a_${i}`, `b_${i}`, `IMG_${i}`, 1000 + i));
  }
  const atCapOut = _renderOverridesForTest(atCap, 30);
  assert(!atCapOut.includes('older corrections truncated'));

  // Cap+1 → footer fires with count 1
  atCap.push(row('vantage_point', 'a_30', 'b_30', 'IMG_30', 999));
  const overCapOut = _renderOverridesForTest(atCap, 30);
  assert(overCapOut.includes('and 1 older corrections truncated'));
});

// ─── 7. Recency-DESC ordering within entries (newest first) ──────────────────

Deno.test('order is recency-DESC across cluster entries and individual lines', () => {
  // Newer cluster (5 members, recency 9000+), older individual (recency 100),
  // medium-age cluster (5 members, recency 5000+). Expect newest cluster
  // first, then medium cluster, then individual.
  const overrides: OverrideStub[] = [];
  // newest cluster: 5 of room_type a→b at recency 9000-9004
  for (let i = 0; i < 5; i++) {
    overrides.push(row('room_type', 'newest_ai', 'newest_human', `NEW_${i}`, 9000 + i));
  }
  // medium cluster: 5 of room_type c→d at recency 5000-5004
  for (let i = 0; i < 5; i++) {
    overrides.push(row('room_type', 'mid_ai', 'mid_human', `MID_${i}`, 5000 + i));
  }
  // single individual: recency 100
  overrides.push(row('vantage_point', 'old_ai', 'old_human', 'OLD_1', 100));

  const out = _renderOverridesForTest(overrides, 30);
  const newestIdx = out.indexOf('newest_ai');
  const midIdx = out.indexOf('mid_ai');
  const oldIdx = out.indexOf('OLD_1');

  assert(newestIdx >= 0 && midIdx >= 0 && oldIdx >= 0);
  assert(newestIdx < midIdx, 'newest cluster should appear before mid cluster');
  assert(midIdx < oldIdx, 'mid cluster should appear before old individual');
});

Deno.test('within an unclustered group, individual entries sort newest-first', () => {
  // Unclustered (4 of one tuple, 4 of another), all individual. Newest
  // overall (recency 999) should appear first, oldest (recency 1) last.
  const overrides: OverrideStub[] = [
    row('room_type', 'a', 'b', 'STEM_OLD', 1),
    row('room_type', 'c', 'd', 'STEM_NEW', 999),
    row('room_type', 'a', 'b', 'STEM_MID1', 500),
    row('room_type', 'c', 'd', 'STEM_MID2', 600),
  ];
  const out = _renderOverridesForTest(overrides, 30);
  const newIdx = out.indexOf('STEM_NEW');
  const mid2Idx = out.indexOf('STEM_MID2');
  const mid1Idx = out.indexOf('STEM_MID1');
  const oldIdx = out.indexOf('STEM_OLD');
  assert(newIdx < mid2Idx);
  assert(mid2Idx < mid1Idx);
  assert(mid1Idx < oldIdx);
});

// ─── 8. Performance: 1000-correction project < 100ms ─────────────────────────

Deno.test('performance: 1000 mixed corrections render in under 100ms', () => {
  const overrides: OverrideStub[] = [];
  // 100 of one big cluster
  for (let i = 0; i < 100; i++) {
    overrides.push(row('room_type', 'dining_room', 'living_dining_combined', `IMG_DIN_${i}`, 9000 + i));
  }
  // 100 of another cluster
  for (let i = 0; i < 100; i++) {
    overrides.push(row('vantage_point', 'eye_level', 'low_angle', `IMG_VP_${i}`, 7000 + i));
  }
  // 800 unique individual corrections
  for (let i = 0; i < 800; i++) {
    overrides.push(row('composition_type', `ai_${i}`, `human_${i}`, `IMG_UNIQ_${i}`, 100 + i));
  }

  const label = 'projectMemoryBlock-render-1000';
  console.time(label);
  const out = _renderOverridesForTest(overrides, 50); // premium cap
  console.timeEnd(label);

  // Use performance.now() for an explicit assertion
  const start = performance.now();
  for (let n = 0; n < 5; n++) {
    _renderOverridesForTest(overrides, 50);
  }
  const elapsed = (performance.now() - start) / 5;
  assert(elapsed < 100, `render avg=${elapsed.toFixed(2)}ms exceeds 100ms`);
  // Sanity: actually rendered something
  assert(out.includes('PATTERN:'));
  assert(out.includes('older corrections truncated'));
});

// ─── 9. Header missing on empty AND tier override ────────────────────────────

Deno.test('empty + non-default cap still returns empty string', () => {
  // Reinforce the empty-string contract — the cap shouldn't matter.
  const out = _renderOverridesForTest([], 50);
  assertEquals(out, '');
});

// ─── 10. Reason truncation at 200 chars on individual lines ──────────────────

Deno.test('reason >200 chars truncates with ellipsis', () => {
  const longReason = 'x'.repeat(220);
  const out = _renderOverridesForTest(
    [row('room_type', 'a', 'b', 'IMG_1', 1000, longReason)],
    30,
  );
  // Truncated to 197 + '...'
  assert(out.includes('x'.repeat(197) + '...'));
  // Full 220 must not appear
  assert(!out.includes('x'.repeat(220)));
});
