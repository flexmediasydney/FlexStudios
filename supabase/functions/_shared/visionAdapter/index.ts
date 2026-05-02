/**
 * visionAdapter/index.ts — Wave 11.8 vendor-agnostic vision-call router.
 *
 * Single entry point: `callVisionAdapter(req)` dispatches to the per-vendor
 * adapter based on `req.vendor`. Each adapter is responsible for:
 *   - Translating VisionRequest → vendor-native request
 *   - Calling the vendor API with timeout + retry semantics
 *   - Parsing the structured-output response into VisionResponse.output
 *   - Computing usage + cost via `pricing.estimateCost`
 *   - Throwing `MissingVendorCredential` when the API key env var is missing
 *   - Throwing `VendorCallError` for HTTP / parse / schema failures
 *
 * The router itself does NO network I/O — it's a switch on vendor. Pure
 * timing wrapper applied: the elapsed_ms field on VisionResponse.vendor_meta
 * is set by the adapter from its own start clock; the router doesn't override.
 *
 * W11.8.1 (2026-05-01): Anthropic adapter stripped — Gemini is the sole vision
 * vendor. The router still uses an exhaustive switch so adding a new vendor
 * remains a single-file edit (drop adapter, wire it here, update VisionVendor
 * union in types.ts). Future Gemini regressions fail LOUD via VendorCallError
 * — no silent failover, no surprise cost spikes.
 */

import {
  type VisionRequest,
  type VisionResponse,
  type VisionVendor,
  VendorCallError,
} from './types.ts';
import {
  callGoogleVision,
  createGeminiCachedContent,
  deleteGeminiCachedContent,
} from './adapters/google.ts';

export type {
  VisionImage,
  VisionRequest,
  VisionResponse,
  VisionUsage,
  VisionVendor,
  VisionVendorMeta,
  VisionTurn,
} from './types.ts';
export { MissingVendorCredential, VendorCallError } from './types.ts';
export { estimateCost, resolveRates, VENDOR_PRICING } from './pricing.ts';
export type { ModelRates } from './pricing.ts';
// QC iter2 W6a (F-E-007): Gemini explicit cachedContents lifecycle.
// Re-exported through the adapter index so callers don't have to know which
// vendor adapter implements caching. Currently google-only; Anthropic's
// prompt-cache shape is different and would land as separate exports if
// reintroduced.
export {
  createGeminiCachedContent,
  deleteGeminiCachedContent,
} from './adapters/google.ts';

// ─── Router ──────────────────────────────────────────────────────────────────

/**
 * Dispatch a VisionRequest to the right vendor adapter.
 *
 * Throws:
 *   - `MissingVendorCredential` when the chosen vendor's API key is unset.
 *   - `VendorCallError` for HTTP / parse failures (with vendor + model + status).
 *   - Generic Error for unsupported vendors (compile-time exhaustive switch
 *     means this only fires when an enum value is added without a case).
 */
export function callVisionAdapter(req: VisionRequest): Promise<VisionResponse> {
  switch (req.vendor) {
    case 'google':
      return callGoogleVision(req);
    default: {
      // Exhaustive switch — `_exhaustive: never` causes a compile error if a
      // future VisionVendor literal is added without updating this switch.
      const _exhaustive: never = req.vendor;
      throw new VendorCallError(
        req.vendor as VisionVendor,
        (req as VisionRequest).model,
        `Unsupported vendor: ${String(_exhaustive)}`,
      );
    }
  }
}
