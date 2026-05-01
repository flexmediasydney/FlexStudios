/**
 * fewShotLibraryBlock.ts — Wave 11.5 / 11.7 / W14 (W7.6 block) cross-project
 * empirically-grown correction library.
 *
 * Loads master_admin-curated few-shot examples from `engine_fewshot_examples`
 * and renders them as authoritative cross-project patterns for the next
 * Stage 1 / Stage 4 prompt. This is the cross-project leg of the closed-loop
 * "engine grows" ethos:
 *
 *   project A round 5: operator corrects exterior_front → exterior_rear
 *                      with evidence [hills_hoist, hot_water_system]
 *   project B round 1: same Hills Hoist visible
 *                      ─→ master_admin promoted that pattern via
 *                         approve-stage4-override or curate flow into
 *                         engine_fewshot_examples.in_active_prompt = TRUE.
 *                         Stage 1 sees the empirical example and avoids the
 *                         exterior_front mislabel.
 *
 * Per-project memory lives in projectMemoryBlock; the few-shot library is the
 * cross-project complement, populated only via explicit master_admin
 * curation (no auto-graduation from raw observation to active prompt — that
 * pollution risk is the reason `in_active_prompt` exists as a separate flag).
 *
 * ─── BLOCK ARCHITECTURE (W7.6 pattern) ───────────────────────────────────────
 *
 * Pure exported async builder returning a multi-line string. Versioned via
 * FEW_SHOT_LIBRARY_BLOCK_VERSION so prompt-cache invalidation tracks block
 * changes. Persisted in `composition_classifications.prompt_block_versions`
 * and (TODO when Agent 1 plumbs it) `engine_run_audit.prompt_block_versions`.
 *
 * Empty-string contract: when there are zero active examples for the
 * filtered combination (tier + image_type), the block returns ''. Callers
 * concatenate prompt blocks with newlines, so the empty string collapses
 * naturally — no header pollution when there's nothing to render.
 *
 * ─── QUERY SHAPE ─────────────────────────────────────────────────────────────
 *
 *   engine_fewshot_examples
 *   WHERE in_active_prompt = TRUE
 *     AND (property_tier IS NULL OR property_tier = $tier)
 *     AND ($image_type IS NULL OR image_type IS NULL OR image_type = $image_type)
 *   ORDER BY observation_count DESC
 *   LIMIT $max_examples (default 20 per W11.7 spec)
 *
 * The dual-NULL behaviour on property_tier and image_type means a row tagged
 * `property_tier = NULL` applies to ALL tiers (cross-cutting examples like
 * hills_hoist signal correction), while a `property_tier = 'premium'` row
 * targets only premium-tier rounds. Same for image_type.
 *
 * ─── ORDERING ────────────────────────────────────────────────────────────────
 *
 * `observation_count DESC` — examples that have been observed (corrected) the
 * most times across the project history are most empirically supported and
 * deserve highest prompt-priority. The 20-cap ensures the model doesn't
 * ignore the tail (per W11.7 spec note: "beyond ~20 the model starts ignoring
 * the tail").
 */

import { getAdminClient } from '../../supabase.ts';

export const FEW_SHOT_LIBRARY_BLOCK_VERSION = 'v1.0';

export type PropertyTierFilter = 'premium' | 'standard' | 'approachable';
export type ImageTypeFilter = 'interior' | 'exterior' | 'detail';

export interface FewShotLibraryOpts {
  /**
   * The current round's property tier. Used to filter the library to
   * tier-targeted examples PLUS tier-agnostic cross-cutting examples.
   */
  property_tier: PropertyTierFilter;
  /**
   * Optional image-type filter. When set, only examples tagged with this
   * type (or untagged / cross-cutting examples) are loaded. Stage 1 typically
   * doesn't know per-batch image types, so this is usually omitted; Stage 4
   * can pass it when it knows the dominant type for the round.
   */
  image_type?: ImageTypeFilter;
  /**
   * Override the default 20-cap on active examples. Per the W11.7 spec note,
   * raising this materially above 20 risks the model ignoring the tail.
   */
  max_examples?: number;
}

interface FewShotRow {
  example_kind: string;
  ai_value: string | null;
  human_value: string | null;
  evidence_keywords: string[];
  description: string | null;
  observation_count: number;
}

// ─── Per-call cache ─────────────────────────────────────────────────────────
//
// Same approach as projectMemoryBlock: avoid double-querying when both
// Stage 1 and Stage 4 inject this block in the same orchestration. Module-
// level Map, 60s TTL, keyed on the filter combination.

interface CacheEntry { rendered: string; ts: number; }
const renderCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

function cacheKey(opts: FewShotLibraryOpts): string {
  return `${opts.property_tier}:${opts.image_type ?? '*'}:${opts.max_examples ?? 20}`;
}

/**
 * Build the few-shot library prompt block for the given tier + optional image
 * type. Returns '' when no active examples match the filter — callers
 * concatenate prompt blocks with '\n', so the empty string collapses
 * naturally without a stray header.
 */
export async function fewShotLibraryBlock(opts: FewShotLibraryOpts): Promise<string> {
  const key = cacheKey(opts);
  const cached = renderCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.rendered;
  }

  const examples = await fetchActiveFewShotExamples(opts);
  const rendered = renderFewShotExamples(examples);

  renderCache.set(key, { rendered, ts: Date.now() });
  return rendered;
}

/**
 * Fetch active few-shot examples matching the tier + (optional) image_type
 * filter. Examples with property_tier = NULL apply across all tiers; same
 * for image_type = NULL.
 *
 * Soft-fail on query error: log + return [] so the prompt assembles without
 * the block rather than blocking the round.
 */
async function fetchActiveFewShotExamples(opts: FewShotLibraryOpts): Promise<FewShotRow[]> {
  const admin = getAdminClient();
  const limit = opts.max_examples ?? 20;

  // Build the query incrementally to keep the OR-with-IS-NULL semantics
  // clear. property_tier filter: row's tier matches OR row applies to all
  // tiers (NULL).
  let query = admin
    .from('engine_fewshot_examples')
    .select(
      'example_kind, ai_value, human_value, evidence_keywords, description, observation_count, property_tier, image_type',
    )
    .eq('in_active_prompt', true)
    .or(`property_tier.is.null,property_tier.eq.${opts.property_tier}`);

  if (opts.image_type) {
    query = query.or(`image_type.is.null,image_type.eq.${opts.image_type}`);
  }

  const { data, error } = await query
    .order('observation_count', { ascending: false })
    .limit(limit);

  if (error) {
    console.warn(`[fewShotLibraryBlock] query failed: ${error.message}`);
    return [];
  }
  return ((data || []) as Record<string, unknown>[]).map((r) => ({
    example_kind: (r.example_kind as string) || 'unknown',
    ai_value: (r.ai_value as string | null) ?? null,
    human_value: (r.human_value as string | null) ?? null,
    evidence_keywords: Array.isArray(r.evidence_keywords)
      ? (r.evidence_keywords as unknown[]).map(String)
      : [],
    description: (r.description as string | null) ?? null,
    observation_count: typeof r.observation_count === 'number'
      ? (r.observation_count as number)
      : 1,
  }));
}

/**
 * Render the FewShotRow list into the prompt-text format per W11.7 spec
 * §"Few-shot library (W14)":
 *
 *   EMPIRICAL CORRECTION EXAMPLES (cross-project patterns):
 *   1. AI labelled exterior_front → human corrected to exterior_rear (8 cases).
 *      Common evidence: hills_hoist, hot_water_system, garden_tap.
 *   2. AI labelled living_room → human corrected to living_secondary (12 cases).
 *      Common evidence: vantage_above_main_floor, distinct_staircase, secondary_furniture.
 *
 *   Apply these patterns when current images match the evidence keywords.
 *
 * Empty list → '' (collapses cleanly).
 */
function renderFewShotExamples(rows: FewShotRow[]): string {
  if (rows.length === 0) return '';

  const lines: string[] = [
    'EMPIRICAL CORRECTION EXAMPLES (cross-project patterns):',
  ];
  rows.forEach((row, idx) => {
    const n = idx + 1;
    const count = row.observation_count;
    const countWord = count === 1 ? 'case' : 'cases';

    // Render is example_kind-aware. Each kind has a slightly different
    // natural-language framing so the model reads them as instructional.
    if (row.example_kind === 'voice_exemplar') {
      // voice_exemplar rows carry the example in `description` (the
      // ideal_output JSON is for downstream tools, not prompt text).
      const desc = (row.description ?? '').trim();
      if (!desc) return; // skip empty exemplars
      lines.push(`${n}. Voice exemplar: ${desc} (${count} ${countWord}).`);
    } else if (row.example_kind === 'reject_pattern') {
      // reject_pattern: "<description> — N cases. Common evidence: <kw>."
      const desc = (row.description ?? '').trim() || 'pattern of high-frequency rejection';
      lines.push(`${n}. Reject pattern: ${desc} (${count} ${countWord}).`);
      if (row.evidence_keywords.length > 0) {
        lines.push(`   Common evidence: ${row.evidence_keywords.join(', ')}.`);
      }
    } else {
      // room_type_correction / composition_correction (default)
      const aiV = row.ai_value || '<unknown>';
      const humanV = row.human_value || '<unknown>';
      lines.push(
        `${n}. AI labelled ${aiV} → human corrected to ${humanV} (${count} ${countWord}).`,
      );
      if (row.evidence_keywords.length > 0) {
        lines.push(`   Common evidence: ${row.evidence_keywords.join(', ')}.`);
      }
      if (row.description && row.description.trim().length > 0) {
        const desc = row.description.trim();
        const capped = desc.length > 200 ? desc.slice(0, 197) + '...' : desc;
        lines.push(`   Note: ${capped}`);
      }
    }
  });
  lines.push(
    '',
    'Apply these patterns when current images match the evidence keywords.',
  );
  return lines.join('\n');
}

/**
 * Test-only export: clear the in-memory cache so unit tests don't see stale
 * renders across test cases. Production code never calls this.
 */
export function _clearFewShotLibraryCache(): void {
  renderCache.clear();
}
