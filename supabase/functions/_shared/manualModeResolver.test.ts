/**
 * Unit tests for manualModeResolver pure helpers.
 * Run: deno test --no-check --allow-all supabase/functions/_shared/manualModeResolver.test.ts
 *
 * Wave 7 P1-19 (W7.13): the manual-mode trigger logic + manual-lock approved-
 * stem resolver are pure functions so the lock + ingest paths don't need
 * mocked DB / Dropbox to verify. Spec Section 4b enumerates the two triggers
 * and Section 4c specifies the resolver's match semantics.
 */

import {
  assert,
  assertEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  resolveManualLockMoves,
  resolveManualModeReason,
  type ManualLockSourceFile,
} from './manualModeResolver.ts';

// ─── Trigger #1 + #2: resolveManualModeReason ────────────────────────────────

Deno.test('resolveManualModeReason: shortlistingSupported=false → project_type_unsupported', () => {
  const reason = resolveManualModeReason({
    shortlistingSupported: false,
    expectedCountTarget: 24,
  });
  assertEquals(reason, 'project_type_unsupported');
});

Deno.test('resolveManualModeReason: shortlistingSupported=true + target=0 → no_photo_products', () => {
  const reason = resolveManualModeReason({
    shortlistingSupported: true,
    expectedCountTarget: 0,
  });
  assertEquals(reason, 'no_photo_products');
});

Deno.test('resolveManualModeReason: shortlistingSupported=true + target>0 → null (engine path)', () => {
  const reason = resolveManualModeReason({
    shortlistingSupported: true,
    expectedCountTarget: 24,
  });
  assertEquals(reason, null);
});

Deno.test('resolveManualModeReason: trigger #1 takes precedence over #2 (unsupported wins even with target=0)', () => {
  const reason = resolveManualModeReason({
    shortlistingSupported: false,
    expectedCountTarget: 0,
  });
  // Per spec § "Architecture / Detection": project_type_unsupported is the
  // structural reason and surfaces the right operator action.
  assertEquals(reason, 'project_type_unsupported');
});

Deno.test('resolveManualModeReason: target=1 (smallest non-zero) → null (engine path)', () => {
  const reason = resolveManualModeReason({
    shortlistingSupported: true,
    expectedCountTarget: 1,
  });
  assertEquals(reason, null);
});

// ─── resolveManualLockMoves: matching ────────────────────────────────────────

const SOURCE_FOLDER = '/Acme/Photos/Raws/Shortlist Proposed';
const APPROVED_DEST = '/Acme/Photos/Raws/Final Shortlist';

function file(name: string, folder = SOURCE_FOLDER): ManualLockSourceFile {
  return { name, path: `${folder}/${name}` };
}

Deno.test('resolveManualLockMoves: empty stems + empty files → empty result', () => {
  const out = resolveManualLockMoves([], [], APPROVED_DEST);
  assertEquals(out.entries, []);
  assertEquals(out.unmatchedStems, []);
});

Deno.test('resolveManualLockMoves: stem matches stripped basename', () => {
  const out = resolveManualLockMoves(['IMG_1'], [file('IMG_1.jpg')], APPROVED_DEST);
  assertEquals(out.entries.length, 1);
  assertEquals(out.entries[0].from_path, '/Acme/Photos/Raws/Shortlist Proposed/IMG_1.jpg');
  assertEquals(out.entries[0].to_path, '/Acme/Photos/Raws/Final Shortlist/IMG_1.jpg');
  assertEquals(out.entries[0].stem, 'IMG_1');
  assertEquals(out.entries[0].already_at_destination, false);
  assertEquals(out.unmatchedStems, []);
});

Deno.test('resolveManualLockMoves: full filename (with extension) matches against name', () => {
  const out = resolveManualLockMoves(['IMG_1.jpg'], [file('IMG_1.jpg')], APPROVED_DEST);
  assertEquals(out.entries.length, 1);
  assertEquals(out.entries[0].from_path, '/Acme/Photos/Raws/Shortlist Proposed/IMG_1.jpg');
  assertEquals(out.unmatchedStems, []);
});

Deno.test('resolveManualLockMoves: case-insensitive matching (Dropbox semantics)', () => {
  const out = resolveManualLockMoves(['img_1', 'IMG_2'], [file('IMG_1.jpg'), file('img_2.JPG')], APPROVED_DEST);
  assertEquals(out.entries.length, 2);
  assertEquals(out.unmatchedStems, []);
});

Deno.test('resolveManualLockMoves: unmatched stem surfaces in unmatchedStems', () => {
  const out = resolveManualLockMoves(['IMG_1', 'IMG_NOPE'], [file('IMG_1.jpg')], APPROVED_DEST);
  assertEquals(out.entries.length, 1);
  assertEquals(out.entries[0].stem, 'IMG_1');
  assertEquals(out.unmatchedStems, ['IMG_NOPE']);
});

Deno.test('resolveManualLockMoves: duplicate stems collapsed to one entry (operator double-click safety)', () => {
  const out = resolveManualLockMoves(['IMG_1', 'IMG_1', 'img_1'], [file('IMG_1.jpg')], APPROVED_DEST);
  assertEquals(out.entries.length, 1);
  assertEquals(out.entries[0].stem, 'IMG_1');
});

Deno.test('resolveManualLockMoves: blank/whitespace stems skipped', () => {
  const out = resolveManualLockMoves(['IMG_1', '', '   ', 'IMG_2'], [file('IMG_1.jpg'), file('IMG_2.jpg')], APPROVED_DEST);
  assertEquals(out.entries.length, 2);
  assertEquals(out.unmatchedStems, []);
});

// ─── resolveManualLockMoves: idempotency ─────────────────────────────────────

Deno.test('resolveManualLockMoves: file already at destination flagged idempotent', () => {
  const alreadyMoved = file('IMG_1.jpg', APPROVED_DEST); // file's path is already in dest
  const out = resolveManualLockMoves(['IMG_1'], [alreadyMoved], APPROVED_DEST);
  assertEquals(out.entries.length, 1);
  assertEquals(out.entries[0].already_at_destination, true);
});

Deno.test('resolveManualLockMoves: case-insensitive idempotent check (Dropbox)', () => {
  const lowercaseDest = '/acme/photos/raws/final shortlist';
  const file1 = { name: 'IMG_1.jpg', path: `${lowercaseDest}/IMG_1.jpg` };
  const out = resolveManualLockMoves(['IMG_1'], [file1], APPROVED_DEST);
  assertEquals(out.entries.length, 1);
  assertEquals(out.entries[0].already_at_destination, true);
});

// ─── resolveManualLockMoves: determinism ─────────────────────────────────────

Deno.test('resolveManualLockMoves: entries sorted by stem deterministically', () => {
  // Insert in non-sorted order; expect lexicographic output.
  const out = resolveManualLockMoves(
    ['IMG_Z', 'IMG_A', 'IMG_M'],
    [file('IMG_A.jpg'), file('IMG_M.jpg'), file('IMG_Z.jpg')],
    APPROVED_DEST,
  );
  assertEquals(out.entries.map((e) => e.stem), ['IMG_A', 'IMG_M', 'IMG_Z']);
});

Deno.test('resolveManualLockMoves: trailing slash on destination normalised', () => {
  const out = resolveManualLockMoves(['IMG_1'], [file('IMG_1.jpg')], APPROVED_DEST + '///');
  assertEquals(out.entries[0].to_path, '/Acme/Photos/Raws/Final Shortlist/IMG_1.jpg');
});

// ─── resolveManualLockMoves: filename extensions ─────────────────────────────

Deno.test('resolveManualLockMoves: stem matches file with various RAW extensions', () => {
  const cr3 = file('IMG_1.CR3');
  const nef = file('IMG_2.NEF');
  const arw = file('IMG_3.ARW');
  const out = resolveManualLockMoves(['IMG_1', 'IMG_2', 'IMG_3'], [cr3, nef, arw], APPROVED_DEST);
  assertEquals(out.entries.length, 3);
  // Each entry preserves the source file's actual extension.
  const byStem = Object.fromEntries(out.entries.map((e) => [e.stem, e.from_path]));
  assertEquals(byStem['IMG_1'], '/Acme/Photos/Raws/Shortlist Proposed/IMG_1.CR3');
  assertEquals(byStem['IMG_2'], '/Acme/Photos/Raws/Shortlist Proposed/IMG_2.NEF');
  assertEquals(byStem['IMG_3'], '/Acme/Photos/Raws/Shortlist Proposed/IMG_3.ARW');
});

Deno.test('resolveManualLockMoves: extensionless source file matched as own stem', () => {
  // Edge: a file with no extension is its own stem.
  const noExt = { name: 'README', path: `${SOURCE_FOLDER}/README` };
  const out = resolveManualLockMoves(['README'], [noExt], APPROVED_DEST);
  assertEquals(out.entries.length, 1);
  assertEquals(out.entries[0].from_path, `${SOURCE_FOLDER}/README`);
});

Deno.test('resolveManualLockMoves: dot-prefix file (.DS_Store) — leading dot does NOT count as extension', () => {
  // stripExtension's lastIndexOf('.') > 0 guard preserves dotfiles.
  const dotFile = { name: '.DS_Store', path: `${SOURCE_FOLDER}/.DS_Store` };
  const out = resolveManualLockMoves(['.DS_Store'], [dotFile], APPROVED_DEST);
  assertEquals(out.entries.length, 1);
  assert(!out.unmatchedStems.includes('.DS_Store'));
});

// ─── resolveManualLockMoves: realistic operator scenario ─────────────────────

Deno.test('resolveManualLockMoves: realistic operator flow — 5 source files, operator approves 3', () => {
  const files = [
    file('IMG_1.jpg'),
    file('IMG_2.jpg'),
    file('IMG_3.jpg'),
    file('IMG_4.jpg'),
    file('IMG_5.jpg'),
  ];
  const approved = ['IMG_1', 'IMG_3', 'IMG_5'];
  const out = resolveManualLockMoves(approved, files, APPROVED_DEST);
  assertEquals(out.entries.length, 3);
  assertEquals(out.entries.map((e) => e.stem), ['IMG_1', 'IMG_3', 'IMG_5']);
  // Files 2 + 4 are not in entries — they stay in source folder as undecided
  // (mirrors engine-mode "leave alone" semantics).
  for (const e of out.entries) {
    assertEquals(e.from_path.startsWith(SOURCE_FOLDER), true);
    assertEquals(e.to_path.startsWith(APPROVED_DEST), true);
    assertEquals(e.already_at_destination, false);
  }
});

Deno.test('resolveManualLockMoves: partial idempotency — 1 of 3 already moved on retry', () => {
  // Simulates a lock that crashed mid-batch: one file already moved, two
  // still in source. Re-running with the same approved-set must converge.
  const movedFile = file('IMG_1.jpg', APPROVED_DEST);
  const stillInSource = [file('IMG_2.jpg'), file('IMG_3.jpg')];
  const out = resolveManualLockMoves(['IMG_1', 'IMG_2', 'IMG_3'], [movedFile, ...stillInSource], APPROVED_DEST);
  assertEquals(out.entries.length, 3);
  const byStem = Object.fromEntries(out.entries.map((e) => [e.stem, e.already_at_destination]));
  assertEquals(byStem['IMG_1'], true);
  assertEquals(byStem['IMG_2'], false);
  assertEquals(byStem['IMG_3'], false);
});
