/**
 * visionAdapter.test.ts — Wave 11.8 unit tests for the router + pricing
 * + missing-credential error path.
 *
 * Run: deno test --no-check --allow-all supabase/functions/_shared/visionAdapter.test.ts
 *
 * Per-adapter unit tests (request shape, response parsing) live alongside each
 * adapter — visionAdapter.anthropic.test.ts (commit 3/7) and
 * visionAdapter.google.test.ts (commit 4/7).
 */

import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertRejects,
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
    vendor: 'anthropic',
    model: 'claude-sonnet-4-6',
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

Deno.test('pricing — Anthropic Sonnet rates resolve correctly', () => {
  const rates = resolveRates('anthropic', 'claude-sonnet-4-6');
  assertEquals(rates.inputPerMillion, 3.0);
  assertEquals(rates.outputPerMillion, 15.0);
});

Deno.test('pricing — Anthropic Opus rates resolve correctly', () => {
  const rates = resolveRates('anthropic', 'claude-opus-4-7');
  assertEquals(rates.inputPerMillion, 15.0);
  assertEquals(rates.outputPerMillion, 75.0);
});

Deno.test('pricing — Anthropic Haiku rates resolve correctly', () => {
  const rates = resolveRates('anthropic', 'claude-haiku-4');
  assertEquals(rates.inputPerMillion, 1.0);
  assertEquals(rates.outputPerMillion, 5.0);
});

Deno.test('pricing — Anthropic date-suffix model strips and resolves', () => {
  const rates = resolveRates('anthropic', 'claude-sonnet-4-6-20260101');
  assertEquals(rates.inputPerMillion, 3.0);
  assertEquals(rates.outputPerMillion, 15.0);
});

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

Deno.test('pricing — unknown model falls back to Sonnet rates with warning', () => {
  // Capture console.warn so the test output isn't cluttered.
  const origWarn = console.warn;
  let warned = false;
  console.warn = () => { warned = true; };
  try {
    const rates = resolveRates('anthropic', 'claude-totally-fake-model');
    assertEquals(rates.inputPerMillion, 3.0);
    assertEquals(rates.outputPerMillion, 15.0);
    assert(warned, 'expected warn-on-fallback');
  } finally {
    console.warn = origWarn;
  }
});

Deno.test('estimateCost — Sonnet 1000 in / 500 out → $0.0105', () => {
  const cost = estimateCost('anthropic', 'claude-sonnet-4-6', {
    input_tokens: 1000,
    output_tokens: 500,
    cached_input_tokens: 0,
  });
  // 1000*3/1M + 500*15/1M = 0.003 + 0.0075 = 0.0105
  assertAlmostEquals(cost, 0.0105, 1e-9);
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
  // Anthropic adapters set cachedInputPerMillion=undefined; cost should include
  // cached tokens at standard input pricing.
  const cost = estimateCost('anthropic', 'claude-opus-4-7', {
    input_tokens: 1000,
    output_tokens: 0,
    cached_input_tokens: 1000,
  });
  // (1000 + 1000) * 15 / 1M = 0.030
  assertAlmostEquals(cost, 0.030, 1e-9);
});

Deno.test('estimateCost — negative usage values are clamped to zero', () => {
  const cost = estimateCost('anthropic', 'claude-sonnet-4-6', {
    input_tokens: -1,
    output_tokens: -1,
    cached_input_tokens: -1,
  });
  assertEquals(cost, 0);
});

Deno.test('VENDOR_PRICING — has rows for every required (vendor, model)', () => {
  // Per W11.8 spec Section 4 — these are the models the Saladine A/B test fires.
  assert(VENDOR_PRICING.anthropic['claude-opus-4-7']);
  assert(VENDOR_PRICING.anthropic['claude-sonnet-4-6']);
  assert(VENDOR_PRICING.anthropic['claude-haiku-4']);
  assert(VENDOR_PRICING.google['gemini-2.0-pro']);
  assert(VENDOR_PRICING.google['gemini-2.0-flash']);
});

// ─── Router tests ────────────────────────────────────────────────────────────
//
// Each adapter has its own dedicated test file (visionAdapter.anthropic.test.ts
// + visionAdapter.google.test.ts) covering request/response shape. The router
// tests below verify ONLY that the right adapter is dispatched — by removing
// API-key env vars and asserting MissingVendorCredential surfaces with the
// correct vendor + env_var labels. This proves the switch routed correctly
// without needing to mock fetch in this file.

Deno.test('router — anthropic vendor routes to Anthropic adapter (verified by env-var label)', async () => {
  const origAnthropic = Deno.env.get('ANTHROPIC_API_KEY');
  const origClaude = Deno.env.get('CLAUDE_API_KEY');
  Deno.env.delete('ANTHROPIC_API_KEY');
  Deno.env.delete('CLAUDE_API_KEY');
  try {
    const req = makeRequest({ vendor: 'anthropic' });
    let captured: unknown = null;
    try {
      await callVisionAdapter(req);
    } catch (err) {
      captured = err;
    }
    assert(captured instanceof MissingVendorCredential);
    assertStrictEquals(captured.vendor, 'anthropic');
    assertStrictEquals(captured.env_var, 'ANTHROPIC_API_KEY');
  } finally {
    if (origAnthropic !== undefined) Deno.env.set('ANTHROPIC_API_KEY', origAnthropic);
    if (origClaude !== undefined) Deno.env.set('CLAUDE_API_KEY', origClaude);
  }
});

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
  const err = new MissingVendorCredential('anthropic', 'ANTHROPIC_API_KEY');
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
