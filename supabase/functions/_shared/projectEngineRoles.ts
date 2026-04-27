/**
 * projectEngineRoles.ts — Wave 7 P1-6 (W7.7) follow-up.
 *
 * Pure resolver for the project-level engine_role union: walks
 *   projects.packages[].products[]   (bundled, additive)
 *   projects.products[]              (à la carte, additive)
 * and returns the deduped set of engine_roles those products imply.
 *
 * Replaces three near-identical inline copies that lived in:
 *   - shortlisting-pass2/index.ts             (`resolveProjectEngineRoles`)
 *   - shortlisting-pass3/index.ts             (`resolveProjectEngineRolesForCoverage`)
 *   - shortlisting-benchmark-runner/index.ts  (`resolveProjectEngineRolesForBench`)
 *
 * Inline-copy diff (preserved here for the audit trail):
 *
 *   - Pass 2's copy ran the role union through
 *     `slotEligibility.resolvePackageEngineRoles`, which filters the result
 *     against the known `ENGINE_ROLES` enum (forward-compat: an unknown
 *     role string from a not-yet-shipped product type is silently dropped
 *     so the engine doesn't crash).
 *   - Pass 3 + benchmark inlined a simpler loop that accepted any non-empty
 *     `engine_role` string. They DID still filter inactive products, so the
 *     only behavioural delta vs Pass 2 was the forward-compat enum filter.
 *
 * The unified helper here matches Pass 2's behaviour (forward-compat
 * filter) — it's the safer of the two policies: any unknown role that
 * leaked through into Pass 3 / benchmark wouldn't have matched any slot's
 * `eligible_when_engine_roles` anyway (slot definitions only enumerate
 * known roles), so the practical effect on coverage filtering is nil.
 *
 * KEEP THIS PURE: no DB calls, no env reads. Caller does the SELECTs and
 * hands the project + products catalog rows in.
 */

import {
  resolvePackageEngineRoles,
  type EngineRole,
  type ProductRow,
} from './slotEligibility.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Shape of a `projects` row needed for engine-role resolution. Mirrors
 * `ProjectForFlatten` (from packageCounts.ts) but only requires the fields
 * this helper actually reads. The two shapes are intentionally compatible
 * — callers that already have a `ProjectForFlatten`-shaped value can pass
 * it straight through.
 */
export interface ProjectForEngineRoles {
  packages?: Array<{
    products?: Array<{ product_id?: string }> | null;
  }> | null;
  products?: Array<{ product_id?: string }> | null;
}

// ─── resolveProjectEngineRoles ───────────────────────────────────────────────

/**
 * Resolve a project's distinct engine_role set from BOTH bundled products
 * (`projects.packages[].products[]`) AND à la carte products
 * (`projects.products[]`). The two paths are additive per Joseph 2026-04-27
 * — à la carte add-ons extend the bundled set, they don't replace it.
 *
 * The `productsCatalog` argument is the rows returned from
 *   SELECT id, engine_role, is_active FROM products WHERE id IN (...)
 * for every product_id referenced by the project. Inactive products and
 * products with null engine_role are skipped (they're catalogue residue
 * or pure add-on fees that don't drive engine behaviour).
 *
 * The result is filtered against the known `ENGINE_ROLES` enum
 * (forward-compat — see slotEligibility.ts for the rationale) so unknown
 * future role strings are silently dropped rather than crashing the
 * engine.
 *
 * Returns the deduped array of engine_roles. Order is not stable; callers
 * that need a deterministic order should sort.
 */
export function resolveProjectEngineRoles(
  project: ProjectForEngineRoles | null | undefined,
  productsCatalog: ProductRow[],
): EngineRole[] {
  if (!project) return [];

  const productIds = new Set<string>();

  // Bundled path
  const projectPackages = Array.isArray(project.packages) ? project.packages : [];
  for (const pkg of projectPackages) {
    if (!pkg) continue;
    const embedded = Array.isArray(pkg.products) ? pkg.products : [];
    for (const ent of embedded) {
      if (ent && typeof ent.product_id === 'string' && ent.product_id) {
        productIds.add(ent.product_id);
      }
    }
  }

  // À la carte path (additive with bundled — Joseph confirmed 2026-04-27)
  const projectProducts = Array.isArray(project.products) ? project.products : [];
  for (const ent of projectProducts) {
    if (ent && typeof ent.product_id === 'string' && ent.product_id) {
      productIds.add(ent.product_id);
    }
  }

  if (productIds.size === 0) return [];

  // Reuse the pure resolver to keep semantics in lockstep with the unit
  // tests for `resolvePackageEngineRoles` (which already cover inactive
  // skip, null-role skip, dedup, and unknown-role drop).
  return resolvePackageEngineRoles(
    Array.from(productIds).map((id) => ({ product_id: id })),
    productsCatalog,
  );
}
