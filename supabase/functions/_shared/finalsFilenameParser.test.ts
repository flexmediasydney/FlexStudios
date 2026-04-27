/**
 * Unit tests for finalsFilenameParser (Wave 0 burst 0.5).
 * Run: deno test supabase/functions/_shared/finalsFilenameParser.test.ts
 *
 * Covers burst 2 H1 (Nikon DSC_/_DSC support) + audit defect #21 (variant
 * suffix handling beyond just numeric chains).
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { parseFinalFilename, aggregateVariantCounts } from './finalsFilenameParser.ts';

// ─── Camera naming conventions (Burst 2 H1) ──────────────────────────────────

Deno.test('parseFinalFilename: Canon EOS (IMG_NNNN)', () => {
  const r = parseFinalFilename('IMG_5620.jpg');
  assertEquals(r, { stem: 'IMG_5620', suffix: '', variantIndex: 1 });
});

Deno.test('parseFinalFilename: Nikon DSC_NNNN', () => {
  const r = parseFinalFilename('DSC_1234.jpg');
  assertEquals(r, { stem: 'DSC_1234', suffix: '', variantIndex: 1 });
});

Deno.test('parseFinalFilename: Nikon alt _DSCNNNN (leading underscore)', () => {
  const r = parseFinalFilename('_DSC1234.jpg');
  assertEquals(r, { stem: '_DSC1234', suffix: '', variantIndex: 1 });
});

Deno.test('parseFinalFilename: Sony DSCNNNNN (no separator)', () => {
  const r = parseFinalFilename('DSC04567.jpg');
  assertEquals(r, { stem: 'DSC04567', suffix: '', variantIndex: 1 });
});

Deno.test('parseFinalFilename: Fujifilm DSCFNNNN', () => {
  const r = parseFinalFilename('DSCF0987.jpg');
  assertEquals(r, { stem: 'DSCF0987', suffix: '', variantIndex: 1 });
});

Deno.test('parseFinalFilename: generic letters+digits (KELVNNNN)', () => {
  const r = parseFinalFilename('KELV4091.jpg');
  assertEquals(r, { stem: 'KELV4091', suffix: '', variantIndex: 1 });
});

// ─── Numeric chain variants ──────────────────────────────────────────────────

Deno.test('parseFinalFilename: -2 numeric → variantIndex=2', () => {
  const r = parseFinalFilename('IMG_5620-2.jpg');
  assertEquals(r?.stem, 'IMG_5620');
  assertEquals(r?.suffix, '-2');
  assertEquals(r?.variantIndex, 2);
});

Deno.test('parseFinalFilename: -2-2 numeric chain → variantIndex=3', () => {
  const r = parseFinalFilename('IMG_5620-2-2.jpg');
  assertEquals(r?.stem, 'IMG_5620');
  assertEquals(r?.variantIndex, 3);
});

Deno.test('parseFinalFilename: -2-2-2 numeric chain → variantIndex=4', () => {
  const r = parseFinalFilename('IMG_5620-2-2-2.jpg');
  assertEquals(r?.variantIndex, 4);
});

// ─── Non-numeric variant tags (audit defect #21) ─────────────────────────────

Deno.test('parseFinalFilename: _HDR underscore tag → variantIndex=2', () => {
  const r = parseFinalFilename('IMG_5620_HDR.jpg');
  assertEquals(r?.stem, 'IMG_5620');
  assertEquals(r?.suffix, '_HDR');
  assertEquals(r?.variantIndex, 2);
});

Deno.test('parseFinalFilename: -vs letter tag → variantIndex=2', () => {
  const r = parseFinalFilename('IMG_5620-vs.jpg');
  assertEquals(r?.variantIndex, 2);
});

Deno.test('parseFinalFilename: -Edit named edit → variantIndex=2', () => {
  const r = parseFinalFilename('IMG_5620-Edit.jpg');
  assertEquals(r?.variantIndex, 2);
});

Deno.test('parseFinalFilename: " (copy)" Finder paren-tag → variantIndex=2', () => {
  const r = parseFinalFilename('IMG_5620 (copy).jpg');
  assertEquals(r?.variantIndex, 2);
});

Deno.test('parseFinalFilename: " (1)" Finder numbered duplicate → variantIndex=2', () => {
  const r = parseFinalFilename('IMG_5620 (1).jpg');
  assertEquals(r?.variantIndex, 2);
});

// ─── Extensions ──────────────────────────────────────────────────────────────

Deno.test('parseFinalFilename: .jpeg accepted', () => {
  const r = parseFinalFilename('IMG_5620.jpeg');
  assertEquals(r?.stem, 'IMG_5620');
});

Deno.test('parseFinalFilename: .png accepted', () => {
  const r = parseFinalFilename('IMG_5620.png');
  assertEquals(r?.stem, 'IMG_5620');
});

Deno.test('parseFinalFilename: .webp accepted', () => {
  const r = parseFinalFilename('IMG_5620.webp');
  assertEquals(r?.stem, 'IMG_5620');
});

Deno.test('parseFinalFilename: .JPG uppercase accepted (case-insensitive)', () => {
  const r = parseFinalFilename('IMG_5620.JPG');
  assertEquals(r?.stem, 'IMG_5620');
});

Deno.test('parseFinalFilename: unsupported extension → null', () => {
  assertEquals(parseFinalFilename('IMG_5620.cr3'), null);
  assertEquals(parseFinalFilename('IMG_5620.tiff'), null);
  assertEquals(parseFinalFilename('IMG_5620.psd'), null);
  assertEquals(parseFinalFilename('IMG_5620.heic'), null);
});

// ─── Non-camera filenames (defensive) ────────────────────────────────────────

Deno.test('parseFinalFilename: non-camera filenames → null', () => {
  assertEquals(parseFinalFilename('agent_headshot.jpg'), null);
  assertEquals(parseFinalFilename('logo.png'), null);
  assertEquals(parseFinalFilename('floorplan_preview.jpg'), null);
});

Deno.test('parseFinalFilename: empty/null/undefined → null', () => {
  assertEquals(parseFinalFilename(''), null);
  // deno-lint-ignore no-explicit-any
  assertEquals(parseFinalFilename(null as any), null);
  // deno-lint-ignore no-explicit-any
  assertEquals(parseFinalFilename(undefined as any), null);
});

// ─── aggregateVariantCounts ──────────────────────────────────────────────────

Deno.test('aggregateVariantCounts: one stem with single delivery → variantCount=1', () => {
  const m = aggregateVariantCounts(['IMG_5620.jpg']);
  assertEquals(m.get('IMG_5620'), 1);
});

Deno.test('aggregateVariantCounts: one stem with chained variants → max wins', () => {
  // Editor delivers IMG_5620, IMG_5620-2, IMG_5620-2-2 — the variant_count
  // for this stem is 3 (max index across the batch).
  const m = aggregateVariantCounts([
    'IMG_5620.jpg',
    'IMG_5620-2.jpg',
    'IMG_5620-2-2.jpg',
  ]);
  assertEquals(m.get('IMG_5620'), 3);
});

Deno.test('aggregateVariantCounts: multiple stems aggregated independently', () => {
  const m = aggregateVariantCounts([
    'IMG_5620.jpg',
    'IMG_5620-2.jpg',
    'IMG_5630.jpg',
    'IMG_5640.jpg',
    'IMG_5640_HDR.jpg',
  ]);
  assertEquals(m.get('IMG_5620'), 2);
  assertEquals(m.get('IMG_5630'), 1);
  assertEquals(m.get('IMG_5640'), 2);
  assertEquals(m.size, 3);
});

Deno.test('aggregateVariantCounts: skips non-camera filenames', () => {
  const m = aggregateVariantCounts([
    'IMG_5620.jpg',
    'agent_headshot.jpg',
    'logo.png',
    'JobOffer.pdf',
  ]);
  assertEquals(m.get('IMG_5620'), 1);
  assertEquals(m.size, 1);
});

Deno.test('aggregateVariantCounts: empty input → empty map', () => {
  const m = aggregateVariantCounts([]);
  assertEquals(m.size, 0);
});

Deno.test('aggregateVariantCounts: arrival order does not affect max', () => {
  // Whether the highest-index variant arrives first, last, or in the middle,
  // the aggregate should be the same.
  const variants = ['IMG_1.jpg', 'IMG_1-2-2.jpg', 'IMG_1-2.jpg'];
  for (const order of [variants, [...variants].reverse(), [variants[1], variants[0], variants[2]]]) {
    const m = aggregateVariantCounts(order);
    assertEquals(m.get('IMG_1'), 3);
  }
});

// ─── Mixed real-world camera batch ───────────────────────────────────────────

Deno.test('aggregateVariantCounts: mixed Canon + Nikon + Sony batch', () => {
  const m = aggregateVariantCounts([
    'IMG_5620.jpg',         // Canon
    'IMG_5620-2.jpg',
    'DSC_1234.jpg',         // Nikon DSC_
    'DSC_1234_HDR.jpg',
    'DSC04567.jpg',         // Sony
    '_DSC1235.jpg',         // Nikon _DSC alt
    'DSCF0987.jpg',         // Fujifilm
  ]);
  assertEquals(m.get('IMG_5620'), 2);
  assertEquals(m.get('DSC_1234'), 2);
  assertEquals(m.get('DSC04567'), 1);
  assertEquals(m.get('_DSC1235'), 1);
  assertEquals(m.get('DSCF0987'), 1);
  assertEquals(m.size, 5);
});
