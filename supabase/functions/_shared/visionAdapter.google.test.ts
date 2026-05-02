/**
 * visionAdapter.google.test.ts — Wave 11.8 unit tests for the Google (Gemini)
 * adapter. Validates request shape (inline_data, responseSchema), response
 * parsing, and cost computation.
 *
 * Run: deno test --no-check --allow-all supabase/functions/_shared/visionAdapter.google.test.ts
 */

import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertObjectMatch,
  assertRejects,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  buildGeminiBody,
  callGoogleVision,
  extractGeminiOutput,
} from './visionAdapter/adapters/google.ts';
import { estimateCost } from './visionAdapter/pricing.ts';
import {
  MissingVendorCredential,
  VendorCallError,
  type VisionRequest,
} from './visionAdapter/index.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function baseReq(overrides: Partial<VisionRequest> = {}): VisionRequest {
  return {
    vendor: 'google',
    model: 'gemini-2.0-pro',
    tool_name: 'classify_image',
    tool_input_schema: {
      type: 'object',
      properties: { room_type: { type: 'string' } },
      required: ['room_type'],
    },
    system: 'You classify real-estate images.',
    user_text: 'Classify this.',
    images: [{ source_type: 'base64', media_type: 'image/jpeg', data: 'ZmFrZS1iYXNlNjQ=' }],
    max_output_tokens: 1500,
    ...overrides,
  };
}

interface MockFetchOpts {
  status?: number;
  body?: unknown;
  bodyText?: string;
  capture?: { lastUrl?: string; lastInit?: RequestInit; lastBody?: unknown };
}

function installMockFetch(opts: MockFetchOpts) {
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (opts.capture) {
      opts.capture.lastUrl = url;
      opts.capture.lastInit = init;
      try {
        opts.capture.lastBody = JSON.parse(String(init?.body ?? '{}'));
      } catch {
        opts.capture.lastBody = init?.body;
      }
    }
    const status = opts.status ?? 200;
    const text = opts.bodyText ?? JSON.stringify(opts.body ?? {});
    return Promise.resolve(
      new Response(text, {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

// ─── Body builder ────────────────────────────────────────────────────────────

Deno.test('buildGeminiBody — systemInstruction wraps system text', () => {
  const body = buildGeminiBody(baseReq()) as {
    systemInstruction: { parts: Array<{ text: string }> };
  };
  assertEquals(body.systemInstruction.parts[0].text, 'You classify real-estate images.');
});

Deno.test('buildGeminiBody — generationConfig forces JSON + schema', () => {
  const body = buildGeminiBody(baseReq()) as {
    generationConfig: {
      responseMimeType: string;
      responseSchema: Record<string, unknown>;
      maxOutputTokens: number;
      temperature: number;
    };
  };
  assertEquals(body.generationConfig.responseMimeType, 'application/json');
  assertEquals(body.generationConfig.maxOutputTokens, 1500);
  assertEquals(body.generationConfig.temperature, 0);
  assertObjectMatch(body.generationConfig.responseSchema, { type: 'object' });
});

Deno.test('buildGeminiBody — base64 image becomes inlineData with mimeType + data', () => {
  const body = buildGeminiBody(baseReq()) as {
    contents: Array<{ role: string; parts: Array<{ inlineData?: { mimeType: string; data: string }; text?: string }> }>;
  };
  const imagePart = body.contents[0].parts.find((p) => p.inlineData);
  assert(imagePart);
  assertEquals(imagePart!.inlineData!.mimeType, 'image/jpeg');
  assertEquals(imagePart!.inlineData!.data, 'ZmFrZS1iYXNlNjQ=');
});

Deno.test('buildGeminiBody — user_text appended after image parts', () => {
  const body = buildGeminiBody(baseReq()) as {
    contents: Array<{ role: string; parts: Array<{ inlineData?: unknown; text?: string }> }>;
  };
  const parts = body.contents[0].parts;
  // Last part should be the text.
  assertEquals(parts[parts.length - 1].text, 'Classify this.');
});

// QC iter2 W6a (F-E-007) — cached_content_name plumbing into Gemini body
Deno.test(
  'buildGeminiBody — cached_content_name swaps systemInstruction for cachedContent reference',
  () => {
    const body = buildGeminiBody(
      baseReq({ cached_content_name: 'cachedContents/abc-xyz' }),
    ) as Record<string, unknown>;
    // systemInstruction MUST be omitted — Gemini rejects requests carrying
    // both inline systemInstruction and a cachedContent reference.
    assertEquals(body.systemInstruction, undefined);
    assertEquals(body.cachedContent, 'cachedContents/abc-xyz');
    // generationConfig (responseSchema, etc.) still travels per-call.
    assert(typeof body.generationConfig === 'object');
  },
);

Deno.test(
  'buildGeminiBody — empty/missing cached_content_name keeps systemInstruction inline (no regression)',
  () => {
    // Empty string and undefined both fall through to inline path.
    const empty = buildGeminiBody(baseReq({ cached_content_name: '' })) as Record<string, unknown>;
    const missing = buildGeminiBody(baseReq()) as Record<string, unknown>;
    for (const body of [empty, missing]) {
      assertEquals(body.cachedContent, undefined);
      const sys = body.systemInstruction as { parts: Array<{ text: string }> };
      assert(sys);
      assertEquals(sys.parts[0].text, 'You classify real-estate images.');
    }
  },
);

Deno.test('buildGeminiBody — multi-image batch packs all into one user turn', () => {
  const req = baseReq({
    images: [
      { source_type: 'base64', media_type: 'image/jpeg', data: 'a' },
      { source_type: 'base64', media_type: 'image/jpeg', data: 'b' },
      { source_type: 'base64', media_type: 'image/jpeg', data: 'c' },
    ],
  });
  const body = buildGeminiBody(req) as {
    contents: Array<{ role: string; parts: Array<{ inlineData?: { data: string }; text?: string }> }>;
  };
  assertEquals(body.contents.length, 1);
  const inlineParts = body.contents[0].parts.filter((p) => p.inlineData);
  assertEquals(inlineParts.length, 3);
  assertEquals(inlineParts[0].inlineData!.data, 'a');
  assertEquals(inlineParts[1].inlineData!.data, 'b');
  assertEquals(inlineParts[2].inlineData!.data, 'c');
});

Deno.test('buildGeminiBody — assistant prior_turn role becomes "model"', () => {
  const body = buildGeminiBody(baseReq({
    prior_turns: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ],
  })) as { contents: Array<{ role: string }> };
  assertEquals(body.contents[0].role, 'user');
  assertEquals(body.contents[1].role, 'model');
  assertEquals(body.contents[2].role, 'user');
});

Deno.test('buildGeminiBody — url-mode image throws (Gemini REST requires inline_data)', () => {
  const req = baseReq({
    images: [{ source_type: 'url', media_type: 'image/jpeg', url: 'https://example.com/x.jpg' }],
  });
  let thrown = false;
  try {
    buildGeminiBody(req);
  } catch (err) {
    thrown = true;
    assert(err instanceof VendorCallError);
    assert(err.message.includes("source_type='base64'"));
  }
  assert(thrown);
});

// ─── Response parsing ────────────────────────────────────────────────────────

Deno.test('extractGeminiOutput — picks first candidate JSON-text part', () => {
  const out = extractGeminiOutput({
    candidates: [
      {
        content: { parts: [{ text: '{"room_type":"foyer"}' }] },
        finishReason: 'STOP',
      },
    ],
  }, 'gemini-2.0-pro');
  assertEquals(out, { room_type: 'foyer' });
});

Deno.test('extractGeminiOutput — concatenates multiple text parts before parsing', () => {
  const out = extractGeminiOutput({
    candidates: [
      {
        content: { parts: [{ text: '{"room_type":' }, { text: '"kitchen"}' }] },
      },
    ],
  }, 'gemini-2.0-pro');
  assertEquals(out, { room_type: 'kitchen' });
});

Deno.test('extractGeminiOutput — wraps array root under `data` to satisfy Record contract', () => {
  const out = extractGeminiOutput({
    candidates: [
      { content: { parts: [{ text: '[{"a":1},{"b":2}]' }] } },
    ],
  }, 'gemini-2.0-pro');
  assertEquals(out, { data: [{ a: 1 }, { b: 2 }] });
});

Deno.test('extractGeminiOutput — throws on no candidates', () => {
  let thrown = false;
  try {
    extractGeminiOutput({ candidates: [] }, 'gemini-2.0-pro');
  } catch (err) {
    thrown = true;
    assert(err instanceof VendorCallError);
    assert(err.message.includes('No candidates'));
  }
  assert(thrown);
});

Deno.test('extractGeminiOutput — throws on unparseable text', () => {
  let thrown = false;
  try {
    extractGeminiOutput({
      candidates: [{ content: { parts: [{ text: 'not JSON at all' }] } }],
    }, 'gemini-2.0-pro');
  } catch (err) {
    thrown = true;
    assert(err instanceof VendorCallError);
    assert(err.message.includes('Failed to parse'));
  }
  assert(thrown);
});

// ─── Full call (mocked fetch) ────────────────────────────────────────────────

Deno.test('callGoogleVision — happy path returns parsed output + usage + cost', async () => {
  const orig = Deno.env.get('GEMINI_API_KEY');
  Deno.env.set('GEMINI_API_KEY', 'test-key-xxx');
  const captured: { lastUrl?: string; lastBody?: unknown } = {};
  const restore = installMockFetch({
    body: {
      candidates: [
        {
          content: { parts: [{ text: '{"room_type":"living_room"}' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 8000, candidatesTokenCount: 200 },
      modelVersion: 'gemini-2.0-pro-001',
      responseId: 'resp_abc',
    },
    capture: captured,
  });
  try {
    const res = await callGoogleVision(baseReq());
    assertEquals(res.output, { room_type: 'living_room' });
    assertEquals(res.usage.input_tokens, 8000);
    assertEquals(res.usage.output_tokens, 200);
    assertEquals(res.usage.cached_input_tokens, 0);
    // 8000*3.5/1M + 200*10.5/1M = 0.028 + 0.0021 = 0.0301
    assertAlmostEquals(res.usage.estimated_cost_usd, 0.0301, 1e-9);
    assertEquals(res.vendor_meta.vendor, 'google');
    assertEquals(res.vendor_meta.model, 'gemini-2.0-pro-001');
    assertEquals(res.vendor_meta.request_id, 'resp_abc');
    assertEquals(res.vendor_meta.finish_reason, 'stop');
    assert(res.vendor_meta.elapsed_ms >= 0);
    assert(captured.lastUrl?.includes('gemini-2.0-pro:generateContent'));
    assert(captured.lastUrl?.includes('key=test-key-xxx'));
  } finally {
    restore();
    if (orig === undefined) Deno.env.delete('GEMINI_API_KEY');
    else Deno.env.set('GEMINI_API_KEY', orig);
  }
});

Deno.test('callGoogleVision — cached input tokens subtract from prompt tokens to avoid double-count', async () => {
  const orig = Deno.env.get('GEMINI_API_KEY');
  Deno.env.set('GEMINI_API_KEY', 'test-key-xxx');
  const restore = installMockFetch({
    body: {
      candidates: [{ content: { parts: [{ text: '{"a":1}' }] }, finishReason: 'STOP' }],
      usageMetadata: {
        promptTokenCount: 10_000,
        candidatesTokenCount: 100,
        cachedContentTokenCount: 6_000,
      },
    },
  });
  try {
    const res = await callGoogleVision(baseReq());
    assertEquals(res.usage.input_tokens, 4_000); // 10000 - 6000
    assertEquals(res.usage.cached_input_tokens, 6_000);
    assertEquals(res.usage.output_tokens, 100);
  } finally {
    restore();
    if (orig === undefined) Deno.env.delete('GEMINI_API_KEY');
    else Deno.env.set('GEMINI_API_KEY', orig);
  }
});

Deno.test('callGoogleVision — request body validates against capture (schema enforcement)', async () => {
  const orig = Deno.env.get('GEMINI_API_KEY');
  Deno.env.set('GEMINI_API_KEY', 'test-key-xxx');
  const captured: { lastBody?: unknown } = {};
  const restore = installMockFetch({
    body: {
      candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    },
    capture: captured,
  });
  try {
    await callGoogleVision(baseReq());
    const body = captured.lastBody as Record<string, unknown>;
    const cfg = body.generationConfig as Record<string, unknown>;
    assertEquals(cfg.responseMimeType, 'application/json');
    assertObjectMatch(cfg.responseSchema as Record<string, unknown>, { type: 'object' });
  } finally {
    restore();
    if (orig === undefined) Deno.env.delete('GEMINI_API_KEY');
    else Deno.env.set('GEMINI_API_KEY', orig);
  }
});

Deno.test('callGoogleVision — finish_reason MAX_TOKENS maps to length', async () => {
  const orig = Deno.env.get('GEMINI_API_KEY');
  Deno.env.set('GEMINI_API_KEY', 'test-key-xxx');
  const restore = installMockFetch({
    body: {
      candidates: [
        { content: { parts: [{ text: '{"a":1}' }] }, finishReason: 'MAX_TOKENS' },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    },
  });
  try {
    const res = await callGoogleVision(baseReq());
    assertEquals(res.vendor_meta.finish_reason, 'length');
  } finally {
    restore();
    if (orig === undefined) Deno.env.delete('GEMINI_API_KEY');
    else Deno.env.set('GEMINI_API_KEY', orig);
  }
});

Deno.test('callGoogleVision — finish_reason SAFETY maps to safety', async () => {
  const orig = Deno.env.get('GEMINI_API_KEY');
  Deno.env.set('GEMINI_API_KEY', 'test-key-xxx');
  const restore = installMockFetch({
    body: {
      candidates: [
        { content: { parts: [{ text: '{"a":1}' }] }, finishReason: 'SAFETY' },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    },
  });
  try {
    const res = await callGoogleVision(baseReq());
    assertEquals(res.vendor_meta.finish_reason, 'safety');
  } finally {
    restore();
    if (orig === undefined) Deno.env.delete('GEMINI_API_KEY');
    else Deno.env.set('GEMINI_API_KEY', orig);
  }
});

Deno.test('callGoogleVision — non-2xx non-retryable status surfaces as VendorCallError', async () => {
  const orig = Deno.env.get('GEMINI_API_KEY');
  Deno.env.set('GEMINI_API_KEY', 'test-key-xxx');
  const restore = installMockFetch({
    status: 400,
    bodyText: '{"error":{"code":400,"message":"bad schema"}}',
  });
  try {
    await assertRejects(
      () => callGoogleVision(baseReq()),
      VendorCallError,
    );
  } finally {
    restore();
    if (orig === undefined) Deno.env.delete('GEMINI_API_KEY');
    else Deno.env.set('GEMINI_API_KEY', orig);
  }
});

Deno.test('callGoogleVision — throws MissingVendorCredential when GEMINI_API_KEY unset', async () => {
  const orig = Deno.env.get('GEMINI_API_KEY');
  Deno.env.delete('GEMINI_API_KEY');
  try {
    await assertRejects(
      () => callGoogleVision(baseReq()),
      MissingVendorCredential,
    );
  } finally {
    if (orig !== undefined) Deno.env.set('GEMINI_API_KEY', orig);
  }
});

// ─── W11.8.2: pricing rate corrections ───────────────────────────────────────

Deno.test('estimateCost — gemini-2.5-pro uses corrected $1.25 / $10.00 rates', () => {
  // Stage 1 single-image envelope: 100K input + 1K output.
  // Expected: 100000 * 1.25 / 1M + 1000 * 10.00 / 1M = 0.125 + 0.01 = 0.135.
  // Pre-W11.8.2 (broken) rates would have produced 0.315 here.
  const cost = estimateCost('google', 'gemini-2.5-pro', {
    input_tokens: 100_000,
    output_tokens: 1_000,
    cached_input_tokens: 0,
  });
  assertAlmostEquals(cost, 0.135, 1e-9);
});

Deno.test('estimateCost — gemini-2.5-flash uses corrected $0.30 / $2.50 rates', () => {
  // Pulse listing extract envelope: 100K input + 1K output.
  // Expected: 100000 * 0.30 / 1M + 1000 * 2.50 / 1M = 0.030 + 0.0025 = 0.0325.
  // Pre-W11.8.2 (broken) rates would have produced 0.014 here (under-counted).
  const cost = estimateCost('google', 'gemini-2.5-flash', {
    input_tokens: 100_000,
    output_tokens: 1_000,
    cached_input_tokens: 0,
  });
  assertAlmostEquals(cost, 0.0325, 1e-9);
});

Deno.test('estimateCost — unknown google model falls back to Gemini 2.5 Pro rates', () => {
  // Fallback assertion: $1.25 / $10.00 (Gemini 2.5 Pro published rate, used
  // when a model row hasn't been registered). Pre-W11.8.2 fallback was Sonnet
  // rates ($3.50 / $10.50) — too aggressive given no Gemini model has ever
  // charged that.
  const cost = estimateCost('google', 'gemini-future-model-2030', {
    input_tokens: 100_000,
    output_tokens: 1_000,
    cached_input_tokens: 0,
  });
  assertAlmostEquals(cost, 0.135, 1e-9);
});

// ─── W11.8.2 (Fix C): thoughtsTokenCount propagation ─────────────────────────

Deno.test('callGoogleVision — propagates thoughtsTokenCount as usage.thinking_tokens', async () => {
  const orig = Deno.env.get('GEMINI_API_KEY');
  Deno.env.set('GEMINI_API_KEY', 'test-key-xxx');
  const restore = installMockFetch({
    body: {
      candidates: [{ content: { parts: [{ text: '{"a":1}' }] }, finishReason: 'STOP' }],
      usageMetadata: {
        promptTokenCount: 1_000,
        candidatesTokenCount: 500,
        thoughtsTokenCount: 1_900,
      },
    },
  });
  try {
    const res = await callGoogleVision(baseReq());
    // Pre-W11.8.2: thoughtsTokenCount silently dropped → thinking_tokens=0.
    // Post-fix: propagated through to usage.thinking_tokens.
    assertEquals(res.usage.thinking_tokens, 1_900);
  } finally {
    restore();
    if (orig === undefined) Deno.env.delete('GEMINI_API_KEY');
    else Deno.env.set('GEMINI_API_KEY', orig);
  }
});

Deno.test('callGoogleVision — thinking_tokens defaults to 0 when vendor omits the field', async () => {
  const orig = Deno.env.get('GEMINI_API_KEY');
  Deno.env.set('GEMINI_API_KEY', 'test-key-xxx');
  const restore = installMockFetch({
    body: {
      candidates: [{ content: { parts: [{ text: '{"a":1}' }] }, finishReason: 'STOP' }],
      // No thoughtsTokenCount — Gemini doesn't always report it (e.g. when
      // thinkingBudget=0 on Flash).
      usageMetadata: { promptTokenCount: 1_000, candidatesTokenCount: 500 },
    },
  });
  try {
    const res = await callGoogleVision(baseReq());
    assertEquals(res.usage.thinking_tokens, 0);
  } finally {
    restore();
    if (orig === undefined) Deno.env.delete('GEMINI_API_KEY');
    else Deno.env.set('GEMINI_API_KEY', orig);
  }
});
