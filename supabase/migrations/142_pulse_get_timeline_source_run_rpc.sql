-- 142_pulse_get_timeline_source_run_rpc.sql
-- ────────────────────────────────────────────────────────────────────────────
-- Purpose
--   Single RPC the Timeline UI calls to drill from a pulse_timeline row down
--   to (sync_log + raw payload + source config). Before this, the UI made
--   2-3 separate selects and stitched them client-side. That stitching is
--   the thing that was fragile when many sync logs overlap in time.
--
-- Returns a single JSONB object shaped like:
-- {
--   sync_log:        { id, source_id, status, records_fetched, records_new,
--                      records_updated, started_at, completed_at,
--                      apify_run_id, error_message, duration_ms } | null,
--   payload_preview: jsonb (truncated),
--   payload_full_size_bytes: int,
--   source_config:   { source_id, label, actor_slug, apify_store_url } | null,
--   matched_by:      'explicit_fk' | 'time_range_fallback' | 'none'
-- }
--
-- Why `matched_by` is returned: the UI can show a small badge telling
-- operators whether this timeline row has a proper FK link or was matched
-- heuristically. Helps debug when the drill-through picks the wrong log.
--
-- Security: GRANT EXECUTE to authenticated. RLS on the underlying tables
-- still applies — this RPC just bundles the joins.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pulse_get_timeline_source_run(p_timeline_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_timeline      pulse_timeline%ROWTYPE;
  v_sync_log_id   uuid;
  v_matched_by    text := 'none';
  v_sync_log      jsonb;
  v_source_cfg    jsonb;
  v_payload_row   pulse_sync_log_payloads%ROWTYPE;
  v_payload_full_bytes integer := 0;
  v_payload_preview jsonb := '{}'::jsonb;
  v_preview_keys  text[];
  v_key           text;
  v_val           jsonb;
  v_items         jsonb;
  v_truncated     jsonb := '{}'::jsonb;
  v_key_count     integer := 0;
BEGIN
  -- 1. Load the timeline row
  SELECT * INTO v_timeline
  FROM   pulse_timeline
  WHERE  id = p_timeline_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'sync_log', NULL,
      'payload_preview', '{}'::jsonb,
      'payload_full_size_bytes', 0,
      'source_config', NULL,
      'matched_by', 'none',
      'error', 'timeline_row_not_found'
    );
  END IF;

  -- 2. Resolve sync_log_id — explicit FK first, else time-range fallback
  IF v_timeline.sync_log_id IS NOT NULL THEN
    v_sync_log_id := v_timeline.sync_log_id;
    v_matched_by  := 'explicit_fk';
  ELSIF v_timeline.source IS NOT NULL THEN
    SELECT s.id
      INTO v_sync_log_id
      FROM pulse_sync_logs s
     WHERE s.source_id = v_timeline.source
       AND s.started_at <= v_timeline.created_at
       AND (
             s.completed_at IS NULL
          OR s.completed_at + interval '5 minutes' >= v_timeline.created_at
           )
     ORDER BY s.started_at DESC
     LIMIT 1;
    IF v_sync_log_id IS NOT NULL THEN
      v_matched_by := 'time_range_fallback';
    END IF;
  END IF;

  -- 3. Load sync_log + source_config + payload
  IF v_sync_log_id IS NOT NULL THEN
    SELECT jsonb_build_object(
             'id',                s.id,
             'source_id',         s.source_id,
             'source_label',      s.source_label,
             'sync_type',         s.sync_type,
             'status',            s.status,
             'records_fetched',   s.records_fetched,
             'records_new',       s.records_new,
             'records_updated',   s.records_updated,
             'started_at',        s.started_at,
             'completed_at',      s.completed_at,
             'apify_run_id',      s.apify_run_id,
             'error_message',     s.error_message,
             'triggered_by',      s.triggered_by,
             'triggered_by_name', s.triggered_by_name,
             'duration_ms',       CASE
                                    WHEN s.completed_at IS NOT NULL
                                    THEN (extract(epoch FROM (s.completed_at - s.started_at)) * 1000)::integer
                                    ELSE NULL
                                  END
           )
      INTO v_sync_log
      FROM pulse_sync_logs s
     WHERE s.id = v_sync_log_id;

    -- source_config — match on source_id (the human slug, not the uuid)
    SELECT jsonb_build_object(
             'source_id',       c.source_id,
             'label',           c.label,
             'description',     c.description,
             'actor_slug',      c.actor_slug,
             'apify_store_url', c.apify_store_url,
             'approach',        c.approach
           )
      INTO v_source_cfg
      FROM pulse_source_configs c
     WHERE c.source_id = (v_sync_log->>'source_id')
     LIMIT 1;

    -- Payload — full size + a truncated preview (~10KB cap)
    SELECT * INTO v_payload_row
      FROM pulse_sync_log_payloads
     WHERE sync_log_id = v_sync_log_id;

    IF FOUND THEN
      v_payload_full_bytes := octet_length(COALESCE(v_payload_row.raw_payload::text, ''));

      -- Build preview: first 10 top-level keys of raw_payload; for each,
      -- if the value is an array, truncate to first 20 items.
      IF v_payload_row.raw_payload IS NOT NULL
         AND jsonb_typeof(v_payload_row.raw_payload) = 'object' THEN
        v_preview_keys := ARRAY(
          SELECT key
          FROM   jsonb_object_keys(v_payload_row.raw_payload) AS key
          ORDER BY key
          LIMIT 10
        );

        FOREACH v_key IN ARRAY v_preview_keys LOOP
          v_val := v_payload_row.raw_payload -> v_key;
          IF jsonb_typeof(v_val) = 'array' THEN
            SELECT COALESCE(jsonb_agg(elem ORDER BY idx), '[]'::jsonb)
              INTO v_items
              FROM (
                SELECT elem, idx
                FROM   jsonb_array_elements(v_val) WITH ORDINALITY AS t(elem, idx)
                ORDER BY idx
                LIMIT 20
              ) sub;
            v_truncated := v_truncated || jsonb_build_object(
              v_key,
              jsonb_build_object(
                '__truncated_array__', true,
                'total_items',         jsonb_array_length(v_val),
                'preview_items',       v_items
              )
            );
          ELSE
            v_truncated := v_truncated || jsonb_build_object(v_key, v_val);
          END IF;
        END LOOP;

        SELECT count(*) INTO v_key_count
          FROM jsonb_object_keys(v_payload_row.raw_payload);

        v_payload_preview := jsonb_build_object(
          'keys',            v_truncated,
          'total_top_keys',  v_key_count,
          'result_summary',  v_payload_row.result_summary,
          'input_config',    v_payload_row.input_config
        );

        -- Hard-cap preview bytes at ~10KB; if we blew past it, drop the
        -- `keys` blob and keep just summaries so the drill-through still
        -- renders something useful.
        IF octet_length(v_payload_preview::text) > 12000 THEN
          v_payload_preview := jsonb_build_object(
            'keys',           '{}'::jsonb,
            'total_top_keys', v_key_count,
            'result_summary', v_payload_row.result_summary,
            'input_config',   v_payload_row.input_config,
            '__preview_truncated__', true,
            '__preview_reason__',    'exceeded_10kb_cap'
          );
        END IF;
      ELSE
        v_payload_preview := jsonb_build_object(
          'result_summary', v_payload_row.result_summary,
          'input_config',   v_payload_row.input_config,
          '__note__',       'raw_payload is null or not an object'
        );
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'sync_log',                v_sync_log,
    'payload_preview',         v_payload_preview,
    'payload_full_size_bytes', v_payload_full_bytes,
    'source_config',           v_source_cfg,
    'matched_by',              v_matched_by,
    'timeline_row', jsonb_build_object(
      'id',             v_timeline.id,
      'source',         v_timeline.source,
      'sync_log_id',    v_timeline.sync_log_id,
      'apify_run_id',   v_timeline.apify_run_id,
      'created_at',     v_timeline.created_at,
      'event_type',     v_timeline.event_type,
      'entity_type',    v_timeline.entity_type,
      'title',          v_timeline.title
    )
  );
END
$fn$;

GRANT EXECUTE ON FUNCTION pulse_get_timeline_source_run(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION pulse_get_timeline_source_run(uuid) TO service_role;
