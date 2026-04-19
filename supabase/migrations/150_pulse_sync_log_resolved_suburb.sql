-- 150_pulse_sync_log_resolved_suburb.sql
--
-- "Truly all Ashfield" suburb filter for Sync History.
-- `pulse_sync_logs.suburb` is populated by most but not all callers (legacy
-- rows, manual invocations, batch orchestrators). Filtering only on that
-- column under-counts: an Ashfield run triggered manually or before
-- migration 121 shows up with suburb=NULL and gets missed.
--
-- This RPC returns sync logs with a `resolved_suburb` derived from four
-- fallback tiers, in order:
--
--   1. pulse_sync_logs.suburb                                 (labelled)
--   2. pulse_sync_log_payloads.input_config->'suburbs'->>0    (input param)
--   3. split_part(<first key of result_summary.apify_run_ids>, '-', -1)
--      — e.g. "listings-Ashfield" → "Ashfield". Only applies when
--      apify_run_ids is an object (not an array — map-style keying was
--      introduced in migration ~88 when chunked dispatches started).
--   4. Most common pulse_listings.suburb touched via pulse_timeline on
--      this sync_log_id (covers runs where only downstream listing rows
--      got written).
--
-- The filter uses case-insensitive ILIKE '%<input>%' so the user can
-- type "ashfield" or "Ashfield" or even "ash" and match.

CREATE OR REPLACE FUNCTION pulse_get_sync_logs_with_resolved_suburb(
  p_source_id     text,
  p_suburb_filter text DEFAULT NULL,
  p_status_filter text DEFAULT NULL,
  p_since         timestamptz DEFAULT NULL,
  p_limit         int DEFAULT 50,
  p_offset        int DEFAULT 0
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH base AS (
  SELECT
    psl.id,
    psl.source_id,
    psl.source_label,
    psl.status,
    psl.started_at,
    psl.completed_at,
    psl.result_summary,
    psl.triggered_by,
    psl.triggered_by_name,
    psl.apify_run_id,
    psl.error_message,
    psl.records_fetched,
    psl.records_new,
    psl.records_updated,
    psl.timeline_events_emitted,
    psl.batch_id,
    psl.batch_number,
    psl.total_batches,
    psl.suburb AS raw_suburb,
    COALESCE(
      -- Tier 1: labelled column on the sync log itself
      NULLIF(trim(psl.suburb), ''),
      -- Tier 2: input_config.suburbs[0] (lives on side-table since payload split)
      (
        SELECT NULLIF(trim(pslp.input_config->'suburbs'->>0), '')
        FROM pulse_sync_log_payloads pslp
        WHERE pslp.sync_log_id = psl.id
        LIMIT 1
      ),
      -- Tier 3: first key of apify_run_ids (object form only), token after last '-'
      (
        SELECT NULLIF(
          trim(split_part(k, '-', array_length(string_to_array(k, '-'), 1))),
          ''
        )
        FROM pulse_sync_log_payloads pslp
        CROSS JOIN LATERAL (
          SELECT CASE
            WHEN jsonb_typeof(pslp.result_summary->'apify_run_ids') = 'object'
            THEN (SELECT k FROM jsonb_object_keys(pslp.result_summary->'apify_run_ids') k LIMIT 1)
            ELSE NULL
          END AS k
        ) keys
        WHERE pslp.sync_log_id = psl.id
          AND keys.k IS NOT NULL
        LIMIT 1
      ),
      -- Tier 4: most-common suburb across pulse_listings touched by pulse_timeline
      (
        SELECT pl.suburb
        FROM pulse_timeline pt
        JOIN pulse_listings pl ON pl.id = pt.pulse_entity_id
        WHERE pt.sync_log_id = psl.id
          AND pt.entity_type = 'listing'
          AND pl.suburb IS NOT NULL
        GROUP BY pl.suburb
        ORDER BY count(*) DESC
        LIMIT 1
      )
    ) AS resolved_suburb
  FROM pulse_sync_logs psl
  WHERE (p_source_id IS NULL OR psl.source_id = p_source_id)
    AND (p_status_filter IS NULL OR psl.status = p_status_filter)
    AND (p_since IS NULL OR psl.started_at >= p_since)
),
filtered AS (
  SELECT *
  FROM base
  WHERE (
    p_suburb_filter IS NULL
    OR trim(p_suburb_filter) = ''
    OR resolved_suburb ILIKE '%' || trim(p_suburb_filter) || '%'
  )
),
total AS (
  SELECT count(*) AS n FROM filtered
),
page AS (
  SELECT *
  FROM filtered
  ORDER BY started_at DESC NULLS LAST
  LIMIT GREATEST(COALESCE(p_limit, 50), 1)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0)
)
SELECT jsonb_build_object(
  'rows',  COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM page p), '[]'::jsonb),
  'total', (SELECT n FROM total)
);
$$;

GRANT EXECUTE ON FUNCTION pulse_get_sync_logs_with_resolved_suburb(text, text, text, timestamptz, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION pulse_get_sync_logs_with_resolved_suburb(text, text, text, timestamptz, int, int) TO service_role;
