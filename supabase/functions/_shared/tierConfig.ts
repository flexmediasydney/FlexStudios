/**
 * tierConfig.ts — Wave 8 helper for fetching the active tier_config row for
 * an engine tier.
 *
 * Spec: docs/design-specs/W8-tier-configs.md §1 + §4.
 *
 * Pass 1 calls `getActiveTierConfig(tierId)` once per round and caches the
 * result for the duration of that round's classifications. Pass 2 calls
 * the same helper to inject the dimension_weights into the prompt's
 * tierWeightingContext block.
 *
 * Behaviour:
 *   - SELECTs the active row (is_active=TRUE) for the given tier_id.
 *   - When no active row exists (data corruption or pre-seed migration
 *     state), returns NULL — caller falls back to DEFAULT_DIMENSION_WEIGHTS
 *     and emits a shortlisting_events warning. Does NOT throw — the engine
 *     should never crash because of a missing config row.
 *   - The cache is per-invocation (a Map captured in the helper module
 *     scope). Each edge-fn cold start gets a fresh Map; warm starts reuse.
 *
 * The signal_weights JSON ride-along is provided to callers but not used by
 * Pass 1's combined-score rollup today (W8 pre-W11 — Pass 1 only emits 4
 * dim aggregates). When W11 lands, the rollup formula extends to read
 * signal_weights; the helper already returns it so the engine just starts
 * using what's there.
 */

import { getAdminClient } from './supabase.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TierConfigRow {
  id: string;
  // mig 443 renamed shortlisting_tier_configs → shortlisting_grade_configs
  // and tier_id → grade_id. We keep the type alias `TierConfigRow` to avoid
  // a wider rename across callers; `grade_id` here is the renamed column.
  grade_id: string;
  version: number;
  dimension_weights: Record<string, number>;
  signal_weights: Record<string, number>;
  hard_reject_thresholds: Record<string, number> | null;
  is_active: boolean;
  activated_at: string | null;
  notes: string | null;
}

// ─── Cache (per-invocation) ───────────────────────────────────────────────────

// In-memory cache scoped to the edge-fn invocation. Each cold start gets a
// fresh Map; warm reuses. Cache key is tier_id; value is the row (or null
// for "no active config exists").
//
// We deliberately do NOT cache across rounds within a long-lived warm
// container — the staleness window matters (an admin activating a new
// config should take effect on the next round bootstrap, not some indefinite
// time later). To enforce a TTL we stamp each entry with a timestamp and
// expire after 60 seconds. This balances: don't re-query for every Pass 1
// classification within a round (~50 calls × 2 reads each = 100 queries
// avoided) but don't serve stale config across rounds (a 60s TTL is well
// below the round-bootstrap-to-Pass-1-completion window of ~2-5 minutes).
interface CacheEntry {
  row: TierConfigRow | null;
  fetchedAt: number;
}
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch the active tier_config row for a given tier_id, with a 60-second
 * cache.
 *
 * Returns NULL when no active row exists — caller falls back to defaults
 * and emits a warning event. Throws only on actual DB errors (network,
 * permission); a missing row is not an error.
 */
export async function getActiveTierConfig(
  tierId: string,
): Promise<TierConfigRow | null> {
  if (!tierId) return null;
  const now = Date.now();
  const cached = cache.get(tierId);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.row;
  }

  const admin = getAdminClient();
  // mig 443 rename: shortlisting_tier_configs → shortlisting_grade_configs,
  // tier_id → grade_id. Caller passes the round's engine_grade_id; we look
  // up the active config row keyed on the renamed column.
  const { data, error } = await admin
    .from('shortlisting_grade_configs')
    .select(
      'id, grade_id, version, dimension_weights, signal_weights, hard_reject_thresholds, is_active, activated_at, notes',
    )
    .eq('grade_id', tierId)
    .eq('is_active', true)
    .maybeSingle();

  if (error) {
    // Don't crash; let the caller fall back to defaults with a warning.
    console.warn(
      `[tierConfig] active grade_config fetch failed for grade_id=${tierId}: ${error.message}`,
    );
    cache.set(tierId, { row: null, fetchedAt: now });
    return null;
  }

  const row = (data ?? null) as TierConfigRow | null;
  cache.set(tierId, { row, fetchedAt: now });
  return row;
}

/**
 * Test-only: clear the in-memory cache. Used by integration tests that need
 * to verify cache behaviour without waiting for the TTL.
 */
export function _clearTierConfigCache(): void {
  cache.clear();
}
