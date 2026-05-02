/**
 * slotRecipeResolver.ts — W11.6.25 pure helper.
 *
 * Resolves a per-round slot recipe by walking the four allocation scopes
 * (project_type → package_tier → package → individual_product) in precedence
 * order and merging matching rows by slot_id.
 *
 * Joseph confirmed the merge rules (2026-05-02):
 *   - allocated_count: SUM across contributing scopes.
 *   - classification:  ESCALATE — mandatory > conditional > free_recommendation.
 *   - max_count:       HIGHER between (recipe.max_count, slot.max_images).
 *                      slot.max_images is the floor; recipes can broaden but
 *                      never tighten the slot.
 *   - priority_rank:   MIN (lowest = highest priority).
 *   - notes:           concat distinct values with newlines.
 *
 * Tolerance fallback chain:
 *   package.expected_count_tolerance_below → engine_settings.expected_count_tolerance_below → 3
 *
 * KEEP THIS PURE: no Supabase client / network deps. Caller does the SELECTs
 * and hands the rows in. Tests import the same helper.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type SlotClassification =
  | 'mandatory'
  | 'conditional'
  | 'free_recommendation';

export type SlotScopeType =
  | 'package'
  | 'package_tier'
  | 'project_type'
  | 'individual_product';

/** A single allocation row pulled from shortlisting_slot_allocations. */
export interface SlotAllocationRow {
  scope_type: SlotScopeType;
  scope_ref_id: string;
  slot_id: string;
  classification: SlotClassification;
  allocated_count: number;
  max_count: number | null;
  priority_rank: number;
  notes: string | null;
}

/** Latest-active version of a slot definition (min/max image bounds). */
export interface SlotDefinitionLite {
  slot_id: string;
  phase: number;
  min_images: number | null;
  max_images: number | null;
}

/** Inputs to the resolver — caller provides the project's scope IDs. */
export interface RecipeResolveContext {
  /** projects.project_type_id (nullable). */
  projectTypeId: string | null;
  /** Engine tier UUID (shortlisting_tiers.id). Used as scope_ref_id for package_tier. */
  packageTierId: string | null;
  /** First / primary packages[?].package_id from the project (nullable). */
  packageId: string | null;
  /** Individual product ids — flattened from project.products[]. */
  individualProductIds: string[];
}

/** One contributing scope row, surfaced in the resolved recipe for traceability. */
export interface ContributingScope {
  scope_type: SlotScopeType;
  scope_ref_id: string;
}

/** A merged per-slot entry in the resolved recipe. */
export interface ResolvedSlotEntry {
  slot_id: string;
  classification: SlotClassification;
  allocated_count: number;
  /**
   * Effective max for this slot. After merge:
   *   max(recipe.max_count if set else slot.max_images, slot.max_images)
   * If slot.max_images is also missing, defaults to allocated_count.
   */
  max_count: number;
  priority_rank: number;
  notes: string | null;
  contributing_scopes: ContributingScope[];
}

/** The full snapshot written onto round.resolved_slot_recipe. */
export interface ResolvedSlotRecipe {
  generated_at: string;
  scope: {
    project_type_id: string | null;
    package_tier_id: string | null;
    package_id: string | null;
    individual_product_ids: string[];
  };
  entries: ResolvedSlotEntry[];
  /** Sum of allocated_count across all entries. */
  totals: {
    mandatory: number;
    conditional: number;
    free_recommendation: number;
    total_min: number;
    total_max: number;
  };
}

// ─── Classification escalation ───────────────────────────────────────────────

const CLASSIFICATION_RANK: Record<SlotClassification, number> = {
  free_recommendation: 0,
  conditional: 1,
  mandatory: 2,
};

function escalateClassification(
  a: SlotClassification,
  b: SlotClassification,
): SlotClassification {
  return CLASSIFICATION_RANK[a] >= CLASSIFICATION_RANK[b] ? a : b;
}

// ─── Scope precedence ────────────────────────────────────────────────────────

/**
 * Precedence order: project_type → package_tier → package → individual_product.
 * Joseph confirmed: most-specific wins per scope. The merge rules (SUM /
 * ESCALATE / HIGHER) fold all contributing scopes into one entry per slot_id;
 * precedence only matters for the order in which rows are visited (it shows
 * up in `contributing_scopes`).
 */
const SCOPE_ORDER: SlotScopeType[] = [
  'project_type',
  'package_tier',
  'package',
  'individual_product',
];

// ─── Filter rows by scope ────────────────────────────────────────────────────

/**
 * Pure helper — filter the loaded allocation rows to those matching the
 * caller's project scope IDs.
 */
export function filterAllocationsByScope(
  rows: SlotAllocationRow[],
  ctx: RecipeResolveContext,
): SlotAllocationRow[] {
  const productSet = new Set(ctx.individualProductIds);
  return rows.filter((r) => {
    if (r.scope_type === 'project_type') {
      return ctx.projectTypeId !== null && r.scope_ref_id === ctx.projectTypeId;
    }
    if (r.scope_type === 'package_tier') {
      return ctx.packageTierId !== null && r.scope_ref_id === ctx.packageTierId;
    }
    if (r.scope_type === 'package') {
      return ctx.packageId !== null && r.scope_ref_id === ctx.packageId;
    }
    if (r.scope_type === 'individual_product') {
      return productSet.has(r.scope_ref_id);
    }
    return false;
  });
}

// ─── Core resolver ───────────────────────────────────────────────────────────

export function resolveSlotRecipe(
  scopedRows: SlotAllocationRow[],
  slotDefs: SlotDefinitionLite[],
  ctx: RecipeResolveContext,
): ResolvedSlotRecipe {
  const slotMap = new Map<string, SlotDefinitionLite>();
  for (const s of slotDefs) slotMap.set(s.slot_id, s);

  const bySlot = new Map<string, SlotAllocationRow[]>();
  for (const scope of SCOPE_ORDER) {
    const rowsForScope = scopedRows
      .filter((r) => r.scope_type === scope)
      .slice()
      .sort((a, b) =>
        a.slot_id.localeCompare(b.slot_id) || a.scope_ref_id.localeCompare(b.scope_ref_id),
      );
    for (const r of rowsForScope) {
      if (!slotMap.has(r.slot_id)) continue; // skip orphans
      if (!bySlot.has(r.slot_id)) bySlot.set(r.slot_id, []);
      bySlot.get(r.slot_id)!.push(r);
    }
  }

  const entries: ResolvedSlotEntry[] = [];
  for (const [slot_id, rows] of bySlot.entries()) {
    let allocated_count = 0;
    let priority_rank = Number.POSITIVE_INFINITY;
    let classification: SlotClassification = 'free_recommendation';
    const noteSet = new Set<string>();
    const scopeSet = new Set<string>();
    const contributing_scopes: ContributingScope[] = [];
    let recipeMaxCount: number | null = null;

    for (const r of rows) {
      allocated_count += r.allocated_count;
      classification = escalateClassification(classification, r.classification);
      if (r.priority_rank < priority_rank) priority_rank = r.priority_rank;
      if (r.notes && r.notes.trim().length > 0) noteSet.add(r.notes.trim());
      if (typeof r.max_count === 'number' && r.max_count !== null) {
        recipeMaxCount = recipeMaxCount === null
          ? r.max_count
          : Math.max(recipeMaxCount, r.max_count);
      }
      const scopeKey = `${r.scope_type}:${r.scope_ref_id}`;
      if (!scopeSet.has(scopeKey)) {
        scopeSet.add(scopeKey);
        contributing_scopes.push({
          scope_type: r.scope_type,
          scope_ref_id: r.scope_ref_id,
        });
      }
    }

    const slotDef = slotMap.get(slot_id);
    const slotMax = slotDef?.max_images ?? null;
    let resolved_max_count: number;
    if (recipeMaxCount !== null && slotMax !== null) {
      resolved_max_count = Math.max(recipeMaxCount, slotMax);
    } else if (recipeMaxCount !== null) {
      resolved_max_count = recipeMaxCount;
    } else if (slotMax !== null) {
      resolved_max_count = slotMax;
    } else {
      resolved_max_count = allocated_count;
    }
    if (resolved_max_count < allocated_count) {
      resolved_max_count = allocated_count;
    }

    entries.push({
      slot_id,
      classification,
      allocated_count,
      max_count: resolved_max_count,
      priority_rank: priority_rank === Number.POSITIVE_INFINITY ? 100 : priority_rank,
      notes: noteSet.size > 0 ? Array.from(noteSet).join('\n') : null,
      contributing_scopes,
    });
  }

  entries.sort((a, b) => {
    const cdiff = CLASSIFICATION_RANK[b.classification] - CLASSIFICATION_RANK[a.classification];
    if (cdiff !== 0) return cdiff;
    if (a.priority_rank !== b.priority_rank) return a.priority_rank - b.priority_rank;
    return a.slot_id.localeCompare(b.slot_id);
  });

  let totalMandatory = 0;
  let totalConditional = 0;
  let totalFree = 0;
  let totalMin = 0;
  let totalMax = 0;
  for (const e of entries) {
    if (e.classification === 'mandatory') totalMandatory += e.allocated_count;
    else if (e.classification === 'conditional') totalConditional += e.allocated_count;
    else totalFree += e.allocated_count;
    totalMin += e.allocated_count;
    totalMax += e.max_count;
  }

  return {
    generated_at: new Date().toISOString(),
    scope: {
      project_type_id: ctx.projectTypeId,
      package_tier_id: ctx.packageTierId,
      package_id: ctx.packageId,
      individual_product_ids: ctx.individualProductIds.slice().sort(),
    },
    entries,
    totals: {
      mandatory: totalMandatory,
      conditional: totalConditional,
      free_recommendation: totalFree,
      total_min: totalMin,
      total_max: totalMax,
    },
  };
}

// ─── Tolerance resolver ──────────────────────────────────────────────────────

export interface ToleranceFallbackInput {
  packageTolBelow: number | null | undefined;
  packageTolAbove: number | null | undefined;
  globalTolBelow: number | null | undefined;
  globalTolAbove: number | null | undefined;
}

export function resolveTolerance(
  input: ToleranceFallbackInput,
): { tolerance_below: number; tolerance_above: number } {
  const HARD_DEFAULT = 3;
  const below = pickFiniteNonNegative(input.packageTolBelow)
    ?? pickFiniteNonNegative(input.globalTolBelow)
    ?? HARD_DEFAULT;
  const above = pickFiniteNonNegative(input.packageTolAbove)
    ?? pickFiniteNonNegative(input.globalTolAbove)
    ?? HARD_DEFAULT;
  return { tolerance_below: below, tolerance_above: above };
}

function pickFiniteNonNegative(v: number | null | undefined): number | null {
  if (typeof v !== 'number') return null;
  if (!Number.isFinite(v)) return null;
  if (v < 0) return null;
  return v;
}
