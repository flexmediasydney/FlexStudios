/**
 * pass2Validator.ts — pure validator for Pass 2 JSON output.
 *
 * Enforces the post-processing rules from spec §6 BEFORE the orchestrator
 * persists anything to DB. All enforcement happens here, not in the prompt —
 * the prompt asks politely; the validator enforces.
 *
 * Rules enforced (spec §6 + §12 + L12 + L16):
 *
 *   1. MUTUAL EXCLUSIVITY (L12). A stem cannot appear in both `shortlist` and
 *      `rejected_near_duplicates`. If overlap is detected, shortlist takes
 *      precedence — overlapping stems are removed from rejected_near_duplicates.
 *      This is auto-fixed; produces a warning, not an error.
 *
 *   2. PACKAGE CEILING (L16). shortlist.length must be ≤ packageCeiling.
 *      Gold=24, Day to Dusk=31, Premium=38. EXCEEDS = error, valid=false.
 *      Cannot auto-fix because removing arbitrary stems would create gaps.
 *
 *   3. MANDATORY SLOTS FILLED (§6). Every slot_id in mandatorySlotIds must
 *      appear in slot_assignments. Missing mandatory slots are appended to
 *      unfilled_slots as severity=error. This is fixable (we just append),
 *      so it produces a warning, not an error.
 *
 *   4. ALTERNATIVES DON'T DUPLICATE THE WINNER. For every slot, the winner
 *      stem must not appear in slot_alternatives[that_slot]. If overlap is
 *      detected, the alternative entry is removed (warning).
 *
 *   5. STEMS EXIST IN UNIVERSE. Every stem in shortlist, slot_assignments,
 *      slot_alternatives, phase3_recommendations, and rejected_near_duplicates
 *      must exist in allFileStems. Hallucinated stems are removed (warning).
 *
 * Pure function — no I/O, no side effects. Returns a `fixed` payload that
 * the orchestrator persists. The orchestrator should also persist `warnings`
 * to shortlisting_events for traceability.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Pass2Phase3Recommendation {
  file: string;
  rank: number;
  justification: string;
}

export interface Pass2Output {
  shortlist: string[];
  /** Per-slot winner — string for single-image slots, string[] for multi-image. */
  slot_assignments: Record<string, string | string[]>;
  /** Per-slot alternatives (ranks 2 + 3). */
  slot_alternatives: Record<string, string[]>;
  phase3_recommendations: Pass2Phase3Recommendation[];
  unfilled_slots: string[];
  rejected_near_duplicates: string[];
  coverage_notes: string;
}

export interface Pass2ValidatorConfig {
  /** Hard cap on shortlist size — Gold=24, Day to Dusk=31, Premium=38. */
  packageCeiling: number;
  /** slot_ids of every Phase 1 slot for this package. */
  mandatorySlotIds: string[];
  /** Every stem the model is allowed to reference (from composition_groups). */
  allFileStems: string[];
}

export interface ValidationResult {
  /** false if any UNFIXABLE rule is violated (currently only ceiling overflow). */
  valid: boolean;
  /** Fixed copy of the input — auto-corrections applied. Safe to persist. */
  fixed: Pass2Output;
  /** Auto-fixes applied — log to events for traceability. */
  warnings: string[];
  /** Hard validation failures — round should not be persisted on these. */
  errors: string[];
}

// ─── Validator ───────────────────────────────────────────────────────────────

/**
 * Validate + auto-fix a Pass 2 JSON output.
 *
 * The function is defensive: missing/null fields default to empty
 * collections, type-mismatched items are dropped with a warning, and
 * everything that can be repaired is repaired. The single failure mode that
 * cannot be auto-fixed is an over-ceiling shortlist — that returns valid=false
 * and the orchestrator should refuse to persist.
 */
export function validatePass2Output(
  raw: Pass2Output,
  config: Pass2ValidatorConfig,
): ValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  const universe = new Set(config.allFileStems);
  const mandatorySet = new Set(config.mandatorySlotIds);

  // ─── Defensive copy + coercion ───────────────────────────────────────────
  // The model may emit nulls/strings instead of arrays; tolerate and coerce.
  const fixed: Pass2Output = {
    shortlist: dedup(toStringArray(raw?.shortlist)),
    slot_assignments: coerceSlotAssignments(raw?.slot_assignments),
    slot_alternatives: coerceSlotAlternatives(raw?.slot_alternatives),
    phase3_recommendations: coercePhase3(raw?.phase3_recommendations),
    unfilled_slots: dedup(toStringArray(raw?.unfilled_slots)),
    rejected_near_duplicates: dedup(toStringArray(raw?.rejected_near_duplicates)),
    coverage_notes: typeof raw?.coverage_notes === 'string' ? raw.coverage_notes : '',
  };

  // ─── 5. Drop hallucinated stems before any cross-list logic ──────────────
  fixed.shortlist = filterUniverse(fixed.shortlist, universe, 'shortlist', warnings);
  fixed.rejected_near_duplicates = filterUniverse(
    fixed.rejected_near_duplicates,
    universe,
    'rejected_near_duplicates',
    warnings,
  );
  for (const slotId of Object.keys(fixed.slot_assignments)) {
    const v = fixed.slot_assignments[slotId];
    if (Array.isArray(v)) {
      const cleaned = filterUniverse(v, universe, `slot_assignments.${slotId}`, warnings);
      if (cleaned.length === 0) delete fixed.slot_assignments[slotId];
      else fixed.slot_assignments[slotId] = cleaned;
    } else if (typeof v === 'string') {
      if (!universe.has(v)) {
        warnings.push(`slot_assignments.${slotId} dropped hallucinated stem: ${v}`);
        delete fixed.slot_assignments[slotId];
      }
    } else {
      delete fixed.slot_assignments[slotId];
    }
  }
  for (const slotId of Object.keys(fixed.slot_alternatives)) {
    fixed.slot_alternatives[slotId] = filterUniverse(
      fixed.slot_alternatives[slotId] || [],
      universe,
      `slot_alternatives.${slotId}`,
      warnings,
    );
    if (fixed.slot_alternatives[slotId].length === 0) {
      delete fixed.slot_alternatives[slotId];
    }
  }
  fixed.phase3_recommendations = fixed.phase3_recommendations.filter((r) => {
    if (!universe.has(r.file)) {
      warnings.push(`phase3_recommendations dropped hallucinated stem: ${r.file}`);
      return false;
    }
    return true;
  });

  // ─── 1. Mutual exclusivity (L12) ─────────────────────────────────────────
  // Burst 7 M3/M4: extend the rule to slot_assignments (winners) and
  // phase3_recommendations, not just shortlist. The model occasionally lists
  // a stem in rejected_near_duplicates AND emits it as a slot winner — Pass 3
  // and the lock fn then see contradictory state (the group is "approved" via
  // slot event AND has classification.is_near_duplicate_candidate=true). The
  // lock fn's rejected-set computation excludes approved stems anyway, so the
  // file move is correct — but the UI shows conflicting badges and the
  // training extractor tags the row inconsistently. Fix here: build a
  // "selected set" from shortlist + slot winners + phase3 files; remove any
  // overlap from rejected_near_duplicates. slot_alternatives are NOT in the
  // selected set because alternatives ARE often near-duplicates of the winner
  // by design (that's why they're alternatives).
  const slotWinnerStems: string[] = [];
  for (const v of Object.values(fixed.slot_assignments)) {
    if (Array.isArray(v)) slotWinnerStems.push(...v);
    else if (typeof v === 'string') slotWinnerStems.push(v);
  }
  const phase3Stems = fixed.phase3_recommendations.map((r) => r.file);
  const selectedSet = new Set<string>([
    ...fixed.shortlist,
    ...slotWinnerStems,
    ...phase3Stems,
  ]);
  const overlap = fixed.rejected_near_duplicates.filter((stem) => selectedSet.has(stem));
  if (overlap.length > 0) {
    fixed.rejected_near_duplicates = fixed.rejected_near_duplicates.filter(
      (stem) => !selectedSet.has(stem),
    );
    warnings.push(
      `mutual_exclusivity_fix: ${overlap.length} stem(s) appeared in both selected (shortlist/slot_assignments/phase3) and rejected_near_duplicates — selection takes precedence (${overlap.slice(0, 5).join(', ')}${overlap.length > 5 ? '…' : ''})`,
    );
  }

  // ─── 4. Alternatives don't duplicate winner ──────────────────────────────
  for (const slotId of Object.keys(fixed.slot_alternatives)) {
    const winnerVal = fixed.slot_assignments[slotId];
    const winners = winnerVal == null
      ? []
      : Array.isArray(winnerVal)
        ? winnerVal
        : [winnerVal];
    const winnerSet = new Set(winners);
    const before = fixed.slot_alternatives[slotId];
    const after = before.filter((stem) => !winnerSet.has(stem));
    if (after.length !== before.length) {
      const removed = before.filter((stem) => winnerSet.has(stem));
      warnings.push(
        `slot_alternatives.${slotId} contained the winner stem(s) — removed: ${removed.join(', ')}`,
      );
      if (after.length === 0) delete fixed.slot_alternatives[slotId];
      else fixed.slot_alternatives[slotId] = after;
    }
  }

  // ─── 3. Mandatory slots filled — missing => add to unfilled_slots ────────
  const filledSlotIds = new Set(Object.keys(fixed.slot_assignments));
  const unfilledMandatory: string[] = [];
  for (const slotId of mandatorySet) {
    if (!filledSlotIds.has(slotId)) unfilledMandatory.push(slotId);
  }
  if (unfilledMandatory.length > 0) {
    // Append to unfilled_slots (de-duplicated).
    const merged = new Set([...fixed.unfilled_slots, ...unfilledMandatory]);
    fixed.unfilled_slots = Array.from(merged);
    warnings.push(
      `mandatory_slots_unfilled: ${unfilledMandatory.length} slot(s) had no candidate — flagged for human review (${unfilledMandatory.join(', ')})`,
    );
  }

  // ─── 2. Package ceiling (L16) — UNFIXABLE ────────────────────────────────
  if (fixed.shortlist.length > config.packageCeiling) {
    errors.push(
      `package_ceiling_exceeded: shortlist has ${fixed.shortlist.length} stems but ceiling is ${config.packageCeiling}. Cannot auto-fix.`,
    );
  }

  // Coverage notes empty is a warning, not an error — the model occasionally
  // forgets, and we'd rather surface a partial result than reject everything.
  if (!fixed.coverage_notes || fixed.coverage_notes.trim().length < 20) {
    warnings.push('coverage_notes was empty or under 20 chars — model omitted summary.');
  }

  return {
    valid: errors.length === 0,
    fixed,
    warnings,
    errors,
  };
}

// ─── Coercion helpers ────────────────────────────────────────────────────────

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === 'string') as string[];
}

function dedup(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

function coerceSlotAssignments(
  v: unknown,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string' && val.length > 0) {
      out[k] = val;
    } else if (Array.isArray(val)) {
      const cleaned = val.filter((x): x is string => typeof x === 'string' && x.length > 0);
      if (cleaned.length === 1) out[k] = cleaned[0];
      else if (cleaned.length > 1) out[k] = cleaned;
    }
    // null / number / object → drop silently (defensive parse)
  }
  return out;
}

function coerceSlotAlternatives(v: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (Array.isArray(val)) {
      const cleaned = val.filter((x): x is string => typeof x === 'string' && x.length > 0);
      if (cleaned.length > 0) out[k] = cleaned;
    }
  }
  return out;
}

function coercePhase3(v: unknown): Pass2Phase3Recommendation[] {
  if (!Array.isArray(v)) return [];
  const out: Pass2Phase3Recommendation[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.file !== 'string' || !obj.file) continue;
    const rank = typeof obj.rank === 'number' ? obj.rank : Number(obj.rank);
    const justification = typeof obj.justification === 'string' ? obj.justification : '';
    out.push({
      file: obj.file,
      rank: Number.isFinite(rank) ? rank : 0,
      justification,
    });
  }
  return out;
}

function filterUniverse(
  arr: string[],
  universe: Set<string>,
  label: string,
  warnings: string[],
): string[] {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const stem of arr) {
    if (universe.has(stem)) kept.push(stem);
    else dropped.push(stem);
  }
  if (dropped.length > 0) {
    warnings.push(
      `${label}: dropped ${dropped.length} hallucinated stem(s) (${dropped.slice(0, 5).join(', ')}${dropped.length > 5 ? '…' : ''})`,
    );
  }
  return kept;
}
