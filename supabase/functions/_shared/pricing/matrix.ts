// Matrix resolution + precedence rules for the pricing engine.
//
// The "active matrix" for a project is derived from two inputs: the agent's
// matrix(es) and the agency's matrix(es). The resolution has three layers:
//
//   1. PICK — given a list of matrices for an entity and a project_type_id,
//      pick the project-type-specific one, else fall back to the type-agnostic
//      one, else null.
//
//   2. USE_DEFAULT_PRICING — a matrix with use_default_pricing=true is treated
//      as if it doesn't exist. Its overrides are ignored. Its blanket_discount
//      is also ignored. Semantically "this entity opts out of matrix pricing".
//
//   3. PRECEDENCE — agent matrix beats agency matrix. Both for per-item
//      overrides AND blanket_discount. Agent + agency blankets are NOT stacked.
//
// Critically: per-item override lookup walks agent → agency in that order per
// line. Blanket discount is a SINGLE blanket (first enabled one wins).
//
// Locked precedence ladder (copied from the architecture doc):
//   T1. Agent matrix product_pricing[] override with override_enabled=true
//   T2. Agency matrix product_pricing[] override
//   T3. Agent matrix package_pricing[] override
//   T4. Agency matrix package_pricing[] override
//   T5. Agent matrix default_tier (NOT implemented here — callers handle tier;
//        engine just receives pricing_tier as input)
//   T6. Agency matrix default_tier (same)
//   T7. Master product/package *_tier (engine fallback)

import type { PriceMatrix, PricingTier } from './schema.ts';

/**
 * Pick the single matrix row from a list that should apply to this project.
 * Returns null if no matrix is applicable.
 *
 * When multiple matrices exist for one entity (e.g. agency has a Residential
 * matrix AND a Commercial matrix), the one matching project_type_id wins.
 * Otherwise falls back to the type-agnostic one, otherwise the first one.
 */
export function pickMatrix(
  matrices: PriceMatrix[] | null | undefined,
  projectTypeId: string | null | undefined,
): PriceMatrix | null {
  if (!matrices || matrices.length === 0) return null;
  if (projectTypeId) {
    const typed = matrices.find((m) => m.project_type_id === projectTypeId);
    if (typed) return typed;
  }
  return matrices.find((m) => !m.project_type_id) || matrices[0] || null;
}

/**
 * Apply the use_default_pricing gate. Returns null for matrices that have
 * opted out, so downstream code can treat "no matrix" and "opt-out matrix"
 * identically.
 */
export function resolveActiveMatrix(raw: PriceMatrix | null): PriceMatrix | null {
  if (!raw) return null;
  if (raw.use_default_pricing) return null;
  return raw;
}

/**
 * Look up a per-item override (product or package) across the agent+agency
 * matrices. Returns null if no override is enabled.
 */
export interface ProductOverrideResolution {
  matrix_id: string;
  entity_type: 'agent' | 'agency';
  base: number | null;
  unit: number | null;
}

export function resolveProductOverride(
  productId: string,
  tier: PricingTier,
  agentMatrix: PriceMatrix | null,
  agencyMatrix: PriceMatrix | null,
): ProductOverrideResolution | null {
  // Agent first, then agency.
  for (const m of [agentMatrix, agencyMatrix]) {
    if (!m?.product_pricing) continue;
    const override = m.product_pricing.find((p) => p.product_id === productId && p.override_enabled);
    if (!override) continue;
    const base =
      tier === 'premium'
        ? toNullableNumber(override.premium_base)
        : toNullableNumber(override.standard_base);
    const unit =
      tier === 'premium'
        ? toNullableNumber(override.premium_unit)
        : toNullableNumber(override.standard_unit);
    // Only return the override if at least one side is meaningful.
    if (base != null || unit != null) {
      return {
        matrix_id: m.id,
        entity_type: m.entity_type,
        base,
        unit,
      };
    }
  }
  return null;
}

export interface PackageOverrideResolution {
  matrix_id: string;
  entity_type: 'agent' | 'agency';
  price: number;
}

export function resolvePackageOverride(
  packageId: string,
  tier: PricingTier,
  agentMatrix: PriceMatrix | null,
  agencyMatrix: PriceMatrix | null,
): PackageOverrideResolution | null {
  for (const m of [agentMatrix, agencyMatrix]) {
    if (!m?.package_pricing) continue;
    const override = m.package_pricing.find((p) => p.package_id === packageId && p.override_enabled);
    if (!override) continue;
    const price =
      tier === 'premium'
        ? toNullableNumber(override.premium_price)
        : toNullableNumber(override.standard_price);
    if (price == null) continue;
    return {
      matrix_id: m.id,
      entity_type: m.entity_type,
      price: Math.max(0, price),
    };
  }
  return null;
}

/**
 * The active blanket discount for this project. Agent wins over agency. If
 * neither is enabled, returns null. Mutually exclusive — no stacking.
 */
export interface BlanketResolution {
  matrix_id: string;
  entity_type: 'agent' | 'agency';
  package_percent: number;
  product_percent: number;
}

export function resolveBlanketDiscount(
  agentMatrix: PriceMatrix | null,
  agencyMatrix: PriceMatrix | null,
): BlanketResolution | null {
  for (const m of [agentMatrix, agencyMatrix]) {
    if (!m?.blanket_discount?.enabled) continue;
    return {
      matrix_id: m.id,
      entity_type: m.entity_type,
      package_percent: clampPct(toNullableNumber(m.blanket_discount.package_percent) ?? 0),
      product_percent: clampPct(toNullableNumber(m.blanket_discount.product_percent) ?? 0),
    };
  }
  return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function toNullableNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
  return Number.isFinite(n) ? n : null;
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
