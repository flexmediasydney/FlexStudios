/**
 * adapters/anthropic.ts — Wave 11.8 Anthropic vision adapter.
 *
 * Translates VisionRequest → Anthropic /v1/messages call → VisionResponse.
 *
 * Strict-JSON output mode: uses tool-use with `tool_choice: {type: 'tool',
 * name: tool_name}` so the model is forced to emit a single tool_use block
 * with structured JSON input matching `tool_input_schema`. We extract that
 * input as `output` on the response.
 *
 * Prompt caching: when `enable_prompt_cache=true`, the system message gets
 * `cache_control: {type: 'ephemeral'}`. The image blocks (the stable bulk of
 * the request) ALSO get cache_control on the LAST image — Anthropic caches
 * everything up to (and including) the last cache_control marker. This keeps
 * a single ephemeral cache breakpoint per request, matching their docs.
 *
 * Auth: ANTHROPIC_API_KEY (or CLAUDE_API_KEY for backward-compat with the
 * legacy `anthropicVision.ts`). Throws MissingVendorCredential when neither is
 * set.
 *
 * Retry / timeout: matches the legacy module's behaviour — 3 attempts on
 * 429/500/502/503 with exponential backoff (1s, 2s, 4s), AbortSignal timeout
 * defaulting to 90s.
 */

import {
  type VisionImage,
  type VisionRequest,
  type VisionResponse,
  type VisionUsage,
  type VisionVendorMeta,
  MissingVendorCredential,
  VendorCallError,
} from '../types.ts';
import { estimateCost } from '../pricing.ts';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 90 * 1000;
const BACKOFF_MS = [1000, 2000, 4000];

function getApiKey(): string {
  const key =
    Deno.env.get('CLAUDE_API_KEY') ||
    Deno.env.get('ANTHROPIC_API_KEY') ||
    '';
  if (!key) {
    throw new MissingVendorCredential('anthropic', 'ANTHROPIC_API_KEY');
  }
  return key;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503;
}

// ─── Body builder ────────────────────────────────────────────────────────────

interface AnthropicImageSourceBase64 {
  type: 'base64';
  media_type: string;
  data: string;
}
interface AnthropicImageSourceUrl {
  type: 'url';
  url: string;
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

function toAnthropicImage(img: VisionImage): {
  type: 'image';
  source: AnthropicImageSourceBase64 | AnthropicImageSourceUrl;
  cache_control?: { type: 'ephemeral' };
} {
  if (img.source_type === 'base64') {
    if (!img.data) {
      throw new VendorCallError(
        'anthropic',
        '',
        'base64 image requires data field',
      );
    }
    return {
      type: 'image',
      source: { type: 'base64', media_type: img.media_type, data: img.data },
    };
  }
  if (!img.url) {
    throw new VendorCallError(
      'anthropic',
      '',
      'url image requires url field',
    );
  }
  return { type: 'image', source: { type: 'url', url: img.url } };
}

/**
 * Build the Anthropic /v1/messages request body from a VisionRequest.
 * Exported for unit testing.
 */
export function buildAnthropicBody(req: VisionRequest): Record<string, unknown> {
  const enableCache = req.enable_prompt_cache === true;

  // System message. With caching, attach cache_control so the system block is
  // cached as part of the stable prefix.
  const systemArr: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> =
    [{ type: 'text', text: req.system }];
  if (enableCache && systemArr[0]) {
    systemArr[0].cache_control = { type: 'ephemeral' };
  }

  // User message: images first (stable), then text. With caching, mark the
  // LAST image with cache_control so everything up to it is cached.
  const imageBlocks = req.images.map((img) => toAnthropicImage(img));
  if (enableCache && imageBlocks.length > 0) {
    imageBlocks[imageBlocks.length - 1].cache_control = { type: 'ephemeral' };
  }

  const userContent: Array<unknown> = [
    ...imageBlocks,
    { type: 'text', text: req.user_text },
  ];

  // Build messages array — prior_turns first, then this user turn.
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
  if (Array.isArray(req.prior_turns)) {
    for (const t of req.prior_turns) {
      messages.push({ role: t.role, content: t.content });
    }
  }
  messages.push({ role: 'user', content: userContent });

  const tool: AnthropicTool = {
    name: req.tool_name,
    description: `Structured output for ${req.tool_name}.`,
    input_schema: req.tool_input_schema,
  };

  // Opus 4.7 + later Anthropic models deprecate temperature parameter — they
  // throw 400 "temperature is deprecated for this model". Only include
  // temperature on models that still accept it. Conservative whitelist:
  // sonnet/haiku 4.x and earlier opus/sonnet generations.
  const acceptsTemperature = !/^claude-opus-4-[7-9]/i.test(req.model)
    && !/^claude-opus-[5-9]/i.test(req.model);
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.max_output_tokens,
    ...(acceptsTemperature ? { temperature: req.temperature ?? 0 } : {}),
    system: systemArr,
    messages,
    tools: [tool],
    tool_choice: { type: 'tool', name: req.tool_name },
  };
  return body;
}

// ─── Response parsing ────────────────────────────────────────────────────────

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AnthropicContentBlock {
  type: 'text' | 'tool_use';
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  id?: string;
}

interface AnthropicResponseBody {
  id?: string;
  model?: string;
  stop_reason?: string;
  usage?: AnthropicUsage;
  content?: AnthropicContentBlock[];
}

function mapStopReason(stop?: string): VisionVendorMeta['finish_reason'] {
  switch (stop) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_use';
    case 'stop_sequence':
      return 'stop';
    default:
      return 'stop';
  }
}

/**
 * Extract the structured tool_use input from an Anthropic response body.
 * Throws VendorCallError if no tool_use block is present (the model didn't
 * follow the tool_choice instruction).
 *
 * Exported for unit testing.
 */
export function extractToolUseOutput(
  raw: AnthropicResponseBody,
  model: string,
): Record<string, unknown> {
  const blocks = Array.isArray(raw.content) ? raw.content : [];
  for (const b of blocks) {
    if (b?.type === 'tool_use' && b.input && typeof b.input === 'object') {
      return b.input;
    }
  }
  // Fallback — if no tool_use block, look for a text block we can parse as
  // JSON. This shouldn't happen with tool_choice enforced, but defensive.
  for (const b of blocks) {
    if (b?.type === 'text' && typeof b.text === 'string') {
      const txt = b.text.trim();
      if (txt.startsWith('{') || txt.startsWith('[')) {
        try {
          return JSON.parse(txt) as Record<string, unknown>;
        } catch {
          // fallthrough to error below
        }
      }
    }
  }
  throw new VendorCallError(
    'anthropic',
    model,
    'No tool_use block in response (tool_choice was supposed to force one)',
  );
}

function buildUsage(
  vendorUsage: AnthropicUsage | undefined,
  model: string,
): VisionUsage {
  const u = vendorUsage || {};
  const input_tokens = u.input_tokens || 0;
  const output_tokens = u.output_tokens || 0;
  // cache_creation tokens are billed at standard input rate; cache_read tokens
  // are billed at the cached-input rate (when configured). Combine
  // creation+read into cached_input_tokens for the unified shape — the
  // pricing.estimateCost call uses cachedInputPerMillion when present, else
  // falls back to inputPerMillion (which matches Anthropic's current cache
  // policy of charging full input rate for creation).
  const cached_input_tokens =
    (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const estimated_cost_usd = estimateCost('anthropic', model, {
    input_tokens,
    output_tokens,
    cached_input_tokens,
  });
  return { input_tokens, output_tokens, cached_input_tokens, estimated_cost_usd };
}

// ─── Public entrypoint ───────────────────────────────────────────────────────

export async function callAnthropicVision(
  req: VisionRequest,
): Promise<VisionResponse> {
  if (req.vendor !== 'anthropic') {
    throw new VendorCallError(
      'anthropic',
      req.model,
      `callAnthropicVision invoked with vendor='${req.vendor}'`,
    );
  }

  const apiKey = getApiKey();
  const body = buildAnthropicBody(req);
  const timeoutMs = req.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const startMs = Date.now();
  let lastErr: string | null = null;
  let lastStatus: number | undefined = undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const rawText = await res.text();
      if (res.ok) {
        let parsed: AnthropicResponseBody;
        try {
          parsed = JSON.parse(rawText) as AnthropicResponseBody;
        } catch {
          throw new VendorCallError(
            'anthropic',
            req.model,
            `Non-JSON response: ${rawText.slice(0, 400)}`,
            res.status,
          );
        }
        const output = extractToolUseOutput(parsed, req.model);
        const usage = buildUsage(parsed.usage, req.model);
        const vendor_meta: VisionVendorMeta = {
          vendor: 'anthropic',
          model: typeof parsed.model === 'string' ? parsed.model : req.model,
          request_id: typeof parsed.id === 'string' ? parsed.id : '',
          finish_reason: mapStopReason(parsed.stop_reason),
          elapsed_ms: Date.now() - startMs,
        };
        return {
          output,
          usage,
          vendor_meta,
          raw_response_excerpt: rawText.slice(0, 2000),
        };
      }

      lastStatus = res.status;
      lastErr = `${res.status}: ${rawText.slice(0, 400)}`;

      if (!isRetryableStatus(res.status)) {
        throw new VendorCallError(
          'anthropic',
          req.model,
          `Anthropic ${res.status}: ${rawText.slice(0, 400)}`,
          res.status,
        );
      }
      // retryable — fall through to backoff
    } catch (err) {
      // VendorCallError thrown above for non-retryable HTTP — re-throw.
      if (err instanceof VendorCallError) throw err;
      // Other errors (timeout, network, JSON-parse on retryable path) → retry.
      lastErr = err instanceof Error ? err.message : String(err);
    }

    if (attempt < MAX_ATTEMPTS - 1) {
      const delay = BACKOFF_MS[attempt] || 4000;
      console.warn(
        `[visionAdapter/anthropic] retrying after ${delay}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS}): ${lastErr}`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw new VendorCallError(
    'anthropic',
    req.model,
    `Anthropic API exhausted ${MAX_ATTEMPTS} attempts: ${lastErr || 'unknown error'}`,
    lastStatus,
  );
}
