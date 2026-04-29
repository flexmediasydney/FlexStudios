// Canonical types for the pricing engine.
//
// These describe the SHAPE of inputs/outputs exchanged between the engine and
// its callers (backend edge fns, frontend hooks, revision preview). No runtime
// validation here — callers are trusted to pass well-shaped data. The engine
// is defensive internally (parseFloat guards, clamps, fallbacks) but doesn't
// throw on malformed input.
//
// Every input is intentionally minimal and serializable (JSON-safe). The
// engine does NOT reach back to the DB from here — all lookups (matrix,
// catalog) are resolved by the caller and passed in.

export type PricingTier = 'standard' | 'premium';
export type DiscountType = 'fixed' | 'percent';
export type DiscountMode = 'discount' | 'fee';

/**
 * Per-tier override mode (engine v3.0.0-shared).
 *
 * - `fixed`          — replace tier values with literal base/unit/price
 * - `percent_off`    — apply (1 - p/100) to master tier values
 * - `percent_markup` — apply (1 + p/100) to master tier values
 *
 * Storage shape (under `tier_overrides`) lives ALONGSIDE the legacy
 * `override_enabled` + `standard_*`/`premium_*` fields during the rollout.
 * The resolver detects tier_overrides first; if absent, falls back to legacy.
 */
export type TierOverrideMode = 'fixed' | 'percent_off' | 'percent_markup';

/** Per-tier override block on a product row. */
export interface TierOverrideProductTier {
  enabled?: boolean;
  mode?: TierOverrideMode;
  base?: number | string | null;
  unit?: number | string | null;
  percent?: number | string | null;
  /** Master tier values captured at write time (for stale detection in UI). */
  master_snapshot?: {
    base?: number | string | null;
    unit?: number | string | null;
    snapshot_at?: string | null;
  } | null;
}

/** Per-tier override block on a package row. Packages have a single `price`. */
export interface TierOverridePackageTier {
  enabled?: boolean;
  mode?: TierOverrideMode;
  price?: number | string | null;
  percent?: number | string | null;
  master_snapshot?: {
    price?: number | string | null;
    snapshot_at?: string | null;
  } | null;
}

// ─── Inputs ──────────────────────────────────────────────────────────────

export interface ProductLine {
  product_id: string;
  quantity: number;
  /** Optional tier hint from Tonomo — ignored by current engine, reserved for future per-line tier override. */
  tier_hint?: string | null;
}

export interface NestedProductLine {
  product_id: string;
  quantity: number;
}

export interface PackageLine {
  package_id: string;
  quantity: number;
  /** Nested product overrides within this package (e.g. "30 Sales Images instead of included 20"). */
  products?: NestedProductLine[];
  /** Audit marker from Tonomo reconciler. Informational only. */
  source?: string;
}

/** Catalog shape: master product row, minimal fields needed for pricing. */
export interface CatalogProduct {
  id: string;
  name: string;
  pricing_type: 'per_unit' | 'fixed' | string;
  min_quantity?: number | null;
  standard_tier?: {
    base_price?: number | string | null;
    unit_price?: number | string | null;
  } | null;
  premium_tier?: {
    base_price?: number | string | null;
    unit_price?: number | string | null;
  } | null;
}

/** Catalog shape: master package row. */
export interface CatalogPackage {
  id: string;
  name: string;
  standard_tier?: {
    package_price?: number | string | null;
    scheduling_time?: number | string | null;
  } | null;
  premium_tier?: {
    package_price?: number | string | null;
    scheduling_time?: number | string | null;
  } | null;
  /** Master product composition. Used to find included qty of nested products. */
  products?: Array<{ product_id: string; quantity: number }>;
}

/** Price matrix row — matches price_matrices table shape. */
export interface PriceMatrix {
  id: string;
  entity_type: 'agent' | 'agency';
  entity_id: string;
  /** Denormalised entity name captured at matrix write time. Used by UI for
      tooltips ("Belle Property Strathfield matrix") without extra lookups. */
  entity_name?: string | null;
  project_type_id?: string | null;
  default_tier?: PricingTier | null;
  use_default_pricing?: boolean | null;
  package_pricing?: Array<{
    package_id: string;
    package_name?: string | null;
    /** Legacy global toggle. Engine v2 reads this; engine v3 reads tier_overrides instead. */
    override_enabled?: boolean;
    standard_price?: number | string | null;
    premium_price?: number | string | null;
    /** Engine v3 per-tier overrides — independent enablement, mode and value per tier. */
    tier_overrides?: Partial<Record<PricingTier, TierOverridePackageTier>> | null;
  }> | null;
  product_pricing?: Array<{
    product_id: string;
    product_name?: string | null;
    /** Legacy global toggle. Engine v2 reads this; engine v3 reads tier_overrides instead. */
    override_enabled?: boolean;
    standard_base?: number | string | null;
    standard_unit?: number | string | null;
    premium_base?: number | string | null;
    premium_unit?: number | string | null;
    /** Engine v3 per-tier overrides — independent enablement, mode and value per tier. */
    tier_overrides?: Partial<Record<PricingTier, TierOverrideProductTier>> | null;
  }> | null;
  blanket_discount?: {
    enabled?: boolean;
    package_percent?: number | string | null;
    product_percent?: number | string | null;
  } | null;
  snapshot_date?: string | null;
}

export interface PricingInput {
  products: ProductLine[];
  packages: PackageLine[];
  pricing_tier: PricingTier;
  project_type_id?: string | null;
  /** All matrices resolved by caller for agent_id (may be multiple across project types; engine picks the right one). */
  agent_matrices?: PriceMatrix[];
  /** All matrices resolved by caller for agency_id. */
  agency_matrices?: PriceMatrix[];
  /** Product/package catalog — caller loads only what's needed. */
  catalog_products: CatalogProduct[];
  catalog_packages: CatalogPackage[];
  /** Manual per-project adjustment. */
  discount_type?: DiscountType;
  discount_value?: number | string;
  discount_mode?: DiscountMode;
}

// ─── Outputs ─────────────────────────────────────────────────────────────

export interface LineItemProduct {
  type: 'product';
  product_id: string;
  product_name: string;
  quantity: number;
  /** Pre-rounding raw price. */
  base_price: number;
  /** True if a matrix per-item override was used. */
  matrix_applied: boolean;
  /** Final per-line price after rounding to $5. */
  final_price: number;
}

export interface LineItemPackage {
  type: 'package';
  package_id: string;
  package_name: string;
  quantity: number;
  base_price: number;
  nested_extra_cost: number;
  nested_details: Array<{
    product_id: string;
    product_name: string;
    included_qty: number;
    user_qty: number;
    extra_qty: number;
    unit_price: number;
    extra_cost: number;
  }>;
  matrix_applied: boolean;
  final_price: number;
}

export type LineItem = LineItemProduct | LineItemPackage;

export interface PricingResult {
  calculated_price: number;
  pricing_tier: PricingTier;
  line_items: LineItem[];
  /** Sum of line_items[].final_price — pre-discount subtotal. */
  subtotal: number;
  /** Amount subtracted by matrix blanket discount. Already rounded. */
  blanket_discount_applied: number;
  /** Amount subtracted by user-entered manual discount. */
  manual_discount_applied: number;
  /** Amount added by user-entered manual fee. */
  manual_fee_applied: number;
  discount_type: DiscountType;
  discount_value: number;
  discount_mode: DiscountMode;
  /** Which matrix (if any) was used for per-item overrides + blanket discount. */
  price_matrix_snapshot: PriceMatrix | null;
  /** Pinned for historical reproducibility. Bump when engine math changes. */
  engine_version: string;
}

/** Current engine semantic version. Bump on any math change.
 *
 *   v2.0.0-shared — extracted from inline edge function math.
 *   v3.0.0-shared — per-tier independent overrides + percent_off / percent_markup modes.
 *                   Reads BOTH legacy (override_enabled + standard_/premium_ scalar fields)
 *                   and new (tier_overrides) shapes; new saves write tier_overrides only.
 */
export const ENGINE_VERSION = 'v3.0.0-shared';
