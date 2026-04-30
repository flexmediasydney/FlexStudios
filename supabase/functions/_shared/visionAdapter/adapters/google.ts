/**
 * adapters/google.ts — Wave 11.8 Google (Gemini) vision adapter.
 *
 * Translates VisionRequest → Gemini generateContent REST call → VisionResponse.
 *
 * Endpoint:
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={GEMINI_API_KEY}
 *
 * Strict-JSON output via:
 *   - generationConfig.responseMimeType: 'application/json'
 *   - generationConfig.responseSchema: <tool_input_schema>
 *
 * The 2M-token context window means most multi-image batches that need
 * sliding-window splits on Anthropic fit a single call here. We therefore do
 * NOT implement multi-turn slicing in this adapter — the harness builds one
 * VisionRequest with all images and we send them in a single contents[0].parts
 * array with inline_data parts.
 *
 * URL image inputs are NOT supported by the Gemini REST endpoint — Google's
 * API requires inline_data (base64 + mimeType) or fileData (uploaded files).
 * The adapter throws VendorCallError for url-mode images. The harness fetches
 * Dropbox previews into base64 before calling.
 *
 * Auth: GEMINI_API_KEY env var. Throws MissingVendorCredential when unset.
 *
 * Retry / timeout: 3 attempts on 429/500/502/503 with 1s/2s/4s backoff,
 * AbortSignal timeout default 90s.
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

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 90 * 1000;
const BACKOFF_MS = [1000, 2000, 4000];

function getApiKey(): string {
  const key = Deno.env.get('GEMINI_API_KEY') || '';
  if (!key) {
    throw new MissingVendorCredential('google', 'GEMINI_API_KEY');
  }
  return key;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503;
}

// ─── Body builder ────────────────────────────────────────────────────────────

interface GeminiInlineDataPart {
  inlineData: { mimeType: string; data: string };
}
interface GeminiTextPart {
  text: string;
}

type GeminiPart = GeminiInlineDataPart | GeminiTextPart;

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

function toGeminiPart(img: VisionImage): GeminiInlineDataPart {
  if (img.source_type !== 'base64') {
    throw new VendorCallError(
      'google',
      '',
      "Google adapter requires source_type='base64' for images (REST endpoint doesn't support URL fetch)",
    );
  }
  if (!img.data) {
    throw new VendorCallError('google', '', 'base64 image requires data field');
  }
  return { inlineData: { mimeType: img.media_type, data: img.data } };
}

/**
 * Build the Gemini generateContent request body from a VisionRequest.
 * Exported for unit testing.
 *
 * Schema enforcement strategy:
 * - systemInstruction = req.system
 * - contents[0] = the user turn (images + final text)
 * - generationConfig.responseMimeType = 'application/json'
 * - generationConfig.responseSchema = req.tool_input_schema (subset Gemini accepts:
 *   no $ref, no additionalProperties, no minLength/maxLength, no patterns —
 *   harness should pre-sanitise schemas if needed; we pass-through verbatim
 *   and let the API surface schema errors as 400s)
 *
 * prior_turns map to additional `contents` entries. Anthropic uses 'assistant'
 * for the model role; Gemini uses 'model'. We translate 'assistant' → 'model'.
 */
export function buildGeminiBody(req: VisionRequest): Record<string, unknown> {
  // User content — images first (stable bulk), then the user_text.
  const userParts: GeminiPart[] = req.images.map((img) => toGeminiPart(img));
  userParts.push({ text: req.user_text });

  const contents: GeminiContent[] = [];

  // Translate prior_turns. content shape varies — if it's a string, wrap in
  // a text part; otherwise pass through as-is (caller's responsibility to
  // shape correctly for Gemini if non-text).
  if (Array.isArray(req.prior_turns)) {
    for (const turn of req.prior_turns) {
      const role: 'user' | 'model' = turn.role === 'assistant' ? 'model' : 'user';
      let parts: GeminiPart[];
      if (typeof turn.content === 'string') {
        parts = [{ text: turn.content }];
      } else if (Array.isArray(turn.content)) {
        parts = turn.content as GeminiPart[];
      } else {
        parts = [{ text: JSON.stringify(turn.content) }];
      }
      contents.push({ role, parts });
    }
  }

  contents.push({ role: 'user', parts: userParts });

  // Gemini 2.5 Pro defaults to dynamic (-1) thinking budget — internal
  // reasoning tokens are consumed FROM `maxOutputTokens` BEFORE visible
  // output. We control budget explicitly per model.
  //
  // Iteration history:
  //   - 1st pass: default dynamic → 75% truncation as Pro burned ~1000 tokens
  //   - 2nd pass: thinkingBudget=0 → 400 INVALID_ARGUMENT, Pro requires non-zero
  //   - 3rd pass: thinkingBudget=128 (floor) → 42/42 ok but terse output (avg
  //     692 chars analysis vs Opus 1358; 4.5 objects vs 7.8)
  //   - 4th pass (here): thinkingBudget=1024 for Pro → enough headroom to
  //     enumerate architectural detail under the iter-4 minItems=8 schema
  //     and the master-architectural-photographer granularity directive.
  //     With max_output_tokens=4000, ~2976 tokens remain for output —
  //     plenty for ~250-word analysis + 8–12 multi-noun key_elements.
  //
  // Pro requires a non-zero budget. Flash and Lite tolerate 0.
  const isProModel = /gemini-2\.5-pro/i.test(req.model);
  const thinkingBudget = isProModel ? 1024 : 0;
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: req.tool_input_schema,
      maxOutputTokens: req.max_output_tokens,
      temperature: req.temperature ?? 0,
      thinkingConfig: { thinkingBudget, includeThoughts: false },
    },
  };
  return body;
}

// ─── Response parsing ────────────────────────────────────────────────────────

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiCandidate {
  content?: { parts?: Array<{ text?: string }> };
  finishReason?: string;
}

interface GeminiResponseBody {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  modelVersion?: string;
  responseId?: string;
}

function mapGeminiFinishReason(r?: string): VisionVendorMeta['finish_reason'] {
  switch (r) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
      return 'safety';
    default:
      return 'stop';
  }
}

/**
 * Extract the JSON output from a Gemini response body. With
 * responseMimeType=application/json the candidate's text part contains a
 * single JSON-stringified object matching the schema. We parse it and
 * return.
 *
 * Throws VendorCallError when no candidate is present or when the candidate's
 * text fails to parse.
 *
 * Exported for unit testing.
 */
export function extractGeminiOutput(
  raw: GeminiResponseBody,
  model: string,
): Record<string, unknown> {
  const candidates = Array.isArray(raw.candidates) ? raw.candidates : [];
  if (candidates.length === 0) {
    throw new VendorCallError('google', model, 'No candidates in Gemini response');
  }
  const cand = candidates[0];
  const parts = Array.isArray(cand.content?.parts) ? cand.content.parts : [];
  // Concatenate all text parts (typical: single text part containing JSON).
  const text = parts
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('')
    .trim();
  if (!text) {
    throw new VendorCallError('google', model, 'Empty Gemini candidate text');
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    // If the schema's root is an array, wrap it under `data` so the
    // Record<string, unknown> contract holds.
    return { data: parsed };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    throw new VendorCallError(
      'google',
      model,
      `Failed to parse Gemini JSON output: ${m} | text: ${text.slice(0, 400)}`,
    );
  }
}

function buildUsage(
  meta: GeminiUsageMetadata | undefined,
  model: string,
): VisionUsage {
  const m = meta || {};
  const cached_input_tokens = m.cachedContentTokenCount || 0;
  // promptTokenCount includes cached content per Gemini docs — subtract so we
  // don't double-count.
  const input_tokens = Math.max(0, (m.promptTokenCount || 0) - cached_input_tokens);
  const output_tokens = m.candidatesTokenCount || 0;
  const estimated_cost_usd = estimateCost('google', model, {
    input_tokens,
    output_tokens,
    cached_input_tokens,
  });
  return { input_tokens, output_tokens, cached_input_tokens, estimated_cost_usd };
}

// ─── Public entrypoint ───────────────────────────────────────────────────────

export async function callGoogleVision(req: VisionRequest): Promise<VisionResponse> {
  if (req.vendor !== 'google') {
    throw new VendorCallError(
      'google',
      req.model,
      `callGoogleVision invoked with vendor='${req.vendor}'`,
    );
  }

  const apiKey = getApiKey();
  const body = buildGeminiBody(req);
  const url = `${GEMINI_BASE}/${encodeURIComponent(req.model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const timeoutMs = req.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const startMs = Date.now();
  let lastErr: string | null = null;
  let lastStatus: number | undefined = undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const rawText = await res.text();
      if (res.ok) {
        let parsed: GeminiResponseBody;
        try {
          parsed = JSON.parse(rawText) as GeminiResponseBody;
        } catch {
          throw new VendorCallError(
            'google',
            req.model,
            `Non-JSON response: ${rawText.slice(0, 400)}`,
            res.status,
          );
        }
        const output = extractGeminiOutput(parsed, req.model);
        const usage = buildUsage(parsed.usageMetadata, req.model);
        const vendor_meta: VisionVendorMeta = {
          vendor: 'google',
          model: typeof parsed.modelVersion === 'string' ? parsed.modelVersion : req.model,
          request_id: typeof parsed.responseId === 'string' ? parsed.responseId : '',
          finish_reason: mapGeminiFinishReason(parsed.candidates?.[0]?.finishReason),
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
          'google',
          req.model,
          `Gemini ${res.status}: ${rawText.slice(0, 400)}`,
          res.status,
        );
      }
      // retryable — fall through
    } catch (err) {
      if (err instanceof VendorCallError) throw err;
      lastErr = err instanceof Error ? err.message : String(err);
    }

    if (attempt < MAX_ATTEMPTS - 1) {
      const delay = BACKOFF_MS[attempt] || 4000;
      console.warn(
        `[visionAdapter/google] retrying after ${delay}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS}): ${lastErr}`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw new VendorCallError(
    'google',
    req.model,
    `Gemini API exhausted ${MAX_ATTEMPTS} attempts: ${lastErr || 'unknown error'}`,
    lastStatus,
  );
}
