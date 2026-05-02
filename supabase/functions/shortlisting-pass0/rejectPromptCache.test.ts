/**
 * Tests for shortlisting-pass0 reject-prompt cache TTL (QC-iter2 W6b F-B-010).
 *
 * The original implementation cached the loaded prompt at module level with
 * NO TTL. Warm Edge isolates that survived >10 min between invocations would
 * keep stale text after an admin edited the prompt in
 * SettingsShortlistingPrompts. The fix mirrors the `roomTypesFromDb` 60s TTL
 * pattern: refetch from the DB after the cache expires.
 *
 * Run:
 *   deno test --allow-all supabase/functions/shortlisting-pass0/rejectPromptCache.test.ts
 *
 * Strategy: inject the loader + a fake clock so tests are deterministic.
 */

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  resolveRejectPromptText,
  _resetPass0RejectPromptCache,
  REJECT_PROMPT_CACHE_TTL_MS,
} from './index.ts';

// Tiny helper: build a stub loader that records call counts so tests can
// assert "did the cache hit or fall through to the DB?".
function makeLoader(promptText: string | null) {
  let calls = 0;
  const loader = async () => {
    calls++;
    return promptText === null ? null : { text: promptText, version: 1 };
  };
  return {
    loader,
    get calls() {
      return calls;
    },
  };
}

Deno.test('F-B-010: cold call hits the loader and caches the result', async () => {
  _resetPass0RejectPromptCache();
  const tracker = makeLoader('hot fresh prompt');
  const clock = () => 1_000_000;

  const text1 = await resolveRejectPromptText(tracker.loader, clock);
  assertEquals(text1, 'hot fresh prompt');
  assertEquals(tracker.calls, 1);
});

Deno.test('F-B-010: warm call within TTL returns cached text without re-fetch', async () => {
  _resetPass0RejectPromptCache();
  const tracker = makeLoader('warm cached prompt');
  let now = 1_000_000;
  const clock = () => now;

  await resolveRejectPromptText(tracker.loader, clock);
  // Advance just under the TTL window — should still hit cache.
  now = 1_000_000 + REJECT_PROMPT_CACHE_TTL_MS - 1;
  const text2 = await resolveRejectPromptText(tracker.loader, clock);
  assertEquals(text2, 'warm cached prompt');
  assertEquals(tracker.calls, 1, 'second call within TTL must NOT re-fetch');
});

Deno.test('F-B-010: call after TTL refetches and picks up updated prompt', async () => {
  _resetPass0RejectPromptCache();
  let dbValue = 'first-version';
  let calls = 0;
  const loader = async () => {
    calls++;
    return { text: dbValue, version: calls };
  };
  let now = 1_000_000;
  const clock = () => now;

  const text1 = await resolveRejectPromptText(loader, clock);
  assertEquals(text1, 'first-version');
  assertEquals(calls, 1);

  // Admin edits the prompt mid-life; bump dbValue.
  dbValue = 'second-version';

  // Advance one ms past the TTL so the cache is considered stale.
  now = 1_000_000 + REJECT_PROMPT_CACHE_TTL_MS + 1;
  const text2 = await resolveRejectPromptText(loader, clock);
  assertEquals(text2, 'second-version');
  assertEquals(calls, 2, 'TTL-expired cache must refetch from the DB');
});

Deno.test('F-B-010: null loader result caches the fallback prompt without re-hammering DB', async () => {
  _resetPass0RejectPromptCache();
  const tracker = makeLoader(null); // DB miss / error
  const clock = () => 1_000_000;

  const text1 = await resolveRejectPromptText(tracker.loader, clock);
  // Fallback to HARD_REJECT_PROMPT — non-null, non-empty.
  assert(text1.length > 0);
  assertEquals(tracker.calls, 1);

  // Subsequent calls within TTL must NOT re-call the loader (avoids hammering
  // the DB when shortlisting_prompt_versions is empty / down).
  await resolveRejectPromptText(tracker.loader, clock);
  await resolveRejectPromptText(tracker.loader, clock);
  assertEquals(tracker.calls, 1, 'fallback path must also cache to avoid DB pressure');
});

Deno.test('F-B-010: _resetPass0RejectPromptCache forces an immediate re-fetch', async () => {
  _resetPass0RejectPromptCache();
  const tracker = makeLoader('p1');
  const clock = () => 1_000_000;

  await resolveRejectPromptText(tracker.loader, clock); // warm
  await resolveRejectPromptText(tracker.loader, clock); // hits cache
  assertEquals(tracker.calls, 1);

  _resetPass0RejectPromptCache();
  await resolveRejectPromptText(tracker.loader, clock); // cold again
  assertEquals(tracker.calls, 2);
});

Deno.test('F-B-010: TTL constant is 60s as documented', () => {
  assertEquals(REJECT_PROMPT_CACHE_TTL_MS, 60_000);
});
