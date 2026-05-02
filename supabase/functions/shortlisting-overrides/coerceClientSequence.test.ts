/**
 * Tests for shortlisting-overrides coerceClientSequence (QC-iter2 W6b F-B-011).
 *
 * The original `>0` predicate at index.ts:565 sent legitimate first-of-session
 * events (client_sequence=0) to NULL. shortlist-lock's `ORDER BY client_sequence
 * NULLS LAST` then sorted those NULL rows AFTER every later event, producing
 * an out-of-order swimlane event stream — the exact bug F-B-011 reports.
 *
 * The fix widens the predicate to `>=0`. These tests pin the new behaviour
 * to prevent regression, plus cover the negative/non-finite/non-numeric
 * defensive branches.
 *
 * Run:
 *   deno test --allow-all supabase/functions/shortlisting-overrides/coerceClientSequence.test.ts
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { coerceClientSequence } from './index.ts';

Deno.test('F-B-011: client_sequence=0 is preserved (was the bug)', () => {
  // The exact first-of-session value the previous `>0` predicate dropped.
  assertEquals(coerceClientSequence(0), 0);
});

Deno.test('F-B-011: positive integers pass through unchanged', () => {
  assertEquals(coerceClientSequence(1), 1);
  assertEquals(coerceClientSequence(7), 7);
  assertEquals(coerceClientSequence(1000), 1000);
});

Deno.test('F-B-011: fractional values are truncated via Math.floor', () => {
  assertEquals(coerceClientSequence(0.5), 0);
  assertEquals(coerceClientSequence(2.9), 2);
});

Deno.test('F-B-011: negative numbers coerce to null', () => {
  assertEquals(coerceClientSequence(-1), null);
  assertEquals(coerceClientSequence(-0.5), null);
  assertEquals(coerceClientSequence(-1000), null);
});

Deno.test('F-B-011: non-finite values coerce to null', () => {
  assertEquals(coerceClientSequence(Number.NaN), null);
  assertEquals(coerceClientSequence(Number.POSITIVE_INFINITY), null);
  assertEquals(coerceClientSequence(Number.NEGATIVE_INFINITY), null);
});

Deno.test('F-B-011: non-numeric input coerces to null', () => {
  assertEquals(coerceClientSequence('5'), null);
  assertEquals(coerceClientSequence('0'), null);
  assertEquals(coerceClientSequence(null), null);
  assertEquals(coerceClientSequence(undefined), null);
  assertEquals(coerceClientSequence({}), null);
  assertEquals(coerceClientSequence([]), null);
  assertEquals(coerceClientSequence(true), null);
});
