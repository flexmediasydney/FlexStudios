-- 089: pulse_sync_runs — aggregate batch info into run cards
--
-- Depends on 088 (adds batch_id/batch_number/total_batches columns to
-- pulse_sync_logs). Extends the pulse_sync_runs view so run cards can say
-- "Batches 3-6 of 10" spanning this 15-min window.
--
-- Added fields:
--   batch_ids        — distinct batch UUIDs represented in this run bucket
--   min_batch_number — smallest batch index in the bucket (NULL if none have it)
--   max_batch_number — largest batch index in the bucket (NULL if none have it)
--   total_batches    — total batches in the parent dispatch (mode across rows)
--   batch_label      — ready-to-render human label like "3–6 of 10", "1 of 10",
--                      or NULL if no rows in this bucket carry batch info

-- Existing view has different column shape; drop + recreate instead of REPLACE
-- (Postgres refuses to change the column layout via CREATE OR REPLACE VIEW).
DROP VIEW IF EXISTS pulse_sync_runs;

CREATE VIEW pulse_sync_runs AS
WITH bucketed AS (
  SELECT
    source_id,
    source_label,
    -- 15-minute tumbling buckets, aligned to clock (00, 15, 30, 45).
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
    result_summary,
    batch_id,
    batch_number,
    total_batches
  FROM pulse_sync_logs
  WHERE started_at > now() - interval '60 days'
    AND source_id IS NOT NULL
)
SELECT
  source_id,
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
  array_remove(array_agg(DISTINCT triggered_by_name), NULL) AS triggered_by_names,

  -- ── New: batch attribution for this bucket ─────────────────────────────
  array_remove(array_agg(DISTINCT batch_id), NULL) AS batch_ids,
  min(batch_number) AS min_batch_number,
  max(batch_number) AS max_batch_number,
  max(total_batches) AS total_batches,
  -- Human label: "3–6 of 10" when range, "1 of 10" when single, NULL otherwise
  CASE
    WHEN max(total_batches) IS NULL THEN NULL
    WHEN min(batch_number) = max(batch_number) THEN
      min(batch_number)::text || ' of ' || max(total_batches)::text
    ELSE
      min(batch_number)::text || '–' || max(batch_number)::text ||
      ' of ' || max(total_batches)::text
  END AS batch_label,

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
      'triggered_by_name', triggered_by_name,
      -- Per-dispatch batch context — lets the UI render a "Batch 3/10" chip
      -- on every expanded dispatch row.
      'batch_id', batch_id,
      'batch_number', batch_number,
      'total_batches', total_batches
    )
    ORDER BY started_at
  ) AS dispatches
FROM bucketed
GROUP BY source_id, run_bucket;

GRANT SELECT ON pulse_sync_runs TO authenticated;
GRANT SELECT ON pulse_sync_runs TO anon;

COMMENT ON VIEW pulse_sync_runs IS
  'Aggregates pulse_sync_logs into runs grouped by source_id + 15-min tumbling bucket. '
  'Includes per-bucket batch attribution (batch_ids, min/max batch_number, batch_label) '
  'so UI run cards can render "Batches 3–6 of 10" spanning a dispatch cohort.';
