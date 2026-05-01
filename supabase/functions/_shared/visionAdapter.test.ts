/**
 * visionAdapter.test.ts — Wave 11.8 unit tests for the router + pricing
 * + missing-credential error path.
 *
 * Run: deno test --no-check --allow-all supabase/functions/_shared/visionAdapter.test.ts
 *
 * W11.8.1 (2026-05-01): Anthropic adapter stripped — Gemini is the sole
 * production vision vendor. Anthropic-routing tests removed; the only routing
 * test verifies google → Google adapter (env-var label proves dispatch).
 *
 * Per-adapter unit tests (request shape, response parsing) live alongside the
 * adapter — visionAdapter.google.test.ts.
 */

import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertStrictEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  callVisionAdapter,
  estimateCost,
  MissingVendorCredential,
  resolveRates,
  VendorCallError,
  VENDOR_PRICING,
  type VisionRequest,
} from './visionAdapter/index.ts';

// ─── Fixture ─────────────────────────────────────────────────────────────────

function makeRequest(overrides: Partial<VisionRequest> = {}): VisionRequest {
  return {
    vendor: 'google',
    model: 'gemini-2.0-pro',
    tool_name: 'classify',
    tool_input_schema: {
      type: 'object',
      properties: { room_type: { type: 'string' } },
      required: ['room_type'],
    },
    system: 'You classify images.',
    user_text: 'What room is this?',
    images: [{ source_type: 'base64', media_type: 'image/jpeg', data: 'fakebase64' }],
    max_output_tokens: 1500,
    ...overrides,
  };
}

// ─── Pricing tests ───────────────────────────────────────────────────────────

Deno.test('pricing — Google Gemini Pro rates resolve correctly', () => {
  const rates = resolveRates('google', 'gemini-2.0-pro');
  assertEquals(rates.inputPerMillion, 3.50);
  assertEquals(rates.outputPerMillion, 10.50);
});

Deno.test('pricing — Google Gemini Flash rates resolve correctly', () => {
  const rates = resolveRates('google', 'gemini-2.0-flash');
  assertEquals(rates.inputPerMillion, 0.10);
  assertEquals(rates.outputPerMillion, 0.40);
});

Deno.test('pricing — Google Gemini 2.5 Pro rates resolve correctly', () => {
  const rates = resolveRates('google', 'gemini-2.5-pro');
  assertEquals(rates.inputPerMillion, 3.50);
  assertEquals(rates.outputPerMillion, 10.50);
});

Deno.test('pricing — Google Gemini 2.5 Flash rates resolve correctly', () => {
  const rates = resolveRates('google', 'gemini-2.5-flash');
  assertEquals(rates.inputPerMillion, 0.10);
  assertEquals(rates.outputPerMillion, 0.40);
});

Deno.test('pricing — Google date-suffix model strips and resolves', () => {
  const rates = resolveRates('google', 'gemini-2.0-pro-20260101');
  assertEquals(rates.inputPerMillion, 3.50);
  assertEquals(rates.outputPerMillion, 10.50);
});

Deno.test('pricing — unknown model falls back to Gemini Pro rates with warning', () => {
  // Capture console.warn so the test output isn't cluttered.
  const origWarn = console.warn;
  let warned = false;
  console.warn = () => { warned = true; };
  try {
    const rates = resolveRates('google', 'gemini-totally-fake-model');
    assertEquals(rates.inputPerMillion, 3.50);
    assertEquals(rates.outputPerMillion, 10.50);
    assert(warned, 'expected warn-on-fallback');
  } finally {
    console.warn = origWarn;
  }
});

Deno.test('estimateCost — Gemini Pro 10000 in / 1000 out → $0.0455', () => {
  const cost = estimateCost('google', 'gemini-2.0-pro', {
    input_tokens: 10_000,
    output_tokens: 1000,
    cached_input_tokens: 0,
  });
  // 10000*3.5/1M + 1000*10.5/1M = 0.035 + 0.0105 = 0.0455
  assertAlmostEquals(cost, 0.0455, 1e-9);
});

Deno.test('estimateCost — Gemini Flash near-zero for tiny call', () => {
  const cost = estimateCost('google', 'gemini-2.0-flash', {
    input_tokens: 100,
    output_tokens: 50,
    cached_input_tokens: 0,
  });
  // 100*0.1/1M + 50*0.4/1M = 0.00001 + 0.00002 = 0.00003
  assertAlmostEquals(cost, 0.00003, 1e-9);
});

Deno.test('estimateCost — cached input falls back to standard input rate when no cache rate set', () => {
  // Gemini's pricing rows don't carry cachedInputPerMillion; cost should
  // include cached tokens at standard input pricing.
  const cost = estimateCost('google', 'gemini-2.0-pro', {
    input_tokens: 1000,
    output_tokens: 0,
    cached_input_tokens: 1000,
  });
  // (1000 + 1000) * 3.5 / 1M = 0.007
  assertAlmostEquals(cost, 0.007, 1e-9);
});

Deno.test('estimateCost — negative usage values are clamped to zero', () => {
  const cost = estimateCost('google', 'gemini-2.0-pro', {
    input_tokens: -1,
    output_tokens: -1,
    cached_input_tokens: -1,
  });
  assertEquals(cost, 0);
});

Deno.test('VENDOR_PRICING — has rows for every required (vendor, model)', () => {
  // Per W11.8 spec Section 4 — these are the models the production Shape D
  // pipeline + Pulse extract use. Anthropic rows removed in W11.8.1.
  assert(VENDOR_PRICING.google['gemini-2.0-pro']);
  assert(VENDOR_PRICING.google['gemini-2.0-flash']);
  assert(VENDOR_PRICING.google['gemini-2.5-pro']);
  assert(VENDOR_PRICING.google['gemini-2.5-flash']);
});

// ─── Router tests ────────────────────────────────────────────────────────────
//
// Per-adapter request/response tests live in visionAdapter.google.test.ts.
// The router test below verifies dispatch by removing the API-key env var
// and asserting MissingVendorCredential surfaces with the correct vendor +
// env_var labels — this proves the switch routed without needing fetch mocks.

Deno.test('router — google vendor routes to Google adapter (verified by env-var label)', async () => {
  const orig = Deno.env.get('GEMINI_API_KEY');
  Deno.env.delete('GEMINI_API_KEY');
  try {
    const req = makeRequest({ vendor: 'google', model: 'gemini-2.0-pro' });
    let captured: unknown = null;
    try {
      await callVisionAdapter(req);
    } catch (err) {
      captured = err;
    }
    assert(captured instanceof MissingVendorCredential);
    assertStrictEquals(captured.vendor, 'google');
    assertStrictEquals(captured.env_var, 'GEMINI_API_KEY');
  } finally {
    if (orig !== undefined) Deno.env.set('GEMINI_API_KEY', orig);
  }
});

// ─── Missing-credential error type ───────────────────────────────────────────

Deno.test('MissingVendorCredential — sets vendor + env_var fields', () => {
  const err = new MissingVendorCredential('google', 'GEMINI_API_KEY');
  assertEquals(err.vendor, 'google');
  assertEquals(err.env_var, 'GEMINI_API_KEY');
  assert(err.message.includes('GEMINI_API_KEY'));
  assert(err.message.includes('google'));
  assertEquals(err.name, 'MissingVendorCredential');
});

Deno.test('MissingVendorCredential — instanceof Error', () => {
  const err = new MissingVendorCredential('google', 'GEMINI_API_KEY');
  assert(err instanceof Error);
  assert(err instanceof MissingVendorCredential);
});

Deno.test('VendorCallError — includes vendor + model + optional status', () => {
  const err = new VendorCallError('google', 'gemini-2.0-pro', 'rate-limited', 429);
  assertEquals(err.vendor, 'google');
  assertEquals(err.model, 'gemini-2.0-pro');
  assertEquals(err.status, 429);
  assertEquals(err.name, 'VendorCallError');
});
