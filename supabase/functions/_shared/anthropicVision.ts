/**
 * anthropicVision.ts — Wave 11.8 thin compatibility wrapper for legacy passes.
 *
 * Original module preserved for backward-compat: existing Pass 0/1/2 + the
 * benchmark runner all import `callClaudeVision({model, messages, system,
 * max_tokens, temperature})` and expect `{content, raw, usage, costUsd,
 * durationMs, model}`. They emit free-form text, NOT tool-use JSON, and parse
 * the text themselves (lenient JSON extraction in pass1/pass2).
 *
 * W11.8.1 (2026-05-01): Anthropic stripped from the W11.8 vision adapter.
 * Pricing previously delegated to `visionAdapter/pricing.ts` for a single
 * source of truth — that table no longer carries Anthropic rows. This file
 * now carries its own internal Anthropic rate table for the legacy passes
 * (sunset ~June 1 per W11.7.10). Once the legacy passes are deleted, this
 * file goes with them.
 *
 * New code (Shape D Stage 1 + 4, finals-qa, pulse-listing-vision-extract,
 * floorplan-ocr-extractor) uses `_shared/visionAdapter/index.ts →
 * callVisionAdapter` directly — Gemini-only, tool-use mode, strict JSON.
 *
 * API key resolution: CLAUDE_API_KEY → ANTHROPIC_API_KEY (fallback).
 *
 * Image input modes:
 *   - 'base64': inline image bytes (use for small/private images we already hold)
 *   - 'url':    Anthropic's hosted-image fetch — the API server fetches it.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface VisionImage {
  type: 'base64' | 'url';
  /** Base64-encoded image bytes (no data: prefix). Required for type='base64'. */
  data?: string;
  /** Direct URL — Anthropic's server fetches this. Required for type='url'. */
  url?: string;
  /** 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'. Required for type='base64'. */
  media_type?: string;
}

export interface VisionMessage {
  role: 'user' | 'assistant';
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; source: VisionImage }
  >;
}

export interface VisionCallOptions {
  model: string;
  messages: VisionMessage[];
  system?: string;
  max_tokens: number;
  /** Default 0 — deterministic for classification. */
  temperature?: number;
}

export interface VisionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface VisionCallResult {
  /** Concatenated text content from response.content[].text. */
  content: string;
  /** Full response body for debugging / advanced parsing. */
  raw: any;
  usage: VisionUsage;
  /** USD cost computed from usage × per-model rates. */
  costUsd: number;
  /** Wall-clock duration for the entire call (including retries). */
  durationMs: number;
  /** Anthropic model id that handled the call (echoed from response.model). */
  model: string;
}

// ─── HTTP / retry primitives ─────────────────────────────────────────────────

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 90 * 1000;
const BACKOFF_MS = [1000, 2000, 4000];

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503;
}

function getApiKey(): string {
  const key =
    Deno.env.get('CLAUDE_API_KEY') ||
    Deno.env.get('ANTHROPIC_API_KEY') ||
    '';
  if (!key) {
    throw new Error(
      'Anthropic API key not configured (set CLAUDE_API_KEY or ANTHROPIC_API_KEY)',
    );
  }
  return key;
}

/**
 * Format the request body Anthropic expects. Image sources differ per type:
 *   base64: { type: 'base64', media_type, data }
 *   url:    { type: 'url', url }
 */
function buildAnthropicBody(opts: VisionCallOptions): Record<string, unknown> {
  const messages = opts.messages.map((m) => ({
    role: m.role,
    content: m.content.map((part) => {
      if (part.type === 'text') return { type: 'text', text: part.text };
      // image
      const src = part.source;
      if (src.type === 'base64') {
        if (!src.data || !src.media_type) {
          throw new Error('base64 image requires data + media_type');
        }
        return {
          type: 'image',
          source: { type: 'base64', media_type: src.media_type, data: src.data },
        };
      }
      // url mode
      if (!src.url) throw new Error('url image requires url');
      return { type: 'image', source: { type: 'url', url: src.url } };
    }),
  }));

  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.max_tokens,
    temperature: opts.temperature ?? 0,
    messages,
  };
  if (opts.system) body.system = opts.system;
  return body;
}

/**
 * Concatenate all text blocks from the Anthropic response.
 * Anthropic returns `response.content` as an array of { type, text } blocks
 * — we only care about text for now (no tool_use / image blocks expected here).
 */
function extractText(raw: any): string {
  if (!raw || !Array.isArray(raw.content)) return '';
  const out: string[] = [];
  for (const block of raw.content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      out.push(block.text);
    }
  }
  return out.join('');
}

// W11.8.1: internal Anthropic rate table (USD per 1M tokens). Kept here so
// the legacy passes don't depend on the W11.8 visionAdapter pricing table
// (which dropped Anthropic rows when the failover was stripped). Sunset with
// the legacy passes themselves on ~June 1 (W11.7.10).
const ANTHROPIC_RATES: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {
  'claude-haiku-4': { inputPerMillion: 1.0, outputPerMillion: 5.0 },
  'claude-haiku-4-5': { inputPerMillion: 1.0, outputPerMillion: 5.0 },
  'claude-sonnet-4-6': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  'claude-opus-4-7': { inputPerMillion: 15.0, outputPerMillion: 75.0 },
};
// Fallback for unknown models — Sonnet rates so cost tracking errs upward.
const ANTHROPIC_FALLBACK_RATES = { inputPerMillion: 3.0, outputPerMillion: 15.0 };

function resolveAnthropicRates(model: string): { inputPerMillion: number; outputPerMillion: number } {
  if (ANTHROPIC_RATES[model]) return ANTHROPIC_RATES[model];
  // Strip a trailing -YYYYMMDD date suffix and retry.
  const stripped = model.replace(/-\d{8}$/, '');
  if (ANTHROPIC_RATES[stripped]) return ANTHROPIC_RATES[stripped];
  console.warn(
    `[anthropicVision/pricing] unknown model '${model}' — defaulting to Sonnet rates`,
  );
  return ANTHROPIC_FALLBACK_RATES;
}

/**
 * USD cost from a free-form-text call. Uses the internal Anthropic rate table
 * above. Cached-input tokens (creation + read) bill at standard input rate
 * (no cache-read discount modelled — Anthropic's policy as of W11.8 was full
 * input rate for creation + ~10% for reads, but the legacy passes sunset
 * before fine-grained cache pricing matters).
 */
function computeCost(model: string, usage: VisionUsage): number {
  const rates = resolveAnthropicRates(model);
  const inputTokens = Math.max(0, usage.input_tokens || 0);
  const outputTokens = Math.max(0, usage.output_tokens || 0);
  const cachedTokens = Math.max(
    0,
    (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0),
  );
  const cost =
    (inputTokens * rates.inputPerMillion) / 1_000_000 +
    (cachedTokens * rates.inputPerMillion) / 1_000_000 +
    (outputTokens * rates.outputPerMillion) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Call Claude with vision + retries + cost tracking.
 *
 * Errors:
 *   - Throws on missing API key (config error — caller should handle 503).
 *   - Throws after exhausting retries on transient 5xx / 429.
 *   - Throws immediately on 4xx (other than 429) — caller's prompt is wrong.
 */
export async function callClaudeVision(
  opts: VisionCallOptions,
): Promise<VisionCallResult> {
  const apiKey = getApiKey();
  const body = buildAnthropicBody(opts);
  const startMs = Date.now();
  let lastErr: string | null = null;

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
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (res.ok) {
        const raw = await res.json();
        const usage: VisionUsage = raw.usage || { input_tokens: 0, output_tokens: 0 };
        return {
          content: extractText(raw),
          raw,
          usage,
          costUsd: computeCost(opts.model, usage),
          durationMs: Date.now() - startMs,
          model: typeof raw.model === 'string' ? raw.model : opts.model,
        };
      }

      const errText = await res.text().catch(() => '');
      lastErr = `${res.status}: ${errText.slice(0, 400)}`;

      if (!isRetryableStatus(res.status)) {
        throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 400)}`);
      }
      // retryable — fall through to backoff below
    } catch (err) {
      // AbortError (timeout) and network errors land here — retryable.
      const msg = err instanceof Error ? err.message : String(err);
      // If this was a non-retryable HTTP error we threw above, re-throw.
      if (msg.startsWith('Anthropic ') && !msg.includes('429')) throw err;
      lastErr = msg;
    }

    if (attempt < MAX_ATTEMPTS - 1) {
      const delay = BACKOFF_MS[attempt] || 4000;
      console.warn(
        `[anthropicVision] retrying after ${delay}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS}): ${lastErr}`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw new Error(
    `Anthropic API exhausted ${MAX_ATTEMPTS} attempts: ${lastErr || 'unknown error'}`,
  );
}
