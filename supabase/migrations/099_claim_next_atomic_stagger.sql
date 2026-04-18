-- 099_claim_next_atomic_stagger.sql
-- CRITICAL BUG FIX: stagger enforcement was in-memory-per-worker, so two
-- concurrent edge invocations of pulseFireWorker would each believe the
-- stagger window was satisfied from their own perspective, and independently
-- dispatch rea_agents items ~7s apart. REA.com.au rate-limits the websift
-- actor after ~7 rapid requests and silently returns empty arrays. Symptom:
-- every sync_log shows records_fetched=0, raw_payload={listings:[], rea_agents:[]}.
--
-- Evidence from the Apr 18 04:03-04:07 UTC run (latest dispatch gaps):
--   Sydney          → Liverpool        7.0s ← should be ≥30s, WAS VIOLATED
--   Liverpool       → Manly           23.4s ← in-worker stagger held
--   Manly           → Bondi Junction   6.7s ← cross-worker violation
--   Bondi Junction  → Randwick        16.2s ← partial overlap
--   Randwick        → Mosman           7.1s ← another cross-worker violation
--   Mosman          → North Sydney    23.0s
-- Pattern: regular 7s / 23s / 7s / 23s cadence = two concurrent workers each
-- respecting their own 30s window but phase-offset. REA sees ~7s request
-- frequency, rate-limits, returns empties.
--
-- ── Fix ────────────────────────────────────────────────────────────────
-- Move stagger enforcement into the claim_next RPC itself, atomically:
--   1. pg_advisory_xact_lock(hashtext(source_id)) — serializes all claim
--      calls for this source_id across the cluster, transaction-scoped.
--      While worker A holds the lock, worker B blocks.
--   2. Inside the lock: check max(dispatched_at) against stagger_seconds
--      from pulse_source_configs. If stagger window still open, return empty
--      (no claim, worker moves on to other sources).
--   3. If stagger window has elapsed, claim + update dispatched_at under
--      the same transaction/lock, atomically.
--   4. Lock releases on COMMIT.
--
-- This makes the 30s stagger a hard constraint observable by all workers,
-- not a polite in-memory suggestion.
--
-- ── Not touched ─────────────────────────────────────────────────────────
-- The in-memory lastDispatched map in pulseFireWorker stays — it still has
-- value as an optimization (avoids an advisory lock acquisition when the
-- worker already knows it just dispatched a second ago). The DB check is the
-- authoritative contract. Worker code change optional — but NOT required.

BEGIN;

CREATE OR REPLACE FUNCTION pulse_fire_queue_claim_next(
  p_source_id TEXT DEFAULT NULL,
  p_limit     INT  DEFAULT 1
) RETURNS SETOF pulse_fire_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  claimed_ids       UUID[];
  v_stagger_seconds INT;
  v_last_dispatch   TIMESTAMPTZ;
BEGIN
  -- ── Per-source atomic stagger check ──────────────────────────────────
  -- Serialize all claim_next calls for the same source_id. Critical for
  -- rate-limited upstreams (websift/realestateau → REA rate-limit at ~7s).
  IF p_source_id IS NOT NULL THEN
    -- Transaction-scoped advisory lock keyed on source_id. Releases on COMMIT.
    PERFORM pg_advisory_xact_lock(hashtext('pulse_fire_queue_claim:' || p_source_id));

    SELECT stagger_seconds INTO v_stagger_seconds
    FROM pulse_source_configs
    WHERE source_id = p_source_id;

    IF v_stagger_seconds IS NOT NULL AND v_stagger_seconds > 0 THEN
      -- Get the most recent dispatch for this source (across all batches).
      -- Covers both 'running' and terminal statuses — what matters is
      -- "when did we last hit Apify".
      SELECT max(dispatched_at) INTO v_last_dispatch
      FROM pulse_fire_queue
      WHERE source_id = p_source_id
        AND dispatched_at IS NOT NULL
        AND dispatched_at > NOW() - (v_stagger_seconds || ' seconds')::interval;

      IF v_last_dispatch IS NOT NULL THEN
        -- Stagger window still open. Return empty — caller can try other
        -- eligible sources or sleep until next tick.
        RETURN;
      END IF;
    END IF;
  END IF;

  -- ── Normal claim-next logic (unchanged from migration 093) ──────────
  WITH eligible AS (
    SELECT q.id
    FROM pulse_fire_queue q
    WHERE q.status = 'pending'
      AND q.next_attempt_at <= NOW()
      AND (p_source_id IS NULL OR q.source_id = p_source_id)
    ORDER BY q.priority DESC, q.next_attempt_at ASC, q.created_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE pulse_fire_queue q
       SET status = 'running',
           dispatched_at = NOW(),
           attempts = q.attempts + 1
      FROM eligible
     WHERE q.id = eligible.id
    RETURNING q.id
  )
  SELECT array_agg(id) INTO claimed_ids FROM claimed;

  RETURN QUERY SELECT * FROM pulse_fire_queue WHERE id = ANY(COALESCE(claimed_ids, ARRAY[]::UUID[]));
END;
$func$;

COMMENT ON FUNCTION pulse_fire_queue_claim_next IS
  'Atomic claim + stagger enforcement. Uses pg_advisory_xact_lock per source_id '
  'to serialize claim attempts. Stagger interval read from pulse_source_configs.'
  'Fixes the cross-worker stagger violation that was causing REA rate-limit. '
  'See migration 099 for forensic details.';

COMMIT;
