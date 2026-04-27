/**
 * slotEligibility — pure resolver for product-driven slot eligibility (W7.8).
 *
 * Replaces the legacy "match slot.package_types[] against round.package_type
 * by string" with a data-driven join through the products table:
 *
 *   round → package → packages.products[] (JSONB) → product_ids
 *   product_ids → products.engine_role[] (distinct, non-null, is_active=true)
 *   slot eligible iff slot.eligible_when_engine_roles && projectEngineRoles
 *
 * Until every slot row has been backfilled with an explicit engine-role list
 * (Migration 337 + manual review per the design spec), we keep a fallback
 * path: when `eligible_when_engine_roles` is empty/null on a slot, fall back
 * to the legacy `package_types` substring-match. This is intentional defensive
 * coding for the transition window — once 100% of slots have explicit
 * engine-role lists, the fallback becomes unreachable and can be retired in
 * a future subtractive migration.
 *
 * The function lives in `_shared/` so any edge function can import it (Pass 2
 * is the primary caller, but Pass 3 + admin tools may want it too).
 *
 * KEEP THIS PURE: no DB calls, no env reads, no I/O. The orchestrator does
 * the SELECTs and hands the rows in. This makes the rule trivially unit-
 * testable and survivable across schema migrations.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Known engine_role values. We store as TEXT in Postgres (no DB enum) for
 * forward compat — new product categories can land their own roles without
 * a schema migration. The frontend mirrors this list as a hardcoded enum.
 */
export const ENGINE_ROLES = [
  'photo_day_shortlist',
  'photo_dusk_shortlist',
  'drone_shortlist',
  'floorplan_qa',
  'video_day_shortlist',
  'video_dusk_shortlist',
  'agent_portraits',
] as const;

export type EngineRole = (typeof ENGINE_ROLES)[number];

/** Subset of `products` table columns the resolver needs. */
export interface ProductRow {
  id: string;
  engine_role: string | null;
  is_active: boolean;
}

/** Embedded entry inside `packages.products` JSONB array. */
export interface PackageProductEntry {
  product_id: string;
  product_name?: string | null;
  quantity?: number | null;
  min_quantity?: number | null;
  pricing_type?: string | null;
}

/** Subset of `shortlisting_slot_definitions` columns the resolver needs. */
export interface SlotDefinitionRow {
  slot_id: string;
  display_name?: string | null;
  phase?: number | null;
  package_types?: string[] | null;
  eligible_when_engine_roles?: string[] | null;
  eligible_room_types?: string[] | null;
  max_images?: number | null;
  min_images?: number | null;
  notes?: string | null;
  version?: number | null;
  is_active?: boolean | null;
  // Allow callers to pass through extra fields opaquely.
  [k: string]: unknown;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve the distinct, non-null engine roles implied by the products
 * embedded in a package. Inactive products are skipped — they're catalogue
 * residue and shouldn't drive engine behaviour.
 *
 * Pure: takes the package's product entries + the products lookup table; no
 * DB calls.
 */
export function resolvePackageEngineRoles(
  packageProducts: PackageProductEntry[] | null | undefined,
  productsById: Map<string, ProductRow> | ProductRow[],
): EngineRole[] {
  if (!Array.isArray(packageProducts) || packageProducts.length === 0) {
    return [];
  }
  const lookup: Map<string, ProductRow> = productsById instanceof Map
    ? productsById
    : new Map(productsById.map((p) => [p.id, p]));

  const roles = new Set<EngineRole>();
  for (const entry of packageProducts) {
    if (!entry || typeof entry.product_id !== 'string') continue;
    const product = lookup.get(entry.product_id);
    if (!product) continue;
    if (product.is_active !== true) continue;
    if (!product.engine_role) continue;
    if ((ENGINE_ROLES as readonly string[]).includes(product.engine_role)) {
      roles.add(product.engine_role as EngineRole);
    } else {
      // Forward-compat: products may carry a not-yet-recognised role string
      // (someone added a new product type before the frontend enum was
      // updated). We deliberately drop it from the engine-role set rather
      // than crashing — the slot will fall back to package_types matching.
    }
  }
  return Array.from(roles);
}

/**
 * Case-insensitive substring match used by the legacy package_types fallback.
 * Mirrors the existing fetchSlotDefinitions() helper in shortlisting-pass2 so
 * behaviour is unchanged when no engine_role data exists yet.
 */
function pkgMatches(defPkg: string, roundPkg: string): boolean {
  const a = String(defPkg).toLowerCase().trim();
  const b = String(roundPkg).toLowerCase().trim();
  if (!a || !b) return false;
  if (a === b) return true;
  return a.includes(b) || b.includes(a);
}

/**
 * Filter slot definitions by engine-role overlap with the round's resolved
 * roles. Slots with non-empty `eligible_when_engine_roles` use the new path;
 * slots with empty/null `eligible_when_engine_roles` fall back to
 * package_types substring match against `roundPackageName` (legacy behaviour
 * during the migration window).
 *
 * If `eligible_when_engine_roles` IS empty AND `package_types` is empty,
 * the slot is treated as universal (existing convention from
 * fetchSlotDefinitions).
 *
 * Pure: takes already-fetched rows; the caller owns the DB.
 */
export function filterSlotsForRound(opts: {
  slots: SlotDefinitionRow[];
  projectEngineRoles: EngineRole[] | string[];
  /**
   * Round's package_type label (e.g. "Gold Package"). Only used by the
   * fallback path when a slot has no engine-role list. Pass null/empty to
   * skip the fallback (strictly engine-role-driven mode).
   */
  roundPackageName: string | null;
}): SlotDefinitionRow[] {
  const { slots, projectEngineRoles, roundPackageName } = opts;
  const projectRoleSet = new Set<string>(projectEngineRoles || []);
  const fallbackPkg = roundPackageName ? String(roundPackageName).toLowerCase().trim() : '';

  const out: SlotDefinitionRow[] = [];
  for (const slot of slots) {
    const engineRoles = Array.isArray(slot.eligible_when_engine_roles)
      ? slot.eligible_when_engine_roles
      : [];
    const pkgTypes = Array.isArray(slot.package_types) ? slot.package_types : [];

    if (engineRoles.length > 0) {
      // Engine-role-driven path: include if ANY of the slot's roles overlap
      // with the project's roles. NB: an empty projectEngineRoles set means
      // we drop all engine-role-restricted slots — that's the correct
      // behaviour when (e.g.) the round's package has no products with
      // engine_role set.
      const overlaps = engineRoles.some((r) => projectRoleSet.has(r));
      if (overlaps) out.push(slot);
      continue;
    }

    // Fallback: legacy package_types substring match. Empty package_types ==
    // universal (per the existing fetchSlotDefinitions convention).
    if (pkgTypes.length === 0) {
      out.push(slot);
      continue;
    }
    if (!fallbackPkg) {
      // No fallback identifier supplied — drop the slot rather than guessing.
      continue;
    }
    if (pkgTypes.some((p) => pkgMatches(p, fallbackPkg))) {
      out.push(slot);
    }
  }
  return out;
}

/**
 * Convenience top-level API used by the engine entry point. Wraps
 * `resolvePackageEngineRoles` + `filterSlotsForRound` so callers can hand it
 * the package's product entries, the products lookup, the slot rows, and the
 * round's package label, and get the filtered slot list back.
 */
export function resolveEligibleSlots(opts: {
  packageProducts: PackageProductEntry[] | null | undefined;
  products: ProductRow[] | Map<string, ProductRow>;
  slots: SlotDefinitionRow[];
  roundPackageName: string | null;
}): {
  eligibleSlots: SlotDefinitionRow[];
  projectEngineRoles: EngineRole[];
} {
  const projectEngineRoles = resolvePackageEngineRoles(opts.packageProducts, opts.products);
  const eligibleSlots = filterSlotsForRound({
    slots: opts.slots,
    projectEngineRoles,
    roundPackageName: opts.roundPackageName,
  });
  return { eligibleSlots, projectEngineRoles };
}

/**
 * Detect out-of-scope content for the OOS warning path (Pass 0). Given the
 * project's resolved engine roles + a "detected" engine role inferred from
 * the content (e.g. dusk-looking compositions implied by Pass 1's
 * `time_of_day` field, or drone shots inferred from EXIF), return whether
 * the detection is in scope. Returns true when the project's roles include
 * the detected role; false otherwise (caller should warn, not auto-reject).
 *
 * The "warn don't reject" policy is enforced upstream — this function is
 * purely the rule.
 */
export function isContentInScope(
  detectedRole: EngineRole | string,
  projectEngineRoles: EngineRole[] | string[] | null | undefined,
): boolean {
  if (!detectedRole) return true;
  if (!Array.isArray(projectEngineRoles) || projectEngineRoles.length === 0) {
    // No project roles → unable to determine scope. Be permissive (warn-only
    // policy).
    return true;
  }
  return projectEngineRoles.includes(detectedRole as EngineRole);
}
