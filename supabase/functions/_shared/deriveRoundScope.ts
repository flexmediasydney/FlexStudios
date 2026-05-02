/**
 * deriveRoundScope.ts — translate a `shortlisting_rounds` row into the scope
 * IDs (package_id / project_type_id / price_tier_id / grade_id / product_id)
 * that `resolveGalleryPositions` filters on.
 *
 * Why this exists
 * ───────────────
 * Stage 4 was previously calling `resolveGalleryPositions({ all NULL })` —
 * the resolver would short-circuit with the warning "no scope filters could
 * be derived" and return zero positions. The seeded `gallery_positions` rows
 * (e.g. Rainbow Cres → Silver Package) never matched, so
 * `shortlisting_position_decisions` stayed empty.
 *
 * The round table only carries `engine_grade_id` (uuid) and `package_type`
 * (text). To get the rest:
 *   - package_id        — lookup `packages.id` WHERE name = round.package_type
 *   - project_type_id   — lookup `projects.project_type_id` WHERE id = round.project_id
 *   - grade_id          — already on the round (engine_grade_id)
 *   - price_tier_id     — TODO(price_tier_on_rounds): hardcoded to Standard
 *                         until `shortlisting_rounds.price_tier_id` is added
 *                         (see follow-up mig). Per-package recipes that vary
 *                         by price tier (Silver Standard vs Silver Premium)
 *                         resolve to Silver Standard scope until then.
 *   - product_id        — round-level product not yet defined; NULL
 *
 * Per-request cache
 * ─────────────────
 * Stage 4 calls `resolveGalleryPositions` once per fire, but the helper
 * exposes a `clearScopeCache` for tests. The cache key is `round_id` so a
 * background re-fire of the SAME round inside one process reuses the prior
 * lookups. The cache is in-memory only (lives for the life of the edge fn
 * worker) — Deno isolates die quickly so this is bounded.
 */

import type { getAdminClient } from './supabase.ts';

/** TODO(price_tier_on_rounds): hardcoded Standard tier from mig 446. Will be
 * replaced when `shortlisting_rounds.price_tier_id` is added. */
export const HARDCODED_STANDARD_PRICE_TIER_ID =
  'a0000000-0000-4000-a000-000000000001';

export interface DeriveRoundScopeRow {
  /** Round id — used as the cache key. */
  id: string;
  /** Round.project_id — needed for the projects-table join. */
  project_id: string;
  /** Round.package_type (text name, e.g. "Silver Package"). */
  package_type: string | null;
  /** Round.engine_grade_id — direct passthrough into `grade_id`. */
  engine_grade_id: string | null;
}

export interface DerivedRoundScope {
  package_id: string | null;
  project_type_id: string | null;
  price_tier_id: string;
  grade_id: string | null;
  product_id: string | null;
  /**
   * Free-text warnings emitted as we resolve. e.g. "package lookup returned
   * NULL for name='Silver Package'". Surfaces alongside resolver warnings
   * so the operator audit trail captures the gap.
   */
  warnings: string[];
}

const cache = new Map<string, DerivedRoundScope>();

/** Test-only — wipe the per-process cache. */
export function clearScopeCache(): void {
  cache.clear();
}

export interface DeriveRoundScopeArgs {
  admin: ReturnType<typeof getAdminClient>;
  round: DeriveRoundScopeRow;
}

/**
 * Resolve the round into scope IDs for `resolveGalleryPositions`. Tolerates
 * NULL `package_type` / `project_id` / `engine_grade_id`: each missing input
 * just yields a NULL output and a warning, so the resolver still works for
 * the scopes it CAN match (e.g. project_type even if the package lookup
 * fails).
 */
export async function deriveRoundScope(
  args: DeriveRoundScopeArgs,
): Promise<DerivedRoundScope> {
  const cached = cache.get(args.round.id);
  if (cached) {
    return cached;
  }

  const warnings: string[] = [];
  const { admin, round } = args;

  // ─── package_id (text name -> uuid) ─────────────────────────────────────
  let package_id: string | null = null;
  if (round.package_type && round.package_type.length > 0) {
    const { data: pkg, error: pkgErr } = await admin
      .from('packages')
      .select('id')
      .eq('name', round.package_type)
      .maybeSingle();
    if (pkgErr) {
      warnings.push(
        `deriveRoundScope: packages lookup failed for name='${round.package_type}': ${pkgErr.message}`,
      );
    } else if (!pkg) {
      warnings.push(
        `deriveRoundScope: no package found for name='${round.package_type}'`,
      );
    } else {
      package_id = String((pkg as { id: string }).id);
    }
  } else {
    warnings.push('deriveRoundScope: round.package_type is NULL/empty — package_id will be NULL');
  }

  // ─── project_type_id (via projects join) ────────────────────────────────
  let project_type_id: string | null = null;
  if (round.project_id) {
    const { data: proj, error: projErr } = await admin
      .from('projects')
      .select('project_type_id')
      .eq('id', round.project_id)
      .maybeSingle();
    if (projErr) {
      warnings.push(
        `deriveRoundScope: projects lookup failed for id='${round.project_id}': ${projErr.message}`,
      );
    } else if (!proj) {
      warnings.push(
        `deriveRoundScope: no project found for id='${round.project_id}'`,
      );
    } else {
      const ptid = (proj as { project_type_id: string | null }).project_type_id;
      project_type_id = ptid ? String(ptid) : null;
      if (!project_type_id) {
        warnings.push(
          `deriveRoundScope: project ${round.project_id} has NULL project_type_id`,
        );
      }
    }
  } else {
    warnings.push('deriveRoundScope: round.project_id is NULL — project_type_id will be NULL');
  }

  // ─── grade_id — direct passthrough from engine_grade_id ─────────────────
  const grade_id = round.engine_grade_id ?? null;
  if (!grade_id) {
    warnings.push('deriveRoundScope: round.engine_grade_id is NULL — grade_id will be NULL');
  }

  // ─── price_tier_id — hardcoded to Standard (see TODO) ───────────────────
  const price_tier_id = HARDCODED_STANDARD_PRICE_TIER_ID;

  // ─── product_id — round-level product not yet defined ───────────────────
  const product_id: string | null = null;

  const result: DerivedRoundScope = {
    package_id,
    project_type_id,
    price_tier_id,
    grade_id,
    product_id,
    warnings,
  };
  cache.set(round.id, result);
  return result;
}

export const DERIVE_ROUND_SCOPE_VERSION = 'v1.0';
