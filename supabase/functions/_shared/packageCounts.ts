/**
 * packageCounts.ts — Wave 7 P1-6 (W7.7) pure helpers for dynamic photo-count
 * resolution.
 *
 * Replaces the hardcoded {Gold: 24, Day-to-Dusk: 31, Premium: 38} ceiling
 * tables that used to live in shortlisting-ingest, shortlisting-pass2,
 * shortlisting-pass3, shortlisting-benchmark-runner, and pass2Prompt's
 * describeCeiling() — none of which can survive the new pricing matrix where
 * customers buy à la carte add-ons that genuinely change the deliverable
 * count per round.
 *
 * Source-of-truth rule (Joseph 2026-04-27):
 *   target = sum(quantities of products with the engine roles for this engine,
 *                across BOTH bundled (project.packages[].products[]) AND
 *                à la carte (project.products[]) — additive, not exclusive)
 *   min    = max(0, target - 3)
 *   max    = target + 3
 *
 * Bundled products inherit the package entry's `tier_choice` as their
 * `tier_hint` (metadata only — the engine ignores it; project.pricing_tier or
 * the package_engine_tier_mapping is the canonical tier source).
 *
 * KEEP THIS PURE: no DB calls, no env reads. Caller does the SELECTs.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * One product line, flattened from either bundled or à la carte source.
 * tier_hint is informational only — the engine resolves the canonical tier
 * via package_engine_tier_mapping (bundled) or project.pricing_tier
 * (à la carte) per engineTierResolver.ts.
 */
export interface FlatProductEntry {
  product_id: string;
  quantity: number;
  tier_hint: string | null;
}

/** Subset of `products` columns the resolver needs. */
export interface ProductCatalogEntry {
  id: string;
  category: string | null;
  engine_role: string | null;
}

/** Shape of `projects` row needed for flattening. */
export interface ProjectForFlatten {
  packages?: Array<{
    package_id?: string | null;
    tier_choice?: string | null;
    products?: Array<{
      product_id?: string;
      quantity?: number | null;
      tier_hint?: string | null;
    }> | null;
  }> | null;
  products?: Array<{
    product_id?: string;
    quantity?: number | null;
    tier_hint?: string | null;
  }> | null;
}

// ─── flattenProjectProducts ──────────────────────────────────────────────────

/**
 * Flatten a project's product entries from BOTH paths into a single list.
 *
 * - Bundled path: `projects.packages[].products[]`. Each per-package entry's
 *   `tier_choice` is propagated as the per-product `tier_hint` (metadata for
 *   audit JSON; engine ignores).
 * - À la carte path: `projects.products[]`. tier_hint is taken from the row
 *   itself if present, else null.
 * - Mixed: both arrays are unioned. Joseph confirmed 2026-04-27 that
 *   bundled and à la carte products are ADDITIVE — they're addons, not
 *   replacements. e.g. Day Video Package (20 Sales Images) + à la carte
 *   5 Sales Images → flattened to 25 photo-count units.
 *
 * Defensive coding: missing/null/non-numeric quantities are coerced to 0
 * (which is harmless for downstream sum). Entries without a string
 * product_id are dropped — they can't be looked up in the catalog anyway.
 */
export function flattenProjectProducts(project: ProjectForFlatten | null | undefined): FlatProductEntry[] {
  if (!project) return [];

  const out: FlatProductEntry[] = [];

  const bundled = Array.isArray(project.packages) ? project.packages : [];
  for (const pkg of bundled) {
    if (!pkg) continue;
    const products = Array.isArray(pkg.products) ? pkg.products : [];
    const inheritedHint = typeof pkg.tier_choice === 'string' ? pkg.tier_choice : null;
    for (const p of products) {
      if (!p || typeof p.product_id !== 'string' || !p.product_id) continue;
      out.push({
        product_id: p.product_id,
        quantity: coerceQuantity(p.quantity),
        tier_hint: inheritedHint,
      });
    }
  }

  const alaCarte = Array.isArray(project.products) ? project.products : [];
  for (const p of alaCarte) {
    if (!p || typeof p.product_id !== 'string' || !p.product_id) continue;
    out.push({
      product_id: p.product_id,
      quantity: coerceQuantity(p.quantity),
      tier_hint: typeof p.tier_hint === 'string' ? p.tier_hint : null,
    });
  }

  return out;
}

// ─── computeExpectedFileCount ────────────────────────────────────────────────

/**
 * Compute target / min / max photo counts for a round.
 *
 * The target is the sum of quantities for products that match either:
 *   1. an `engine_role` in `forEngineRoles` (the new W7.8 source of truth), OR
 *   2. a `category` in `fallbackCategories` IF the product has no engine_role
 *      (transitional fallback for products not yet backfilled).
 *
 * Returns { target, min, max } where min = max(0, target − 3) and max = target + 3.
 * The ±3 tolerance is the operator-friendly drift budget that lets a
 * photographer over-/under-shoot by a few frames without violating the count
 * contract.
 *
 * Pure: no DB calls. Caller fetches the products catalog once and passes it
 * in. Empty inputs → target=0, min=0, max=3 (Joseph confirmed graceful
 * degradation; the orchestrator will route target=0 rounds to manual mode).
 */
export function computeExpectedFileCount(
  flatProducts: FlatProductEntry[],
  productsCatalog: ProductCatalogEntry[],
  forEngineRoles: string[],
  fallbackCategories: string[] = [],
): { target: number; min: number; max: number } {
  const catalogById = new Map<string, ProductCatalogEntry>();
  for (const p of productsCatalog) {
    if (p && typeof p.id === 'string') catalogById.set(p.id, p);
  }

  const engineRoleSet = new Set(forEngineRoles || []);
  const fallbackCatSet = new Set(fallbackCategories || []);

  let target = 0;
  for (const entry of flatProducts || []) {
    if (!entry || typeof entry.product_id !== 'string') continue;
    const product = catalogById.get(entry.product_id);
    if (!product) continue;

    const matchesEngineRole = !!product.engine_role && engineRoleSet.has(product.engine_role);
    const matchesFallback =
      !product.engine_role &&
      !!product.category &&
      fallbackCatSet.has(product.category);

    if (matchesEngineRole || matchesFallback) {
      target += entry.quantity || 0;
    }
  }

  return {
    target,
    min: Math.max(0, target - 3),
    max: target + 3,
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function coerceQuantity(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}
