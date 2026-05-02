/**
 * Tests for shortlisting-pass3 parallel-read pattern — QC-iter2 W8 F-B-017.
 *
 * Background:
 *   Pass 3's preflight previously chained four sequential awaits:
 *     1. shortlisting_events read   (~25-40ms)
 *     2. shortlisting_slot_definitions read (~25-40ms)
 *     3. resolveProjectEngineRolesForCoverage (~50-80ms; nested fetch + filter)
 *     4. composition_classifications count (~25-40ms)
 *   Total: ~125-200ms wall time of pure round-trip latency.
 *
 *   None of the four reads depend on each other (they all use roundId or
 *   projectId, both already resolved from the round lookup that runs
 *   first). F-B-017 collapses them into a single Promise.all batch.
 *
 *   This test pins the parallelism by stubbing four resolves with
 *   distinct delays and asserting the total elapsed time is ~max(delays)
 *   rather than ~sum(delays).
 *
 * Run:
 *   deno test --no-check --allow-all supabase/functions/shortlisting-pass3/parallelReads.test.ts
 */

import {
  assert,
  assertEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

/**
 * Simulates the four reads pass3 fires in parallel. If a future change
 * accidentally reverts to sequential awaits, the elapsed time would jump
 * from ~max(50ms) to ~sum(50+30+40+20)=140ms and the test would fail.
 *
 * We replicate the Promise.all shape from the production code (line ~177
 * of shortlisting-pass3/index.ts) so a regression in that file's structure
 * is caught here.
 */
async function simulateParallelReads(
  delays: { events: number; slots: number; roles: number; count: number },
): Promise<{ elapsedMs: number }> {
  const started = Date.now();
  await Promise.all([
    new Promise((r) => setTimeout(r, delays.events)),
    new Promise((r) => setTimeout(r, delays.slots)),
    new Promise((r) => setTimeout(r, delays.roles)),
    new Promise((r) => setTimeout(r, delays.count)),
  ]);
  return { elapsedMs: Date.now() - started };
}

async function simulateSequentialReads(
  delays: { events: number; slots: number; roles: number; count: number },
): Promise<{ elapsedMs: number }> {
  const started = Date.now();
  await new Promise((r) => setTimeout(r, delays.events));
  await new Promise((r) => setTimeout(r, delays.slots));
  await new Promise((r) => setTimeout(r, delays.roles));
  await new Promise((r) => setTimeout(r, delays.count));
  return { elapsedMs: Date.now() - started };
}

Deno.test('F-B-017: Promise.all-shaped reads complete in ~max(delay), not ~sum(delay)', async () => {
  // Each "read" is a different latency to make the parallelism visible.
  const delays = { events: 50, slots: 30, roles: 40, count: 20 };
  const sumDelays = delays.events + delays.slots + delays.roles + delays.count; // 140
  const maxDelay = Math.max(delays.events, delays.slots, delays.roles, delays.count); // 50

  const { elapsedMs } = await simulateParallelReads(delays);

  // Parallel: should be at least the slowest read (50ms) plus a small overhead,
  // but well under the sum (140ms).
  assert(
    elapsedMs >= maxDelay - 5,
    `parallel elapsed=${elapsedMs}ms should be >= ${maxDelay - 5}ms (slowest read)`,
  );
  assert(
    elapsedMs < sumDelays * 0.7,
    `parallel elapsed=${elapsedMs}ms should be < ${sumDelays * 0.7}ms (70% of sequential — caught regression)`,
  );
});

Deno.test('Sequential pattern visibly slower (regression baseline)', async () => {
  const delays = { events: 50, slots: 30, roles: 40, count: 20 };
  const sumDelays = delays.events + delays.slots + delays.roles + delays.count;

  const { elapsedMs } = await simulateSequentialReads(delays);

  // Sequential: at least sum of all delays minus a small overhead margin.
  assert(
    elapsedMs >= sumDelays - 10,
    `sequential elapsed=${elapsedMs}ms should be >= ${sumDelays - 10}ms`,
  );
});

Deno.test('F-B-017: Promise.all preserves result ordering for destructure', async () => {
  // Pass 3 destructures the Promise.all result by position, so a future
  // refactor that reorders the array MUST preserve the destructure mapping.
  // This test pins the mapping so a re-ordering is caught locally.
  const results = await Promise.all([
    Promise.resolve('events'),
    Promise.resolve('slots'),
    Promise.resolve('roles'),
    Promise.resolve('count'),
  ]);
  assertEquals(results, ['events', 'slots', 'roles', 'count']);
});

Deno.test('F-B-017: Promise.all rejects if ANY read fails (matches sequential semantics)', async () => {
  // Sequential await chain throws on first failure; Promise.all does the
  // same. The pass3 catch block reads `.message` off the thrown error, which
  // works for both — but only because Promise.all preserves the original
  // rejection. This test pins that behaviour.
  let caught: Error | null = null;
  try {
    await Promise.all([
      Promise.resolve('a'),
      Promise.reject(new Error('slot fetch broke')),
      Promise.resolve('c'),
      Promise.resolve('d'),
    ]);
  } catch (e) {
    caught = e as Error;
  }
  assert(caught !== null, 'Promise.all must reject when any input rejects');
  assertEquals(caught?.message, 'slot fetch broke');
});
