/**
 * projectMemoryBlock.ts — Wave 11.5 / 11.7 / W11.6.19 (W7.6 block) project-scoped memory.
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
 * "accept AI" signal — not authoritative for memory).
 *
 * Order: actor_at DESC (falls back to created_at when actor_at IS NULL — most
 * older rows pre-date the actor_at column). We pull `max_overrides * 5` from
 * the DB to give clustering room to coalesce; the final prompt is bounded by
 * the tier-aware cap below.
 *
 * ─── W11.6.19: CAP + CLUSTER + TIER-AWARE TRUNCATION ─────────────────────────
 *
 * Without bounds, a heavily-reviewed project's prompt grows linearly with
 * every operator correction (~50-100 tokens per row). Across 100+ overrides
 * this is 5-10k extra tokens per Stage 1 invocation — at $0.0025/1k input
 * tokens, that's $0.025/round just on memory bloat, plus diminishing model
 * attention as the tail grows. W11.6.19 caps the impact:
 *
 *   1. Tier-aware caps:
 *        - premium     → 50 lines max
 *        - standard    → 30 lines max
 *        - approachable→ 20 lines max
 *      Mirrors the broader principle: premium gets more model attention
 *      (more anchors, more memory, more few-shots) per the engine tier
 *      pricing. Approachable is volume work — keep prompts lean.
 *
 *   2. Pattern clustering: when 5+ corrections share the same
 *      (field, ai_value, human_value) tuple — e.g. 8 different stems all
 *      reclassified `room_type: dining_room → living_dining_combined` —
 *      we emit ONE clustered line:
 *
 *        PATTERN: room_type dining_room → living_dining_combined
 *                 (observed 8 times on this project)
 *
 *      replacing 8 verbose stem-by-stem lines. The model only needs to see
 *      the PATTERN once to apply it; repetition wastes tokens and dilutes
 *      attention.
 *
 *   3. Recency ordering: actor_at DESC. Within each cluster (and between
 *      individual lines and clusters in the final list), most recent
 *      operator intent wins. Older signal lives behind clustering.
 *
 *   4. Truncation footer: when the input exceeds the tier cap, append
 *
 *        ... and N older corrections truncated. Top patterns above
 *        represent recent operator intent.
 *
 *      so the model knows the list is not exhaustive — protects against
 *      "the operator never overrode X on this property" hallucinations
 *      from a missing tail.
 *
 * In-memory call-scoped cache: sub-100ms lookup if the same builder is called
 * twice in one request (Stage 1 + Stage 4 both inject this block). Not a
 * persistent cache — fresh DB read per HTTP invocation.
 */

import { getAdminClient } from '../../supabase.ts';

// W11.6.19: bumped from v1.0 → v1.1 to invalidate prompt cache so the new
// cap + cluster + tier-aware truncation propagates immediately.
export const PROJECT_MEMORY_BLOCK_VERSION = 'v1.1';

export type ProjectMemoryTier = 'premium' | 'standard' | 'approachable';

/**
 * Tier-aware caps. Premium rounds carry richer prompts to match the higher
 * model attention budget; approachable stays lean. Consumers of the block
 * pass `voice.tier` from the round's property_tier (default 'standard').
 */
const TIER_CAPS: Record<ProjectMemoryTier, number> = {
  premium: 50,
  standard: 30,
  approachable: 20,
};

/**
 * Clustering threshold: a (field, ai_value, human_value) tuple becomes a
 * clustered PATTERN line when it occurs >= this many times. Below the
 * threshold we emit individual stem-by-stem lines — variation matters when
 * the pattern is still emerging.
 */
const CLUSTER_MIN_OCCURRENCES = 5;

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
   * Optional explicit cap. When provided, overrides the tier-derived cap.
   * Used by tests or edge ops sanity-checking pagination. Production
   * callers should pass `tier` and let the cap resolve from TIER_CAPS.
   */
  max_overrides?: number;
  /**
   * Property tier for the round. Drives the tier-aware cap (premium=50,
   * standard=30, approachable=20). Defaults to 'standard' when omitted —
   * matches the round.property_tier default in shortlisting-shape-d.
   */
  tier?: ProjectMemoryTier;
}

interface OverrideRow {
  stem: string;
  field: string;          // e.g. 'room_type' | 'composition_type' | 'vantage_point' | 'combined_score'
  ai_value: string;
  human_value: string;
  reason: string | null;  // override_reason from the row (capped to ~200 chars in render)
  // Recency timestamp used for ordering and clustering tiebreaks. Falls back
  // to created_at when actor_at is NULL on older rows.
  recency_ts: number;
}

// ─── Per-call cache: avoid double-querying when both Stage 1 + Stage 4 ask ───
//
// Keyed by `${project_id}:${current_round_id}:${cap}`. Lifetime is the
// lifetime of the parent edge fn invocation — the module-level Map gets
// reset on cold-start, which is fine: we only de-dupe within a single round
// orchestration. NOT a persistent cache; safe across orchestration restarts.

interface CacheEntry { rendered: string; ts: number; }
const renderCache = new Map<string, CacheEntry>();

// Per-call entries expire after 60s — long enough to span Stage 1 + Stage 4
// in the same orchestration, short enough that a re-run on the same round
// picks up the freshly-inserted overrides without an explicit cache bust.
const CACHE_TTL_MS = 60_000;

/**
 * Resolve the effective cap. Explicit `max_overrides` wins; otherwise
 * derive from `tier` (defaults to 'standard' = 30).
 */
function resolveCap(opts: ProjectMemoryOpts): number {
  if (typeof opts.max_overrides === 'number' && opts.max_overrides > 0) {
    return opts.max_overrides;
  }
  const tier = opts.tier ?? 'standard';
  return TIER_CAPS[tier];
}

function cacheKey(opts: ProjectMemoryOpts): string {
  return `${opts.project_id}:${opts.current_round_id}:${resolveCap(opts)}`;
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
  const cap = resolveCap(opts);
  const rendered = renderOverridesWithCap(overrides, cap);

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
 * Recency: order by actor_at DESC, falling back to created_at when actor_at
 * is NULL (older rows). We pull `cap * 5` from the DB so clustering has
 * room to coalesce — the final prompt is bounded after rendering.
 */
async function fetchProjectOverrides(opts: ProjectMemoryOpts): Promise<OverrideRow[]> {
  const admin = getAdminClient();
  const cap = resolveCap(opts);
  // Pull 5x the cap so clustering can coalesce without losing tail signal.
  // Hard ceiling at 1000 to bound DB load on pathological projects — even at
  // the ceiling the downstream cap + cluster keeps the prompt lean.
  const queryLimit = Math.min(cap * 5, 1000);

  // We need:
  //   - override fields (ai_*, human_*, override_reason)
  //   - composition_groups.delivery_reference_stem / best_bracket_stem (stem for prompt)
  //   - shortlisting_rounds.project_id (filter scope)
  //   - actor_at + created_at for recency ordering
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
      actor_at,
      created_at,
      round_id,
      composition_groups!inner ( delivery_reference_stem, best_bracket_stem ),
      shortlisting_rounds!inner ( project_id )
    `)
    .eq('shortlisting_rounds.project_id', opts.project_id)
    .neq('round_id', opts.current_round_id)
    // actor_at first (most-accurate operator-action timestamp), created_at as
    // tiebreak for older rows where actor_at is NULL.
    .order('actor_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(queryLimit);

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
    const recency_ts = parseRecencyTs(row.actor_at, row.created_at);

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
        recency_ts,
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
        recency_ts,
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
        recency_ts,
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
        recency_ts,
      });
      continue;
    }
    // No human_* field set — accept AI signal. Skip.
  }
  return out;
}

/**
 * Parse the override row's recency timestamp. Prefers actor_at (the operator's
 * action time), falls back to created_at, then to 0 (epoch) if neither parses —
 * those rows sort to the bottom but stay in the list.
 */
function parseRecencyTs(actor_at: unknown, created_at: unknown): number {
  for (const v of [actor_at, created_at]) {
    if (typeof v === 'string' && v.length > 0) {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
  }
  return 0;
}

/**
 * Tuple key used for clustering. Two overrides cluster iff they share
 * (field, ai_value, human_value). Stem and reason are NOT part of the key —
 * pattern is "what AI got wrong → what operator wants instead", regardless
 * of which image surfaced the pattern.
 */
function clusterTupleKey(r: OverrideRow): string {
  return `${r.field}::${r.ai_value}::${r.human_value}`;
}

/**
 * Apply tier-aware cap, pattern clustering, and recency truncation.
 *
 * Strategy:
 *   1. Sort all rows by recency_ts DESC (newest first).
 *   2. Group by clusterTupleKey, preserving recency-sorted order within each
 *      group. Each group carries its newest member's recency_ts as the
 *      "group recency" for downstream sorting.
 *   3. Decide per group: if size >= CLUSTER_MIN_OCCURRENCES emit ONE clustered
 *      PATTERN line; else emit each member as an individual line.
 *   4. Sort the resulting line entries (mix of individual + clustered) by
 *      group recency DESC. Ensures most-recent operator intent appears first.
 *   5. Truncate to the tier cap. Append the truncation footer when the
 *      pre-truncation count exceeded the cap.
 *
 * Clustering applies BEFORE the cap so a project with 100 corrections that
 * are all the same pattern collapses to 1 prompt line — the cap budget is
 * spent on diversity of patterns, not repetition.
 */
function renderOverridesWithCap(rows: OverrideRow[], cap: number): string {
  if (rows.length === 0) return '';

  // Step 1: stable recency-DESC sort. Rows with identical recency_ts keep
  // their input order — DB already pre-sorted by actor_at DESC, created_at
  // DESC so this is just a defensive in-memory pass.
  const sorted = [...rows].sort((a, b) => b.recency_ts - a.recency_ts);

  // Step 2: cluster by tuple key, preserving recency order within each group.
  const groups = new Map<string, OverrideRow[]>();
  for (const r of sorted) {
    const key = clusterTupleKey(r);
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }

  // Step 3: build line entries. Each entry has a `recency` for cross-entry
  // sorting and a `render()` that emits the lines for that entry.
  interface LineEntry {
    recency: number;
    members: number;        // 1 for individual, N for clustered
    render: () => string[];
  }
  const entries: LineEntry[] = [];

  for (const members of groups.values()) {
    // Newest member's recency drives the entry's overall recency. Already
    // sorted DESC within the group, so members[0] is newest.
    const recency = members[0].recency_ts;

    if (members.length >= CLUSTER_MIN_OCCURRENCES) {
      // Cluster line: one PATTERN entry replaces N stem lines.
      const head = members[0];
      entries.push({
        recency,
        members: members.length,
        render: () => [
          `- PATTERN: ${head.field} ${head.ai_value} → ${head.human_value} ` +
            `(observed ${members.length} times on this project)`,
        ],
      });
    } else {
      // Individual lines: each member emits its own stem-tagged line.
      for (const r of members) {
        entries.push({
          recency: r.recency_ts,
          members: 1,
          render: () => renderIndividual(r),
        });
      }
    }
  }

  // Step 4: sort entries by recency DESC. Cluster entries land at the
  // newest-member's recency, so freshly-recurring patterns surface near
  // the top alongside individual fresh corrections.
  entries.sort((a, b) => b.recency - a.recency);

  // Step 5: cap. Count members truncated for the footer.
  let totalMembers = 0;
  for (const e of entries) totalMembers += e.members;

  const kept: LineEntry[] = [];
  let keptMembers = 0;
  for (const e of entries) {
    if (kept.length >= cap) break;
    kept.push(e);
    keptMembers += e.members;
  }
  const truncatedMembers = Math.max(0, totalMembers - keptMembers);

  // Render kept entries.
  const lines: string[] = [
    'PROJECT MEMORY (prior operator corrections on this property):',
  ];
  for (const e of kept) {
    for (const line of e.render()) lines.push(line);
  }

  if (truncatedMembers > 0) {
    lines.push(
      '',
      `... and ${truncatedMembers} older corrections truncated. ` +
        `Top patterns above represent recent operator intent.`,
    );
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
 * Render a single (non-clustered) override as 1-2 prompt lines.
 *
 *   - IMG_6195: AI room_type=exterior_front → operator corrected to exterior_rear.
 *     Reason: "Hills Hoist + hot water system visible — clearly back yard."
 */
function renderIndividual(r: OverrideRow): string[] {
  // Field-aware verb:
  //   room_type / composition_type / vantage_point → "corrected to"
  //   combined_score → "set to" (numeric override reads better)
  const verb = r.field === 'combined_score' ? 'set to' : 'corrected to';
  const head = `- ${r.stem}: AI ${r.field}=${r.ai_value} → operator ${verb} ${r.human_value}.`;
  if (r.reason && r.reason.trim().length > 0) {
    // Cap reason at ~200 chars to keep the prompt compact. Use a single
    // smart-truncate; the operator's full reason is preserved in the DB
    // for the W11.6 dashboard.
    const trimmed = r.reason.trim();
    const capped = trimmed.length > 200 ? trimmed.slice(0, 197) + '...' : trimmed;
    return [head, `  Reason: "${capped}"`];
  }
  return [head];
}

/**
 * Test-only export: clear the in-memory cache so unit tests don't see stale
 * renders across test cases. Production code never calls this.
 */
export function _clearProjectMemoryCache(): void {
  renderCache.clear();
}

/**
 * Test-only export: render a pre-built OverrideRow list directly so tests
 * can exercise the cap/cluster logic without mocking the Supabase client.
 * Production callers go through projectMemoryBlock() which fetches first.
 */
export function _renderOverridesForTest(
  rows: Array<{
    stem: string;
    field: string;
    ai_value: string;
    human_value: string;
    reason?: string | null;
    recency_ts?: number;
  }>,
  cap: number,
): string {
  const normalised: OverrideRow[] = rows.map((r) => ({
    stem: r.stem,
    field: r.field,
    ai_value: r.ai_value,
    human_value: r.human_value,
    reason: r.reason ?? null,
    recency_ts: typeof r.recency_ts === 'number' ? r.recency_ts : 0,
  }));
  return renderOverridesWithCap(normalised, cap);
}

/**
 * Test-only export: resolve the cap that projectMemoryBlock() would use for
 * a given opts. Lets the tier-cap test verify resolution without DB access.
 */
export function _resolveCapForTest(opts: ProjectMemoryOpts): number {
  return resolveCap(opts);
}
