-- ============================================================================
-- Migration 439 — Taxonomy Explorer RPCs
-- ============================================================================
-- Power the Settings → Shortlisting Command Center → Taxonomy Explorer subtab.
--
-- Joseph asked for an interactive visual surface that exposes both vocabularies
-- the engine relies on: object_registry's 5-level hierarchy and the orthogonal
-- axes on composition_classifications. Long jsonb scans + count aggregations
-- are slow client-side, so this migration centralises the heavy lifting in
-- four read-only RPCs (SECURITY DEFINER + role-gated to admin/manager).
--
--   1. taxonomy_a_tree()                   — full object_registry hierarchy
--   2. taxonomy_a_node_detail(canonical_id) — one node + recent observations
--   3. taxonomy_b_axis_distribution(axis)  — distribution of one B-axis
--   4. taxonomy_b_value_detail(axis,value) — value detail + slot eligibility
--
-- All return TEXT/JSONB scalars — no closed enums in return types (codebase
-- discipline; consistent with the v2.4 schema drop).
-- ============================================================================

-- ─── Helper: assert caller is admin-equivalent ────────────────────────────────
-- Inlined into each RPC so the role-gate runs under SECURITY DEFINER context.
-- (We use get_user_role() which already runs SECURITY DEFINER over public.users.)

-- ─── 1. taxonomy_a_tree() ─────────────────────────────────────────────────────
-- Returns the full object_registry hierarchy as nested JSON.
-- Nodes carry: count of distinct canonical_ids underneath + sum of
-- market_frequency. Empty levels are pruned client-side; the RPC returns
-- every active row keyed by its full level path.

CREATE OR REPLACE FUNCTION public.taxonomy_a_tree()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text;
  v_rows jsonb;
BEGIN
  v_role := get_user_role();
  IF v_role IS NULL OR v_role NOT IN ('master_admin','admin','manager') THEN
    RAISE EXCEPTION 'taxonomy_a_tree: unauthorized (role=%)', COALESCE(v_role,'<null>');
  END IF;

  -- Flat array of all active rows; the React component buckets these into
  -- the 5-level hierarchy. Returning a flat list (not a recursive CTE tree)
  -- keeps the payload predictable and lets the UI sort/filter freely.
  SELECT jsonb_agg(
           jsonb_build_object(
             'canonical_id',        canonical_id,
             'display_name',        display_name,
             'description',         description,
             'level_0_class',       level_0_class,
             'level_1_functional',  level_1_functional,
             'level_2_material',    level_2_material,
             'level_3_specific',    level_3_specific,
             'level_4_detail',      level_4_detail,
             'aliases',             aliases,
             'market_frequency',    COALESCE(market_frequency, 0),
             'signal_room_type',    signal_room_type,
             'signal_confidence',   signal_confidence,
             'status',              status,
             'last_observed_at',    last_observed_at
           )
           ORDER BY level_0_class NULLS LAST,
                    level_1_functional NULLS LAST,
                    level_2_material NULLS LAST,
                    level_3_specific NULLS LAST,
                    level_4_detail NULLS LAST,
                    canonical_id
         )
    INTO v_rows
    FROM public.object_registry
   WHERE is_active = true;

  RETURN jsonb_build_object(
    'total_rows',  COALESCE(jsonb_array_length(v_rows), 0),
    'generated_at', now(),
    'nodes',        COALESCE(v_rows, '[]'::jsonb)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.taxonomy_a_tree() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.taxonomy_a_tree() TO authenticated;

-- ─── 2. taxonomy_a_node_detail(canonical_id) ──────────────────────────────────
-- Returns the full row for one canonical_id, plus up to 25 recent
-- composition_classifications that referenced it via observed_objects, plus
-- the list of slot_ids whose eligible_room_types/space_types/etc. would
-- match a classification carrying this object's signal_room_type.

CREATE OR REPLACE FUNCTION public.taxonomy_a_node_detail(p_canonical_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text;
  v_node jsonb;
  v_obs_count int;
  v_observations jsonb;
  v_eligible_slots jsonb;
BEGIN
  v_role := get_user_role();
  IF v_role IS NULL OR v_role NOT IN ('master_admin','admin','manager') THEN
    RAISE EXCEPTION 'taxonomy_a_node_detail: unauthorized (role=%)', COALESCE(v_role,'<null>');
  END IF;

  -- Full row payload
  SELECT jsonb_build_object(
           'canonical_id',        canonical_id,
           'display_name',        display_name,
           'description',         description,
           'level_0_class',       level_0_class,
           'level_1_functional',  level_1_functional,
           'level_2_material',    level_2_material,
           'level_3_specific',    level_3_specific,
           'level_4_detail',      level_4_detail,
           'parent_canonical_id', parent_canonical_id,
           'aliases',             aliases,
           'market_frequency',    COALESCE(market_frequency, 0),
           'signal_room_type',    signal_room_type,
           'signal_confidence',   signal_confidence,
           'status',              status,
           'auto_promoted',       auto_promoted,
           'first_observed_at',   first_observed_at,
           'last_observed_at',    last_observed_at,
           'created_at',          created_at,
           'updated_at',          updated_at
         )
    INTO v_node
    FROM public.object_registry
   WHERE canonical_id = p_canonical_id
     AND is_active = true;

  IF v_node IS NULL THEN
    RETURN jsonb_build_object('found', false, 'canonical_id', p_canonical_id);
  END IF;

  -- Recent classifications referencing this canonical_id via observed_objects.
  -- Index on observed_objects is GIN; the @> filter below is the standard
  -- shape Postgres knows how to optimise.
  SELECT COUNT(*)::int
    INTO v_obs_count
    FROM public.composition_classifications
   WHERE observed_objects @> jsonb_build_array(
           jsonb_build_object('proposed_canonical_id', p_canonical_id)
         );

  SELECT jsonb_agg(
           jsonb_build_object(
             'classification_id',  c.id,
             'group_id',           c.group_id,
             'project_id',         c.project_id,
             'classified_at',      c.classified_at,
             'room_type',          c.room_type,
             'space_type',         c.space_type,
             'zone_focus',         c.zone_focus,
             'image_type',         c.image_type,
             'source_image_url',   c.source_image_url
           )
           ORDER BY c.classified_at DESC
         )
    INTO v_observations
    FROM (
      SELECT id, group_id, project_id, classified_at, room_type, space_type,
             zone_focus, image_type, source_image_url
        FROM public.composition_classifications
       WHERE observed_objects @> jsonb_build_array(
               jsonb_build_object('proposed_canonical_id', p_canonical_id)
             )
       ORDER BY classified_at DESC NULLS LAST
       LIMIT 25
    ) c;

  -- Slots that match this object's signal_room_type — useful for understanding
  -- where this vocabulary surfaces inside the slot recipe.
  SELECT jsonb_agg(DISTINCT slot_id ORDER BY slot_id)
    INTO v_eligible_slots
    FROM public.shortlisting_slot_definitions
   WHERE is_active = true
     AND (
       (v_node->>'signal_room_type') IS NOT NULL
       AND eligible_room_types @> ARRAY[v_node->>'signal_room_type']::text[]
     );

  RETURN jsonb_build_object(
    'found',             true,
    'node',              v_node,
    'observation_count', v_obs_count,
    'observations',      COALESCE(v_observations, '[]'::jsonb),
    'eligible_slots',    COALESCE(v_eligible_slots, '[]'::jsonb)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.taxonomy_a_node_detail(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.taxonomy_a_node_detail(text) TO authenticated;

-- ─── 3. taxonomy_b_axis_distribution(axis) ────────────────────────────────────
-- Returns value distribution for one Hierarchy B axis. The axis param is
-- TEXT and validated inline (no closed enum).

CREATE OR REPLACE FUNCTION public.taxonomy_b_axis_distribution(p_axis text)
RETURNS TABLE (
  value text,
  n_compositions bigint,
  pct numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text;
  v_total bigint;
BEGIN
  v_role := get_user_role();
  IF v_role IS NULL OR v_role NOT IN ('master_admin','admin','manager') THEN
    RAISE EXCEPTION 'taxonomy_b_axis_distribution: unauthorized (role=%)', COALESCE(v_role,'<null>');
  END IF;

  IF p_axis NOT IN ('image_type','room_type','space_type','zone_focus','composition_type') THEN
    RAISE EXCEPTION 'taxonomy_b_axis_distribution: invalid axis %', p_axis;
  END IF;

  -- Total non-null rows for the axis (used for pct denominator)
  EXECUTE format(
    'SELECT COUNT(*) FROM public.composition_classifications WHERE %I IS NOT NULL',
    p_axis
  ) INTO v_total;

  IF v_total = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY EXECUTE format(
    'SELECT %I::text AS value,
            COUNT(*)::bigint AS n_compositions,
            ROUND((COUNT(*)::numeric / %s::numeric) * 100, 2) AS pct
       FROM public.composition_classifications
      WHERE %I IS NOT NULL
      GROUP BY %I
      ORDER BY COUNT(*) DESC, %I ASC',
    p_axis, v_total, p_axis, p_axis, p_axis
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.taxonomy_b_axis_distribution(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.taxonomy_b_axis_distribution(text) TO authenticated;

-- ─── 4. taxonomy_b_value_detail(axis, value) ──────────────────────────────────
-- Returns slot eligibility list + recent sample classifications for a given
-- axis/value pair.

CREATE OR REPLACE FUNCTION public.taxonomy_b_value_detail(
  p_axis text,
  p_value text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text;
  v_count bigint;
  v_samples jsonb;
  v_eligible_slots jsonb;
  v_eligible_column text;
BEGIN
  v_role := get_user_role();
  IF v_role IS NULL OR v_role NOT IN ('master_admin','admin','manager') THEN
    RAISE EXCEPTION 'taxonomy_b_value_detail: unauthorized (role=%)', COALESCE(v_role,'<null>');
  END IF;

  IF p_axis NOT IN ('image_type','room_type','space_type','zone_focus','composition_type') THEN
    RAISE EXCEPTION 'taxonomy_b_value_detail: invalid axis %', p_axis;
  END IF;

  -- Map axis → eligibility column name on shortlisting_slot_definitions
  v_eligible_column := CASE p_axis
    WHEN 'image_type'       THEN 'eligible_image_types'
    WHEN 'room_type'        THEN 'eligible_room_types'
    WHEN 'space_type'       THEN 'eligible_space_types'
    WHEN 'zone_focus'       THEN 'eligible_zone_focuses'
    WHEN 'composition_type' THEN 'eligible_composition_types'
  END;

  -- Total compositions with this value
  EXECUTE format(
    'SELECT COUNT(*) FROM public.composition_classifications WHERE %I = $1',
    p_axis
  ) INTO v_count USING p_value;

  -- Recent samples (up to 12)
  EXECUTE format(
    'SELECT jsonb_agg(
              jsonb_build_object(
                ''classification_id'', id,
                ''group_id'',          group_id,
                ''project_id'',        project_id,
                ''classified_at'',     classified_at,
                ''room_type'',         room_type,
                ''space_type'',        space_type,
                ''zone_focus'',        zone_focus,
                ''image_type'',        image_type,
                ''source_image_url'',  source_image_url
              )
              ORDER BY classified_at DESC NULLS LAST
            )
       FROM (
         SELECT id, group_id, project_id, classified_at, room_type,
                space_type, zone_focus, image_type, source_image_url
           FROM public.composition_classifications
          WHERE %I = $1
          ORDER BY classified_at DESC NULLS LAST
          LIMIT 12
       ) c',
    p_axis
  ) INTO v_samples USING p_value;

  -- Slots whose eligible_<axis> array contains this value
  EXECUTE format(
    'SELECT jsonb_agg(DISTINCT slot_id ORDER BY slot_id)
       FROM public.shortlisting_slot_definitions
      WHERE is_active = true
        AND %I @> ARRAY[$1]::text[]',
    v_eligible_column
  ) INTO v_eligible_slots USING p_value;

  RETURN jsonb_build_object(
    'axis',           p_axis,
    'value',          p_value,
    'n_compositions', COALESCE(v_count, 0),
    'samples',        COALESCE(v_samples, '[]'::jsonb),
    'eligible_slots', COALESCE(v_eligible_slots, '[]'::jsonb)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.taxonomy_b_value_detail(text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.taxonomy_b_value_detail(text, text) TO authenticated;

-- ─── Comment metadata ────────────────────────────────────────────────────────
COMMENT ON FUNCTION public.taxonomy_a_tree() IS
  'Settings/Shortlisting/TaxonomyExplorer — full object_registry hierarchy as JSON.';
COMMENT ON FUNCTION public.taxonomy_a_node_detail(text) IS
  'Settings/Shortlisting/TaxonomyExplorer — one object_registry node + observations + slot links.';
COMMENT ON FUNCTION public.taxonomy_b_axis_distribution(text) IS
  'Settings/Shortlisting/TaxonomyExplorer — distribution of one composition_classifications axis.';
COMMENT ON FUNCTION public.taxonomy_b_value_detail(text, text) IS
  'Settings/Shortlisting/TaxonomyExplorer — value detail + slot eligibility for a B-axis value.';
