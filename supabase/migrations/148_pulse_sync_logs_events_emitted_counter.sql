-- ──────────────────────────────────────────────────────────────────────────────
-- Migration 148 — pulse_sync_logs.timeline_events_emitted counter
--
-- Why
-- ───
-- User observation (verified): rea_detail_enrich averages 22.1 timeline events
-- per run but shows "0 new" in Sync History, making valuable runs look like
-- no-ops. BB sources emit many change events but currently show 0.2/run.
--
-- Solution: add a counter column on pulse_sync_logs that mirrors the count of
-- *entity-level* (non-rollup, non-system) timeline events emitted during the
-- run, and wire it into the shared emitTimeline() helper so every writer
-- increments it consistently.
--
-- The filter list below MUST stay in sync with:
--   · migration 147 (change_events CTE in pulse_get_sync_log_records)
--   · supabase/functions/_shared/timeline.ts (ROLLUP_TYPES set)
-- so the counter represents true "entity changes" not summary noise.
-- ──────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. Counter column ─────────────────────────────────────────────────────
ALTER TABLE pulse_sync_logs
  ADD COLUMN IF NOT EXISTS timeline_events_emitted int NOT NULL DEFAULT 0;

-- ── 2. Backfill from existing pulse_timeline rows ─────────────────────────
-- Uses the same filter as migration 147's change_events CTE so the counter
-- reflects the same notion of "entity change" the UI drill-through shows.
WITH counts AS (
  SELECT sync_log_id, count(*) AS n
  FROM pulse_timeline
  WHERE sync_log_id IS NOT NULL
    AND event_type NOT IN (
      'new_listings_detected','client_new_listing',
      'cron_dispatched','cron_dispatch_batch','cron_dispatch_started','cron_dispatch_completed',
      'coverage_report','data_sync','data_cleanup','circuit_reset'
    )
    AND (entity_type IS NULL OR entity_type != 'system')
  GROUP BY sync_log_id
)
UPDATE pulse_sync_logs psl
   SET timeline_events_emitted = counts.n
  FROM counts
 WHERE psl.id = counts.sync_log_id;

-- ── 3. Index for future "runs with N changes" queries ─────────────────────
CREATE INDEX IF NOT EXISTS idx_pulse_sync_logs_timeline_events
  ON pulse_sync_logs(timeline_events_emitted DESC)
  WHERE timeline_events_emitted > 0;

-- ── 4. RPC: atomic `col = col + n` increment ──────────────────────────────
-- Supabase's JS client doesn't expose atomic column increment via upsert,
-- so we wrap it in a tiny SQL function. Called from emitTimeline() after
-- each successful batch upsert.
CREATE OR REPLACE FUNCTION pulse_sync_log_increment_events(p_id uuid, p_delta int)
RETURNS void LANGUAGE sql AS $$
  UPDATE pulse_sync_logs
     SET timeline_events_emitted = timeline_events_emitted + p_delta
   WHERE id = p_id;
$$;

GRANT EXECUTE ON FUNCTION pulse_sync_log_increment_events(uuid, int)
  TO authenticated, service_role;

COMMIT;
