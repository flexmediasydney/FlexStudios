/**
 * decideJobStatus.test.ts — QC-iter2-W3 F-B-001 regression test.
 *
 * Run: deno test --no-check --allow-all \
 *   supabase/functions/floorplan-ocr-extractor/decideJobStatus.test.ts
 *
 * Pin the bgWork status decision so the bug never re-emerges:
 *   - clean run            → 'succeeded'
 *   - any unit failed      → 'failed'   (not 'succeeded' as the prior bug)
 *   - all units failed     → 'failed'
 *   - top-level summary.ok=false → 'failed' regardless of unit counts
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { decideJobStatusFromSummary } from './index.ts';

Deno.test('decideJobStatusFromSummary: clean run → succeeded', () => {
  assertEquals(
    decideJobStatusFromSummary({ ok: true, units_failed: 0 }),
    'succeeded',
  );
});

Deno.test('decideJobStatusFromSummary: any unit failed → failed', () => {
  assertEquals(
    decideJobStatusFromSummary({ ok: true, units_failed: 1 }),
    'failed',
  );
});

Deno.test('decideJobStatusFromSummary: all units failed → failed (regression: pre-fix returned succeeded)', () => {
  // The original ternary returned 'succeeded' on BOTH branches, so a run with
  // 100% per-unit failures persisted as green. This assertion locks the fix.
  assertEquals(
    decideJobStatusFromSummary({ ok: true, units_failed: 50 }),
    'failed',
  );
});

Deno.test('decideJobStatusFromSummary: summary.ok=false + zero unit failures → failed', () => {
  // top-level abort (e.g. cost-cap reached pre-loop) should still surface as
  // failed even when no per-unit failures were recorded.
  assertEquals(
    decideJobStatusFromSummary({ ok: false, units_failed: 0 }),
    'failed',
  );
});
