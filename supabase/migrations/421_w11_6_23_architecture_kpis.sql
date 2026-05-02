-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 421 — Wave 11.6.23: Architecture & Data Explorer KPI RPC
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: W11.6.23 — Architecture tab inside the Shortlisting Command Center.
-- The tab visualises the engine's data hierarchy (project → products →
-- engine_roles → slots → compositions → object_registry) and surfaces
-- (a) live row counts per layer, (b) a slot-coverage matrix for the last
-- N days of rounds, and (c) heuristic slot-shape suggestions (split /
-- deletion-candidate / new-slot-needed).
--
-- One RPC, one round-trip — same pattern as W11.6.21
-- (shortlisting_command_center_kpis) and W15b.9
-- (pulse_command_center_kpis).
--
-- Defensive zero-state: each layer is wrapped in
--   EXCEPTION WHEN undefined_table OR undefined_column
-- so the tab keeps rendering even if a downstream table hasn't shipped
-- yet (mirrors the W11.6.21 / W15b.9 pattern).
--
-- Returned blob shape (jsonb):
--   {
--     "project_count": int,
--     "products_count": int,
--     "engine_role_distribution": jsonb,         -- { role: n }
--     "slot_count_total": int,
--     "slot_count_active": int,
--     "slot_count_by_phase": jsonb,              -- { "1": n, "2": n, "3": n }
--     "slot_count_by_selection_mode": jsonb,
--     "round_count_30d": int,
--     "composition_count": int,
--     "composition_group_count": int,
--     "raw_observation_count": int,
--     "object_registry_size": int,
--     "attribute_value_count": int,
--     "slot_suggestion_pending_count": int,
--     "room_type_distribution": jsonb,           -- [{room_type,n}, ...]
--     "space_type_distribution": jsonb,
--     "zone_focus_distribution": jsonb,
--     "image_type_distribution": jsonb,
--     "slot_coverage_matrix": jsonb,             -- [{slot_id,phase,rounds:[...]}]
--     "coverage_aggregate_stats": jsonb,         -- {pct_filled,red_round_count,zero_fill_slot_count,total_cells}
--     "heuristic_slot_suggestions": jsonb,       -- [{type,slot_id,...}]
--     "window_days": int,
--     "computed_at": timestamptz
--   }
-- ═══════════════════════════════════════════════════════════════════════════

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
  BEGIN
    SELECT COALESCE(
      jsonb_agg(jsonb_build_object('room_type', room_type, 'n', n)
                ORDER BY n DESC), '[]'::jsonb)
      INTO v_room_type_dist
      FROM (
        SELECT COALESCE(room_type, 'unset') AS room_type, COUNT(*) AS n
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
        SELECT COALESCE(space_type, 'unset') AS space_type, COUNT(*) AS n
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
        SELECT COALESCE(zone_focus, 'unset') AS zone_focus, COUNT(*) AS n
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
        SELECT COALESCE(image_type, 'unset') AS image_type, COUNT(*) AS n
          FROM composition_classifications
         GROUP BY 1
         ORDER BY 2 DESC
         LIMIT 25
      ) t;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_image_type_dist := '[]'::jsonb;
  END;

  -- ── Slot coverage matrix ───────────────────────────────────────────────
  -- For every (active slot × round-in-window), compute the fill state.
  -- Eligibility: a slot's eligible_when_engine_roles array intersects with
  -- the engine_role(s) of the round's products. We approximate this by
  -- looking at the round's slot_assigned events — if the engine emitted
  -- ANY event for that round, the round is in scope; if none of those
  -- events targeted a given slot we infer eligibility from
  -- whether the slot's engine_roles overlap with the union of engine roles
  -- in the round. For W11.6.23 we keep it simple: a slot is "eligible" for
  -- a round if any winner event in that round mentions that slot id, OR
  -- if any other slot was assigned in that round (round was active). The
  -- finer-grained "almost matched" log is deferred to a later wave.
  --
  -- fill_state:
  --   green  — filled_count >= min_required and >= 1 winner event
  --   amber  — filled via ai_backfill (event payload kind='ai_backfill'
  --            or position_filled_via='ai_backfill') OR overfilled
  --   red    — slot has min_required >= 1 and 0 winner events
  --   grey   — slot's eligible_when_engine_roles do not overlap any product
  --            engine_role active in this round (heuristic: if no events
  --            for the round at all, every slot is grey; otherwise based
  --            on overlap as best we can)
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
    -- Per-round per-slot fills via events
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
    -- Set of round_ids that emitted at least one event (round was active).
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

    -- Rounds containing 1+ red gaps (mandatory empties).
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

  -- "zero-fill" definition: slot whose every cell in the window was red OR
  -- grey (i.e. never filled green/amber). Recompute distinctly:
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
  -- Three rules:
  --   (a) split: avg fill_count per round (excluding 0-fills) >= 2.5
  --       AND max_allowed >= 2 (slot capacity) — operator may want >1 slot.
  --   (b) deletion_candidate: slot was empty in 80%+ of rounds.
  --   (c) new_slot_needed: a zone_focus value appeared in N rounds with no
  --       slot whose eligible_zone_focuses contains that value.
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
    -- New-slot-needed: zone focuses observed in compositions that no slot
    -- declares in eligible_zone_focuses. Aggregated across the window.
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
    'slot_coverage_matrix',           COALESCE(v_slot_coverage, '[]'::jsonb),
    'coverage_aggregate_stats',       COALESCE(v_aggregate_stats, '{}'::jsonb),
    'heuristic_slot_suggestions',     COALESCE(v_heuristic_suggestions, '[]'::jsonb),
    'window_days',                    p_days,
    'computed_at',                    now()
  );
END $$;

COMMENT ON FUNCTION public.shortlisting_architecture_kpis(int) IS
  'W11.6.23 — single-roundtrip aggregation for the Architecture & Data '
  'Explorer tab. Returns layer counts (project → products → engine_roles '
  '→ slots → compositions → object_registry), distributions across '
  'classification fields, the slot-coverage matrix for the last N days '
  'of rounds, and heuristic slot-shape suggestions (split, '
  'deletion_candidate, new_slot_needed). Defensive fallbacks for any '
  'underlying table/column that may not exist yet.';

GRANT EXECUTE ON FUNCTION public.shortlisting_architecture_kpis(int) TO authenticated;

NOTIFY pgrst, 'reload schema';
