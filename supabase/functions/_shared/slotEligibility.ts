/**
 * slotEligibility — pure resolver for product-driven slot eligibility (W7.8 + W7.7).
 *
 * Resolves eligible slots for a round via:
 *
 *   round → package + à la carte products → products.engine_role[] (distinct,
 *           non-null, is_active=true)
 *   slot eligible iff slot.eligible_when_engine_roles && projectEngineRoles
 *
 * Wave 7 P1-6 (W7.7) — the legacy `package_types[]` substring-match fallback
 * has been retired. Migration 339 drops the column entirely; W7.8's backfill
 * left every active slot with eligible_when_engine_roles populated, so the
 * fallback path was already dead code at the time of removal.
 *
 * Defensive policy: a slot row with `is_active=true` AND `eligible_when_engine_roles`
 * empty/null is treated as MISCONFIGURED — it's excluded from the result
 * with a warning. Admins shouldn't be able to ship a slot with no eligibility,
 * but we don't crash the engine if they do.
 *
 * The function lives in `_shared/` so any edge function can import it (Pass 2
 * is the primary caller, but Pass 3 + benchmark + admin tools all consume it).
 *
 * KEEP THIS PURE: no DB calls, no env reads, no I/O. The orchestrator does
 * the SELECTs and hands the rows in.
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

/** Subset of `shortlisting_slot_definitions` columns the resolver needs.
 *  W7.7: package_types column dropped from the table; field removed here. */
export interface SlotDefinitionRow {
  slot_id: string;
  display_name?: string | null;
  phase?: number | null;
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
      // than crashing — the slot will simply not match.
    }
  }
  return Array.from(roles);
}

/**
 * Filter slot definitions by engine-role overlap with the round's resolved
 * roles.
 *
 * Wave 7 P1-6 (W7.7): the legacy `package_types[]` substring fallback is
 * retired. Every active slot must have a non-empty
 * `eligible_when_engine_roles` array. A slot violating that contract
 * (empty/null `eligible_when_engine_roles` AND `is_active=true`) is
 * defensively dropped from the result with a console warning — the engine
 * doesn't crash, but the misconfiguration is surfaced.
 *
 * Pure: takes already-fetched rows; the caller owns the DB.
 */
export function filterSlotsForRound(opts: {
  slots: SlotDefinitionRow[];
  projectEngineRoles: EngineRole[] | string[];
  /**
   * @deprecated Wave 7 P1-6 (W7.7) — kept on the API for source compatibility
   * with existing call sites; the value is ignored. Slot eligibility is now
   * strictly engine-role driven.
   */
  roundPackageName: string | null;
}): SlotDefinitionRow[] {
  const { slots, projectEngineRoles } = opts;
  const projectRoleSet = new Set<string>(projectEngineRoles || []);

  const out: SlotDefinitionRow[] = [];
  for (const slot of slots) {
    const engineRoles = Array.isArray(slot.eligible_when_engine_roles)
      ? slot.eligible_when_engine_roles
      : [];

    if (engineRoles.length === 0) {
      // Defensive: a slot row that's is_active=true but has no engine roles
      // is a misconfiguration. Drop it from the result and warn.
      if (slot.is_active === true) {
        console.warn(
          `[slotEligibility] dropping misconfigured slot '${slot.slot_id}' — is_active=true but eligible_when_engine_roles is empty`,
        );
      }
      continue;
    }

    if (engineRoles.some((r) => projectRoleSet.has(r))) {
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
  /**
   * @deprecated Wave 7 P1-6 (W7.7) — see `filterSlotsForRound.roundPackageName`.
   */
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
