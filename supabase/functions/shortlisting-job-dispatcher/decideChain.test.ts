/**
 * Tests for shortlisting-job-dispatcher decideChain() — the pure decision
 * helper extracted as part of QC-iter2 W6b F-B-012.
 *
 * F-B-012 fix: when chainNextKind sees an unmapped kind, the dispatcher
 * silently no-op'd and the round never advanced. decideChain explicitly
 * returns `{ action: 'unknown' }` for unmapped kinds so the caller logs a
 * warn and ops can see stuck rounds.
 *
 * Run:
 *   deno test --allow-all supabase/functions/shortlisting-job-dispatcher/decideChain.test.ts
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { decideChain } from './index.ts';

Deno.test('decideChain: ingest is terminal (chain handled inside shortlisting-ingest)', () => {
  assertEquals(decideChain('ingest'), { action: 'terminal' });
});

Deno.test('decideChain: pass3 is terminal (fires round-complete notification)', () => {
  assertEquals(decideChain('pass3'), { action: 'terminal' });
});

Deno.test('decideChain: Shape D terminal kinds are all terminal', () => {
  assertEquals(decideChain('shape_d_stage1'), { action: 'terminal' });
  assertEquals(decideChain('stage4_synthesis'), { action: 'terminal' });
  assertEquals(decideChain('canonical_rollup'), { action: 'terminal' });
});

Deno.test('decideChain: standalone batch kinds are terminal', () => {
  assertEquals(decideChain('pulse_description_extract'), { action: 'terminal' });
  assertEquals(decideChain('floorplan_extract'), { action: 'terminal' });
});

Deno.test('decideChain: extract returns extract_chain for sibling-aware logic', () => {
  // The dispatcher only enqueues pass0 once ALL extract siblings for a round
  // are succeeded. The caller (chainNextKind) does the sibling count.
  assertEquals(decideChain('extract'), { action: 'extract_chain' });
});

Deno.test('decideChain: pass0 chains to shape_d_stage1', () => {
  assertEquals(decideChain('pass0'), { action: 'chain', next: 'shape_d_stage1' });
});

Deno.test('F-B-012: retired kinds (pass1, pass2) return unknown so the warn fires', () => {
  // pass1/pass2 are retired (mig 439). Any stray historical job row still
  // claiming these kinds must surface as a warning so ops can clean it up
  // rather than silently orphaning the round.
  assertEquals(decideChain('pass1'), { action: 'unknown' });
  assertEquals(decideChain('pass2'), { action: 'unknown' });
});

Deno.test('F-B-012: arbitrary unmapped kind returns unknown', () => {
  // A typo'd or yet-to-be-wired kind shouldn't silently advance the round —
  // the dispatcher emits a warn. This is the regression guard for F-B-012:
  // the previous behaviour returned undefined and dropped to a silent
  // `if (!mapped) return;`.
  assertEquals(decideChain('made_up_kind'), { action: 'unknown' });
  assertEquals(decideChain('typo_in_kind'), { action: 'unknown' });
  assertEquals(decideChain(''), { action: 'unknown' });
});
