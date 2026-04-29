// Pricing engine — the single orchestrator.
//
// This is the ONLY function any caller invokes. Backend edge functions call
// it. Frontend hooks call it. Revision preview calls it. Matrix summary table
// calls it. Everyone.
//
// Input:  catalogs + matrices already loaded by the caller + project line items
// Output: the complete PricingResult — line items, all three discount amounts,
//         final total, snapshot of which matrix fired
//
// No DB access, no side effects, fully pure. Callers load what they need
// (from Supabase, react-query cache, fixture data, whatever) and pass it in.
// This makes the engine trivially testable and trivially sharable between
// Deno edge runtime and Vite browser runtime.
//
// Semver: bump ENGINE_VERSION in schema.ts on ANY math change. Historical
// snapshots stamp their version so they can be replayed with their era's
// engine if we ever need to reproduce old prices exactly.

import { pickMatrix, resolveActiveMatrix } from './matrix.ts';
import { computeLineItems } from './line-items.ts';
import { applyBlanketDiscount, applyManualAdjustment } from './discount.ts';
import { ENGINE_VERSION } from './schema.ts';
import type { PricingInput, PricingResult } from './schema.ts';

export function computePrice(input: PricingInput): PricingResult {
  // ─── Empty input → zeroed result, no matrix lookup ───────────────────
  if ((input.products?.length || 0) === 0 && (input.packages?.length || 0) === 0) {
    return {
      calculated_price: 0,
      pricing_tier: input.pricing_tier,
      line_items: [],
      subtotal: 0,
      blanket_discount_applied: 0,
      manual_discount_applied: 0,
      manual_fee_applied: 0,
      discount_type: input.discount_type || 'fixed',
      discount_value: parseDiscount(input.discount_value),
      discount_mode: input.discount_mode || 'discount',
      price_matrix_snapshot: null,
      engine_version: ENGINE_VERSION,
    };
  }

  // ─── Matrix resolution ───────────────────────────────────────────────
  const rawAgent = pickMatrix(input.agent_matrices || [], input.project_type_id);
  const rawAgency = pickMatrix(input.agency_matrices || [], input.project_type_id);
  const agentMatrix = resolveActiveMatrix(rawAgent);
  const agencyMatrix = resolveActiveMatrix(rawAgency);

  // ─── Line items (products + packages, with per-item overrides) ───────
  const lineItems = computeLineItems({
    products: input.products || [],
    packages: input.packages || [],
    tier: input.pricing_tier,
    catalog_products: input.catalog_products,
    catalog_packages: input.catalog_packages,
    agent_matrix: agentMatrix,
    agency_matrix: agencyMatrix,
  });

  // ─── Blanket discount (agent wins over agency, mutually exclusive) ───
  // Engine v3.1: tier is passed in so the resolver can pick a per-tier
  // blanket block (tier_blanket.standard / tier_blanket.premium) when present.
  const blanket = applyBlanketDiscount(lineItems, agentMatrix, agencyMatrix, input.pricing_tier);

  // ─── Manual per-project adjustment (discount or fee) ─────────────────
  const manual = applyManualAdjustment(blanket.post_blanket, {
    discount_type: input.discount_type,
    discount_value: input.discount_value,
    discount_mode: input.discount_mode,
  });

  return {
    calculated_price: manual.total,
    pricing_tier: input.pricing_tier,
    line_items: lineItems,
    subtotal: blanket.subtotal,
    blanket_discount_applied: blanket.applied_discount,
    manual_discount_applied: manual.manual_discount_applied,
    manual_fee_applied: manual.manual_fee_applied,
    discount_type: manual.discount_type,
    discount_value: manual.discount_value,
    discount_mode: manual.discount_mode,
    // Prefer agent matrix if it fired, else agency, else raw (before use_default_pricing filter)
    // Snapshot includes the matrix that set pricing direction — even if use_default_pricing
    // filtered the overrides, the raw match is captured for audit.
    price_matrix_snapshot: agentMatrix || agencyMatrix || rawAgent || rawAgency,
    engine_version: ENGINE_VERSION,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function parseDiscount(raw: number | string | undefined): number {
  if (raw === null || raw === undefined || raw === '') return 0;
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Re-export primary types so consumers only need to import from './engine'.
export type {
  PricingInput,
  PricingResult,
  LineItem,
  LineItemProduct,
  LineItemPackage,
  PriceMatrix,
  CatalogProduct,
  CatalogPackage,
  PricingTier,
  DiscountType,
  DiscountMode,
} from './schema.ts';
export { ENGINE_VERSION } from './schema.ts';
