/**
 * visionAdapter.anthropic.test.ts — Wave 11.8 unit tests for the Anthropic
 * adapter. Validates request shape (tool_use + cache_control), response
 * parsing (tool_use input extraction + text fallback), and cost computation.
 *
 * Run: deno test --no-check --allow-all supabase/functions/_shared/visionAdapter.anthropic.test.ts
 */

import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertObjectMatch,
  assertRejects,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  buildAnthropicBody,
  callAnthropicVision,
  extractToolUseOutput,
} from './visionAdapter/adapters/anthropic.ts';
import { MissingVendorCredential, type VisionRequest } from './visionAdapter/index.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function baseReq(overrides: Partial<VisionRequest> = {}): VisionRequest {
  return {
    vendor: 'anthropic',
    model: 'claude-sonnet-4-6',
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

Deno.test('buildAnthropicBody — model + max_tokens + temperature defaults to 0', () => {
  const body = buildAnthropicBody(baseReq()) as {
    model: string;
    max_tokens: number;
    temperature: number;
  };
  assertEquals(body.model, 'claude-sonnet-4-6');
  assertEquals(body.max_tokens, 1500);
  assertEquals(body.temperature, 0);
});

Deno.test('buildAnthropicBody — temperature passed through when set', () => {
  const body = buildAnthropicBody(baseReq({ temperature: 0.7 })) as { temperature: number };
  assertEquals(body.temperature, 0.7);
});

Deno.test('buildAnthropicBody — system message wrapped in array form', () => {
  const body = buildAnthropicBody(baseReq()) as {
    system: Array<{ type: string; text: string; cache_control?: unknown }>;
  };
  assert(Array.isArray(body.system));
  assertEquals(body.system[0].type, 'text');
  assertEquals(body.system[0].text, 'You classify real-estate images.');
  // No cache_control by default.
  assertEquals(body.system[0].cache_control, undefined);
});

Deno.test('buildAnthropicBody — enable_prompt_cache attaches cache_control to system + last image', () => {
  const body = buildAnthropicBody(baseReq({
    enable_prompt_cache: true,
    images: [
      { source_type: 'base64', media_type: 'image/jpeg', data: 'aaa' },
      { source_type: 'base64', media_type: 'image/jpeg', data: 'bbb' },
    ],
  })) as {
    system: Array<{ cache_control?: { type: string } }>;
    messages: Array<{ content: Array<{ type: string; cache_control?: { type: string } }> }>;
  };
  // System cache_control set.
  assertEquals(body.system[0].cache_control, { type: 'ephemeral' });
  // The user message's image blocks: only the LAST image has cache_control.
  const userContent = body.messages[0].content;
  const imageBlocks = userContent.filter((b) => b.type === 'image');
  assertEquals(imageBlocks.length, 2);
  assertEquals(imageBlocks[0].cache_control, undefined);
  assertEquals(imageBlocks[1].cache_control, { type: 'ephemeral' });
});

Deno.test('buildAnthropicBody — tool_choice forces our tool name', () => {
  const body = buildAnthropicBody(baseReq()) as {
    tools: Array<{ name: string; input_schema: unknown }>;
    tool_choice: { type: string; name: string };
  };
  assertEquals(body.tools.length, 1);
  assertEquals(body.tools[0].name, 'classify_image');
  assertObjectMatch(body.tools[0].input_schema as Record<string, unknown>, {
    type: 'object',
  });
  assertEquals(body.tool_choice, { type: 'tool', name: 'classify_image' });
});

Deno.test('buildAnthropicBody — base64 images become source.type=base64 with media_type', () => {
  const body = buildAnthropicBody(baseReq()) as {
    messages: Array<{ content: Array<{ type: string; source?: { type: string; media_type?: string; data?: string; url?: string } }> }>;
  };
  const imageBlock = body.messages[0].content.find((b) => b.type === 'image')!;
  assertEquals(imageBlock.source!.type, 'base64');
  assertEquals(imageBlock.source!.media_type, 'image/jpeg');
  assertEquals(imageBlock.source!.data, 'ZmFrZS1iYXNlNjQ=');
});

Deno.test('buildAnthropicBody — url images become source.type=url', () => {
  const req = baseReq({
    images: [{ source_type: 'url', media_type: 'image/jpeg', url: 'https://example.com/x.jpg' }],
  });
  const body = buildAnthropicBody(req) as {
    messages: Array<{ content: Array<{ type: string; source?: { type: string; url?: string } }> }>;
  };
  const imageBlock = body.messages[0].content.find((b) => b.type === 'image')!;
  assertEquals(imageBlock.source!.type, 'url');
  assertEquals(imageBlock.source!.url, 'https://example.com/x.jpg');
});

Deno.test('buildAnthropicBody — prior_turns prepended before user message', () => {
  const body = buildAnthropicBody(baseReq({
    prior_turns: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
    ],
  })) as { messages: Array<{ role: string }> };
  assertEquals(body.messages.length, 3);
  assertEquals(body.messages[0].role, 'user');
  assertEquals(body.messages[1].role, 'assistant');
  assertEquals(body.messages[2].role, 'user');
});

// ─── Tool-use extraction ─────────────────────────────────────────────────────

Deno.test('extractToolUseOutput — picks the tool_use input block', () => {
  const out = extractToolUseOutput({
    content: [
      { type: 'text', text: 'thinking…' },
      { type: 'tool_use', name: 'classify_image', input: { room_type: 'living_room' }, id: 'tu_1' },
    ],
  }, 'claude-sonnet-4-6');
  assertEquals(out, { room_type: 'living_room' });
});

Deno.test('extractToolUseOutput — falls back to JSON-like text when no tool_use block', () => {
  const out = extractToolUseOutput({
    content: [{ type: 'text', text: '{"room_type":"kitchen"}' }],
  }, 'claude-sonnet-4-6');
  assertEquals(out, { room_type: 'kitchen' });
});

Deno.test('extractToolUseOutput — throws when no tool_use and no parseable text', () => {
  let thrown = false;
  try {
    extractToolUseOutput({ content: [{ type: 'text', text: 'no JSON here' }] }, 'claude-sonnet-4-6');
  } catch (err) {
    thrown = true;
    assert(err instanceof Error);
    assert(err.message.includes('No tool_use'));
  }
  assert(thrown);
});

// ─── Full call (mocked fetch) ────────────────────────────────────────────────

Deno.test('callAnthropicVision — happy path returns parsed output + usage + cost', async () => {
  const orig = Deno.env.get('ANTHROPIC_API_KEY');
  Deno.env.set('ANTHROPIC_API_KEY', 'test-key-xxx');

  const restore = installMockFetch({
    body: {
      id: 'msg_abc',
      model: 'claude-sonnet-4-6',
      stop_reason: 'tool_use',
      usage: { input_tokens: 1000, output_tokens: 500 },
      content: [
        { type: 'tool_use', name: 'classify_image', input: { room_type: 'bedroom' }, id: 'tu_1' },
      ],
    },
  });

  try {
    const res = await callAnthropicVision(baseReq());
    assertEquals(res.output, { room_type: 'bedroom' });
    assertEquals(res.usage.input_tokens, 1000);
    assertEquals(res.usage.output_tokens, 500);
    assertEquals(res.usage.cached_input_tokens, 0);
    // 1000*3/1M + 500*15/1M = 0.0105
    assertAlmostEquals(res.usage.estimated_cost_usd, 0.0105, 1e-9);
    assertEquals(res.vendor_meta.vendor, 'anthropic');
    assertEquals(res.vendor_meta.model, 'claude-sonnet-4-6');
    assertEquals(res.vendor_meta.request_id, 'msg_abc');
    assertEquals(res.vendor_meta.finish_reason, 'tool_use');
    assert(res.vendor_meta.elapsed_ms >= 0);
    assert(res.raw_response_excerpt.length > 0);
    assert(res.raw_response_excerpt.includes('msg_abc'));
  } finally {
    restore();
    if (orig === undefined) Deno.env.delete('ANTHROPIC_API_KEY');
    else Deno.env.set('ANTHROPIC_API_KEY', orig);
  }
});

Deno.test('callAnthropicVision — cache_creation + cache_read aggregate into cached_input_tokens', async () => {
  const orig = Deno.env.get('ANTHROPIC_API_KEY');
  Deno.env.set('ANTHROPIC_API_KEY', 'test-key-xxx');
  const restore = installMockFetch({
    body: {
      id: 'msg_x',
      model: 'claude-opus-4-7',
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 100,
        output_tokens: 200,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 1500,
      },
      content: [{ type: 'tool_use', name: 'classify_image', input: { room_type: 'kitchen' } }],
    },
  });
  try {
    const res = await callAnthropicVision(baseReq({ model: 'claude-opus-4-7' }));
    assertEquals(res.usage.cached_input_tokens, 2000);
  } finally {
    restore();
    if (orig === undefined) Deno.env.delete('ANTHROPIC_API_KEY');
    else Deno.env.set('ANTHROPIC_API_KEY', orig);
  }
});

Deno.test('callAnthropicVision — request body validates against capture', async () => {
  const orig = Deno.env.get('ANTHROPIC_API_KEY');
  Deno.env.set('ANTHROPIC_API_KEY', 'test-key-xxx');
  const captured: { lastBody?: unknown } = {};
  const restore = installMockFetch({
    body: {
      id: 'msg_x',
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [{ type: 'tool_use', name: 'classify_image', input: { room_type: 'foyer' } }],
    },
    capture: captured,
  });
  try {
    await callAnthropicVision(baseReq({ enable_prompt_cache: true }));
    const body = captured.lastBody as Record<string, unknown>;
    assertEquals(body.model, 'claude-sonnet-4-6');
    const tools = body.tools as Array<{ name: string }>;
    assertEquals(tools[0].name, 'classify_image');
    const toolChoice = body.tool_choice as { type: string; name: string };
    assertEquals(toolChoice.name, 'classify_image');
  } finally {
    restore();
    if (orig === undefined) Deno.env.delete('ANTHROPIC_API_KEY');
    else Deno.env.set('ANTHROPIC_API_KEY', orig);
  }
});

Deno.test('callAnthropicVision — throws MissingVendorCredential when ANTHROPIC_API_KEY unset', async () => {
  const origAnthropic = Deno.env.get('ANTHROPIC_API_KEY');
  const origClaude = Deno.env.get('CLAUDE_API_KEY');
  Deno.env.delete('ANTHROPIC_API_KEY');
  Deno.env.delete('CLAUDE_API_KEY');
  try {
    await assertRejects(
      () => callAnthropicVision(baseReq()),
      MissingVendorCredential,
    );
  } finally {
    if (origAnthropic !== undefined) Deno.env.set('ANTHROPIC_API_KEY', origAnthropic);
    if (origClaude !== undefined) Deno.env.set('CLAUDE_API_KEY', origClaude);
  }
});
