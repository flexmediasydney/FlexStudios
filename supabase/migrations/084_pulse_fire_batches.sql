-- 084_pulse_fire_batches.sql
-- Chunked self-invocation state for pulseFireScrapes (edge-runtime 150s cap).
--
-- Problem: pulseFireScrapes iterates the active suburb pool (~166 entries for
-- the `rea_listings_bb_*` sources) with a 2s inter-dispatch stagger plus ~3s
-- per-suburb fetch handshake, totalling ~5s per suburb. The edge runtime kills
-- isolates at 150s wall-clock, so a single invocation only gets through ~30-80
-- suburbs before being terminated — silent dispatch truncation. The timeline
-- audit event is written AFTER the loop, so a killed invocation leaves zero
-- evidence in pulse_timeline (logs exist only for suburbs that actually
-- reached pulseDataSync before the kill).
--
-- Fix: pulseFireScrapes now chunks its loop into batches of ~20 suburbs and
-- self-invokes (fire-and-forget) for each next batch. A row in this table
-- tracks the per-source batch run so concurrent invocations can resume where
-- the previous one left off, and late-arriving audit events know which batch
-- they belong to.
--
-- Lifecycle:
--   - offset=0, batch_id missing → kickoff: row inserted with status='running',
--     suburb_ids snapshotted from pulse_target_suburbs.
--   - subsequent self-invocations pass batch_id; worker updates
--     dispatched_count + current_offset + last_batch_at in place.
--   - status transitions running → completed when offset+batch_size >= total.
--   - stale-cleanup cron (added below) flips running rows older than 30min to
--     timed_out so future kickoffs aren't misled by abandoned state.

CREATE TABLE IF NOT EXISTS public.pulse_fire_batches (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id         TEXT NOT NULL,
  suburb_ids        JSONB NOT NULL,
  total_count       INT NOT NULL,
  dispatched_count  INT NOT NULL DEFAULT 0,
  current_offset    INT NOT NULL DEFAULT 0,
  batch_size        INT NOT NULL DEFAULT 20,
  status            TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running','completed','failed','timed_out')),
  started_at        TIMESTAMPTZ DEFAULT NOW(),
  last_batch_at     TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  error_message     TEXT
);

CREATE INDEX IF NOT EXISTS pulse_fire_batches_source_started_idx
  ON public.pulse_fire_batches (source_id, started_at DESC);

CREATE INDEX IF NOT EXISTS pulse_fire_batches_running_idx
  ON public.pulse_fire_batches (status, started_at)
  WHERE status = 'running';

-- ── Stale-batch cleanup: reuse the 30-min wall-clock pattern from migration 082
-- Runs 10 minutes past every hour (offset from pulse-stale-cleanup to avoid
-- contention). Any batch still 'running' after 30min is considered a runtime
-- kill casualty and flipped to 'timed_out'. This unblocks future kickoffs and
-- marks the audit trail correctly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pulse-fire-batches-cleanup') THEN
    PERFORM cron.unschedule('pulse-fire-batches-cleanup');
  END IF;
END $$;

SELECT cron.schedule(
  'pulse-fire-batches-cleanup',
  '10 * * * *',
  $$UPDATE public.pulse_fire_batches
    SET status = 'timed_out',
        completed_at = NOW(),
        error_message = COALESCE(error_message, 'auto-timed-out: exceeded 30min wall-clock')
    WHERE status = 'running'
      AND started_at < NOW() - INTERVAL '30 minutes'$$
);

-- ── One-time cleanup of any pre-existing stale rows at deploy time
UPDATE public.pulse_fire_batches
SET status = 'timed_out',
    completed_at = NOW(),
    error_message = 'auto-timed-out on migration 084 deploy'
WHERE status = 'running'
  AND started_at < NOW() - INTERVAL '30 minutes';

COMMENT ON TABLE public.pulse_fire_batches IS
  'Per-invocation state for pulseFireScrapes chunked self-invocation. '
  'Each row represents one logical cron dispatch (166 suburbs) split into '
  'batches of ~20 across multiple 150s isolates. Used to resume work across '
  'runtime kills and reconstruct the dispatch audit trail.';
