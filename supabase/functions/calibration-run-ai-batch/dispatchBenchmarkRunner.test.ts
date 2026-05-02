/**
 * dispatchBenchmarkRunner.test.ts — QC-iter2-W3 F-B-002 regression test.
 *
 * Run: deno test --no-check --allow-all \
 *   supabase/functions/calibration-run-ai-batch/dispatchBenchmarkRunner.test.ts
 *
 * Pin the wrap-in-waitUntil contract so the bug never re-emerges:
 *   - dispatcher CALLS waitUntil with the in-flight fetch promise.
 *   - dispatcher fires fetch with the right URL + headers + body shape.
 *   - dispatcher tolerates a missing waitUntil hook (no throw).
 */

import {
  assert,
  assertEquals,
  assertStrictEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { dispatchBenchmarkRunnerWithWaitUntil } from './index.ts';

function makeFakeFetch(): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(new Response('{}', { status: 200 }));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

Deno.test('dispatchBenchmarkRunnerWithWaitUntil: registers fetch promise via waitUntil', async () => {
  const { fetchImpl, calls } = makeFakeFetch();
  const waitUntilCalls: Array<Promise<unknown>> = [];
  const waitUntil = (p: Promise<unknown>) => {
    waitUntilCalls.push(p);
  };

  const dispatched = dispatchBenchmarkRunnerWithWaitUntil({
    fetchImpl,
    invokeUrl: 'https://example.test/functions/v1/shortlisting-benchmark-runner',
    serviceKey: 'test-key',
    invokeBody: { trigger: 'calibration', round_ids: ['r1', 'r2'] },
    callerContext: 'calibration-run-ai-batch',
    waitUntil,
  });

  // The exact same promise we returned must have been registered with waitUntil.
  assertStrictEquals(waitUntilCalls.length, 1);
  assertStrictEquals(waitUntilCalls[0], dispatched);

  // Fetch was invoked once with the expected shape.
  await dispatched;
  assertStrictEquals(calls.length, 1);
  assertEquals(
    calls[0].url,
    'https://example.test/functions/v1/shortlisting-benchmark-runner',
  );
  const init = calls[0].init!;
  assertEquals(init.method, 'POST');
  // deno-lint-ignore no-explicit-any
  const headers = init.headers as Record<string, string>;
  assertEquals(headers.Authorization, 'Bearer test-key');
  assertEquals(headers['Content-Type'], 'application/json');
  assertEquals(headers['x-caller-context'], 'calibration-run-ai-batch');
  assertEquals(
    JSON.parse(init.body as string),
    { trigger: 'calibration', round_ids: ['r1', 'r2'] },
  );
});

Deno.test('dispatchBenchmarkRunnerWithWaitUntil: missing waitUntil hook is tolerated', async () => {
  const { fetchImpl, calls } = makeFakeFetch();

  // Simulates a non-edge runtime where EdgeRuntime is undefined.
  const dispatched = dispatchBenchmarkRunnerWithWaitUntil({
    fetchImpl,
    invokeUrl: 'https://example.test/functions/v1/shortlisting-benchmark-runner',
    serviceKey: 'test-key',
    invokeBody: { trigger: 'calibration' },
    callerContext: 'calibration-run-ai-batch',
    waitUntil: undefined,
  });

  await dispatched;
  // Fetch still fires; the absence of waitUntil is non-fatal.
  assertStrictEquals(calls.length, 1);
  assert(true);
});
