/**
 * Wave 14 — calibration SESSION math helpers (editor-vs-AI diff).
 *
 * Distinct from `calibrationMath.ts` (mig 384a / W14-structured-calibration),
 * which measures engine-vs-engine drift between regen runs. This module
 * computes the editor-vs-AI disagreement diff for the W14 calibration session
 * substrate (mig 407 / W14-calibration-session.md).
 *
 * Pure functions — no Supabase / Deno / network deps. Imported by:
 *   - shortlisting-benchmark-runner (when trigger='calibration', writes diffs)
 *   - calibrationSessionMath.test.ts (the unit tests)
 *
 * Spec: docs/design-specs/W14-calibration-session.md §3.
 * Migration: 407_w14_calibration_session.sql.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type DecisionState =
  | 'shortlisted'
  | 'rejected'
  | 'unranked'
  | 'no_eligible';

export type Agreement = 'match' | 'disagree';

/**
 * One slot's worth of editor + AI ground truth, paired up.
 *
 * stem is nullable because for some slots both sides may have decided "no
 * eligible photo" (no_eligible/no_eligible) — the slot still produces a row,
 * stem stays null, agreement=match.
 */
export interface SlotPairing {
  slot_id: string;
  stem: string | null;
  ai_decision: DecisionState;
  editor_decision: DecisionState;
  ai_score?: number | null;
  ai_per_dim_scores?:
    | { technical: number; lighting: number; composition: number; aesthetic: number }
    | null;
  ai_analysis_excerpt?: string | null;
}

/**
 * Inputs to buildCalibrationDecisions: the editor's submitted shortlist for a
 * project + the AI's parallel benchmark output, joined by slot_id.
 */
export interface CalibrationDiffInput {
  calibration_session_id: string;
  project_id: string;
  round_id: string | null;
  slots: SlotPairing[];
  /** Pinned at session start. Stamped onto every decision row. */
  engine_version: string | null;
  tier_config_version: number | null;
}

/**
 * Insertable row shape for `calibration_decisions`. Matches the column list
 * declared in mig 407.
 */
export interface CalibrationDecisionRow {
  calibration_session_id: string;
  project_id: string;
  round_id: string | null;
  slot_id: string;
  stem: string | null;
  ai_decision: DecisionState;
  editor_decision: DecisionState;
  agreement: Agreement;
  ai_score: number | null;
  ai_per_dim_scores: Record<string, number> | null;
  ai_analysis_excerpt: string | null;
  // editor_reasoning + primary_signal_diff + reasoning_categories +
  // editor_score_override are filled in later by the editor UI submit hook
  // (`calibration-submit-decisions`). The benchmark-runner-driven build only
  // produces the AI side + agreement classification.
  editor_reasoning: string | null;
  primary_signal_diff: string | null;
  reasoning_categories: string[] | null;
  editor_score_override: number | null;
  engine_version: string | null;
  tier_config_version: number | null;
}

// ─── Pure builders ──────────────────────────────────────────────────────────

/**
 * Compute agreement = 'match' iff ai_decision === editor_decision.
 */
export function classifyAgreement(
  ai: DecisionState,
  editor: DecisionState,
): Agreement {
  return ai === editor ? 'match' : 'disagree';
}

/**
 * Build the rows the benchmark-runner will INSERT into calibration_decisions.
 * Editor-side reasoning fields stay null at this stage — the editor fills them
 * in via `calibration-submit-decisions`.
 *
 * Ordering: stable by slot_id ASC for deterministic test snapshots.
 */
export function buildCalibrationDecisions(
  input: CalibrationDiffInput,
): CalibrationDecisionRow[] {
  const sorted = [...input.slots].sort((a, b) => a.slot_id.localeCompare(b.slot_id));
  return sorted.map((s) => ({
    calibration_session_id: input.calibration_session_id,
    project_id: input.project_id,
    round_id: input.round_id,
    slot_id: s.slot_id,
    stem: s.stem,
    ai_decision: s.ai_decision,
    editor_decision: s.editor_decision,
    agreement: classifyAgreement(s.ai_decision, s.editor_decision),
    ai_score: typeof s.ai_score === 'number' ? s.ai_score : null,
    ai_per_dim_scores: s.ai_per_dim_scores ?? null,
    ai_analysis_excerpt: s.ai_analysis_excerpt ?? null,
    editor_reasoning: null,
    primary_signal_diff: null,
    reasoning_categories: null,
    editor_score_override: null,
    engine_version: input.engine_version,
    tier_config_version: input.tier_config_version,
  }));
}

/**
 * Pair the AI-proposed shortlist (per-slot stem assignments) with the editor's
 * submitted picked_stems list. Returns one SlotPairing per known slot_id from
 * the union of both sides.
 *
 * Decision derivation (per spec §3):
 *   - ai_decision='shortlisted' for the AI-assigned stem at slot_id.
 *   - editor_decision='shortlisted' if the slot's AI stem is in editor_picked_stems.
 *   - When editor picks a DIFFERENT stem for the same slot, that yields a
 *     SECOND pairing row for the editor's stem with editor=shortlisted +
 *     ai=rejected.
 */
export interface PairingInput {
  /** AI's proposed shortlist: slot_id -> stem (or null when AI proposed nothing). */
  ai_slot_assignments: Record<string, string | null>;
  /** AI's per-stem context for shortlisted picks. */
  ai_per_stem_context: Record<
    string,
    {
      ai_score?: number | null;
      ai_per_dim_scores?: SlotPairing['ai_per_dim_scores'];
      ai_analysis_excerpt?: string | null;
    }
  >;
  /** Editor's blind shortlist (regardless of slot). */
  editor_picked_stems: string[];
  /** Optional map: editor's intended slot_id for each picked stem. */
  editor_slot_intent?: Record<string, string>;
}

export function pairSlotsForDiff(input: PairingInput): SlotPairing[] {
  const editorPicked = new Set(input.editor_picked_stems);
  const out: SlotPairing[] = [];

  // 1) For each AI slot assignment, emit one row.
  for (const [slot_id, ai_stem] of Object.entries(input.ai_slot_assignments)) {
    const stemCtx = ai_stem ? input.ai_per_stem_context[ai_stem] ?? {} : {};
    const ai_decision: DecisionState = ai_stem ? 'shortlisted' : 'no_eligible';
    const editor_decision: DecisionState =
      ai_stem && editorPicked.has(ai_stem) ? 'shortlisted' : 'rejected';
    out.push({
      slot_id,
      stem: ai_stem,
      ai_decision,
      editor_decision,
      ai_score: stemCtx.ai_score ?? null,
      ai_per_dim_scores: stemCtx.ai_per_dim_scores ?? null,
      ai_analysis_excerpt: stemCtx.ai_analysis_excerpt ?? null,
    });
  }

  // 2) For each editor-picked stem the AI did NOT shortlist for any slot, emit
  //    a row with ai=rejected, editor=shortlisted.
  const aiShortlistedStems = new Set(
    Object.values(input.ai_slot_assignments).filter((v): v is string => !!v),
  );
  for (const editor_stem of input.editor_picked_stems) {
    if (aiShortlistedStems.has(editor_stem)) continue;
    const intended_slot = input.editor_slot_intent?.[editor_stem] ?? 'unmapped';
    out.push({
      slot_id: intended_slot,
      stem: editor_stem,
      ai_decision: 'rejected',
      editor_decision: 'shortlisted',
    });
  }

  return out;
}

// ─── W14.5: Suggestion-engine validation join (object_registry.market_frequency) ─

/**
 * One disagreement row joined with the canonical object the editor's
 * primary_signal_diff likely points at (W14.5 — spec §7).
 *
 * The join: SELECT calibration_decisions WHERE agreement='disagree'
 *           LEFT JOIN object_registry ON canonical_id = primary_signal_diff
 *           ORDER BY market_frequency DESC NULLS LAST.
 */
export interface DisagreementWithMarketFreq {
  decision_id: string;
  slot_id: string;
  primary_signal_diff: string | null;
  market_frequency: number | null;
  canonical_display_name: string | null;
  editor_reasoning: string | null;
}

export interface SignalPriorityRow {
  primary_signal_diff: string;
  count: number;
  market_frequency: number | null;
  /** market_frequency × count — higher = touch first. */
  priority_score: number;
  example_reasonings: string[];
}

export function rankSignalsByMarketImpact(
  rows: DisagreementWithMarketFreq[],
  opts: { example_count?: number } = {},
): SignalPriorityRow[] {
  const exampleN = opts.example_count ?? 3;
  const grouped = new Map<
    string,
    {
      count: number;
      market_frequency: number | null;
      example_reasonings: string[];
    }
  >();
  for (const r of rows) {
    if (!r.primary_signal_diff) continue;
    const key = r.primary_signal_diff;
    const slot = grouped.get(key);
    if (!slot) {
      grouped.set(key, {
        count: 1,
        market_frequency: r.market_frequency,
        example_reasonings: r.editor_reasoning ? [r.editor_reasoning] : [],
      });
    } else {
      slot.count += 1;
      if (
        slot.market_frequency == null ||
        (r.market_frequency != null && r.market_frequency > slot.market_frequency)
      ) {
        slot.market_frequency = r.market_frequency;
      }
      if (r.editor_reasoning && slot.example_reasonings.length < exampleN) {
        slot.example_reasonings.push(r.editor_reasoning);
      }
    }
  }
  const out: SignalPriorityRow[] = [];
  for (const [key, agg] of grouped.entries()) {
    const freq = agg.market_frequency;
    const priority_score = freq != null ? freq * agg.count : 0;
    out.push({
      primary_signal_diff: key,
      count: agg.count,
      market_frequency: freq,
      priority_score,
      example_reasonings: agg.example_reasonings,
    });
  }
  out.sort((a, b) => {
    if (b.priority_score !== a.priority_score) return b.priority_score - a.priority_score;
    if (b.count !== a.count) return b.count - a.count;
    return a.primary_signal_diff.localeCompare(b.primary_signal_diff);
  });
  return out;
}

// ─── Validation: spec §3 + §5 ──────────────────────────────────────────────

export interface DecisionValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Edge-fn-side validation per spec R3:
 *   - disagreement rows MUST carry non-empty editor_reasoning + primary_signal_diff
 *   - match rows can have empty reasoning
 */
export function validateSubmittedDecisions(
  rows: ReadonlyArray<{
    slot_id: string;
    agreement: Agreement;
    editor_reasoning: string | null;
    primary_signal_diff: string | null;
  }>,
): DecisionValidationResult {
  const errors: string[] = [];
  for (const r of rows) {
    if (r.agreement !== 'disagree') continue;
    if (!r.editor_reasoning || !r.editor_reasoning.trim()) {
      errors.push(`slot ${r.slot_id}: disagree row missing editor_reasoning`);
    }
    if (!r.primary_signal_diff || !r.primary_signal_diff.trim()) {
      errors.push(`slot ${r.slot_id}: disagree row missing primary_signal_diff`);
    }
  }
  return { ok: errors.length === 0, errors };
}
