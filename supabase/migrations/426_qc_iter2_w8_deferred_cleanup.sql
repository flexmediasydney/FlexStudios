-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 426 — QC iter 2 Wave 8: deferred-finding cleanup
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Two findings landed here:
--
--   F-B-018: finals_qa_runs orphan cleanup cron. Edge Function crashes
--            (panic, OOM, gateway timeout) leave finals-qa rows stuck in
--            status='running' indefinitely. The dispatcher pattern handles
--            shortlisting_jobs (5min stale-claim sweep in mig 292), but
--            finals_qa_runs is a parallel task tracker with no equivalent
--            sweeper. Add a 15min cron that flips any 'running' row >30min
--            old to 'failed' with error_message='wall_timeout'.
--
--            30min is generous: a finals-qa pass over a typical 50-image
--            shortlist completes in 5-10min on Modal. Rows stuck longer
--            than 3x that are unambiguously wedged.
--
--   F-FE-Architecture: shortlisting_architecture_kpis distribution columns
--                      currently fold structural NULL and semantic 'unset'
--                      into a single 'unset' bucket via COALESCE. That makes
--                      it impossible to tell from the dashboard whether a
--                      column is being populated at all (NULL = pipeline
--                      bug; 'unset' = legitimate "no value" classification).
--                      The W11.6.13 cutover regression (5 rounds, 148
--                      classifications, 100% NULL space_type/zone_focus)
--                      hid behind this exact COALESCE — every round looked
--                      "all unset" rather than "all NULL".
--
--                      Replace COALESCE(col, 'unset') with a sentinel that
--                      explicitly distinguishes structural NULL from any
--                      empty/sentinel string the pipeline might emit. Use
--                      '__null_field_never_populated__' so existing readers
--                      that key on 'unset' still work for legitimate cases
--                      and the pathological case becomes visible.
--
-- Migration is idempotent: cron block uses unschedule-then-schedule;
-- CREATE OR REPLACE FUNCTION on the RPC.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- F-B-018 — finals_qa_runs orphan cleanup cron
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Schedule: every 15 minutes. Threshold: 30 minutes. The threshold is decoupled
-- from the cron cadence so a row that crosses 30min still gets cleaned up on
-- the next tick (worst-case latency: 15min).
--
-- We update started_at-based age, not created_at, because finals_qa_runs has
-- a long pre-flight window before status flips to 'running' (queue claim +
-- pre-checks). started_at marks the actual edge-fn start.
--
-- error_message='wall_timeout' makes this row distinguishable from genuine
-- failures in ops dashboards. The downstream Tonomo notifier already filters
-- error_message ILIKE '%timeout%' for retry classification.

DO $$
BEGIN
  PERFORM cron.unschedule('finals_qa_runs_cleanup')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'finals_qa_runs_cleanup');

  PERFORM cron.schedule(
    'finals_qa_runs_cleanup',
    '*/15 * * * *',
    $job$
      UPDATE finals_qa_runs
         SET status = 'failed',
             error_message = COALESCE(error_message, '') ||
                             CASE WHEN COALESCE(error_message, '') = '' THEN '' ELSE ' | ' END ||
                             'wall_timeout',
             finished_at = NOW()
       WHERE status = 'running'
         AND started_at IS NOT NULL
         AND started_at < NOW() - INTERVAL '30 minutes';
    $job$
  );
END$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- F-FE-Architecture — KPI sentinel for NULL field state distinction
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The four distribution payloads (room_type, space_type, zone_focus, image_type)
-- previously mapped both NULL and the empty string into 'unset'. The W11.6.13
-- space_type/zone_focus regression (NULL on 100% of 148 classifications) showed
-- up as "everything unset" — operationally indistinguishable from "everything
-- legitimately classified as unknown".
--
-- Replace COALESCE(col, 'unset') with a layered classification:
--   * '__null_field_never_populated__' — column literally NULL (pipeline gap)
--   * '__empty_string__'               — column = '' (sentinel, also a bug)
--   * <actual_value>                   — populated normally
--
-- Plus a new top-level field 'field_population_health' that summarises per-
-- column NULL vs populated counts — the Architecture tab can render a single
-- "all 4 columns 0% populated" red banner rather than burying the regression
-- in a stacked-bar chart.
--
-- Drop-and-recreate: full RPC body so the change is auditable in this single
-- migration. The shape of the returned blob gains one new key
-- (field_population_health) and the four distribution arrays now use the
-- new sentinel; everything else is unchanged.

CREATE OR REPLACE FUNCTION public.shortlisting_architecture_kpis(
  p_days int DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_window_start timestamptz;
  v_project_count int;
  v_products_count int;
  v_engine_role_dist jsonb;
  v_slot_total int;
  v_slot_active int;
  v_slot_by_phase jsonb;
  v_slot_by_mode jsonb;
  v_round_count_30d int;
  v_composition_count int;
  v_composition_group_count int;
  v_raw_observation_count int;
  v_object_registry_size int;
  v_attribute_value_count int;
  v_slot_suggestion_pending_count int;
  v_room_type_dist jsonb;
  v_space_type_dist jsonb;
  v_zone_focus_dist jsonb;
  v_image_type_dist jsonb;
  v_field_population_health jsonb;
  v_slot_coverage jsonb;
  v_aggregate_stats jsonb;
  v_heuristic_suggestions jsonb;
  v_total_cells int := 0;
  v_filled_cells int := 0;
  v_red_round_count int := 0;
  v_zero_fill_slot_count int := 0;
BEGIN
  IF p_days IS NULL OR p_days < 1 THEN
    p_days := 30;
  ELSIF p_days > 365 THEN
    p_days := 365;
  END IF;

  v_window_start := now() - (p_days || ' days')::interval;

  -- ── Layer 1: Projects ───────────────────────────────────────────────────
  BEGIN
    SELECT COUNT(*) INTO v_project_count FROM projects;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_project_count := 0;
  END;

  -- ── Layer 2: Products + engine_role distribution ────────────────────────
  BEGIN
    SELECT COUNT(*) INTO v_products_count FROM products WHERE COALESCE(is_active, true) = true;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_products_count := 0;
  END;

  BEGIN
    SELECT COALESCE(jsonb_object_agg(engine_role, n), '{}'::jsonb)
      INTO v_engine_role_dist
      FROM (
        SELECT COALESCE(engine_role, 'unset') AS engine_role, COUNT(*) AS n
          FROM products
         WHERE COALESCE(is_active, true) = true
         GROUP BY 1
      ) t;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_engine_role_dist := '{}'::jsonb;
  END;

  -- ── Layer 3: Slots ──────────────────────────────────────────────────────
  BEGIN
    SELECT COUNT(*),
           COUNT(*) FILTER (WHERE COALESCE(is_active, true) = true)
      INTO v_slot_total, v_slot_active
      FROM shortlisting_slot_definitions;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_slot_total := 0;
    v_slot_active := 0;
  END;

  BEGIN
    SELECT COALESCE(jsonb_object_agg(phase::text, n), '{}'::jsonb)
      INTO v_slot_by_phase
      FROM (
        SELECT phase, COUNT(*) AS n
          FROM shortlisting_slot_definitions
         WHERE COALESCE(is_active, true) = true
         GROUP BY phase
      ) t;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_slot_by_phase := '{}'::jsonb;
  END;

  BEGIN
    SELECT COALESCE(jsonb_object_agg(COALESCE(selection_mode, 'ai_decides'), n), '{}'::jsonb)
      INTO v_slot_by_mode
      FROM (
        SELECT COALESCE(selection_mode, 'ai_decides') AS selection_mode, COUNT(*) AS n
          FROM shortlisting_slot_definitions
         WHERE COALESCE(is_active, true) = true
         GROUP BY 1
      ) t;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_slot_by_mode := '{}'::jsonb;
  END;

  -- ── Layer 4: Rounds + compositions + groups ─────────────────────────────
  BEGIN
    SELECT COUNT(*) INTO v_round_count_30d
      FROM shortlisting_rounds
     WHERE created_at >= v_window_start;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_round_count_30d := 0;
  END;

  BEGIN
    SELECT COUNT(*) INTO v_composition_count FROM composition_classifications;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_composition_count := 0;
  END;

  BEGIN
    SELECT COUNT(*) INTO v_composition_group_count FROM composition_groups;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_composition_group_count := 0;
  END;

  BEGIN
    SELECT COUNT(*) INTO v_raw_observation_count FROM raw_attribute_observations;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_raw_observation_count := 0;
  END;

  -- ── Layer 5: Object registry + attribute values ─────────────────────────
  BEGIN
    SELECT COUNT(*) INTO v_object_registry_size
      FROM object_registry
     WHERE COALESCE(status, 'canonical') = 'canonical';
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_object_registry_size := 0;
  END;

  BEGIN
    SELECT COUNT(*) INTO v_attribute_value_count FROM attribute_values;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_attribute_value_count := 0;
  END;

  -- ── Pending slot suggestions (W12.7) ────────────────────────────────────
  BEGIN
    SELECT COUNT(*) INTO v_slot_suggestion_pending_count
      FROM shortlisting_slot_suggestions
     WHERE COALESCE(status, 'pending_review') = 'pending_review';
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_slot_suggestion_pending_count := 0;
  END;

  -- ── Distributions across composition_classifications ────────────────────
  -- W8 F-FE-Architecture: distinguish structural NULL from semantic 'unset'.
  -- Previously COALESCE(col, 'unset') folded both into one bucket; the
  -- W11.6.13 regression (NULL on 100% of 148 rows) was invisible.
  BEGIN
    SELECT COALESCE(
      jsonb_agg(jsonb_build_object('room_type', room_type, 'n', n)
                ORDER BY n DESC), '[]'::jsonb)
      INTO v_room_type_dist
      FROM (
        SELECT
          CASE
            WHEN room_type IS NULL THEN '__null_field_never_populated__'
            WHEN room_type = ''     THEN '__empty_string__'
            ELSE room_type
          END AS room_type,
          COUNT(*) AS n
          FROM composition_classifications
         GROUP BY 1
         ORDER BY 2 DESC
         LIMIT 25
      ) t;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_room_type_dist := '[]'::jsonb;
  END;

  BEGIN
    SELECT COALESCE(
      jsonb_agg(jsonb_build_object('space_type', space_type, 'n', n)
                ORDER BY n DESC), '[]'::jsonb)
      INTO v_space_type_dist
      FROM (
        SELECT
          CASE
            WHEN space_type IS NULL THEN '__null_field_never_populated__'
            WHEN space_type = ''     THEN '__empty_string__'
            ELSE space_type
          END AS space_type,
          COUNT(*) AS n
          FROM composition_classifications
         GROUP BY 1
         ORDER BY 2 DESC
         LIMIT 25
      ) t;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_space_type_dist := '[]'::jsonb;
  END;

  BEGIN
    SELECT COALESCE(
      jsonb_agg(jsonb_build_object('zone_focus', zone_focus, 'n', n)
                ORDER BY n DESC), '[]'::jsonb)
      INTO v_zone_focus_dist
      FROM (
        SELECT
          CASE
            WHEN zone_focus IS NULL THEN '__null_field_never_populated__'
            WHEN zone_focus = ''     THEN '__empty_string__'
            ELSE zone_focus
          END AS zone_focus,
          COUNT(*) AS n
          FROM composition_classifications
         GROUP BY 1
         ORDER BY 2 DESC
         LIMIT 25
      ) t;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_zone_focus_dist := '[]'::jsonb;
  END;

  BEGIN
    SELECT COALESCE(
      jsonb_agg(jsonb_build_object('image_type', image_type, 'n', n)
                ORDER BY n DESC), '[]'::jsonb)
      INTO v_image_type_dist
      FROM (
        SELECT
          CASE
            WHEN image_type IS NULL THEN '__null_field_never_populated__'
            WHEN image_type = ''     THEN '__empty_string__'
            ELSE image_type
          END AS image_type,
          COUNT(*) AS n
          FROM composition_classifications
         GROUP BY 1
         ORDER BY 2 DESC
         LIMIT 25
      ) t;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_image_type_dist := '[]'::jsonb;
  END;

  -- New: field_population_health rollup. Single jsonb object summarising
  -- {column → {populated: n, null: n, empty: n, pct_populated: float}} so the
  -- frontend can render a "100% NULL on space_type" red banner without
  -- digging through the distribution arrays.
  BEGIN
    SELECT jsonb_build_object(
      'room_type', jsonb_build_object(
        'populated',     COUNT(*) FILTER (WHERE room_type IS NOT NULL AND room_type <> ''),
        'null',          COUNT(*) FILTER (WHERE room_type IS NULL),
        'empty',         COUNT(*) FILTER (WHERE room_type = ''),
        'total',         COUNT(*),
        'pct_populated', ROUND(100.0 * COUNT(*) FILTER (WHERE room_type IS NOT NULL AND room_type <> '') / NULLIF(COUNT(*), 0), 1)
      ),
      'space_type', jsonb_build_object(
        'populated',     COUNT(*) FILTER (WHERE space_type IS NOT NULL AND space_type <> ''),
        'null',          COUNT(*) FILTER (WHERE space_type IS NULL),
        'empty',         COUNT(*) FILTER (WHERE space_type = ''),
        'total',         COUNT(*),
        'pct_populated', ROUND(100.0 * COUNT(*) FILTER (WHERE space_type IS NOT NULL AND space_type <> '') / NULLIF(COUNT(*), 0), 1)
      ),
      'zone_focus', jsonb_build_object(
        'populated',     COUNT(*) FILTER (WHERE zone_focus IS NOT NULL AND zone_focus <> ''),
        'null',          COUNT(*) FILTER (WHERE zone_focus IS NULL),
        'empty',         COUNT(*) FILTER (WHERE zone_focus = ''),
        'total',         COUNT(*),
        'pct_populated', ROUND(100.0 * COUNT(*) FILTER (WHERE zone_focus IS NOT NULL AND zone_focus <> '') / NULLIF(COUNT(*), 0), 1)
      ),
      'image_type', jsonb_build_object(
        'populated',     COUNT(*) FILTER (WHERE image_type IS NOT NULL AND image_type <> ''),
        'null',          COUNT(*) FILTER (WHERE image_type IS NULL),
        'empty',         COUNT(*) FILTER (WHERE image_type = ''),
        'total',         COUNT(*),
        'pct_populated', ROUND(100.0 * COUNT(*) FILTER (WHERE image_type IS NOT NULL AND image_type <> '') / NULLIF(COUNT(*), 0), 1)
      )
    )
      INTO v_field_population_health
      FROM composition_classifications
     WHERE classified_at >= v_window_start;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_field_population_health := '{}'::jsonb;
  END;

  -- ── Slot coverage matrix ───────────────────────────────────────────────
  -- (unchanged from mig 421; copied verbatim because CREATE OR REPLACE
  -- FUNCTION needs the full body.)
  BEGIN
    WITH
    active_slots AS (
      SELECT slot_id, phase, COALESCE(min_images, 0) AS min_required,
             COALESCE(max_images, 1) AS max_allowed,
             COALESCE(eligible_when_engine_roles, ARRAY[]::text[]) AS engine_roles
        FROM shortlisting_slot_definitions
       WHERE COALESCE(is_active, true) = true
    ),
    recent_rounds AS (
      SELECT id AS round_id, project_id, created_at
        FROM shortlisting_rounds
       WHERE created_at >= v_window_start
       ORDER BY created_at DESC
       LIMIT 30
    ),
    slot_fills AS (
      SELECT
        e.round_id,
        e.payload->>'slot_id' AS slot_id,
        COUNT(*) FILTER (
          WHERE COALESCE(e.payload->>'kind', 'winner') IN ('winner', 'ai_backfill')
        ) AS filled_n,
        COUNT(*) FILTER (
          WHERE COALESCE(e.payload->>'kind', 'winner') = 'ai_backfill'
            OR (e.payload->>'position_filled_via') = 'ai_backfill'
        ) AS backfill_n
        FROM shortlisting_events e
       WHERE e.round_id IN (SELECT round_id FROM recent_rounds)
         AND e.event_type LIKE '%slot_assigned%'
         AND (e.payload->>'slot_id') IS NOT NULL
       GROUP BY e.round_id, e.payload->>'slot_id'
    ),
    active_round_ids AS (
      SELECT DISTINCT round_id FROM slot_fills
    ),
    cells AS (
      SELECT
        s.slot_id,
        s.phase,
        r.round_id,
        r.created_at,
        s.min_required,
        s.max_allowed,
        COALESCE(f.filled_n, 0) AS filled_n,
        COALESCE(f.backfill_n, 0) AS backfill_n,
        (r.round_id IN (SELECT round_id FROM active_round_ids)) AS round_active,
        CASE
          WHEN r.round_id NOT IN (SELECT round_id FROM active_round_ids) THEN 'grey'
          WHEN COALESCE(f.backfill_n, 0) > 0 THEN 'amber'
          WHEN COALESCE(f.filled_n, 0) > s.max_allowed THEN 'amber'
          WHEN COALESCE(f.filled_n, 0) >= s.min_required AND COALESCE(f.filled_n, 0) > 0 THEN 'green'
          WHEN s.min_required >= 1 AND COALESCE(f.filled_n, 0) = 0 THEN 'red'
          ELSE 'grey'
        END AS fill_state
        FROM active_slots s
        CROSS JOIN recent_rounds r
        LEFT JOIN slot_fills f ON f.round_id = r.round_id AND f.slot_id = s.slot_id
    ),
    rolled_up AS (
      SELECT
        slot_id,
        phase,
        jsonb_agg(
          jsonb_build_object(
            'round_id',     round_id,
            'created_at',   created_at,
            'fill_state',   fill_state,
            'filled_count', filled_n,
            'backfill_count', backfill_n,
            'min_required', min_required
          )
          ORDER BY created_at DESC
        ) AS rounds
        FROM cells
       GROUP BY slot_id, phase
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'slot_id', slot_id,
        'phase',   phase,
        'rounds',  rounds
      ) ORDER BY phase, slot_id), '[]'::jsonb)
      INTO v_slot_coverage
      FROM rolled_up;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_slot_coverage := '[]'::jsonb;
  END;

  -- ── Coverage aggregate stats (computed off the matrix) ──────────────────
  BEGIN
    WITH cells AS (
      SELECT
        (s_obj->>'slot_id') AS slot_id,
        (r_obj->>'fill_state') AS fill_state
        FROM jsonb_array_elements(v_slot_coverage) s_obj
        CROSS JOIN LATERAL jsonb_array_elements(s_obj->'rounds') r_obj
    )
    SELECT
      COUNT(*),
      COUNT(*) FILTER (WHERE fill_state IN ('green', 'amber')),
      COUNT(DISTINCT slot_id) FILTER (WHERE fill_state = 'red')
      INTO v_total_cells, v_filled_cells, v_zero_fill_slot_count
      FROM cells;

    WITH cells AS (
      SELECT
        (r_obj->>'round_id') AS round_id,
        (r_obj->>'fill_state') AS fill_state
        FROM jsonb_array_elements(v_slot_coverage) s_obj
        CROSS JOIN LATERAL jsonb_array_elements(s_obj->'rounds') r_obj
    )
    SELECT COUNT(DISTINCT round_id) FILTER (WHERE fill_state = 'red')
      INTO v_red_round_count
      FROM cells;
  EXCEPTION WHEN undefined_table OR undefined_column OR invalid_text_representation THEN
    v_total_cells := 0;
    v_filled_cells := 0;
    v_red_round_count := 0;
    v_zero_fill_slot_count := 0;
  END;

  BEGIN
    WITH cells AS (
      SELECT
        (s_obj->>'slot_id') AS slot_id,
        (r_obj->>'fill_state') AS fill_state
        FROM jsonb_array_elements(v_slot_coverage) s_obj
        CROSS JOIN LATERAL jsonb_array_elements(s_obj->'rounds') r_obj
    ),
    by_slot AS (
      SELECT slot_id,
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE fill_state IN ('green', 'amber')) AS filled
        FROM cells
       GROUP BY slot_id
    )
    SELECT COUNT(*) FILTER (WHERE total > 0 AND filled = 0)
      INTO v_zero_fill_slot_count
      FROM by_slot;
  EXCEPTION WHEN undefined_table OR undefined_column OR invalid_text_representation THEN
    v_zero_fill_slot_count := 0;
  END;

  v_aggregate_stats := jsonb_build_object(
    'total_cells', COALESCE(v_total_cells, 0),
    'filled_cells', COALESCE(v_filled_cells, 0),
    'pct_filled', CASE
      WHEN COALESCE(v_total_cells, 0) = 0 THEN NULL
      ELSE ROUND(100.0 * v_filled_cells / NULLIF(v_total_cells, 0), 1)
    END,
    'red_round_count', COALESCE(v_red_round_count, 0),
    'zero_fill_slot_count', COALESCE(v_zero_fill_slot_count, 0)
  );

  -- ── Heuristic slot suggestions ──────────────────────────────────────────
  -- (unchanged from mig 421)
  BEGIN
    WITH
    active_slots AS (
      SELECT slot_id, phase, COALESCE(min_images, 0) AS min_required,
             COALESCE(max_images, 1) AS max_allowed,
             COALESCE(eligible_zone_focuses, ARRAY[]::text[]) AS zone_focuses
        FROM shortlisting_slot_definitions
       WHERE COALESCE(is_active, true) = true
    ),
    recent_rounds AS (
      SELECT id AS round_id FROM shortlisting_rounds
       WHERE created_at >= v_window_start
       LIMIT 30
    ),
    slot_round_fills AS (
      SELECT
        s.slot_id,
        s.max_allowed,
        s.min_required,
        r.round_id,
        COALESCE((SELECT COUNT(*)
                    FROM shortlisting_events e
                   WHERE e.round_id = r.round_id
                     AND e.event_type LIKE '%slot_assigned%'
                     AND (e.payload->>'slot_id') = s.slot_id
                     AND COALESCE(e.payload->>'kind', 'winner') = 'winner'
                  ), 0) AS filled_n
        FROM active_slots s
        CROSS JOIN recent_rounds r
    ),
    per_slot AS (
      SELECT
        slot_id,
        max_allowed,
        min_required,
        COUNT(*) AS rounds_total,
        COUNT(*) FILTER (WHERE filled_n = 0) AS rounds_empty,
        AVG(filled_n) FILTER (WHERE filled_n > 0) AS avg_fill_when_present,
        MAX(filled_n) AS peak_fill
        FROM slot_round_fills
       GROUP BY slot_id, max_allowed, min_required
    ),
    splits AS (
      SELECT
        'split' AS type,
        slot_id,
        rounds_total AS evidence_round_count,
        ROUND(avg_fill_when_present::numeric, 2) AS avg_fill_count,
        peak_fill,
        max_allowed,
        format(
          'Slot %s averaged %s compositions per filled round (peak %s); capacity is %s. Consider splitting into multiple slots.',
          slot_id, ROUND(avg_fill_when_present::numeric, 2)::text,
          peak_fill::text, max_allowed::text
        ) AS rationale
        FROM per_slot
       WHERE avg_fill_when_present IS NOT NULL
         AND avg_fill_when_present >= 2.5
         AND max_allowed >= 2
    ),
    deletions AS (
      SELECT
        'deletion_candidate' AS type,
        slot_id,
        rounds_empty,
        rounds_total,
        format(
          'Slot %s was empty in %s of %s rounds (%s%%). Consider retiring or relaxing eligibility filters.',
          slot_id, rounds_empty::text, rounds_total::text,
          ROUND(100.0 * rounds_empty / NULLIF(rounds_total, 0), 0)::text
        ) AS rationale
        FROM per_slot
       WHERE rounds_total >= 3
         AND (rounds_empty::numeric / NULLIF(rounds_total, 0)) >= 0.80
    ),
    observed_zone_focuses AS (
      SELECT DISTINCT cc.zone_focus, COUNT(DISTINCT cc.round_id) AS rounds_with
        FROM composition_classifications cc
       WHERE cc.zone_focus IS NOT NULL
         AND cc.zone_focus <> ''
         AND cc.round_id IN (SELECT round_id FROM recent_rounds)
       GROUP BY cc.zone_focus
    ),
    covered_zone_focuses AS (
      SELECT DISTINCT unnest(COALESCE(eligible_zone_focuses, ARRAY[]::text[])) AS zone_focus
        FROM shortlisting_slot_definitions
       WHERE COALESCE(is_active, true) = true
    ),
    new_slots AS (
      SELECT
        'new_slot_needed' AS type,
        ozf.zone_focus AS zone_focus,
        ozf.rounds_with AS evidence_round_count,
        format(
          'zone_focus=%s appeared in %s rounds but no slot anchors it. Consider adding a slot.',
          ozf.zone_focus, ozf.rounds_with::text
        ) AS rationale
        FROM observed_zone_focuses ozf
       WHERE ozf.zone_focus NOT IN (SELECT zone_focus FROM covered_zone_focuses)
         AND ozf.rounds_with >= 2
    )
    SELECT COALESCE(jsonb_agg(row_to_json(combined)), '[]'::jsonb)
      INTO v_heuristic_suggestions
      FROM (
        SELECT type, slot_id, NULL::text AS zone_focus,
               evidence_round_count, NULL::int AS rounds_total,
               avg_fill_count, peak_fill, max_allowed,
               NULL::int AS rounds_empty, rationale
          FROM splits
        UNION ALL
        SELECT type, slot_id, NULL::text AS zone_focus,
               NULL::numeric AS evidence_round_count, rounds_total,
               NULL::numeric AS avg_fill_count, NULL::int AS peak_fill,
               NULL::int AS max_allowed, rounds_empty, rationale
          FROM deletions
        UNION ALL
        SELECT type, NULL::text AS slot_id, zone_focus,
               evidence_round_count::numeric, NULL::int AS rounds_total,
               NULL::numeric AS avg_fill_count, NULL::int AS peak_fill,
               NULL::int AS max_allowed, NULL::int AS rounds_empty, rationale
          FROM new_slots
      ) combined;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_heuristic_suggestions := '[]'::jsonb;
  END;

  -- ── Build the blob ──────────────────────────────────────────────────────
  RETURN jsonb_build_object(
    'project_count',                  COALESCE(v_project_count, 0),
    'products_count',                 COALESCE(v_products_count, 0),
    'engine_role_distribution',       COALESCE(v_engine_role_dist, '{}'::jsonb),
    'slot_count_total',               COALESCE(v_slot_total, 0),
    'slot_count_active',              COALESCE(v_slot_active, 0),
    'slot_count_by_phase',            COALESCE(v_slot_by_phase, '{}'::jsonb),
    'slot_count_by_selection_mode',   COALESCE(v_slot_by_mode, '{}'::jsonb),
    'round_count_30d',                COALESCE(v_round_count_30d, 0),
    'composition_count',              COALESCE(v_composition_count, 0),
    'composition_group_count',        COALESCE(v_composition_group_count, 0),
    'raw_observation_count',          COALESCE(v_raw_observation_count, 0),
    'object_registry_size',           COALESCE(v_object_registry_size, 0),
    'attribute_value_count',          COALESCE(v_attribute_value_count, 0),
    'slot_suggestion_pending_count',  COALESCE(v_slot_suggestion_pending_count, 0),
    'room_type_distribution',         COALESCE(v_room_type_dist, '[]'::jsonb),
    'space_type_distribution',        COALESCE(v_space_type_dist, '[]'::jsonb),
    'zone_focus_distribution',        COALESCE(v_zone_focus_dist, '[]'::jsonb),
    'image_type_distribution',        COALESCE(v_image_type_dist, '[]'::jsonb),
    'field_population_health',        COALESCE(v_field_population_health, '{}'::jsonb),
    'slot_coverage_matrix',           COALESCE(v_slot_coverage, '[]'::jsonb),
    'coverage_aggregate_stats',       COALESCE(v_aggregate_stats, '{}'::jsonb),
    'heuristic_slot_suggestions',     COALESCE(v_heuristic_suggestions, '[]'::jsonb),
    'window_days',                    p_days,
    'computed_at',                    now()
  );
END $$;

COMMENT ON FUNCTION public.shortlisting_architecture_kpis(int) IS
  'W11.6.23 + W8 (F-FE-Architecture) — single-roundtrip aggregation for the '
  'Architecture & Data Explorer tab. Returns layer counts (project → products '
  '→ engine_roles → slots → compositions → object_registry), distributions '
  'across classification fields with __null_field_never_populated__ + '
  '__empty_string__ sentinels (W8 fix: previously folded into a single '
  '"unset" bucket that hid the W11.6.13 NULL-on-100% regression), the '
  'slot-coverage matrix for the last N days of rounds, heuristic slot-shape '
  'suggestions, and the new field_population_health rollup. Defensive '
  'fallbacks for any underlying table/column that may not exist yet.';

GRANT EXECUTE ON FUNCTION public.shortlisting_architecture_kpis(int) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
