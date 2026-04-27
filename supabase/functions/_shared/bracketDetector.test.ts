/**
 * Unit tests for bracketDetector pure helpers (Wave 0 burst 0.2).
 * Run: deno test supabase/functions/_shared/bracketDetector.test.ts
 *
 * Covers: 5-shot maximum enforcement (L1), AEB-restart detection,
 * timestamp gap break, settings continuity, AEB-null transition (burst 3 I4),
 * micro-adjustment split flag, validation drift.
 */

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  groupIntoBrackets,
  groupIntoBracketsPartitioned,
  validateBracketCounts,
  type ExifSignals,
} from './bracketDetector.ts';

// ─── Test fixture builders ───────────────────────────────────────────────────
//
// We use explicit field passing to avoid `??` swallowing null (the I4 test
// needs aebBracketValue=null to round-trip through makeFile).

interface FileOverrides {
  fileName?: string;
  captureTimestampMs?: number;
  aebBracketValue?: number | null;  // null is meaningful — see I4 test
  aperture?: number;
  iso?: number;
  focalLength?: number;
  cameraModel?: string;
  /** Wave 10.1: body serial for the partitioned variant tests. */
  bodySerial?: string | null;
}

function makeFile(o: FileOverrides = {}): ExifSignals {
  return {
    fileName: o.fileName ?? 'IMG_default',
    cameraModel: o.cameraModel ?? 'Canon EOS R5',
    shutterSpeed: '1/100',
    shutterSpeedValue: 0.01,
    aperture: o.aperture ?? 10,
    iso: o.iso ?? 250,
    focalLength: o.focalLength ?? 16,
    // Use 'in' to differentiate "not provided" from "explicitly null"
    aebBracketValue: 'aebBracketValue' in o ? (o.aebBracketValue ?? null) : 0,
    dateTimeOriginal: '2026:04:25 12:00:00',
    subSecTimeOriginal: '00',
    captureTimestampMs: o.captureTimestampMs ?? 0,
    orientation: '1',
    motionBlurRisk: false,
    highIsoRisk: false,
    bodySerial: 'bodySerial' in o ? (o.bodySerial ?? null) : null,
  };
}

const AEB = [-2.667, -1.333, 0, 1.333, 2.667];

/**
 * Make a 5-bracket sequence at baseTimeMs with 250ms intra-spacing.
 * Each file's aebBracketValue follows the standard 5-bracket Canon AEB sequence.
 */
function makeBracket(
  baseTimeMs: number,
  prefix: string,
  fieldOverrides: FileOverrides = {},
  count = 5,
): ExifSignals[] {
  return Array.from({ length: count }, (_, i) =>
    makeFile({
      ...fieldOverrides,
      fileName: `${prefix}_${i}`,
      captureTimestampMs: baseTimeMs + i * 250,
      aebBracketValue: AEB[i % AEB.length],
    }),
  );
}

// ─── 1. Empty input ──────────────────────────────────────────────────────────

Deno.test('groupIntoBrackets: empty input → empty result', () => {
  assertEquals(groupIntoBrackets([]), []);
});

// ─── 2. Single complete bracket ──────────────────────────────────────────────

Deno.test('groupIntoBrackets: 5 files with consistent settings → 1 group of 5', () => {
  const files = makeBracket(1_000, 'A');
  const groups = groupIntoBrackets(files);
  assertEquals(groups.length, 1);
  assertEquals(groups[0].files.length, 5);
  assertEquals(groups[0].isComplete, true);
  assertEquals(groups[0].isMicroAdjustmentSplit, false);
  assertEquals(groups[0].cameraModel, 'Canon EOS R5');
  assertEquals(groups[0].primaryTimestampMs, 1_000);
});

// ─── 3. Timestamp gap > 4s breaks groups ─────────────────────────────────────

Deno.test('groupIntoBrackets: timestamp gap > 4000ms creates new group', () => {
  // groupA at t=1000..2000; groupB at t=10000..11000 → 8s gap
  const groupA = makeBracket(1_000, 'A');
  const groupB = makeBracket(10_000, 'B');
  const groups = groupIntoBrackets([...groupA, ...groupB]);
  assertEquals(groups.length, 2);
  assertEquals(groups[0].files.length, 5);
  assertEquals(groups[1].files.length, 5);
});

// ─── 4. 5-shot maximum enforcement (Bug L1, micro-adjustment re-shoot) ──────

Deno.test('groupIntoBrackets: 10 files within 4s gap split into 2 × 5 (micro-adjustment)', () => {
  // 10 files at 250ms gaps with AEB cycling -2.667 ... +2.667 ... -2.667 ...
  // The aebSequenceRestart check OR the 5-shot enforcement should split.
  const files: ExifSignals[] = Array.from({ length: 10 }, (_, i) =>
    makeFile({
      fileName: `IMG_${i}`,
      captureTimestampMs: 1_000 + i * 250,
      aebBracketValue: AEB[i % 5],
    }),
  );
  const groups = groupIntoBrackets(files);
  assertEquals(groups.length, 2, 'should split 10 into 2 groups');
  assertEquals(groups[0].files.length, 5);
  assertEquals(groups[1].files.length, 5);
});

// ─── 5. Settings change forces new group (timestamps NON-overlapping) ───────

Deno.test('groupIntoBrackets: aperture change > 0.05 forces new group', () => {
  // Place groups in non-overlapping time windows so settings drives the break
  const groupA = makeBracket(1_000, 'A', { aperture: 8 });
  const groupB = makeBracket(3_000, 'B', { aperture: 11 }); // 1s gap from end of A — under 4s threshold
  const groups = groupIntoBrackets([...groupA, ...groupB]);
  assertEquals(groups.length, 2);
  assertEquals(groups[0].files.length, 5);
  assertEquals(groups[1].files.length, 5);
});

Deno.test('groupIntoBrackets: focal-length change > 0.5 forces new group', () => {
  const groupA = makeBracket(1_000, 'A', { focalLength: 16 });
  const groupB = makeBracket(3_000, 'B', { focalLength: 24 });
  const groups = groupIntoBrackets([...groupA, ...groupB]);
  assertEquals(groups.length, 2);
});

Deno.test('groupIntoBrackets: ISO change forces new group', () => {
  const groupA = makeBracket(1_000, 'A', { iso: 250 });
  const groupB = makeBracket(3_000, 'B', { iso: 800 });
  const groups = groupIntoBrackets([...groupA, ...groupB]);
  assertEquals(groups.length, 2);
});

Deno.test('groupIntoBrackets: camera model change forces new group', () => {
  const groupA = makeBracket(1_000, 'A', { cameraModel: 'Canon EOS R5' });
  const groupB = makeBracket(3_000, 'B', { cameraModel: 'Canon EOS R6' });
  const groups = groupIntoBrackets([...groupA, ...groupB]);
  assertEquals(groups.length, 2);
});

// ─── 6. AEB-null transition (burst 3 I4) ─────────────────────────────────────

Deno.test('groupIntoBrackets: AEB null→non-null transition forces new group', () => {
  // First file: aebBracketValue=null (manual exposure test shot)
  // Then 5 files with AEB sequence — same settings, tight timing
  // Burst 3 I4: must NOT merge into one heterogeneous group of 6
  const testShot = makeFile({
    fileName: 'IMG_test',
    captureTimestampMs: 1_000,
    aebBracketValue: null,
  });
  const aebGroup = makeBracket(1_300, 'AEB');
  const groups = groupIntoBrackets([testShot, ...aebGroup]);
  assertEquals(groups.length, 2, 'AEB-null transition must split groups');
  assertEquals(groups[0].files.length, 1, 'lone test shot is its own group');
  assertEquals(groups[1].files.length, 5, 'AEB run is intact');
});

// ─── 7. AEB sequence restart ─────────────────────────────────────────────────

Deno.test('groupIntoBrackets: AEB sequence restart (back-to-back identical bursts)', () => {
  // Two consecutive 5-bracket bursts within 250ms gaps, AEB resets each time
  const files: ExifSignals[] = Array.from({ length: 10 }, (_, i) =>
    makeFile({
      fileName: `IMG_${i}`,
      captureTimestampMs: 1_000 + i * 250,
      aebBracketValue: AEB[i % 5],
    }),
  );
  const groups = groupIntoBrackets(files);
  assertEquals(groups.length, 2);
  assertEquals(groups[0].files[0].aebBracketValue, -2.667);
  assertEquals(groups[1].files[0].aebBracketValue, -2.667);
});

// ─── 8. Validation: drift within tolerance ──────────────────────────────────

Deno.test('validateBracketCounts: 60 files / 12 complete groups → ok', () => {
  const groups = Array.from({ length: 12 }, (_, gi) => ({
    files: makeBracket(gi * 5_000, `G${gi}`),
    isComplete: true,
    isMicroAdjustmentSplit: false,
    cameraModel: 'Canon EOS R5',
    primaryTimestampMs: gi * 5_000,
  }));
  const r = validateBracketCounts(groups, 60);
  assertEquals(r.expected, 12);
  assertEquals(r.actual, 12);
  assertEquals(r.drift, 0);
  assertEquals(r.ok, true);
  assertEquals(r.warnings.length, 0);
});

Deno.test('validateBracketCounts: drift > tolerance → warning', () => {
  const groups = Array.from({ length: 20 }, (_, gi) => ({
    files: [makeFile({ fileName: `f${gi}`, captureTimestampMs: gi * 5_000 })],
    isComplete: false,
    isMicroAdjustmentSplit: false,
    cameraModel: 'Canon EOS R5',
    primaryTimestampMs: gi * 5_000,
  }));
  // 60 files / 5 = 12 expected, got 20 → drift +8 > tolerance ±2
  const r = validateBracketCounts(groups, 60);
  assertEquals(r.ok, false);
  assert(r.warnings.length >= 1);
  assert(r.warnings[0].includes('Bracket count anomaly'));
});

Deno.test('validateBracketCounts: incomplete groups soft-warn but do not fail', () => {
  const groups = [
    {
      files: makeBracket(1_000, 'A'),
      isComplete: true,
      isMicroAdjustmentSplit: false,
      cameraModel: 'Canon EOS R5',
      primaryTimestampMs: 1_000,
    },
    {
      files: [makeFile({ fileName: 'lone', captureTimestampMs: 10_000 })],
      isComplete: false,
      isMicroAdjustmentSplit: false,
      cameraModel: 'Canon EOS R5',
      primaryTimestampMs: 10_000,
    },
  ];
  const r = validateBracketCounts(groups, 6);
  // 6/5 = 1.2 expected; got 2 → drift +0.8 within tolerance, but 1 incomplete → warn
  assertEquals(r.ok, false);
  assertEquals(r.drift, 0.8);
  assert(r.warnings.some((w) => w.includes('incomplete')));
});

// ─── 9. Multi-bracket sort ordering ──────────────────────────────────────────

Deno.test('groupIntoBrackets: out-of-order input gets sorted by timestamp', () => {
  // Insert files in REVERSE order — bracketDetector must sort internally
  const files: ExifSignals[] = Array.from({ length: 5 }, (_, i) =>
    makeFile({
      fileName: `IMG_${4 - i}`,
      captureTimestampMs: 1_000 + (4 - i) * 250,
      aebBracketValue: AEB[4 - i],
    }),
  );
  const groups = groupIntoBrackets(files);
  assertEquals(groups.length, 1);
  // Files inside the group must be sorted by timestamp ASC
  const tss = groups[0].files.map((f) => f.captureTimestampMs);
  for (let i = 1; i < tss.length; i++) {
    assert(tss[i] >= tss[i - 1], 'files within group must be timestamp-ordered');
  }
});

// ─── 10. Mixed AEB+non-AEB shoot — primary then bursts ──────────────────────

Deno.test('groupIntoBrackets: lone non-AEB shot followed by AEB burst → 2 groups', () => {
  // Real-world scenario: photographer fires 1 manual test, then switches to
  // AEB mode and fires a 5-bracket burst. They must NOT merge into a
  // 6-shot group with mixed AEB/non-AEB. Burst 3 I4 enforces this.
  const lone = makeFile({
    fileName: 'IMG_test',
    captureTimestampMs: 1_000,
    aebBracketValue: null,
    aperture: 10,
  });
  const burst = makeBracket(1_500, 'AEB', { aperture: 10 });
  const groups = groupIntoBrackets([lone, ...burst]);
  assertEquals(groups.length, 2);
  assertEquals(groups[0].files.length, 1);
  assertEquals(groups[1].files.length, 5);
});

// ─── W10.1: groupIntoBracketsPartitioned ─────────────────────────────────────

Deno.test('groupIntoBracketsPartitioned: empty input → empty array', () => {
  assertEquals(groupIntoBracketsPartitioned([]), []);
});

Deno.test('groupIntoBracketsPartitioned: single-camera shoot → 1 bracket, isSecondaryCamera=false', () => {
  // Exact same input as the legacy single-bracket test, but going through
  // the partitioned path. The single Canon body becomes the primary
  // partition; the bracket detector runs as before.
  const files = makeBracket(1_000, 'A', { bodySerial: '01234567890' });
  const groups = groupIntoBracketsPartitioned(files);
  assertEquals(groups.length, 1);
  assertEquals(groups[0].files.length, 5);
  assertEquals(groups[0].isComplete, true);
  assertEquals(groups[0].isSecondaryCamera, false);
  assertEquals(groups[0].cameraSource, 'canon-eos-r5:01234567890');
});

Deno.test('groupIntoBracketsPartitioned: R5 primary + R6 secondary → R5 brackets + R6 singletons', () => {
  // 10 R5 files = 2 complete brackets (primary). 3 R6 files = 3 singletons.
  // Expected output: 2 primary BracketGroups (file_count=5 each) + 3
  // secondary BracketGroups (file_count=1 each) = 5 groups total.
  const r5 = makeBracket(1_000, 'R5_a', { bodySerial: 'AAA' }).concat(
    makeBracket(10_000, 'R5_b', { bodySerial: 'AAA' }),
  );
  const r6 = [
    makeFile({ fileName: 'R6_0', captureTimestampMs: 5_000, cameraModel: 'Canon EOS R6', bodySerial: 'BBB', aebBracketValue: null }),
    makeFile({ fileName: 'R6_1', captureTimestampMs: 7_000, cameraModel: 'Canon EOS R6', bodySerial: 'BBB', aebBracketValue: null }),
    makeFile({ fileName: 'R6_2', captureTimestampMs: 9_000, cameraModel: 'Canon EOS R6', bodySerial: 'BBB', aebBracketValue: null }),
  ];
  const groups = groupIntoBracketsPartitioned([...r5, ...r6]);

  // Primary brackets: 2 groups of 5 each
  const primary = groups.filter((g) => g.isSecondaryCamera === false);
  assertEquals(primary.length, 2, 'two R5 brackets on the primary partition');
  for (const g of primary) {
    assertEquals(g.files.length, 5);
    assertEquals(g.isComplete, true);
    assertEquals(g.cameraSource, 'canon-eos-r5:aaa');
  }

  // Secondary singletons: 3 groups of 1 each
  const secondary = groups.filter((g) => g.isSecondaryCamera === true);
  assertEquals(secondary.length, 3, 'three R6 singletons on the secondary partition');
  for (const g of secondary) {
    assertEquals(g.files.length, 1);
    assertEquals(g.isComplete, false, 'singletons are NOT complete brackets');
    assertEquals(g.isMicroAdjustmentSplit, false);
    assertEquals(g.cameraSource, 'canon-eos-r6:bbb');
  }

  // Sort order: primary before secondary
  for (let i = 1; i < groups.length; i++) {
    if (groups[i - 1].isSecondaryCamera === true) {
      assertEquals(
        groups[i].isSecondaryCamera,
        true,
        'once we hit secondary, no more primary follows',
      );
    }
  }
});

Deno.test('groupIntoBracketsPartitioned: iPhone files emit as singletons even when outnumbering Canon', () => {
  // 5 Canon R5 + 12 iPhone shots. Canon STILL primary — iPhone never beats
  // Canon. iPhone shots emit as 12 singletons (not bracket-merged on
  // timestamp).
  const r5 = makeBracket(1_000, 'R5', { bodySerial: 'CCC' });
  const phone = Array.from({ length: 12 }, (_, i) =>
    makeFile({
      fileName: `IMG_phone_${i}`,
      captureTimestampMs: 2_000 + i * 100,
      cameraModel: 'iPhone 14 Pro',
      bodySerial: null,
      aebBracketValue: null,
    }),
  );
  const groups = groupIntoBracketsPartitioned([...r5, ...phone]);

  const primary = groups.filter((g) => g.isSecondaryCamera === false);
  const secondary = groups.filter((g) => g.isSecondaryCamera === true);

  assertEquals(primary.length, 1, 'one R5 bracket as the primary');
  assertEquals(primary[0].files.length, 5);
  assertEquals(primary[0].cameraSource, 'canon-eos-r5:ccc');

  assertEquals(secondary.length, 12, '12 iPhone singletons (NOT bracket-merged)');
  for (const g of secondary) {
    assertEquals(g.files.length, 1);
    assertEquals(g.cameraSource, 'iphone-14-pro:unknown');
  }
});

Deno.test('groupIntoBracketsPartitioned: missing bodySerial collapses model files to one source', () => {
  // Two R5 sequences with NULL serial — both treated as one camera source
  // (defensive per R4 in the spec — exiftool fluke shouldn't break).
  const a = makeBracket(1_000, 'A', { bodySerial: null });
  const b = makeBracket(10_000, 'B', { bodySerial: null });
  const groups = groupIntoBracketsPartitioned([...a, ...b]);
  // One source ("canon-eos-r5:unknown"), so it's primary; bracket detector
  // produces 2 complete brackets from 10 files (timestamps separated by
  // GAP_MS).
  assertEquals(groups.length, 2);
  for (const g of groups) {
    assertEquals(g.isSecondaryCamera, false);
    assertEquals(g.cameraSource, 'canon-eos-r5:unknown');
    assertEquals(g.files.length, 5);
  }
});
