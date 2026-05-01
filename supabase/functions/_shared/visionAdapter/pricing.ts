/**
 * visionAdapter/pricing.ts — per-vendor per-model token pricing tables.
 *
 * USD per 1M tokens. Used for:
 *   - Cost gates in the retroactive-comparison fn (pre-flight estimate vs cap).
 *   - VisionUsage.estimated_cost_usd on every adapter response.
 *
 * W11.8.1 (2026-05-01): Anthropic rows removed. The `_shared/anthropicVision.ts`
 * legacy helper still has its own internal table for sunset (June 1) legacy
 * passes (pass0/pass1/pass2) and `vendor-retroactive-compare` keeps its own
 * Anthropic pricing for A/B benchmarks — neither shares this table.
 *
 * W11.8.2 (2026-05-01): Gemini 2.5 Pro / 2.5 Flash rates corrected. Prior
 * commit (4e53f1d) shipped 2.5 rates copied from a stale 2.0 source comment —
 * 2.5 Pro is $1.25 / $10.00 (≤200K context tier; Stage 1 single-image always
 * <200K) and 2.5 Flash is $0.30 / $2.50. Source:
 * https://ai.google.dev/gemini-api/docs/pricing as of 2026-04-30. The 2.0
 * rows are unchanged ($3.50 / $10.50 Pro and $0.10 / $0.40 Flash) — those
 * legacy rates remained correct for 2.0 and aren't currently called.
 *
 * Unknown models fall back to a defensive moderate rate (Gemini 2.5 Pro
 * published rates) so cost tracking errs upward without quoting Sonnet-tier
 * rates that no Gemini model has ever charged.
 */

import type { VisionUsage, VisionVendor } from './types.ts';

// ─── Rate types ──────────────────────────────────────────────────────────────

export interface ModelRates {
  inputPerMillion: number;
  outputPerMillion: number;
  /**
   * Optional cached-input rate (used by Anthropic prompt-cache reads).
   * When unset, cached input falls back to standard input pricing.
   */
  cachedInputPerMillion?: number;
}

// ─── Pricing rows ────────────────────────────────────────────────────────────

export const VENDOR_PRICING: Record<VisionVendor, Record<string, ModelRates>> = {
  google: {
    // Gemini 2.0 Pro: $3.50 / $10.50 per 1M tokens (long-context tier; spec
    // intentionally bills at the higher tier to keep the cost gate
    // conservative).
    'gemini-2.0-pro': { inputPerMillion: 3.50, outputPerMillion: 10.50 },
    // Gemini 2.0 Flash: $0.10 / $0.40 per 1M tokens.
    'gemini-2.0-flash': { inputPerMillion: 0.10, outputPerMillion: 0.40 },
    // Gemini 2.5 Pro: $1.25 / $10.00 per 1M tokens (≤200K context tier;
    // Stage 1 single-image calls always sit well under 200K). Production
    // Stage 1 + 4 model since W11.7.17 keystone cutover. Source:
    // https://ai.google.dev/gemini-api/docs/pricing (W11.8.2 correction —
    // prior commit had stale 2.0-tier rates copied here).
    'gemini-2.5-pro': { inputPerMillion: 1.25, outputPerMillion: 10.00 },
    // Gemini 2.5 Flash: $0.30 / $2.50 per 1M tokens (Pulse listing extract).
    // Source: same page (W11.8.2 correction — prior 0.10/0.40 was stale
    // 2.0-tier).
    'gemini-2.5-flash': { inputPerMillion: 0.30, outputPerMillion: 2.50 },
  },
};

// Fallback for unknown models — Gemini 2.5 Pro published rates so cost
// tracking errs slightly upward without inventing Sonnet-tier numbers no
// Gemini model has ever charged. With explicit 2.0/2.5 Pro/Flash rows above,
// this only fires for models we've forgotten to register.
const FALLBACK_RATES: ModelRates = { inputPerMillion: 1.25, outputPerMillion: 10.00 };

// ─── Resolution ──────────────────────────────────────────────────────────────

/**
 * Look up rates for a (vendor, model) pair. Models can carry a date suffix —
 * strip a trailing `-YYYYMMDD` and retry the lookup before falling back. Logs
 * a warning on fallback so the pricing table can be updated.
 */
export function resolveRates(vendor: VisionVendor, model: string): ModelRates {
  const table = VENDOR_PRICING[vendor];
  if (table && table[model]) return table[model];
  if (table) {
    const stripped = model.replace(/-\d{8}$/, '');
    if (table[stripped]) return table[stripped];
  }
  console.warn(
    `[visionAdapter/pricing] unknown model '${model}' for vendor '${vendor}' — defaulting to Gemini 2.5 Pro rates`,
  );
  return FALLBACK_RATES;
}

// ─── Cost estimation ─────────────────────────────────────────────────────────

/**
 * Compute USD cost from (vendor, model, usage). Pure function — no I/O.
 *
 * Cached-input tokens (Anthropic prompt cache) are billed at the cached-input
 * rate when the model has one configured, otherwise at the standard input
 * rate. Output tokens are always billed at the output rate.
 *
 * Rounded to 6 decimal places for stable display.
 */
export function estimateCost(
  vendor: VisionVendor,
  model: string,
  usage: Pick<VisionUsage, 'input_tokens' | 'output_tokens' | 'cached_input_tokens'>,
): number {
  const rates = resolveRates(vendor, model);
  const inputTokens = Math.max(0, usage.input_tokens || 0);
  const outputTokens = Math.max(0, usage.output_tokens || 0);
  const cachedTokens = Math.max(0, usage.cached_input_tokens || 0);

  const cachedRate = rates.cachedInputPerMillion ?? rates.inputPerMillion;

  const cost =
    (inputTokens * rates.inputPerMillion) / 1_000_000 +
    (cachedTokens * cachedRate) / 1_000_000 +
    (outputTokens * rates.outputPerMillion) / 1_000_000;

  return Math.round(cost * 1_000_000) / 1_000_000;
}
