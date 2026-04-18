-- Migration 121 — Populate suburb + batch fields on pulse_sync_logs so the
-- "Run history" blocks on each Industry Pulse source card have something to
-- render.
--
-- ── Problem ───────────────────────────────────────────────────────────────
-- The run-history table on the Data Sources tab reads `d.suburbs` and
-- `d.batch_number` / `d.total_batches` off the `pulse_sync_runs` view. The
-- view extracts those from:
--   * `input_config -> 'suburbs'` (for the per-suburb dispatch case), and
--   * `batch_number` / `total_batches` columns on `pulse_sync_logs`.
--
-- Since migration 095 moved heavy jsonb columns (including `input_config`)
-- off `pulse_sync_logs` and onto the `pulse_sync_log_payloads` side-table,
-- the view's `input_config -> 'suburbs'` extraction returns NULL for every
-- row — so the UI always shows "—" for the Suburb column. Similarly, neither
-- pulseFireScrapes (enqueue) nor pulseDataSync (executor) has ever populated
-- `batch_number` / `total_batches` per queue item — only `batch_id` gets
-- stamped — so the "Batch" column is also always "—".
--
-- pulseDetailEnrich is even sparser: it writes no `source_label`, no
-- `suburb`, no batch fields.
--
-- ── Fix ───────────────────────────────────────────────────────────────────
-- 1. Add a dedicated `suburb` TEXT column on `pulse_sync_logs`. Small (~30
--    bytes), stays on the hot table, no TOAST concern.
-- 2. Backfill existing rows: parse from `source_label` when it's
--    "<source_id> - <Suburb> (queue)", else pull from side-table's
--    `input_config -> 'suburbs'` first element.
-- 3. Add a `batch_number` column on `pulse_fire_queue` so the enqueuer can
--    stamp 1..N on each queue row. The dispatch RPC then plumbs it through
--    to pulseDataSync, which already writes the field to pulse_sync_logs.
-- 4. Rebuild the `pulse_sync_runs` view to use the new `suburb` column.
--
-- Frontend + edge function changes ship alongside this migration.

-- ── 1. Add suburb column to pulse_sync_logs ───────────────────────────────
ALTER TABLE pulse_sync_logs
  ADD COLUMN IF NOT EXISTS suburb TEXT;

COMMENT ON COLUMN pulse_sync_logs.suburb IS
  'Suburb name for per-suburb dispatches (rea_agents, rea_listings_bb_*) or a short summary tag (e.g. "15 listings") for batch-based sources (rea_detail_enrich). Added migration 121 so the UI can render a "Suburb" column in each source card''s run history without parsing source_label / joining the side-table.';

-- ── 2. Backfill suburb for recent rows (last 30d) ─────────────────────────
-- Anything older won''t be visible in the UI anyway (view has a 60d filter
-- but the card only shows the last ~10 bucketed runs).
--
-- Strategy 1: parse from source_label like "rea_agents - Strathfield (queue)"
-- Covers the pulseFireWorker -> dispatch_via_net path (>99% of rows).
UPDATE pulse_sync_logs
   SET suburb = trim(regexp_replace(source_label, '^[^-]+ - (.+) \(queue\)$', '\1'))
 WHERE suburb IS NULL
   AND started_at > now() - interval '30 days'
   AND source_label ~ '^[^-]+ - .+ \(queue\)$';

-- Strategy 2: for anything still missing, try the side-table input_config
UPDATE pulse_sync_logs l
   SET suburb = (p.input_config -> 'suburbs' ->> 0)
  FROM pulse_sync_log_payloads p
 WHERE l.suburb IS NULL
   AND l.id = p.sync_log_id
   AND l.started_at > now() - interval '30 days'
   AND (p.input_config -> 'suburbs' ->> 0) IS NOT NULL
   AND jsonb_typeof(p.input_config -> 'suburbs') = 'array';

-- ── 3. Add batch_number to pulse_fire_queue ───────────────────────────────
ALTER TABLE pulse_fire_queue
  ADD COLUMN IF NOT EXISTS batch_number INTEGER;

COMMENT ON COLUMN pulse_fire_queue.batch_number IS
  'Sequence number (1..N) of this queue row within its batch, where N = pulse_fire_batches.total_count. Assigned by pulseFireScrapes at enqueue time and plumbed through to pulse_sync_logs.batch_number by pulse_fire_queue_dispatch_via_net. Added migration 121.';

-- ── 4. Update dispatch RPC to carry batch_number + total_batches + suburb ─
-- Unchanged behaviour otherwise — same URL, same auth, same timeout.
CREATE OR REPLACE FUNCTION public.pulse_fire_queue_dispatch_via_net(p_queue_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  item RECORD;
  v_total_count INT;
  payload JSONB;
  request_id BIGINT;
  v_jwt TEXT;
BEGIN
  SELECT * INTO item FROM pulse_fire_queue WHERE id = p_queue_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF item.status != 'running' THEN RETURN NULL; END IF;

  -- Cohort size (total_batches) — join the batch row so we always have the
  -- canonical N. Safe because batch rows live forever.
  SELECT total_count INTO v_total_count
    FROM pulse_fire_batches
   WHERE id = item.batch_id;

  payload := jsonb_build_object(
    'suburbs',           ARRAY[item.suburb_name],
    'state',             'NSW',
    'source_id',         item.source_id,
    'source_label',      item.source_id || ' - ' || item.suburb_name || ' (queue)',
    'suburb',            item.suburb_name,
    'triggered_by_name', COALESCE(item.triggered_by_name, 'Queue'),
    'actorInput',        item.actor_input,
    'batch_id',          item.batch_id,
    'batch_number',      item.batch_number,
    'total_batches',     v_total_count,
    'fire_queue_id',     item.id
  );

  SELECT decrypted_secret INTO v_jwt
  FROM vault.decrypted_secrets
  WHERE name = 'pulse_cron_jwt'
  LIMIT 1;

  SELECT net.http_post(
    url     := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/pulseDataSync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_jwt
    ),
    body    := payload,
    timeout_milliseconds := 180000
  ) INTO request_id;

  RETURN request_id;
END;
$function$;

-- ── 5. Rebuild pulse_sync_runs view to use the new suburb column ─────────
-- The view now prefers `pulse_sync_logs.suburb` (populated on every new
-- dispatch via pulseDataSync changes in this release) and falls back to
-- parsing `source_label` so backfill gaps don''t show "—".
CREATE OR REPLACE VIEW public.pulse_sync_runs AS
WITH bucketed AS (
  SELECT pulse_sync_logs.source_id,
         pulse_sync_logs.source_label,
         date_trunc('hour'::text, pulse_sync_logs.started_at)
           + '00:15:00'::interval
             * floor((EXTRACT(minute FROM pulse_sync_logs.started_at)::integer / 15)::double precision)
           AS run_bucket,
         pulse_sync_logs.id,
         pulse_sync_logs.status,
         pulse_sync_logs.started_at,
         pulse_sync_logs.completed_at,
         pulse_sync_logs.triggered_by,
         pulse_sync_logs.triggered_by_name,
         pulse_sync_logs.records_fetched,
         pulse_sync_logs.records_new,
         pulse_sync_logs.records_updated,
         pulse_sync_logs.error_message,
         pulse_sync_logs.result_summary,
         pulse_sync_logs.batch_id,
         pulse_sync_logs.batch_number,
         pulse_sync_logs.total_batches,
         -- Prefer the dedicated `suburb` column (migration 121). Fallback to
         -- parsing source_label ("rea_agents - Strathfield (queue)") so rows
         -- older than the backfill horizon still render something.
         COALESCE(
           pulse_sync_logs.suburb,
           NULLIF(regexp_replace(pulse_sync_logs.source_label, '^[^-]+ - (.+) \(queue\)$', '\1'),
                  pulse_sync_logs.source_label)
         ) AS suburb
    FROM pulse_sync_logs
   WHERE pulse_sync_logs.started_at > (now() - '60 days'::interval)
     AND pulse_sync_logs.source_id IS NOT NULL
)
SELECT source_id,
       (array_agg(source_label ORDER BY started_at))[1] AS source_label,
       run_bucket,
       min(started_at) AS run_started_at,
       max(COALESCE(completed_at, started_at)) AS run_last_activity,
       count(*) AS total_dispatches,
       count(*) FILTER (WHERE status = 'completed'::text) AS succeeded,
       count(*) FILTER (WHERE status = 'failed'::text) AS failed,
       count(*) FILTER (WHERE status = 'running'::text) AS in_progress,
       COALESCE(sum(records_fetched), 0::bigint) AS total_records_fetched,
       COALESCE(sum(records_new), 0::bigint) AS total_records_new,
       COALESCE(sum(records_updated), 0::bigint) AS total_records_updated,
       array_remove(array_agg(DISTINCT triggered_by_name), NULL::text) AS triggered_by_names,
       array_remove(array_agg(DISTINCT batch_id), NULL::uuid) AS batch_ids,
       min(batch_number) AS min_batch_number,
       max(batch_number) AS max_batch_number,
       max(total_batches) AS total_batches,
       CASE
         WHEN max(total_batches) IS NULL THEN NULL::text
         WHEN min(batch_number) = max(batch_number) THEN (min(batch_number)::text || ' of '::text) || max(total_batches)::text
         ELSE (((min(batch_number)::text || '–'::text) || max(batch_number)::text) || ' of '::text) || max(total_batches)::text
       END AS batch_label,
       jsonb_agg(
         jsonb_build_object(
           'id', id,
           'status', status,
           -- The frontend reads `d.suburbs` (an array) — wrap the scalar in
           -- an array for API compatibility with the previous view shape.
           'suburbs', CASE WHEN suburb IS NOT NULL THEN jsonb_build_array(suburb) ELSE NULL::jsonb END,
           'suburb', suburb,
           'records_fetched', records_fetched,
           'records_new', records_new,
           'records_updated', records_updated,
           'started_at', started_at,
           'completed_at', completed_at,
           'duration_sec', EXTRACT(epoch FROM COALESCE(completed_at, now()) - started_at)::integer,
           'error_message', error_message,
           'triggered_by_name', triggered_by_name,
           'batch_id', batch_id,
           'batch_number', batch_number,
           'total_batches', total_batches
         )
         ORDER BY started_at
       ) AS dispatches
  FROM bucketed
 GROUP BY source_id, run_bucket;
