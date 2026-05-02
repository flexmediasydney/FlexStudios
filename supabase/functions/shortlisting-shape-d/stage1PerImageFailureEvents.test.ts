/**
 * stage1PerImageFailureEvents.test.ts — W15c per-image observability tests.
 *
 * Run: SUPABASE_URL=test SUPABASE_SERVICE_ROLE_KEY=test \
 *   deno test --no-check --allow-all \
 *   supabase/functions/shortlisting-shape-d/stage1PerImageFailureEvents.test.ts
 *
 * Covers W15c: surface per-image Stage 1 failures as first-class events.
 *
 * The full Stage 1 orchestrator (runShapeDStage1Core) is private + heavy,
 * so we test the high-leverage piece directly: classifyStage1PerImageError
 * (the pure mapping from raw vendor error string -> stable error_class
 * bucket consumed by stage1_per_image_failure.payload.error_class +
 * stage1_per_image_summary.payload.failure_classes histogram).
 *
 * If the bucket boundaries drift, the dashboard (which queries
 * `payload->>'error_class'`) silently breaks — these tests guard against
 * that regression. They also document the expected error-string formats
 * we got wrong in the past.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { classifyStage1PerImageError } from './index.ts';

Deno.test('classifyStage1PerImageError — preview fetch failure', () => {
  assertEquals(
    classifyStage1PerImageError(
      'preview_fetch_failed: Dropbox 404 not_found at /Photos/.../foo.jpg',
    ),
    'preview_fetch',
  );
});

Deno.test('classifyStage1PerImageError — wholesale worker exception', () => {
  assertEquals(
    classifyStage1PerImageError(
      'wholesale_failed: TypeError: Cannot read property of undefined',
    ),
    'wholesale',
  );
});

Deno.test('classifyStage1PerImageError — VendorCallError with status', () => {
  assertEquals(
    classifyStage1PerImageError(
      'google/gemini-2.5-pro 503: The service is currently unavailable.',
    ),
    'vendor_call',
  );
});

Deno.test('classifyStage1PerImageError — VendorCallError without status', () => {
  assertEquals(
    classifyStage1PerImageError('google/gemini-2.5-pro : timeout'),
    'vendor_call',
  );
});

Deno.test('classifyStage1PerImageError — missing credential', () => {
  assertEquals(
    classifyStage1PerImageError('GEMINI_API_KEY credential missing for google'),
    'missing_credential',
  );
});

Deno.test('classifyStage1PerImageError — no_response sentinel', () => {
  assertEquals(classifyStage1PerImageError('no_response'), 'no_response');
});

Deno.test('classifyStage1PerImageError — empty string defaults to unknown', () => {
  assertEquals(classifyStage1PerImageError(''), 'unknown');
});

Deno.test('classifyStage1PerImageError — unrecognised raw vendor 5xx text → unknown', () => {
  // Real-world Gemini regression: HTML 500 page returned with no JSON body.
  // Adapter strips it down to the first line; we still need to bucket.
  assertEquals(
    classifyStage1PerImageError('Internal server error <html>...'),
    'unknown',
  );
});

Deno.test('classifyStage1PerImageError — failure histogram aggregation', () => {
  // Smoke the full-flow shape: a mixed set of failures from one round
  // produces a deterministic histogram. This mirrors what the orchestrator
  // builds into stage1_per_image_summary.payload.failure_classes.
  const errors = [
    'preview_fetch_failed: 404',
    'preview_fetch_failed: 403',
    'google/gemini-2.5-pro 503: unavailable',
    'wholesale_failed: TypeError',
    'no_response',
    '',
  ];
  const histogram: Record<string, number> = {};
  for (const e of errors) {
    const c = classifyStage1PerImageError(e);
    histogram[c] = (histogram[c] ?? 0) + 1;
  }
  assertEquals(histogram, {
    preview_fetch: 2,
    vendor_call: 1,
    wholesale: 1,
    no_response: 1,
    unknown: 1,
  });
});
