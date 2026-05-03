-- 464_dropbox_429_log.sql
--
-- Wave 2 architecture: Dropbox circuit breaker.
--
-- Today, when Dropbox /files starts ratelimiting (which is a
-- recurring pain — see the round-3 post-mortem 2026-05-03), the
-- dispatcher keeps claiming `extract` jobs and firing them at
-- Modal. Modal's per-call retry helper handles a single 429 with
-- a sleep, but the bucket stays hot and every subsequent call
-- bounces. The result is a stuck round, all jobs eventually
-- dead_letter at the 180s timeout, and we burn through the
-- attempt budget for nothing.
--
-- Mechanism:
--   1. Whenever Modal photos-extract observes a 429 from Dropbox
--      it best-effort POSTs a row into dropbox_429_log with the
--      bucket name and retry_after.
--   2. The shortlisting-job-dispatcher checks this log on every
--      tick before claiming `extract` jobs: if 3+ rows landed
--      against bucket='files' in the last 60s, the circuit is
--      considered OPEN and we skip extract claims that tick.
--      Other kinds (pass0, shape-d, etc.) keep flowing.
--   3. Auto-recovery: once the 60s window rolls forward and the
--      old rows fall out of count, the circuit closes naturally.
--      No operator action required.
--
-- Storage cost: ~1 row/sec at peak (cap), <1MB/day. 7-day TTL
-- via the cleanup cron below keeps the table tiny forever.

CREATE TABLE IF NOT EXISTS public.dropbox_429_log (
  id              BIGSERIAL PRIMARY KEY,
  observed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  bucket          TEXT NOT NULL,
  retry_after_s   INTEGER,
  source          TEXT NOT NULL,
  context         JSONB
);

COMMENT ON TABLE public.dropbox_429_log IS
  'Wave 2 circuit breaker telemetry. One row per observed Dropbox '
  '429. Read by shortlisting-job-dispatcher to gate extract claims. '
  'Cleaned to 7d via cron job dropbox_429_log_cleanup.';

COMMENT ON COLUMN public.dropbox_429_log.bucket IS
  'Dropbox API bucket: files | users | auth | sharing | other.';

COMMENT ON COLUMN public.dropbox_429_log.source IS
  'Writer identity: modal:photos-extract | edge:shortlisting-extract | edge:getDeliveryMediaFeed | etc.';

CREATE INDEX IF NOT EXISTS idx_dropbox_429_log_observed_at
  ON public.dropbox_429_log (observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_dropbox_429_log_bucket_observed_at
  ON public.dropbox_429_log (bucket, observed_at DESC);

-- RLS: only service_role writes/reads (dispatcher + Modal). No
-- end-user paths into this table; anon/authenticated stay locked.
ALTER TABLE public.dropbox_429_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dropbox_429_log_service_only ON public.dropbox_429_log;
CREATE POLICY dropbox_429_log_service_only
  ON public.dropbox_429_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 7-day cleanup cron. Runs at 04:00 UTC (off-peak).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dropbox_429_log_cleanup') THEN
    PERFORM cron.unschedule('dropbox_429_log_cleanup');
  END IF;

  PERFORM cron.schedule(
    'dropbox_429_log_cleanup',
    '0 4 * * *',
    $cleanup$DELETE FROM public.dropbox_429_log WHERE observed_at < now() - interval '7 days'$cleanup$
  );
END $$;
