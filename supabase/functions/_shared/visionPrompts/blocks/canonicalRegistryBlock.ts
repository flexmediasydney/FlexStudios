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
 * Coordination note: Agent 2 owns Stage 1 prompt composition
 * (shortlisting-shape-d/index.ts). This file is the helper Agent 2 wires in.
 * If they're done before us they'll TODO it; we deliver the helper so the
 * wiring is a one-line import.
 */

import { getAdminClient } from '../../supabase.ts';

export const CANONICAL_REGISTRY_BLOCK_VERSION = 'v1.0';

export interface CanonicalRegistryBlockOpts {
  /** Number of canonicals to render. Default 200 per W11.7 spec. */
  top_n?: number;
  /** Optional minimum market_frequency floor — drop entries below this count.
   *  Default 0 (include all). At maturity, raising this to 5 trims long-tail
   *  noise from the prompt. */
  min_frequency?: number;
}

interface RegistryRow {
  canonical_id: string;
  display_name: string;
  description: string | null;
  market_frequency: number;
  signal_room_type: string | null;
  signal_confidence: number | null;
}

/**
 * Render the canonical feature registry block.
 *
 * @returns text block ready to drop into a system prompt; empty string if
 *          the registry is empty.
 */
export async function canonicalRegistryBlock(
  opts: CanonicalRegistryBlockOpts = {},
): Promise<string> {
  const topN = Math.max(1, Math.min(opts.top_n ?? 200, 1000));
  const minFreq = Math.max(0, opts.min_frequency ?? 0);

  const admin = getAdminClient();
  const { data, error } = await admin
    .from('object_registry')
    .select('canonical_id, display_name, description, market_frequency, signal_room_type, signal_confidence')
    .eq('status', 'canonical')
    .eq('is_active', true)
    .gte('market_frequency', minFreq)
    .order('market_frequency', { ascending: false })
    .limit(topN);

  if (error) {
    console.warn(`[canonicalRegistryBlock] query failed: ${error.message}`);
    return '';
  }

  const rows = (data || []) as RegistryRow[];
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

function formatRow(row: RegistryRow): string {
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
