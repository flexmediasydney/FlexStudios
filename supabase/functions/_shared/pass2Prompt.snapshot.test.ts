/**
 * pass2Prompt.snapshot.test.ts — Wave 7 P1-10 (W7.6) byte-identical regression
 * gate. The pre-refactor monolithic builder produced the snapshot in
 * `visionPrompts/__snapshots__/pass2Prompt.snap.txt`; this test replays the
 * SAME fixtures through the new modular builder and asserts the joined
 * `system + '\n---\n' + userPrefix` is byte-identical.
 *
 * If this test fails, the refactor introduced a behavioural change. Fix the
 * refactor — do not regenerate the snapshot.
 */

import { assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { buildPass2Prompt } from './pass2Prompt.ts';
import { FIXTURE_PASS2_OPTS } from './visionPrompts/__snapshots__/_fixtures.ts';

Deno.test('pass2Prompt: byte-identical to checked-in snapshot (W7.6 regression gate)', async () => {
  const built = buildPass2Prompt(FIXTURE_PASS2_OPTS);
  const got = `${built.system}\n---\n${built.userPrefix}`;

  const snapPath = new URL(
    './visionPrompts/__snapshots__/pass2Prompt.snap.txt',
    import.meta.url,
  );
  const want = await Deno.readTextFile(snapPath);

  if (got !== want) {
    const minLen = Math.min(got.length, want.length);
    let firstDiff = -1;
    for (let i = 0; i < minLen; i++) {
      if (got[i] !== want[i]) { firstDiff = i; break; }
    }
    const ctx = (s: string, i: number) =>
      i < 0 ? '<eof>' : JSON.stringify(s.slice(Math.max(0, i - 30), i + 30));
    throw new Error(
      `pass2Prompt snapshot mismatch.\n` +
      `  got.length=${got.length} want.length=${want.length}\n` +
      `  first diff index=${firstDiff}\n` +
      `  got: ${ctx(got, firstDiff)}\n` +
      `  want: ${ctx(want, firstDiff)}\n`,
    );
  }
  assertEquals(got, want);
});
