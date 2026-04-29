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

import type {
  PriceMatrix,
  PricingTier,
  TierOverrideMode,
  TierOverrideProductTier,
  TierOverridePackageTier,
} from './schema.ts';

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
 *
 * Master values are accepted for the percent_off / percent_markup modes
 * introduced by engine v3 — those modes compute final values relative to
 * the master tier price, so the resolver must know what the master price
 * IS at compute time. Callers that only know they want the legacy shape
 * (e.g. UI summary preview using the matrix without master context) can
 * pass the same value as both master_* and treat the percent path as a
 * graceful no-op when master values are 0.
 */
export interface ProductOverrideResolution {
  matrix_id: string;
  entity_type: 'agent' | 'agency';
  base: number | null;
  unit: number | null;
  /** Which engine shape resolved this override (for trace/debug). */
  shape: 'legacy' | 'tier_overrides';
  /** Mode for tier_overrides shape — null for legacy (which is always equivalent to 'fixed'). */
  mode: TierOverrideMode | null;
}

export function resolveProductOverride(
  productId: string,
  tier: PricingTier,
  agentMatrix: PriceMatrix | null,
  agencyMatrix: PriceMatrix | null,
  masterBase: number = 0,
  masterUnit: number = 0,
): ProductOverrideResolution | null {
  // Agent first, then agency.
  for (const m of [agentMatrix, agencyMatrix]) {
    if (!m?.product_pricing) continue;
    const row = m.product_pricing.find((p) => p.product_id === productId);
    if (!row) continue;
    const resolved = resolveProductTierForRow(row, tier, masterBase, masterUnit);
    if (!resolved) continue;
    return {
      matrix_id: m.id,
      entity_type: m.entity_type,
      ...resolved,
    };
  }
  return null;
}

function resolveProductTierForRow(
  row: NonNullable<PriceMatrix['product_pricing']>[number],
  tier: PricingTier,
  masterBase: number,
  masterUnit: number,
): { base: number | null; unit: number | null; shape: 'legacy' | 'tier_overrides'; mode: TierOverrideMode | null } | null {
  // ─── New shape (engine v3): per-tier enablement + mode ────────────────
  if (row.tier_overrides) {
    const t = row.tier_overrides[tier] as TierOverrideProductTier | undefined;
    if (!t || !t.enabled) return null;
    const mode = (t.mode || 'fixed') as TierOverrideMode;
    if (mode === 'fixed') {
      const base = toNullableNumber(t.base);
      const unit = toNullableNumber(t.unit);
      if (base == null && unit == null) return null;
      return {
        base: base != null ? Math.max(0, base) : null,
        unit: unit != null ? Math.max(0, unit) : null,
        shape: 'tier_overrides',
        mode,
      };
    }
    if (mode === 'percent_off' || mode === 'percent_markup') {
      const pct = clampPct(toNullableNumber(t.percent) ?? 0);
      const factor = mode === 'percent_off' ? 1 - pct / 100 : 1 + pct / 100;
      return {
        base: Math.max(0, masterBase * factor),
        unit: Math.max(0, masterUnit * factor),
        shape: 'tier_overrides',
        mode,
      };
    }
    // Unknown mode → treat as no override, but log via shape for debugging.
    return null;
  }

  // ─── Legacy shape (engine v2): single override_enabled toggle ──────────
  if (!row.override_enabled) return null;
  const base =
    tier === 'premium' ? toNullableNumber(row.premium_base) : toNullableNumber(row.standard_base);
  const unit =
    tier === 'premium' ? toNullableNumber(row.premium_unit) : toNullableNumber(row.standard_unit);
  if (base == null && unit == null) return null;
  return {
    base: base != null ? Math.max(0, base) : null,
    unit: unit != null ? Math.max(0, unit) : null,
    shape: 'legacy',
    mode: null,
  };
}

export interface PackageOverrideResolution {
  matrix_id: string;
  entity_type: 'agent' | 'agency';
  price: number;
  shape: 'legacy' | 'tier_overrides';
  mode: TierOverrideMode | null;
}

export function resolvePackageOverride(
  packageId: string,
  tier: PricingTier,
  agentMatrix: PriceMatrix | null,
  agencyMatrix: PriceMatrix | null,
  masterPrice: number = 0,
): PackageOverrideResolution | null {
  for (const m of [agentMatrix, agencyMatrix]) {
    if (!m?.package_pricing) continue;
    const row = m.package_pricing.find((p) => p.package_id === packageId);
    if (!row) continue;
    const resolved = resolvePackageTierForRow(row, tier, masterPrice);
    if (!resolved) continue;
    return {
      matrix_id: m.id,
      entity_type: m.entity_type,
      ...resolved,
    };
  }
  return null;
}

function resolvePackageTierForRow(
  row: NonNullable<PriceMatrix['package_pricing']>[number],
  tier: PricingTier,
  masterPrice: number,
): { price: number; shape: 'legacy' | 'tier_overrides'; mode: TierOverrideMode | null } | null {
  if (row.tier_overrides) {
    const t = row.tier_overrides[tier] as TierOverridePackageTier | undefined;
    if (!t || !t.enabled) return null;
    const mode = (t.mode || 'fixed') as TierOverrideMode;
    if (mode === 'fixed') {
      const price = toNullableNumber(t.price);
      if (price == null) return null;
      return { price: Math.max(0, price), shape: 'tier_overrides', mode };
    }
    if (mode === 'percent_off' || mode === 'percent_markup') {
      const pct = clampPct(toNullableNumber(t.percent) ?? 0);
      const factor = mode === 'percent_off' ? 1 - pct / 100 : 1 + pct / 100;
      return { price: Math.max(0, masterPrice * factor), shape: 'tier_overrides', mode };
    }
    return null;
  }

  if (!row.override_enabled) return null;
  const price =
    tier === 'premium' ? toNullableNumber(row.premium_price) : toNullableNumber(row.standard_price);
  if (price == null) return null;
  return { price: Math.max(0, price), shape: 'legacy', mode: null };
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
