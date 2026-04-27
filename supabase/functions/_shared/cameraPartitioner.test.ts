/**
 * Unit tests for cameraPartitioner — Wave 10.1 P2-6 (W10.1).
 *
 * Run:
 *   deno test supabase/functions/_shared/cameraPartitioner.test.ts \
 *     --no-check --allow-all
 */

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  partitionByCamera,
  canonicalCameraSource,
  type ExifMinimal,
} from './cameraPartitioner.ts';

// ─── Builders ────────────────────────────────────────────────────────────────

function file(
  stem: string,
  cameraModel: string | null,
  bodySerial: string | null,
): ExifMinimal {
  return { stem, cameraModel, bodySerial };
}

function repeat(
  prefix: string,
  count: number,
  cameraModel: string | null,
  bodySerial: string | null,
): ExifMinimal[] {
  return Array.from({ length: count }, (_, i) => file(`${prefix}_${i}`, cameraModel, bodySerial));
}

// ─── canonicalCameraSource ───────────────────────────────────────────────────

Deno.test('canonicalCameraSource: typical Canon R5 with serial', () => {
  assertEquals(canonicalCameraSource('Canon EOS R5', '01234567890'), 'canon-eos-r5:01234567890');
});

Deno.test('canonicalCameraSource: missing serial falls back to "unknown"', () => {
  assertEquals(canonicalCameraSource('Canon EOS R5', null), 'canon-eos-r5:unknown');
  assertEquals(canonicalCameraSource('Canon EOS R5', ''), 'canon-eos-r5:unknown');
  assertEquals(canonicalCameraSource('Canon EOS R5', '   '), 'canon-eos-r5:unknown');
});

Deno.test('canonicalCameraSource: missing model falls back to "unknown"', () => {
  assertEquals(canonicalCameraSource(null, '01234567890'), 'unknown:01234567890');
  assertEquals(canonicalCameraSource('', '01234567890'), 'unknown:01234567890');
});

Deno.test('canonicalCameraSource: both missing → "unknown:unknown"', () => {
  assertEquals(canonicalCameraSource(null, null), 'unknown:unknown');
});

Deno.test('canonicalCameraSource: punctuation slugs to "-"', () => {
  // iPhone HEIC may emit "iPhone 14 Pro" with embedded spaces; serials are
  // sometimes hyphenated or contain whitespace. All collapse to dashes.
  assertEquals(canonicalCameraSource('iPhone 14 Pro', 'AB-12_34'), 'iphone-14-pro:ab-12-34');
});

// ─── partitionByCamera ───────────────────────────────────────────────────────

Deno.test('partitionByCamera: empty input → empty array', () => {
  assertEquals(partitionByCamera([]), []);
});

Deno.test('partitionByCamera: single-camera shoot → 1 partition, isPrimary=true', () => {
  const files = repeat('R5', 5, 'Canon EOS R5', '01234567890');
  const partitions = partitionByCamera(files);
  assertEquals(partitions.length, 1);
  assertEquals(partitions[0].cameraSource, 'canon-eos-r5:01234567890');
  assertEquals(partitions[0].isPrimary, true);
  assertEquals(partitions[0].files.length, 5);
});

Deno.test('partitionByCamera: two Canon bodies, 100 vs 30 files → R5 primary, R6 secondary', () => {
  const r5 = repeat('R5', 100, 'Canon EOS R5', '01234567890');
  const r6 = repeat('R6', 30, 'Canon EOS R6', '09876543210');
  const partitions = partitionByCamera([...r5, ...r6]);
  assertEquals(partitions.length, 2);

  const primary = partitions.find((p) => p.isPrimary);
  const secondary = partitions.find((p) => !p.isPrimary);
  assert(primary, 'primary partition must exist');
  assert(secondary, 'secondary partition must exist');

  assertEquals(primary.cameraSource, 'canon-eos-r5:01234567890');
  assertEquals(primary.files.length, 100);
  assertEquals(secondary.cameraSource, 'canon-eos-r6:09876543210');
  assertEquals(secondary.files.length, 30);
});

Deno.test('partitionByCamera: iPhone + Canon → Canon primary regardless of count', () => {
  // 5 Canon R5 + 50 iPhone shots — Canon STILL wins because iPhones never
  // beat Canon for primary, regardless of count.
  const r5 = repeat('R5', 5, 'Canon EOS R5', '01234567890');
  const phone = repeat('IMG', 50, 'iPhone 14 Pro', null);
  const partitions = partitionByCamera([...r5, ...phone]);
  assertEquals(partitions.length, 2);

  const primary = partitions.find((p) => p.isPrimary);
  const secondary = partitions.find((p) => !p.isPrimary);
  assert(primary, 'primary partition must exist');
  assert(secondary, 'secondary partition must exist');

  assertEquals(primary.cameraSource, 'canon-eos-r5:01234567890');
  assertEquals(primary.files.length, 5);
  assertEquals(secondary.cameraSource, 'iphone-14-pro:unknown');
  assertEquals(secondary.files.length, 50);
});

Deno.test('partitionByCamera: files with NULL bodySerial fall back to model-only slug', () => {
  // Two iPhones with no readable serial → both bucket together as
  // "iphone-14-pro:unknown". Three iPhones from one device + two from
  // another all end up in the same partition, which is the desired
  // "treated as the iPhone(s)" behaviour.
  const phoneA = repeat('A', 3, 'iPhone 14 Pro', null);
  const phoneB = repeat('B', 2, 'iPhone 14 Pro', null);
  const r5 = repeat('R5', 1, 'Canon EOS R5', '11111');
  const partitions = partitionByCamera([...r5, ...phoneA, ...phoneB]);
  assertEquals(partitions.length, 2, 'two distinct sources: Canon R5 + the iPhones');

  const phonePart = partitions.find((p) => p.cameraSource === 'iphone-14-pro:unknown');
  assert(phonePart, 'iPhone partition exists');
  assertEquals(phonePart.files.length, 5);
  assertEquals(phonePart.isPrimary, false);
});

Deno.test('partitionByCamera: tie at file count → Canon model wins over Sony', () => {
  // 10 Canon + 10 Sony — Canon wins the tie even though counts are equal.
  const canon = repeat('R5', 10, 'Canon EOS R5', '01234567890');
  const sony = repeat('S7', 10, 'Sony A7R V', 'SSSSSS');
  const partitions = partitionByCamera([...canon, ...sony]);
  assertEquals(partitions.length, 2);

  const primary = partitions.find((p) => p.isPrimary);
  assert(primary);
  assertEquals(primary.cameraSource, 'canon-eos-r5:01234567890');
});

Deno.test('partitionByCamera: tie at file count, both Canon → lexically smaller serial wins', () => {
  // Two R5 bodies with different serials, equal file counts. Lexical sort
  // on the canonical slug picks "canon-eos-r5:00000000" over
  // "canon-eos-r5:99999999" — deterministic.
  const r5a = repeat('A', 10, 'Canon EOS R5', '00000000');
  const r5b = repeat('B', 10, 'Canon EOS R5', '99999999');
  const partitions = partitionByCamera([...r5a, ...r5b]);
  assertEquals(partitions.length, 2);

  const primary = partitions.find((p) => p.isPrimary);
  assert(primary);
  assertEquals(primary.cameraSource, 'canon-eos-r5:00000000');
});

Deno.test('partitionByCamera: same model, same NULL serial → all collapse to one partition', () => {
  // Reverse of the iPhone case: TWO Canon bodies with no serial both bucket
  // as "canon-eos-r5:unknown". Looks like one source. This is acceptable
  // per R4 in the design spec (defensive — exiftool flukes don't break the
  // pipeline).
  const a = repeat('A', 5, 'Canon EOS R5', null);
  const b = repeat('B', 5, 'Canon EOS R5', null);
  const partitions = partitionByCamera([...a, ...b]);
  assertEquals(partitions.length, 1, 'unknown serial collapses to one bucket');
  assertEquals(partitions[0].cameraSource, 'canon-eos-r5:unknown');
  assertEquals(partitions[0].files.length, 10);
  assertEquals(partitions[0].isPrimary, true);
});

Deno.test('partitionByCamera: input order preserved within partition', () => {
  // The bracket detector relies on stem ordering downstream; make sure we
  // don't shuffle inside a partition.
  const files: ExifMinimal[] = [
    file('IMG_001', 'Canon EOS R5', '11111'),
    file('IMG_002', 'Canon EOS R5', '11111'),
    file('IMG_003', 'Canon EOS R5', '11111'),
  ];
  const partitions = partitionByCamera(files);
  assertEquals(partitions[0].files.map((f) => f.stem), ['IMG_001', 'IMG_002', 'IMG_003']);
});

Deno.test('partitionByCamera: only iPhone files → iPhone partition is primary by default', () => {
  // Edge case: phone-only shoot (rare but legal). With no Canon to demote
  // it, the iPhone bucket itself becomes primary so the bracket detector
  // still has SOMETHING to operate on.
  const phone = repeat('IMG', 8, 'iPhone 14 Pro', null);
  const partitions = partitionByCamera(phone);
  assertEquals(partitions.length, 1);
  assertEquals(partitions[0].isPrimary, true);
  assertEquals(partitions[0].cameraSource, 'iphone-14-pro:unknown');
});
