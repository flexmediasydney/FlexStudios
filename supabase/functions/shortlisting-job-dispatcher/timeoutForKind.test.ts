/**
 * Tests for shortlisting-job-dispatcher timeoutForKind() — the per-kind fetch
 * timeout map introduced by QC-iter2 W8 F-B-015.
 *
 * Background:
 *   The previous dispatcher used a flat 120s timeout for every kind. Stage 4
 *   declares an internal 240s budget; pass0 finishes in ~30s P95. The flat
 *   value was simultaneously too tight (Stage 4 timed out on the dispatcher
 *   side before its own internal deadline fired) and too loose (pass0 spent
 *   90s waiting after a real failure).
 *
 *   F-B-015 introduces KIND_TIMEOUT_MS and timeoutForKind(). This test pins
 *   the values so a future tweak to one kind doesn't silently regress
 *   another.
 *
 * Run:
 *   deno test --allow-all supabase/functions/shortlisting-job-dispatcher/timeoutForKind.test.ts
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { timeoutForKind, KIND_TIMEOUT_MS } from './index.ts';

Deno.test('timeoutForKind: pass0 ~ 90s (fast path, slot decisions only)', () => {
  assertEquals(timeoutForKind('pass0'), 90_000);
});

Deno.test('timeoutForKind: extract = 120s (Modal photos-extract worst case)', () => {
  assertEquals(timeoutForKind('extract'), 120_000);
});

Deno.test('F-B-015: stage4_synthesis = 240s (matches Stage 4 internal budget)', () => {
  // The headline F-B-015 fix: dispatcher now waits the full 240s window so
  // Stage 4 doesn't get killed externally before its internal timeout fires.
  assertEquals(timeoutForKind('stage4_synthesis'), 240_000);
});

Deno.test('timeoutForKind: shape_d_stage1 = 30s (background mode; ack only)', () => {
  // Background-mode kind returns a fast 200 ack; the heavy work runs inside
  // EdgeRuntime.waitUntil. 30s covers the ack handshake with headroom.
  assertEquals(timeoutForKind('shape_d_stage1'), 30_000);
});

Deno.test('W11.8: detect_instances = 150s (synchronous LLM clustering call)', () => {
  // detect_instances is NOT background-mode — single Gemini call (~30-90s
  // typical). 150s gives 60s of headroom over the worst-case wall.
  assertEquals(timeoutForKind('detect_instances'), 150_000);
});

Deno.test('timeoutForKind: pass3 = 90s (pure DB orchestration, no AI calls)', () => {
  assertEquals(timeoutForKind('pass3'), 90_000);
});

Deno.test('timeoutForKind: canonical_rollup = 120s (round-level normaliser)', () => {
  assertEquals(timeoutForKind('canonical_rollup'), 120_000);
});

Deno.test('timeoutForKind: ingest = 60s (chunk fan-out; fast)', () => {
  assertEquals(timeoutForKind('ingest'), 60_000);
});

Deno.test('timeoutForKind: background-mode pulse + floorplan extractors are 30s', () => {
  assertEquals(timeoutForKind('pulse_description_extract'), 30_000);
  assertEquals(timeoutForKind('floorplan_extract'), 30_000);
});

Deno.test('timeoutForKind: unknown kind falls back to 120s default', () => {
  // Defence in depth — if a new kind is added to the dispatcher chain but the
  // map isn't updated, we still want a finite, reasonable timeout.
  assertEquals(timeoutForKind('made_up_kind'), 120_000);
  assertEquals(timeoutForKind(''), 120_000);
});

Deno.test('F-B-015: KIND_TIMEOUT_MS is exported (so ops can sanity-check the schedule)', () => {
  // Pin the existence + non-emptiness of the map. Catches accidental
  // export removal during refactors.
  assertEquals(typeof KIND_TIMEOUT_MS, 'object');
  assertEquals(Object.keys(KIND_TIMEOUT_MS).length >= 9, true);
});
