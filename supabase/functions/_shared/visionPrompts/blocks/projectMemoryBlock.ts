/**
 * projectMemoryBlock.ts — Wave 11.5 / 11.7 (W7.6 block) project-scoped memory.
 *
 * Loads the operator's prior reclassifications on THIS property and renders
 * them as authoritative context for the next Stage 1 / Stage 4 prompt. This
 * is the per-project leg of the closed-loop "engine grows per project" ethos
 * (W11.7 §"Project memory + canonical registry hooks"):
 *
 *   round N: operator reclassifies IMG_6195 from `exterior_front` to
 *            `exterior_rear`, citing "Hills Hoist + hot water system visible"
 *            ─→ row inserted into composition_classification_overrides with
 *               override_source='stage1_correction'.
 *   round N+1 (same project, fresh shoot or reroll): Stage 1's prompt
 *            assembly injects this block. The model sees the prior correction
 *            and treats it as authoritative, never re-mislabeling that image
 *            (or visually-similar ones) on this property.
 *
 * The cross-project leg lives in W12 (canonical object registry) and W14
 * (few-shot library). Project memory is the conservative scope: it never
 * pollutes other projects with one operator's call.
 *
 * ─── BLOCK ARCHITECTURE (W7.6 pattern) ───────────────────────────────────────
 *
 * Pure exported async builder returning a multi-line string. Versioned via
 * PROJECT_MEMORY_BLOCK_VERSION so prompt-cache invalidation tracks block
 * changes. Persisted in `composition_classifications.prompt_block_versions`
 * and (TODO when Agent 1 plumbs it) `engine_run_audit.prompt_block_versions`.
 *
 * Empty-string contract: when the project has zero overrides, the block
 * returns ''. Callers concatenate blocks with newlines, so the empty string
 * collapses naturally — no header pollution when there's nothing to render.
 *
 * ─── QUERY SHAPE ─────────────────────────────────────────────────────────────
 *
 *   composition_classification_overrides
 *     ⨯ shortlisting_rounds (filter to this project, exclude current round)
 *     ⨯ composition_groups (resolve stem for the prompt text)
 *
 * Filter: human_value IS NOT NULL (a row with all human_* fields NULL is an
 * "accept AI" signal — not authoritative for memory). LIMIT 50 to keep the
 * prompt block bounded; older overrides in 50+ project memory are unusual
 * (operators don't re-correct already-corrected groups across rounds).
 *
 * In-memory call-scoped cache: sub-100ms lookup if the same builder is called
 * twice in one request (Stage 1 + Stage 4 both inject this block). Not a
 * persistent cache — fresh DB read per HTTP invocation.
 */

import { getAdminClient } from '../../supabase.ts';

export const PROJECT_MEMORY_BLOCK_VERSION = 'v1.0';

export interface ProjectMemoryOpts {
  /**
   * The project we're rendering memory for. We resolve this via a JOIN on
   * shortlisting_rounds → projects so any override row whose round belongs
   * to this project_id is in scope.
   */
  project_id: string;
  /**
   * The current round being prompt-assembled. We exclude overrides from this
   * round itself — the model is currently emitting Stage 1 against this
   * round; its own in-flight overrides aren't "prior" yet.
   */
  current_round_id: string;
  /**
   * Override the default 50-row cap. Used by tests or edge ops who want to
   * sanity-check that pagination behaves.
   */
  max_overrides?: number;
}

interface OverrideRow {
  stem: string;
  field: string;          // e.g. 'room_type' | 'composition_type' | 'vantage_point' | 'combined_score'
  ai_value: string;
  human_value: string;
  reason: string | null;  // override_reason from the row (capped to ~200 chars in render)
}

// ─── Per-call cache: avoid double-querying when both Stage 1 + Stage 4 ask ───
//
// Keyed by `${project_id}:${current_round_id}:${max_overrides}`. Lifetime is
// the lifetime of the parent edge fn invocation — the module-level Map gets
// reset on cold-start, which is fine: we only de-dupe within a single round
// orchestration. NOT a persistent cache; safe across orchestration restarts.

interface CacheEntry { rendered: string; ts: number; }
const renderCache = new Map<string, CacheEntry>();

// Per-call entries expire after 60s — long enough to span Stage 1 + Stage 4
// in the same orchestration, short enough that a re-run on the same round
// picks up the freshly-inserted overrides without an explicit cache bust.
const CACHE_TTL_MS = 60_000;

function cacheKey(opts: ProjectMemoryOpts): string {
  return `${opts.project_id}:${opts.current_round_id}:${opts.max_overrides ?? 50}`;
}

/**
 * Build the project_memory prompt block for the given project + round.
 *
 * Returns '' (empty string) when there are no prior overrides — callers
 * concatenate prompt blocks with '\n', so the empty string collapses
 * naturally without a stray header.
 */
export async function projectMemoryBlock(opts: ProjectMemoryOpts): Promise<string> {
  // Cache check: cheap, since Stage 1 + Stage 4 in the same orchestration
  // build identical block text.
  const key = cacheKey(opts);
  const cached = renderCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.rendered;
  }

  const overrides = await fetchProjectOverrides(opts);
  const rendered = renderOverrides(overrides);

  renderCache.set(key, { rendered, ts: Date.now() });
  return rendered;
}

/**
 * Fetch overrides for this project, excluding the current round, where the
 * operator actually corrected something (any human_* field non-null).
 *
 * Schema reminder (mig 373):
 *   composition_classification_overrides has these correctable columns:
 *     ai_room_type / human_room_type
 *     ai_composition_type / human_composition_type
 *     ai_vantage_point / human_vantage_point
 *     ai_combined_score / human_combined_score
 *
 * We pick the FIRST non-null human_* field and emit one row per override
 * per field. Most operators correct one field at a time so this is usually
 * 1:1; multi-field overrides emit the most-impactful field
 * (room_type > composition_type > vantage_point > combined_score).
 *
 * Limitations / future work:
 *   - We don't currently emit `human_eligible_slot_ids` overrides into the
 *     prompt — those are slot-routing hints rather than per-image labels.
 *   - We don't show observation_count or operator role; the operator's
 *     correction is treated as authoritative regardless of role.
 */
async function fetchProjectOverrides(opts: ProjectMemoryOpts): Promise<OverrideRow[]> {
  const admin = getAdminClient();
  const limit = opts.max_overrides ?? 50;

  // We need:
  //   - override fields (ai_*, human_*, override_reason)
  //   - composition_groups.delivery_reference_stem / best_bracket_stem (stem for prompt)
  //   - shortlisting_rounds.project_id (filter scope)
  //
  // Postgrest nested-select syntax does the JOINs in one round-trip.
  const { data, error } = await admin
    .from('composition_classification_overrides')
    .select(`
      ai_room_type,
      human_room_type,
      ai_composition_type,
      human_composition_type,
      ai_vantage_point,
      human_vantage_point,
      ai_combined_score,
      human_combined_score,
      override_reason,
      created_at,
      round_id,
      composition_groups!inner ( delivery_reference_stem, best_bracket_stem ),
      shortlisting_rounds!inner ( project_id )
    `)
    .eq('shortlisting_rounds.project_id', opts.project_id)
    .neq('round_id', opts.current_round_id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    // Soft-fail: log and return empty so the prompt assembles without memory
    // rather than blocking the round entirely.
    console.warn(
      `[projectMemoryBlock] override lookup failed for project ${opts.project_id}: ${error.message}`,
    );
    return [];
  }

  // Map rows to OverrideRow, picking the first non-null human_* field per row.
  const out: OverrideRow[] = [];
  for (const row of (data || []) as Record<string, unknown>[]) {
    const groups = row.composition_groups as Record<string, unknown> | null;
    const stem = (groups?.delivery_reference_stem as string | null)
      || (groups?.best_bracket_stem as string | null)
      || '<unknown>';
    const reason = (row.override_reason as string | null) ?? null;

    // Field priority: room_type > composition_type > vantage_point > combined_score.
    // Most semantically important first; operators typically only override one
    // field per row but we want the highest-leverage signal in the prompt.
    if (row.human_room_type) {
      out.push({
        stem,
        field: 'room_type',
        ai_value: (row.ai_room_type as string | null) ?? '<unknown>',
        human_value: row.human_room_type as string,
        reason,
      });
      continue;
    }
    if (row.human_composition_type) {
      out.push({
        stem,
        field: 'composition_type',
        ai_value: (row.ai_composition_type as string | null) ?? '<unknown>',
        human_value: row.human_composition_type as string,
        reason,
      });
      continue;
    }
    if (row.human_vantage_point) {
      out.push({
        stem,
        field: 'vantage_point',
        ai_value: (row.ai_vantage_point as string | null) ?? '<unknown>',
        human_value: row.human_vantage_point as string,
        reason,
      });
      continue;
    }
    if (row.human_combined_score != null) {
      out.push({
        stem,
        field: 'combined_score',
        ai_value: row.ai_combined_score != null ? String(row.ai_combined_score) : '<unknown>',
        human_value: String(row.human_combined_score),
        reason,
      });
      continue;
    }
    // No human_* field set — accept AI signal. Skip.
  }
  return out;
}

/**
 * Render the OverrideRow list into the prompt-text format per W11.7 spec
 * §"Project memory (W11.5)":
 *
 *   PROJECT MEMORY (prior operator corrections on this property):
 *   - IMG_6195: AI=exterior_front → operator corrected to exterior_rear.
 *     Reason: "Hills Hoist + hot water system visible — clearly back yard."
 *   - IMG_6228: AI=living_room → operator corrected to living_secondary.
 *     Reason: "Upstairs lounge, visually distinct from ground-floor living."
 *
 *   Treat these prior corrections as authoritative for this property.
 *   When images in the current set show similar evidence, apply the same
 *   classification pattern.
 *
 * Empty list → '' (collapses cleanly when concatenated with surrounding blocks).
 */
function renderOverrides(rows: OverrideRow[]): string {
  if (rows.length === 0) return '';

  const lines: string[] = [
    'PROJECT MEMORY (prior operator corrections on this property):',
  ];
  for (const r of rows) {
    // Field-aware verb:
    //   room_type / composition_type / vantage_point → "corrected to"
    //   combined_score → "set to" (numeric override reads better)
    const verb = r.field === 'combined_score' ? 'set to' : 'corrected to';
    lines.push(
      `- ${r.stem}: AI ${r.field}=${r.ai_value} → operator ${verb} ${r.human_value}.`,
    );
    if (r.reason && r.reason.trim().length > 0) {
      // Cap reason at ~200 chars to keep the prompt compact. Use a single
      // smart-truncate; the operator's full reason is preserved in the DB
      // for the W11.6 dashboard.
      const trimmed = r.reason.trim();
      const capped = trimmed.length > 200 ? trimmed.slice(0, 197) + '...' : trimmed;
      lines.push(`  Reason: "${capped}"`);
    }
  }
  lines.push(
    '',
    'Treat these prior corrections as authoritative for this property.',
    'When images in the current set show similar evidence, apply the same',
    'classification pattern.',
  );
  return lines.join('\n');
}

/**
 * Test-only export: clear the in-memory cache so unit tests don't see stale
 * renders across test cases. Production code never calls this.
 */
export function _clearProjectMemoryCache(): void {
  renderCache.clear();
}
