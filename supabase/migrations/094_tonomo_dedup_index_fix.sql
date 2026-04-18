-- 094_tonomo_dedup_index_fix.sql
-- Fix the tonomo_processing_queue dedup index + bump Google Calendar sync to 5min.
--
-- ── Bug: dedup index was dropping legitimate webhooks ─────────────────────
-- The old index `idx_queue_event_id_dedup` was:
--   UNIQUE (event_id) WHERE event_id IS NOT NULL AND status IN ('pending','processing')
-- Intent: prevent Tonomo retries from enqueueing the same event twice.
-- Flaw: Tonomo sends MULTIPLE distinct actions for the same event_id in rapid
-- succession (e.g. 'changed' → 'canceled' ~13ms apart when you remove an
-- appointment). The second webhook's insert hits the unique violation while
-- the first is still 'pending', gets dropped, and the handler never runs.
--
-- Observed impact (last 30 days): 3 of 6 cancel webhooks silently dropped
-- (50% failure rate). Mount Colah / Erskineville / Moorebank all have ghost
-- calendar events because their cancel handler never fired.
--
-- ── Fix: make dedup composite on (event_id, action) ───────────────────────
-- Same-event + same-action (true Tonomo retry) still dedups ✓
-- Same-event + different-action (legitimate lifecycle) both enqueue ✓

BEGIN;

DROP INDEX IF EXISTS idx_queue_event_id_dedup;

CREATE UNIQUE INDEX idx_queue_event_id_action_dedup
  ON tonomo_processing_queue (event_id, action)
  WHERE event_id IS NOT NULL AND status IN ('pending','processing');

COMMENT ON INDEX idx_queue_event_id_action_dedup IS
  'Composite dedup on (event_id, action). Previous version was (event_id) only '
  'which dropped cancel webhooks that followed a changed/rescheduled for the '
  'same event_id. See migration 094 header for forensic details.';

-- ── Bump Google Calendar sync from 30 min to 5 min ────────────────────────
-- The 30-min interval was fine when the Tonomo webhook path was the primary
-- deletion mechanism. Now that we're hardening against handler races, the
-- Google sync acts as the authoritative safety net for "event was deleted
-- upstream". 5 min is the sweet spot: effectively real-time for human
-- perception, still well under Google API quotas (0.14% of daily free tier
-- at 5 connections).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sync-google-calendar') THEN
    PERFORM cron.alter_job(
      job_id := (SELECT jobid FROM cron.job WHERE jobname = 'sync-google-calendar'),
      schedule := '*/5 * * * *'
    );
  END IF;
END $$;

COMMIT;
