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
 * This file is the compile-time guarantee that adding a new vendor is one
 * place to edit (the switch below) plus one new file under `adapters/`.
 */

import {
  type VisionRequest,
  type VisionResponse,
  type VisionVendor,
  VendorCallError,
} from './types.ts';
import { callAnthropicVision } from './adapters/anthropic.ts';
import { callGoogleVision } from './adapters/google.ts';

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
    case 'anthropic':
      return callAnthropicVision(req);
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
