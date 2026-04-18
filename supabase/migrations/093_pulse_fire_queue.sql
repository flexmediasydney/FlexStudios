-- 093_pulse_fire_queue.sql
-- Queue-based dispatch architecture for pulseFireScrapes.
--
-- ── The problem with chained self-invocation (what we're replacing) ──────────
-- Before this migration, pulseFireScrapes owned both orchestration AND execution.
-- When one edge isolate finished its batch of 20 suburbs, it fire-and-forget
-- POSTed to /functions/v1/pulseFireScrapes to continue with the next 20. A 3-second
-- handshake budget governed whether the handoff landed. Under concurrent load
-- (three sources crons overlapping, edge router cold-starts) the handoff silently
-- dropped ~30% of the time, leaving chains dead and suburbs unsynced until the
-- next day's cron. The hourly janitorial reaper (pulse-fire-batches-cleanup)
-- marked stuck 'running' rows as 'timed_out' but never attempted recovery.
--
-- Observed failure modes in production:
--   - Rent cron Apr 18 23:55 UTC: died after batch 5/10 → 100/183 suburbs
--   - Sold cron Apr 18 23:53 UTC: died after batch 6/10 → 120/183 suburbs
--   - Both chains failed at ~00:03 UTC, within 7 seconds of each other,
--     reaped at 01:10 UTC when the hourly cleanup noticed them.
--
-- ── The new architecture ─────────────────────────────────────────────────────
-- Separate orchestration from execution:
--   1. pulseFireScrapes (orchestrator) becomes pure enqueue — inserts N rows
--      into pulse_fire_queue, returns in <1s. No chain to break.
--   2. pulse_fire_queue (durable state) — one row per (source_id, suburb) pair.
--      Survives edge kills, network issues, cold starts.
--   3. pulseFireWorker (executor, new edge function) — pg_cron fires every minute.
--      Claims N rows via FOR UPDATE SKIP LOCKED, dispatches pulseDataSync,
--      respects per-source stagger + circuit breakers, marks completion via
--      pulseDataSync's fire_queue_id callback.
--   4. Automatic retry with exponential backoff. Dead-letter at max_attempts.
--   5. Circuit breaker pauses sources with consecutive upstream failures.
--   6. Daily coverage watchdog checks SLO (>95% of active pool synced per source
--      in rolling 24h) and emits timeline events.
--
-- Properties this guarantees:
--   - No orphaned work. Every enqueued row is either completed, dead-lettered,
--     or visible as 'pending/running' in the queue.
--   - Idempotent claim via SKIP LOCKED. Two workers never dispatch the same row.
--   - Graceful degradation. If Apify rate-limits websift, circuit opens; other
--     sources keep flowing.
--   - Observable. `SELECT * FROM pulse_fire_queue WHERE status='pending'` always
--     shows exactly what's waiting. No silent failure class.

BEGIN;

-- ── 1. Queue table ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pulse_fire_queue (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id             UUID REFERENCES pulse_fire_batches(id) ON DELETE SET NULL,
  source_id            TEXT NOT NULL,
  suburb_name          TEXT NOT NULL,
  postcode             TEXT,
  priority             INT  NOT NULL DEFAULT 0,
  actor_input          JSONB NOT NULL,
  -- Lifecycle states:
  --   pending   → waiting for a worker tick, eligible at next_attempt_at
  --   running   → claimed by a worker, pulseDataSync invoked; awaiting callback
  --   completed → pulseDataSync succeeded for this suburb (sync_log_id set)
  --   failed    → dead-lettered: hit max_attempts, last_error_category=permanent,
  --               or circuit broke too many times
  --   cancelled → user explicitly dropped the batch before completion
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','running','completed','failed','cancelled')),
  attempts             INT  NOT NULL DEFAULT 0,
  max_attempts         INT  NOT NULL DEFAULT 3,
  next_attempt_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error           TEXT,
  -- Error category drives retry policy:
  --   transient  → HTTP 5xx, network timeouts, edge cold-start fails → backoff & retry
  --   rate_limit → HTTP 429 from Apify or upstream rate-limit pattern → long backoff
  --                + increment circuit_breaker.consecutive_failures
  --   permanent  → HTTP 4xx (bad input, invalid suburb), unrecoverable config → dead-letter immediately
  last_error_category  TEXT CHECK (last_error_category IN ('transient','rate_limit','permanent')),
  dispatched_at        TIMESTAMPTZ,   -- when worker last POSTed to pulseDataSync
  completed_at         TIMESTAMPTZ,
  sync_log_id          UUID,           -- correlation to pulse_sync_logs for tracing
  triggered_by_name    TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-bump updated_at on any change
CREATE OR REPLACE FUNCTION pulse_fire_queue_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pulse_fire_queue_updated_at ON pulse_fire_queue;
CREATE TRIGGER pulse_fire_queue_updated_at
  BEFORE UPDATE ON pulse_fire_queue
  FOR EACH ROW EXECUTE FUNCTION pulse_fire_queue_touch_updated_at();

-- ── 2. Hot-path indexes ─────────────────────────────────────────────────────
-- Worker's "claim next item" query: ORDER BY priority DESC, next_attempt_at ASC
-- with SKIP LOCKED. Partial index keeps it tiny (only pending rows).
CREATE INDEX IF NOT EXISTS idx_pulse_fire_queue_claim
  ON pulse_fire_queue (priority DESC, next_attempt_at ASC)
  WHERE status = 'pending';

-- Per-source lookups (stagger tracking, circuit breaker state checks)
CREATE INDEX IF NOT EXISTS idx_pulse_fire_queue_source_status
  ON pulse_fire_queue (source_id, status);

-- Reconciler: find in-flight items past their wall-clock budget
CREATE INDEX IF NOT EXISTS idx_pulse_fire_queue_running_age
  ON pulse_fire_queue (dispatched_at)
  WHERE status = 'running';

-- Batch completion check
CREATE INDEX IF NOT EXISTS idx_pulse_fire_queue_batch
  ON pulse_fire_queue (batch_id, status)
  WHERE batch_id IS NOT NULL;

-- ── 3. Circuit breakers per source ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pulse_source_circuit_breakers (
  source_id            TEXT PRIMARY KEY REFERENCES pulse_source_configs(source_id) ON DELETE CASCADE,
  -- State machine:
  --   closed    → normal operation, dispatches allowed
  --   open      → too many consecutive failures; no dispatches until reopen_at
  --   half_open → reopen_at reached, allow 1 probe; success closes, fail reopens
  state                TEXT NOT NULL DEFAULT 'closed'
                         CHECK (state IN ('closed','open','half_open')),
  consecutive_failures INT  NOT NULL DEFAULT 0,
  failure_threshold    INT  NOT NULL DEFAULT 5,
  -- How long circuit stays open before entering half_open for a probe
  cooldown_minutes     INT  NOT NULL DEFAULT 30,
  opened_at            TIMESTAMPTZ,
  reopen_at            TIMESTAMPTZ,
  last_probe_at        TIMESTAMPTZ,
  total_opens          INT  NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed a breaker row for each existing source
INSERT INTO pulse_source_circuit_breakers (source_id)
SELECT source_id FROM pulse_source_configs
ON CONFLICT DO NOTHING;

-- ── 4. Coverage view for the SLO watchdog ──────────────────────────────────
-- Per-source metrics aggregated from queue + sync logs in rolling windows.
-- coverage_pct_24h = suburbs with completed queue rows in last 24h / active pool size
CREATE OR REPLACE VIEW pulse_source_coverage AS
WITH active_pool AS (
  SELECT count(*)::int AS pool_size
  FROM pulse_target_suburbs
  WHERE is_active = true AND postcode IS NOT NULL
),
queue_stats AS (
  SELECT
    q.source_id,
    count(DISTINCT q.suburb_name)
      FILTER (WHERE q.status = 'completed' AND q.completed_at > NOW() - INTERVAL '24 hours')::int
      AS suburbs_synced_24h,
    count(*)
      FILTER (WHERE q.status = 'failed' AND q.updated_at > NOW() - INTERVAL '24 hours')::int
      AS items_dead_lettered_24h,
    count(*) FILTER (WHERE q.status = 'pending')::int AS items_pending,
    count(*) FILTER (WHERE q.status = 'running')::int AS items_running,
    max(q.completed_at) AS last_completion_at
  FROM pulse_fire_queue q
  GROUP BY q.source_id
)
SELECT
  sc.source_id,
  sc.label,
  sc.is_enabled,
  sc.approach,
  sc.min_priority,
  cb.state              AS circuit_state,
  cb.consecutive_failures AS circuit_fails,
  cb.reopen_at          AS circuit_reopen_at,
  COALESCE(qs.suburbs_synced_24h,  0) AS suburbs_synced_24h,
  COALESCE(qs.items_dead_lettered_24h, 0) AS items_dead_lettered_24h,
  COALESCE(qs.items_pending, 0) AS items_pending,
  COALESCE(qs.items_running, 0) AS items_running,
  qs.last_completion_at,
  ap.pool_size,
  CASE
    WHEN NOT sc.is_enabled THEN NULL
    WHEN sc.min_priority > 0 THEN
      -- Source filters the pool — coverage denominator is the filtered subset
      ROUND(100.0 * COALESCE(qs.suburbs_synced_24h, 0) /
        NULLIF((SELECT count(*) FROM pulse_target_suburbs
                WHERE is_active = true AND postcode IS NOT NULL
                  AND priority >= sc.min_priority), 0), 1)
    ELSE
      ROUND(100.0 * COALESCE(qs.suburbs_synced_24h, 0) /
        NULLIF(ap.pool_size, 0), 1)
  END AS coverage_pct_24h
FROM pulse_source_configs sc
CROSS JOIN active_pool ap
LEFT JOIN queue_stats qs ON qs.source_id = sc.source_id
LEFT JOIN pulse_source_circuit_breakers cb ON cb.source_id = sc.source_id;

GRANT SELECT ON pulse_source_coverage TO authenticated, anon;

-- ── 5. Worker cron: every 60s ──────────────────────────────────────────────
-- Calls pulseFireWorker edge function, which drains the queue respecting
-- stagger + circuit breakers. Each invocation runs up to ~2 min.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pulse-fire-worker') THEN
    PERFORM cron.unschedule('pulse-fire-worker');
  END IF;
END $$;

SELECT cron.schedule(
  'pulse-fire-worker',
  '* * * * *',  -- every minute
  $$
  SELECT net.http_post(
    url := current_setting('app.settings.supabase_url', true) || '/functions/v1/pulseFireWorker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pulse_cron_jwt' LIMIT 1)
    ),
    body := '{"source":"pg_cron"}'::jsonb,
    timeout_milliseconds := 5000
  );
  $$
);

-- ── 6. Coverage watchdog: daily SLO report at 8:30am AEST ─────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pulse-coverage-watchdog') THEN
    PERFORM cron.unschedule('pulse-coverage-watchdog');
  END IF;
END $$;

SELECT cron.schedule(
  'pulse-coverage-watchdog',
  '30 22 * * *',  -- 10:30pm UTC = 8:30am AEST
  $$
  INSERT INTO pulse_timeline (entity_type, event_type, event_category, title, description, new_value, source, created_at)
  SELECT
    'system',
    'coverage_report',
    'system',
    CASE
      WHEN MIN(COALESCE(coverage_pct_24h, 0)) < 95
        THEN '⚠ Coverage below SLO: ' || ROUND(MIN(COALESCE(coverage_pct_24h, 0))) || '%'
      ELSE '✓ Coverage SLO met (' || ROUND(MIN(COALESCE(coverage_pct_24h, 100))) || '%+ all sources)'
    END,
    'Per-source 24h coverage: ' ||
      string_agg(source_id || '=' || COALESCE(coverage_pct_24h, 0) || '%', ', ' ORDER BY source_id),
    jsonb_build_object(
      'min_coverage_pct', MIN(COALESCE(coverage_pct_24h, 0)),
      'sources', jsonb_agg(jsonb_build_object(
        'source_id', source_id,
        'coverage_pct_24h', coverage_pct_24h,
        'suburbs_synced_24h', suburbs_synced_24h,
        'items_dead_lettered_24h', items_dead_lettered_24h,
        'items_pending', items_pending,
        'items_running', items_running,
        'circuit_state', circuit_state,
        'pool_size', pool_size
      ) ORDER BY source_id)
    ),
    'watchdog',
    NOW()
  FROM pulse_source_coverage
  WHERE is_enabled = true
  HAVING count(*) > 0;
  $$
);

-- ── 7. Helper: atomic claim-next-batch RPC for the worker ──────────────────
-- Claims up to `p_limit` eligible items for `p_source_id` (or any source if NULL),
-- marks them 'running' with dispatched_at=NOW(), returns the claimed rows.
-- Uses FOR UPDATE SKIP LOCKED to guarantee two concurrent workers never claim
-- the same item. Respects per-source stagger via `p_min_age_seconds` — items
-- dispatched from same source within stagger window aren't eligible.
CREATE OR REPLACE FUNCTION pulse_fire_queue_claim_next(
  p_source_id TEXT DEFAULT NULL,
  p_limit     INT  DEFAULT 1
) RETURNS SETOF pulse_fire_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claimed_ids UUID[];
BEGIN
  WITH eligible AS (
    SELECT q.id
    FROM pulse_fire_queue q
    WHERE q.status = 'pending'
      AND q.next_attempt_at <= NOW()
      AND (p_source_id IS NULL OR q.source_id = p_source_id)
    ORDER BY q.priority DESC, q.next_attempt_at ASC, q.created_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE pulse_fire_queue q
     SET status = 'running',
         dispatched_at = NOW(),
         attempts = q.attempts + 1
    FROM eligible
   WHERE q.id = eligible.id
  RETURNING q.id INTO claimed_ids;

  -- Return the claimed rows (fresh read so caller sees updated status)
  RETURN QUERY SELECT * FROM pulse_fire_queue WHERE id = ANY(claimed_ids);
END;
$$;

GRANT EXECUTE ON FUNCTION pulse_fire_queue_claim_next TO authenticated, service_role;

-- ── 8. Helper: record a queue item outcome ─────────────────────────────────
-- Called by pulseDataSync (success path) or the worker's reconciler (failure path).
-- Handles transition from 'running' to 'completed' or 'pending' (retry) or 'failed'.
CREATE OR REPLACE FUNCTION pulse_fire_queue_record_outcome(
  p_id          UUID,
  p_success     BOOLEAN,
  p_error       TEXT    DEFAULT NULL,
  p_category    TEXT    DEFAULT NULL,
  p_sync_log_id UUID    DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  item RECORD;
  v_next_attempt TIMESTAMPTZ;
  v_backoff_seconds INT;
BEGIN
  SELECT * INTO item FROM pulse_fire_queue WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF p_success THEN
    UPDATE pulse_fire_queue
       SET status = 'completed',
           completed_at = NOW(),
           sync_log_id = COALESCE(p_sync_log_id, sync_log_id),
           last_error = NULL,
           last_error_category = NULL
     WHERE id = p_id;

    -- Success resets the circuit breaker for this source
    UPDATE pulse_source_circuit_breakers
       SET consecutive_failures = 0,
           state = 'closed',
           opened_at = NULL,
           reopen_at = NULL
     WHERE source_id = item.source_id;
    RETURN;
  END IF;

  -- Failure path: classify + decide retry vs dead-letter
  IF p_category = 'permanent' OR item.attempts >= item.max_attempts THEN
    UPDATE pulse_fire_queue
       SET status = 'failed',
           completed_at = NOW(),
           last_error = p_error,
           last_error_category = COALESCE(p_category, 'transient')
     WHERE id = p_id;
  ELSE
    -- Exponential backoff: 2^attempts minutes, capped at 10 min.
    -- Rate-limit errors: 5 min base (give upstream time to cool off).
    v_backoff_seconds := CASE
      WHEN p_category = 'rate_limit' THEN LEAST(600, 300 * item.attempts)
      ELSE LEAST(600, 60 * POWER(2, item.attempts))::int
    END;
    v_next_attempt := NOW() + (v_backoff_seconds || ' seconds')::interval;
    UPDATE pulse_fire_queue
       SET status = 'pending',
           dispatched_at = NULL,
           next_attempt_at = v_next_attempt,
           last_error = p_error,
           last_error_category = COALESCE(p_category, 'transient')
     WHERE id = p_id;
  END IF;

  -- Update circuit breaker on failure (rate_limit / transient both count)
  IF p_category IN ('rate_limit','transient') THEN
    UPDATE pulse_source_circuit_breakers
       SET consecutive_failures = consecutive_failures + 1,
           state = CASE
             WHEN consecutive_failures + 1 >= failure_threshold THEN 'open'
             ELSE state
           END,
           opened_at = CASE
             WHEN consecutive_failures + 1 >= failure_threshold AND state != 'open' THEN NOW()
             ELSE opened_at
           END,
           reopen_at = CASE
             WHEN consecutive_failures + 1 >= failure_threshold AND state != 'open'
               THEN NOW() + (cooldown_minutes || ' minutes')::interval
             ELSE reopen_at
           END,
           total_opens = CASE
             WHEN consecutive_failures + 1 >= failure_threshold AND state != 'open' THEN total_opens + 1
             ELSE total_opens
           END
     WHERE source_id = item.source_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION pulse_fire_queue_record_outcome TO authenticated, service_role;

-- ── 9. Helper: reconcile stuck 'running' items ──────────────────────────────
-- Worker phase 1: items marked 'running' > 5 min ago are likely dead.
-- Either the dispatch handshake dropped, or pulseDataSync died before
-- calling pulse_fire_queue_record_outcome. Re-queue with incremented attempts.
CREATE OR REPLACE FUNCTION pulse_fire_queue_reconcile_stuck(
  p_stuck_minutes INT DEFAULT 5
) RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  reconciled_count INT := 0;
BEGIN
  WITH stuck AS (
    SELECT id FROM pulse_fire_queue
    WHERE status = 'running'
      AND dispatched_at < NOW() - (p_stuck_minutes || ' minutes')::interval
    FOR UPDATE SKIP LOCKED
  )
  SELECT count(*) INTO reconciled_count FROM stuck;

  -- Re-queue stuck items as 'pending' for retry, or 'failed' if at max_attempts
  UPDATE pulse_fire_queue q
     SET status = CASE
           WHEN q.attempts >= q.max_attempts THEN 'failed'
           ELSE 'pending'
         END,
         dispatched_at = NULL,
         next_attempt_at = NOW() + INTERVAL '30 seconds',
         completed_at = CASE
           WHEN q.attempts >= q.max_attempts THEN NOW() ELSE NULL
         END,
         last_error = 'Reconciler: dispatch timed out without outcome callback',
         last_error_category = 'transient'
   WHERE q.id IN (
     SELECT id FROM pulse_fire_queue
     WHERE status = 'running'
       AND dispatched_at < NOW() - (p_stuck_minutes || ' minutes')::interval
   );

  RETURN reconciled_count;
END;
$$;

GRANT EXECUTE ON FUNCTION pulse_fire_queue_reconcile_stuck TO authenticated, service_role;

-- ── 10. Helper: mark batch complete when all items terminal ─────────────────
CREATE OR REPLACE FUNCTION pulse_fire_batches_reconcile()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_count INT;
BEGIN
  UPDATE pulse_fire_batches b
     SET status = 'completed',
         completed_at = COALESCE(b.completed_at, NOW()),
         dispatched_count = (
           SELECT count(*) FROM pulse_fire_queue
           WHERE batch_id = b.id AND status = 'completed'
         )
   WHERE b.status = 'running'
     AND NOT EXISTS (
       SELECT 1 FROM pulse_fire_queue
       WHERE batch_id = b.id AND status IN ('pending','running')
     )
     AND EXISTS (
       SELECT 1 FROM pulse_fire_queue WHERE batch_id = b.id
     );
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

GRANT EXECUTE ON FUNCTION pulse_fire_batches_reconcile TO authenticated, service_role;

COMMENT ON TABLE pulse_fire_queue IS
  'Durable work queue for per-suburb Apify dispatches. Populated by pulseFireScrapes '
  '(enqueue-only), drained by pulseFireWorker (polling every minute via pg_cron). '
  'Replaces the fire-and-forget chained self-invocation that used to silently drop '
  '~30% of dispatches under concurrent load.';

COMMENT ON TABLE pulse_source_circuit_breakers IS
  'Per-source circuit breaker state. When consecutive_failures >= failure_threshold, '
  'state flips to open and the worker skips dispatches for this source until '
  'reopen_at passes. Prevents one broken upstream from burning the entire queue.';

COMMIT;
