-- 069: pulse_sync_runs view — aggregates per-suburb sync_logs into "runs"
--
-- A "run" = all pulse_sync_logs rows for a given source_id whose started_at
-- fell in the same 15-minute tumbling bucket. Because pulseFireScrapes fires
-- one pulseDataSync per suburb (each of which writes its own log row), the
-- UI needs a way to reassemble these per-suburb dispatches back into a single
-- run. This view does that.
--
-- Bounding-box sources (rea_listings_bb_*) naturally have total_dispatches=1
-- per run because they're a single call, not a per-suburb iteration.
--
-- Frontend queries this via `api.supabase.from('pulse_sync_runs')`.
-- Refresh cadence: typically every 15s while a run is in_progress.

CREATE OR REPLACE VIEW pulse_sync_runs AS
WITH bucketed AS (
  SELECT
    source_id,
    source_label,
    -- 15-minute tumbling buckets, aligned to clock (00, 15, 30, 45).
    -- Runs launched within the same 15-minute window are grouped together.
    date_trunc('hour', started_at)
      + interval '15 minutes' * FLOOR(EXTRACT(MINUTE FROM started_at)::int / 15) AS run_bucket,
    id,
    status,
    started_at,
    completed_at,
    triggered_by,
    triggered_by_name,
    records_fetched,
    records_new,
    records_updated,
    error_message,
    input_config,
    result_summary
  FROM pulse_sync_logs
  WHERE started_at > now() - interval '60 days'
    AND source_id IS NOT NULL
)
SELECT
  source_id,
  -- Take the most common label across the run (first alphabetically on tie)
  (array_agg(source_label ORDER BY started_at))[1] AS source_label,
  run_bucket,
  min(started_at) AS run_started_at,
  max(coalesce(completed_at, started_at)) AS run_last_activity,
  count(*) AS total_dispatches,
  count(*) FILTER (WHERE status = 'completed') AS succeeded,
  count(*) FILTER (WHERE status = 'failed') AS failed,
  count(*) FILTER (WHERE status = 'running') AS in_progress,
  coalesce(sum(records_fetched), 0) AS total_records_fetched,
  coalesce(sum(records_new), 0) AS total_records_new,
  coalesce(sum(records_updated), 0) AS total_records_updated,
  -- Array of distinct who-triggered-this-run labels ("Cron", "Joseph Saad", etc.)
  array_remove(
    array_agg(DISTINCT triggered_by_name),
    NULL
  ) AS triggered_by_names,
  -- Per-dispatch detail that the UI can expand to show a per-suburb breakdown
  jsonb_agg(
    jsonb_build_object(
      'id', id,
      'status', status,
      'suburbs', input_config -> 'suburbs',
      'records_fetched', records_fetched,
      'records_new', records_new,
      'records_updated', records_updated,
      'started_at', started_at,
      'completed_at', completed_at,
      'duration_sec', EXTRACT(EPOCH FROM (coalesce(completed_at, now()) - started_at))::int,
      'error_message', error_message,
      'triggered_by_name', triggered_by_name
    )
    ORDER BY started_at
  ) AS dispatches
FROM bucketed
GROUP BY source_id, run_bucket;

GRANT SELECT ON pulse_sync_runs TO authenticated;
GRANT SELECT ON pulse_sync_runs TO anon;

COMMENT ON VIEW pulse_sync_runs IS
  'Aggregates pulse_sync_logs into runs grouped by source_id + 15-min tumbling bucket. '
  'Used by IndustryPulse Data Sources tab to render per-suburb run summaries.';
