/**
 * visionAdapter/types.ts — Wave 11.8 unified vision-call interface.
 *
 * Vendor-agnostic shapes consumed by `_shared/visionAdapter/index.ts` (router)
 * and produced by `_shared/visionAdapter/adapters/{anthropic,google}.ts`.
 *
 * Joseph 2026-04-29: OpenAI dropped from v1 scope. The `VisionVendor` enum is
 * intentionally narrow — adding OpenAI later is a single-file addition (one
 * new adapter file + one new pricing row + one new vendor enum value).
 */

// ─── Vendor enum ─────────────────────────────────────────────────────────────

/**
 * Allowed vision vendors. v1 scope: anthropic + google.
 * To add a new vendor:
 *   1. Add the literal here.
 *   2. Add a row in `pricing.ts` for each model.
 *   3. Drop a new file under `adapters/<vendor>.ts` exporting `callXxx(req)`.
 *   4. Wire it into the switch in `index.ts`.
 */
export type VisionVendor = 'anthropic' | 'google';

// ─── Image input ─────────────────────────────────────────────────────────────

/**
 * A single image attached to a vision request.
 *
 * `source_type='base64'` carries inline bytes (the harness uses this when it
 * has already fetched the image as Uint8Array — saves a vendor-side round-trip
 * and keeps URL secrets out of vendor logs).
 *
 * `source_type='url'` lets the vendor's server fetch the URL itself. Only
 * supported by Anthropic today; the Google adapter throws on URL inputs (the
 * Gemini REST endpoint requires inline_data).
 */
export interface VisionImage {
  source_type: 'base64' | 'url';
  /** image/jpeg | image/png | image/webp | image/gif. */
  media_type: string;
  /** Required when source_type='base64'. Plain base64 (no data: prefix). */
  data?: string;
  /** Required when source_type='url'. Direct URL. */
  url?: string;
}

// ─── Vision request ──────────────────────────────────────────────────────────

/**
 * A single conversation turn — used for multi-turn / prompt-cache scenarios.
 * `content` is intentionally `unknown` because each vendor has its own native
 * content shape; the adapter is responsible for translating.
 */
export interface VisionTurn {
  role: 'user' | 'assistant';
  content: unknown;
}

export interface VisionRequest {
  vendor: VisionVendor;
  /** Vendor-specific model id e.g. 'claude-opus-4-7' | 'gemini-2.0-pro'. */
  model: string;
  /** Tool / function name for strict-JSON output mode. */
  tool_name: string;
  /**
   * JSON schema for the structured output. Must conform to the JSON-schema
   * subset both vendors support (no $ref, no oneOf/anyOf depth >1).
   */
  tool_input_schema: Record<string, unknown>;
  /** System message — role context. */
  system: string;
  /** User-message text part(s), concatenated by the caller. */
  user_text: string;
  /** Images attached to the user message. */
  images: VisionImage[];
  /** Conversation history (for multi-turn / prompt caching). */
  prior_turns?: VisionTurn[];
  /** Hard cap on output tokens. */
  max_output_tokens: number;
  /** Temperature 0-1. Defaults to 0 in adapters when omitted. */
  temperature?: number;
  /** Whether to enable prompt caching (Anthropic ephemeral / Gemini implicit). */
  enable_prompt_cache?: boolean;
  /** Hard timeout in ms. Defaults to 90s in adapters when omitted. */
  timeout_ms?: number;
}

// ─── Vision response ─────────────────────────────────────────────────────────

export interface VisionUsage {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  estimated_cost_usd: number;
}

export interface VisionVendorMeta {
  vendor: VisionVendor;
  model: string;
  request_id: string;
  finish_reason: 'stop' | 'length' | 'tool_use' | 'safety' | 'error';
  elapsed_ms: number;
}

export interface VisionResponse {
  /** Parsed structured output matching tool_input_schema. */
  output: Record<string, unknown>;
  usage: VisionUsage;
  vendor_meta: VisionVendorMeta;
  /** First 2000 chars of the vendor's raw JSON body — for audit / debugging. */
  raw_response_excerpt: string;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Thrown by an adapter when its API key environment variable is missing.
 * Distinguishable from generic vendor errors so the harness can surface a
 * specific "GEMINI_API_KEY not configured" message rather than a generic 5xx.
 */
export class MissingVendorCredential extends Error {
  readonly vendor: VisionVendor;
  readonly env_var: string;
  constructor(vendor: VisionVendor, env_var: string) {
    super(`${env_var} not configured (required for vendor=${vendor})`);
    this.vendor = vendor;
    this.env_var = env_var;
    this.name = 'MissingVendorCredential';
  }
}

/**
 * Thrown for vendor API errors (HTTP non-2xx, JSON parse failures, schema
 * violations the adapter detects). Generic enough that the router can log
 * and rethrow uniformly.
 */
export class VendorCallError extends Error {
  readonly vendor: VisionVendor;
  readonly model: string;
  readonly status?: number;
  constructor(
    vendor: VisionVendor,
    model: string,
    message: string,
    status?: number,
  ) {
    super(message);
    this.vendor = vendor;
    this.model = model;
    this.status = status;
    this.name = 'VendorCallError';
  }
}
