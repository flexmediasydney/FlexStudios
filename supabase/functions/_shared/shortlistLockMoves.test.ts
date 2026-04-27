/**
 * Unit tests for shortlistLockMoves pure helpers.
 * Run: deno test --no-check --allow-env supabase/functions/_shared/shortlistLockMoves.test.ts
 *
 * Wave 7 P0-1: covers buildMoveSpecs deterministic ordering, idempotent
 * already-at-destination flagging, stem→fileName resolution via exif metadata,
 * and the approved/rejected set computation under each override action.
 */

import {
  assert,
  assertEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  buildMoveSpecs,
  computeApprovedRejectedSets,
  resolveFullFilename,
  type CompositionGroupForLock,
  type SlotEventForLock,
  type OverrideForLock,
  type ClassificationForLock,
} from './shortlistLockMoves.ts';

// ── resolveFullFilename ───────────────────────────────────────────────────

Deno.test('resolveFullFilename: stem with extension passes through', () => {
  assertEquals(resolveFullFilename('IMG_5620.CR3', null), 'IMG_5620.CR3');
  assertEquals(resolveFullFilename('IMG_5620.JPG', { IMG_5620: { fileName: 'IMG_5620.CR3' } }), 'IMG_5620.JPG');
});

Deno.test('resolveFullFilename: bare stem looks up exif metadata fileName', () => {
  const exif = { IMG_5620: { fileName: 'IMG_5620.CR3' }, IMG_5621: { fileName: 'IMG_5621.NEF' } };
  assertEquals(resolveFullFilename('IMG_5620', exif), 'IMG_5620.CR3');
  assertEquals(resolveFullFilename('IMG_5621', exif), 'IMG_5621.NEF');
});

Deno.test('resolveFullFilename: missing exif falls back to .CR3 default', () => {
  assertEquals(resolveFullFilename('IMG_9999', null), 'IMG_9999.CR3');
  assertEquals(resolveFullFilename('IMG_9999', {}), 'IMG_9999.CR3');
  assertEquals(resolveFullFilename('IMG_9999', { OTHER: { fileName: 'OTHER.CR3' } }), 'IMG_9999.CR3');
});

// ── buildMoveSpecs ────────────────────────────────────────────────────────

const SOURCE = '/Acme/Photos/Raws/Shortlist Proposed';
const APPROVED = '/Acme/Photos/Raws/Final Shortlist';
const REJECTED = '/Acme/Photos/Raws/Rejected';

function makeGroup(
  id: string,
  files: string[],
  exif: Record<string, { fileName: string }> | null = null,
): CompositionGroupForLock {
  return { id, files_in_group: files, exif_metadata: exif };
}

Deno.test('buildMoveSpecs: empty groups → empty list', () => {
  const out = buildMoveSpecs([], new Set(), new Set(), SOURCE, APPROVED, REJECTED);
  assertEquals(out, []);
});

Deno.test('buildMoveSpecs: undecided groups (neither approved nor rejected) skipped', () => {
  const groups = [makeGroup('g1', ['IMG_1'], { IMG_1: { fileName: 'IMG_1.CR3' } })];
  const out = buildMoveSpecs(groups, new Set(), new Set(), SOURCE, APPROVED, REJECTED);
  assertEquals(out, []);
});

Deno.test('buildMoveSpecs: approved group emits approved bucket move', () => {
  const groups = [makeGroup('g1', ['IMG_1'], { IMG_1: { fileName: 'IMG_1.CR3' } })];
  const out = buildMoveSpecs(groups, new Set(['g1']), new Set(), SOURCE, APPROVED, REJECTED);
  assertEquals(out.length, 1);
  assertEquals(out[0], {
    group_id: 'g1',
    stem: 'IMG_1',
    from_path: '/Acme/Photos/Raws/Shortlist Proposed/IMG_1.CR3',
    to_path: '/Acme/Photos/Raws/Final Shortlist/IMG_1.CR3',
    bucket: 'approved',
    already_at_destination: false,
  });
});

Deno.test('buildMoveSpecs: rejected group emits rejected bucket move', () => {
  const groups = [makeGroup('g1', ['IMG_1'], { IMG_1: { fileName: 'IMG_1.CR3' } })];
  const out = buildMoveSpecs(groups, new Set(), new Set(['g1']), SOURCE, APPROVED, REJECTED);
  assertEquals(out.length, 1);
  assertEquals(out[0].bucket, 'rejected');
  assertEquals(out[0].to_path, '/Acme/Photos/Raws/Rejected/IMG_1.CR3');
});

Deno.test('buildMoveSpecs: bracket of 5 files in approved emits 5 specs', () => {
  const exif = {
    IMG_1: { fileName: 'IMG_1.CR3' },
    IMG_2: { fileName: 'IMG_2.CR3' },
    IMG_3: { fileName: 'IMG_3.CR3' },
    IMG_4: { fileName: 'IMG_4.CR3' },
    IMG_5: { fileName: 'IMG_5.CR3' },
  };
  const groups = [makeGroup('g1', ['IMG_1', 'IMG_2', 'IMG_3', 'IMG_4', 'IMG_5'], exif)];
  const out = buildMoveSpecs(groups, new Set(['g1']), new Set(), SOURCE, APPROVED, REJECTED);
  assertEquals(out.length, 5);
  // Stems preserved in order
  assertEquals(out.map((s) => s.stem), ['IMG_1', 'IMG_2', 'IMG_3', 'IMG_4', 'IMG_5']);
  // All in approved bucket
  for (const s of out) assertEquals(s.bucket, 'approved');
});

Deno.test('buildMoveSpecs: groups sorted by id deterministically', () => {
  const exif = { IMG_A: { fileName: 'IMG_A.CR3' }, IMG_B: { fileName: 'IMG_B.CR3' } };
  // Insert in non-sorted order
  const groups = [
    makeGroup('zzz-uuid', ['IMG_A'], exif),
    makeGroup('aaa-uuid', ['IMG_B'], exif),
  ];
  const out = buildMoveSpecs(groups, new Set(['zzz-uuid', 'aaa-uuid']), new Set(), SOURCE, APPROVED, REJECTED);
  // aaa < zzz so IMG_B comes first
  assertEquals(out.map((s) => s.stem), ['IMG_B', 'IMG_A']);
});

Deno.test('buildMoveSpecs: source already at destination flagged idempotent', () => {
  // Stem already in /Final Shortlist/ via a full-path entry.
  const fullPath = '/Acme/Photos/Raws/Final Shortlist/IMG_1.CR3';
  const groups = [makeGroup('g1', [fullPath], null)];
  const out = buildMoveSpecs(groups, new Set(['g1']), new Set(), SOURCE, APPROVED, REJECTED);
  assertEquals(out.length, 1);
  assertEquals(out[0].already_at_destination, true);
  // Caller is expected to omit these from the batch — but we still emit the
  // spec so the caller can count them as 'skipped' for telemetry.
});

Deno.test('buildMoveSpecs: case-insensitive idempotent check (Dropbox is case-insensitive)', () => {
  const fullPath = '/acme/photos/raws/final shortlist/img_1.cr3'; // lowercased
  const groups = [makeGroup('g1', [fullPath], null)];
  const out = buildMoveSpecs(groups, new Set(['g1']), new Set(), SOURCE, APPROVED, REJECTED);
  assertEquals(out.length, 1);
  assertEquals(out[0].already_at_destination, true);
});

Deno.test('buildMoveSpecs: stem without exif falls back to .CR3', () => {
  const groups = [makeGroup('g1', ['IMG_NEW'], null)];
  const out = buildMoveSpecs(groups, new Set(['g1']), new Set(), SOURCE, APPROVED, REJECTED);
  assertEquals(out[0].from_path, '/Acme/Photos/Raws/Shortlist Proposed/IMG_NEW.CR3');
  assertEquals(out[0].to_path, '/Acme/Photos/Raws/Final Shortlist/IMG_NEW.CR3');
});

Deno.test('buildMoveSpecs: trailing-slash variants on dest folders normalised', () => {
  const exif = { IMG_1: { fileName: 'IMG_1.CR3' } };
  const groups = [makeGroup('g1', ['IMG_1'], exif)];
  const out = buildMoveSpecs(
    groups,
    new Set(['g1']),
    new Set(),
    SOURCE + '///', // extra slashes should be stripped
    APPROVED + '/',
    REJECTED,
  );
  assertEquals(out[0].from_path, '/Acme/Photos/Raws/Shortlist Proposed/IMG_1.CR3');
  assertEquals(out[0].to_path, '/Acme/Photos/Raws/Final Shortlist/IMG_1.CR3');
});

Deno.test('buildMoveSpecs: empty files_in_group skipped (no specs emitted)', () => {
  const groups = [
    makeGroup('g1', [], null),
    makeGroup('g2', ['IMG_2'], { IMG_2: { fileName: 'IMG_2.CR3' } }),
  ];
  const out = buildMoveSpecs(groups, new Set(['g1', 'g2']), new Set(), SOURCE, APPROVED, REJECTED);
  assertEquals(out.length, 1);
  assertEquals(out[0].group_id, 'g2');
});

// ── computeApprovedRejectedSets ───────────────────────────────────────────

function ev(group_id: string, event_type: string, payload?: SlotEventForLock['payload']): SlotEventForLock {
  return { group_id, event_type, payload: payload ?? null };
}

Deno.test('computeApprovedRejectedSets: pass2 rank=1 + phase3 → approved seeded', () => {
  const events: SlotEventForLock[] = [
    ev('g1', 'pass2_slot_assigned', { rank: 1, slot_id: 'kitchen_hero' }),
    ev('g2', 'pass2_phase3_recommendation', { slot_id: 'ai_recommended' }),
    ev('g3', 'pass2_slot_assigned', { rank: 2, slot_id: 'kitchen_hero' }), // rank=2 is alt — NOT approved
  ];
  const { approvedSet, rejectedSet } = computeApprovedRejectedSets(events, [], []);
  assert(approvedSet.has('g1'));
  assert(approvedSet.has('g2'));
  assert(!approvedSet.has('g3'));
  assertEquals(rejectedSet.size, 0);
});

Deno.test('computeApprovedRejectedSets: human_action=removed pulls from approved into rejected', () => {
  const events: SlotEventForLock[] = [ev('g1', 'pass2_slot_assigned', { rank: 1 })];
  const overrides: OverrideForLock[] = [
    { ai_proposed_group_id: 'g1', human_selected_group_id: null, human_action: 'removed' },
  ];
  const { approvedSet, rejectedSet } = computeApprovedRejectedSets(events, overrides, []);
  assert(!approvedSet.has('g1'));
  assert(rejectedSet.has('g1'));
});

Deno.test('computeApprovedRejectedSets: added_from_rejects promotes a previously-not-proposed group', () => {
  const events: SlotEventForLock[] = [];
  const overrides: OverrideForLock[] = [
    { ai_proposed_group_id: null, human_selected_group_id: 'g1', human_action: 'added_from_rejects' },
  ];
  const { approvedSet, rejectedSet } = computeApprovedRejectedSets(events, overrides, []);
  assert(approvedSet.has('g1'));
  assert(!rejectedSet.has('g1'));
});

Deno.test('computeApprovedRejectedSets: swapped removes ai_proposed and adds human_selected', () => {
  const events: SlotEventForLock[] = [ev('g1', 'pass2_slot_assigned', { rank: 1 })];
  const overrides: OverrideForLock[] = [
    { ai_proposed_group_id: 'g1', human_selected_group_id: 'g2', human_action: 'swapped' },
  ];
  const { approvedSet, rejectedSet } = computeApprovedRejectedSets(events, overrides, []);
  assert(!approvedSet.has('g1'));
  assert(approvedSet.has('g2'));
  assert(rejectedSet.has('g1')); // ai_proposed becomes a soft reject
});

Deno.test('computeApprovedRejectedSets: near_duplicate classification populates rejected', () => {
  const events: SlotEventForLock[] = [ev('g1', 'pass2_slot_assigned', { rank: 1 })];
  const classifications: ClassificationForLock[] = [
    { group_id: 'g1', is_near_duplicate_candidate: true }, // approved wins
    { group_id: 'g2', is_near_duplicate_candidate: true }, // → rejected
    { group_id: 'g3', is_near_duplicate_candidate: false },
  ];
  const { approvedSet, rejectedSet } = computeApprovedRejectedSets(events, [], classifications);
  assert(approvedSet.has('g1'));
  assert(!rejectedSet.has('g1')); // approval wins on conflict
  assert(rejectedSet.has('g2'));
  assert(!rejectedSet.has('g3'));
});

Deno.test('computeApprovedRejectedSets: approved_as_proposed re-affirms ai_proposed (idempotent on already-approved)', () => {
  const events: SlotEventForLock[] = [ev('g1', 'pass2_slot_assigned', { rank: 1 })];
  const overrides: OverrideForLock[] = [
    { ai_proposed_group_id: 'g1', human_selected_group_id: null, human_action: 'approved_as_proposed' },
  ];
  const { approvedSet, rejectedSet } = computeApprovedRejectedSets(events, overrides, []);
  assert(approvedSet.has('g1'));
  assert(!rejectedSet.has('g1'));
});

Deno.test('computeApprovedRejectedSets: removed-then-re-added returns to approved (override sequence)', () => {
  const events: SlotEventForLock[] = [ev('g1', 'pass2_slot_assigned', { rank: 1 })];
  const overrides: OverrideForLock[] = [
    { ai_proposed_group_id: 'g1', human_selected_group_id: null, human_action: 'removed' },
    { ai_proposed_group_id: null, human_selected_group_id: 'g1', human_action: 'added_from_rejects' },
  ];
  const { approvedSet, rejectedSet } = computeApprovedRejectedSets(events, overrides, []);
  assert(approvedSet.has('g1'));
  assert(!rejectedSet.has('g1'));
});
