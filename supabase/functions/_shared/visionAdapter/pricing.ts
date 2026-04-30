/**
 * visionAdapter/pricing.ts — per-vendor per-model token pricing tables.
 *
 * USD per 1M tokens. Used for:
 *   - Cost gates in the retroactive-comparison fn (pre-flight estimate vs cap).
 *   - VisionUsage.estimated_cost_usd on every adapter response.
 *
 * Anthropic rates are a superset of `_shared/anthropicVision.ts`'s table, so
 * the wrapper continues to report identical costs after the W11.8 migration.
 *
 * Google (Gemini) rates per https://ai.google.dev/gemini-api/docs/pricing as
 * of 2026-04-29. Rates are model-tier flat per spec — context-length tiers
 * (e.g. >128K input on Pro) are intentionally NOT modelled; the conservative
 * choice is to bill at the higher long-context rate so the cost cap fires
 * earlier rather than later.
 *
 * Unknown models fall back to the most expensive Anthropic Sonnet rate so
 * cost tracking never silently undercounts.
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
  anthropic: {
    'claude-haiku-4': { inputPerMillion: 1.0, outputPerMillion: 5.0 },
    'claude-haiku-4-5': { inputPerMillion: 1.0, outputPerMillion: 5.0 },
    'claude-sonnet-4-6': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
    'claude-opus-4-7': { inputPerMillion: 15.0, outputPerMillion: 75.0 },
  },
  google: {
    // Gemini 2.0 Pro: $3.50 / $10.50 per 1M tokens (long-context tier; spec
    // intentionally bills at the higher tier to keep the cost gate
    // conservative).
    'gemini-2.0-pro': { inputPerMillion: 3.50, outputPerMillion: 10.50 },
    // Gemini 2.0 Flash: $0.10 / $0.40 per 1M tokens.
    'gemini-2.0-flash': { inputPerMillion: 0.10, outputPerMillion: 0.40 },
  },
};

// Fallback for unknown models — Sonnet rates so cost tracking errs upward.
const FALLBACK_RATES: ModelRates = { inputPerMillion: 3.0, outputPerMillion: 15.0 };

// ─── Resolution ──────────────────────────────────────────────────────────────

/**
 * Look up rates for a (vendor, model) pair. Anthropic models can carry a date
 * suffix (`claude-sonnet-4-6-20260101`) — strip a trailing `-YYYYMMDD` and
 * retry the lookup before falling back. Logs a warning on fallback so the
 * pricing table can be updated.
 */
export function resolveRates(vendor: VisionVendor, model: string): ModelRates {
  const table = VENDOR_PRICING[vendor];
  if (table && table[model]) return table[model];
  if (table) {
    const stripped = model.replace(/-\d{8}$/, '');
    if (table[stripped]) return table[stripped];
  }
  console.warn(
    `[visionAdapter/pricing] unknown model '${model}' for vendor '${vendor}' — defaulting to Sonnet rates`,
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
