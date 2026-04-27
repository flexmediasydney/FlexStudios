/**
 * engineTierResolver.ts — Wave 7 P1-6 (W7.7) pure helper for resolving an
 * engine tier (S/P/A) from a project at round bootstrap.
 *
 * Three real project shapes exist in production (per Joseph 2026-04-27):
 *
 *   1. BUNDLED — projects.packages[].products[] populated.
 *      Tier source = first packages[?].tier_choice → package_engine_tier_mapping
 *      lookup. Falls through to the à la carte rule if the mapping has no
 *      matching row (defensive — admin may not have seeded all packages yet).
 *
 *   2. À LA CARTE — projects.products[] populated, packages[] empty.
 *      Tier source = projects.pricing_tier directly:
 *        'premium'  → engine Tier P
 *        'standard' → engine Tier S
 *        null/other → engine Tier S (default)
 *
 *   3. MIXED — both populated. Same as Bundled (the package wins for tier
 *      resolution; à la carte products inherit the package's tier_choice as
 *      a metadata-only `tier_hint`, but the engine's canonical tier is the
 *      package mapping).
 *
 * Returns the resolved `shortlisting_tiers.id` UUID — written to
 * `shortlisting_rounds.engine_tier_id` so Pass 2 reads it directly without
 * re-resolving per inference.
 *
 * KEEP THIS PURE: no DB calls. Caller does the SELECTs and hands the rows in.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProjectForTierResolve {
  packages?: Array<{
    package_id?: string | null;
    tier_choice?: string | null;
  }> | null;
  pricing_tier?: string | null;
}

export interface PackageEngineTierMappingRow {
  package_id: string;
  tier_choice: string;
  engine_tier_id: string;
}

export interface ShortlistingTierRow {
  id: string;
  tier_code: string;
}

// ─── resolveEngineTierId ─────────────────────────────────────────────────────

/**
 * Resolve a project's engine tier UUID.
 *
 * Priority chain:
 *   1. First packages[?].package_id present → look up via
 *      package_engine_tier_mapping (with packages[?].tier_choice, defaulting
 *      to project.pricing_tier, defaulting to 'standard'). If a mapping row
 *      exists, return its engine_tier_id.
 *   2. Fall through (no package or no mapping match) → use
 *      project.pricing_tier directly: 'premium' → 'P', 'standard' → 'S',
 *      anything else (including null) → 'S'. Look up the matching tier_code
 *      in `tiers` and return that row's id.
 *   3. If even step 2 can't find a tier (tiers table is empty), throw —
 *      that's a data quality bug.
 */
export function resolveEngineTierId(
  project: ProjectForTierResolve | null | undefined,
  packageEngineTierMapping: PackageEngineTierMappingRow[],
  tiers: ShortlistingTierRow[],
): string {
  const tierByCode = new Map<string, string>();
  for (const t of tiers || []) {
    if (t && typeof t.tier_code === 'string' && typeof t.id === 'string') {
      tierByCode.set(t.tier_code, t.id);
    }
  }

  // ── Path 1: Bundled — first package entry's tier_choice → mapping ─────────
  const firstPkg = Array.isArray(project?.packages) && project!.packages!.length > 0
    ? project!.packages![0]
    : null;
  if (firstPkg && typeof firstPkg.package_id === 'string' && firstPkg.package_id) {
    const tierChoice = (typeof firstPkg.tier_choice === 'string' && firstPkg.tier_choice)
      || (typeof project?.pricing_tier === 'string' && project.pricing_tier)
      || 'standard';
    const mapped = (packageEngineTierMapping || []).find((m) =>
      m && m.package_id === firstPkg.package_id && m.tier_choice === tierChoice
    );
    if (mapped && mapped.engine_tier_id) {
      return mapped.engine_tier_id;
    }
    // Mapping miss → defensively fall through to à la carte rule.
  }

  // ── Path 2: À la carte — project.pricing_tier directly ────────────────────
  const pricingTier = typeof project?.pricing_tier === 'string'
    ? project.pricing_tier.toLowerCase()
    : '';
  const targetCode = pricingTier === 'premium' ? 'P' : 'S';
  const tierId = tierByCode.get(targetCode);
  if (tierId) return tierId;

  // ── Path 3: data quality bug — tiers table unseeded ───────────────────────
  throw new Error(
    `engineTierResolver: cannot resolve tier_code='${targetCode}' — shortlisting_tiers table is empty or missing this row. Migration 339 should have seeded S/P/A.`,
  );
}
