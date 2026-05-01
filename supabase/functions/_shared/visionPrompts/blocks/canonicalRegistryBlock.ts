/**
 * canonicalRegistryBlock.ts — Wave 12 prompt block (W7.6 composable).
 *
 * Renders the top-N most-frequent canonical objects from `object_registry` as
 * a "CANONICAL FEATURE REGISTRY" block, suitable for embedding into Stage 1
 * (and Stage 4) prompts. Format matches W11.7 spec §"Canonical registry":
 *
 *   CANONICAL FEATURE REGISTRY (top 200 by frequency, for cross-project
 *   consistency):
 *   - hills_hoist (rotary clothesline): exterior_rear signal, 92% confidence, 47 obs
 *   - caesarstone (engineered stone benchtop): kitchen_main signal, 96%, 80 obs
 *   - subway_tile_splashback: kitchen_main, 87%, 42 obs
 *   - terracotta_tile_roof: exterior signal, 99%, 211 obs
 *   ...
 *
 * Returns the empty string when the registry is empty (no rows yet) — Stage 1
 * still works without it; the rollup pass populates the registry over time.
 *
 * Default `top_n=200` per W11.7 spec.
 *
 * Block-versioned via CANONICAL_REGISTRY_BLOCK_VERSION so prompt-cache
 * invalidation tracks block changes (W7.6 pattern). Persisted in
 * `composition_classifications.prompt_block_versions`.
 *
 * ─── W12.A REFACTOR ─────────────────────────────────────────────────────────
 *
 * Split into pure renderer + DB loader so the rendering layer is testable
 * without a Supabase client. Three exports now:
 *
 *   loadTopCanonicals(client, opts) → CanonicalRow[]   — DB query (impure)
 *   renderCanonicalRegistryBlock(rows) → string        — pure renderer
 *   canonicalRegistryBlock(opts) → Promise<string>     — back-compat composed
 *
 * Cost / latency: 200 rows × ~12 tokens each ≈ 2-3KB additional input tokens
 * per call. Per Stage 1 call: 200 × 12 × $1.25/1M = $0.003. Per round (33
 * Stage 1 calls): +$0.10. Per Stage 4 (12 calls): +$0.04. Negligible vs the
 * cross-project consistency benefit of anchoring observations to a stable
 * canonical_id vocabulary.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getAdminClient } from '../../supabase.ts';

export const CANONICAL_REGISTRY_BLOCK_VERSION = 'v1.1';

export interface CanonicalRegistryBlockOpts {
  /** Number of canonicals to render. Default 200 per W11.7 spec. */
  top_n?: number;
  /** Optional minimum market_frequency floor — drop entries below this count.
   *  Default 0 (include all). At maturity, raising this to 5 trims long-tail
   *  noise from the prompt. */
  min_frequency?: number;
}

/** A single row from object_registry rendered into the registry block. */
export interface CanonicalRow {
  canonical_id: string;
  display_name: string;
  description: string | null;
  market_frequency: number;
  signal_room_type: string | null;
  signal_confidence: number | null;
}

// ─── DB loader (impure) ─────────────────────────────────────────────────────

/**
 * Load the top-N canonical rows from `object_registry`.
 *
 * Filters on `status='canonical'` AND `is_active=true`. Sorted by
 * `market_frequency DESC` so the model sees the most-photographed features
 * first. RLS bypassed via the service-role client — registry rows are
 * project-agnostic so we don't need per-project filtering.
 *
 * Returns `[]` on query error (logged) so the caller can render the empty
 * block string gracefully.
 */
export async function loadTopCanonicals(
  client: SupabaseClient,
  opts: CanonicalRegistryBlockOpts = {},
): Promise<CanonicalRow[]> {
  const topN = Math.max(1, Math.min(opts.top_n ?? 200, 1000));
  const minFreq = Math.max(0, opts.min_frequency ?? 0);

  const { data, error } = await client
    .from('object_registry')
    .select(
      'canonical_id, display_name, description, market_frequency, signal_room_type, signal_confidence',
    )
    .eq('status', 'canonical')
    .eq('is_active', true)
    .gte('market_frequency', minFreq)
    .order('market_frequency', { ascending: false })
    .limit(topN);

  if (error) {
    console.warn(`[canonicalRegistryBlock] query failed: ${error.message}`);
    return [];
  }

  return (data || []) as CanonicalRow[];
}

// ─── Pure renderer ──────────────────────────────────────────────────────────

/**
 * Render a list of canonical rows as a Gemini-friendly text block.
 *
 * Pure function — no DB access, no env reads. Given a fixed input array the
 * output is deterministic. This is the seam unit tests target.
 *
 * Returns the empty string when `rows` is empty so callers can wire
 * unconditionally.
 */
export function renderCanonicalRegistryBlock(rows: CanonicalRow[]): string {
  if (rows.length === 0) {
    return '';
  }

  const headerCount = rows.length;
  const lines: string[] = [
    `CANONICAL FEATURE REGISTRY (top ${headerCount} by frequency, for cross-project consistency):`,
  ];

  for (const row of rows) {
    lines.push(formatRow(row));
  }

  lines.push('');
  lines.push(
    'When you observe one of these features in an image, prefer the canonical_id ' +
      'when emitting observed_objects (raw_label is still encouraged for novel detail). ' +
      'When in doubt, emit the descriptive raw_label — the canonical-rollup pass will ' +
      'normalise it post-hoc.',
  );

  return lines.join('\n');
}

function formatRow(row: CanonicalRow): string {
  const desc = (row.description || '').trim();
  const descPart = desc ? ` (${desc})` : '';
  const obs = `${row.market_frequency} obs`;

  if (row.signal_room_type) {
    const conf = row.signal_confidence !== null
      ? `${Math.round(Number(row.signal_confidence) * 100)}%`
      : '';
    const confPart = conf ? `, ${conf}` : '';
    return `- ${row.canonical_id}${descPart}: ${row.signal_room_type} signal${confPart}, ${obs}`;
  }

  return `- ${row.canonical_id}${descPart}: ${obs}`;
}

// ─── Back-compat composed entry point ──────────────────────────────────────

/**
 * Render the canonical feature registry block (back-compat wrapper).
 *
 * Loads via `loadTopCanonicals(getAdminClient(), opts)` then hands the rows
 * to `renderCanonicalRegistryBlock`. Use this when you don't already have a
 * Supabase client in scope. Existing Stage 1 + Stage 4 call sites use this
 * form for ergonomics — passing a client through every block invocation
 * would clutter the prompt assembly without changing behaviour.
 *
 * @returns text block ready to drop into a system prompt; empty string if
 *          the registry is empty.
 */
export async function canonicalRegistryBlock(
  opts: CanonicalRegistryBlockOpts = {},
): Promise<string> {
  const admin = getAdminClient();
  const rows = await loadTopCanonicals(admin, opts);
  return renderCanonicalRegistryBlock(rows);
}
