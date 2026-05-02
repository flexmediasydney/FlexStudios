-- ============================================================================
-- Migration 441 — Taxonomy Explorer source attribution per observation
-- ============================================================================
-- Joseph spotted that the Hierarchy A / Hierarchy B detail panels (mig 439)
-- showed "recent observations" as opaque rows — you couldn't tell which row
-- came from which project or which Pulse listing. This migration extends the
-- two RPCs that emit observation arrays with full source attribution + adds
-- a small filter-discovery RPC the frontend uses to render a per-source
-- chip strip.
--
-- Joins added:
--   composition_classifications c
--     LEFT JOIN composition_groups   cg ON cg.id = c.group_id
--     LEFT JOIN projects             p  ON p.id  = c.project_id
--     LEFT JOIN pulse_listings       pl ON pl.id = c.pulse_listing_id
--
-- All FKs already exist (group_id added in mig 432; project_id since 020;
-- pulse_listing_id since mig 400). The LEFT JOINs are required because
-- internal_raw rows have no pulse_listing_id and external_listing rows
-- have a project_id that references a synthetic "pulse_external" project
-- only when one was created (typically NULL).
--
-- Source-type vocabulary:
--   The composition_classifications.source_type CHECK constraint allows four
--   values: internal_raw / internal_finals / external_listing / floorplan_image.
--   Joseph asked for "pulse_listing" as a 5th conceptual bucket — we expose
--   it in the RPC return shape as the resolved attribution_source: rows where
--   source_type='external_listing' AND pulse_listing_id IS NOT NULL surface
--   as "pulse_listing"; rows where source_type='external_listing' AND
--   pulse_listing_id IS NULL stay as "external_listing". This is a derived
--   field, not a column rewrite — the underlying check constraint is
--   unchanged.
--
-- Observation cap:
--   50 rows max inside the RPC (frontend default-shows 25 with a "Load more"
--   affordance left for a follow-up). Cap is in-RPC for predictable EXPLAIN
--   plans on hot taxonomy nodes.
--
-- All three RPCs SECURITY DEFINER + role-gated to admin/manager/master_admin,
-- consistent with mig 439.
-- ============================================================================

-- ─── 1. taxonomy_a_node_detail(canonical_id) — extended ──────────────────────
-- Same shape as mig 439 plus richer observations[]. Each observation now
-- carries project_name + project_url + pulse_listing_url + image_filename +
-- image_dropbox_path + source_type + image_type. The frontend renders a
-- clickable Source badge + a clickable project / pulse-listing link per row.

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

  SELECT COUNT(*)::int
    INTO v_obs_count
    FROM public.composition_classifications
   WHERE observed_objects @> jsonb_build_array(
           jsonb_build_object('proposed_canonical_id', p_canonical_id)
         );

  -- Build the observation array with full source attribution.
  -- Cap at 50 rows for predictable EXPLAIN plans on hot nodes.
  SELECT jsonb_agg(row_to_jsonb(c) ORDER BY (c.classified_at) DESC NULLS LAST)
    INTO v_observations
    FROM (
      SELECT
        cc.id           AS composition_classification_id,
        cc.group_id     AS group_id,
        cc.round_id     AS round_id,
        cc.project_id   AS project_id,
        p.title         AS project_name,
        CASE WHEN cc.project_id IS NOT NULL
             THEN '/ProjectDetails?id=' || cc.project_id::text
             ELSE NULL
        END             AS project_url,
        COALESCE(
          cg.delivery_reference_stem,
          cg.best_bracket_stem,
          cc.source_image_url
        )               AS image_filename,
        cg.dropbox_preview_path  AS image_dropbox_path,
        cc.source_type           AS source_type,
        -- Joseph's 5-bucket taxonomy: derive a UI-side bucket so the chip
        -- strip can split external_listing into pulse vs other-external.
        CASE
          WHEN cc.source_type = 'external_listing' AND cc.pulse_listing_id IS NOT NULL
            THEN 'pulse_listing'
          ELSE cc.source_type
        END                      AS attribution_source,
        cc.image_type            AS image_type,
        cc.pulse_listing_id      AS pulse_listing_id,
        CASE WHEN cc.pulse_listing_id IS NOT NULL
             THEN '/PulseListingDetail?id=' || cc.pulse_listing_id::text
             ELSE NULL
        END                      AS pulse_listing_url,
        pl.address               AS pulse_listing_address,
        cc.classified_at         AS classified_at
      FROM public.composition_classifications cc
      LEFT JOIN public.composition_groups cg ON cg.id = cc.group_id
      LEFT JOIN public.projects           p  ON p.id  = cc.project_id
      LEFT JOIN public.pulse_listings     pl ON pl.id = cc.pulse_listing_id
      WHERE cc.observed_objects @> jsonb_build_array(
              jsonb_build_object('proposed_canonical_id', p_canonical_id)
            )
      ORDER BY cc.classified_at DESC NULLS LAST
      LIMIT 50
    ) c;

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

COMMENT ON FUNCTION public.taxonomy_a_node_detail(text) IS
  'Settings/Shortlisting/TaxonomyExplorer — one object_registry node + '
  'observations (with source attribution: project_name, project_url, '
  'pulse_listing_url, image_filename, attribution_source) + slot links. '
  'Mig 441 extends mig 439 with the LEFT JOINs to composition_groups / '
  'projects / pulse_listings. Cap 50 rows.';

-- ─── 2. taxonomy_b_value_detail(axis, value) — extended ──────────────────────
-- Same attribution shape as #1. samples[] now carries every field a frontend
-- needs to render a clickable Source / Project / Pulse-listing column trio.

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

  v_eligible_column := CASE p_axis
    WHEN 'image_type'       THEN 'eligible_image_types'
    WHEN 'room_type'        THEN 'eligible_room_types'
    WHEN 'space_type'       THEN 'eligible_space_types'
    WHEN 'zone_focus'       THEN 'eligible_zone_focuses'
    WHEN 'composition_type' THEN 'eligible_composition_types'
  END;

  EXECUTE format(
    'SELECT COUNT(*) FROM public.composition_classifications WHERE %I = $1',
    p_axis
  ) INTO v_count USING p_value;

  -- Sample rows with full source attribution. Cap 50.
  EXECUTE format(
    $sql$
    SELECT jsonb_agg(row_to_jsonb(c) ORDER BY (c.classified_at) DESC NULLS LAST)
      FROM (
        SELECT
          cc.id           AS composition_classification_id,
          cc.group_id     AS group_id,
          cc.round_id     AS round_id,
          cc.project_id   AS project_id,
          p.title         AS project_name,
          CASE WHEN cc.project_id IS NOT NULL
               THEN '/ProjectDetails?id=' || cc.project_id::text
               ELSE NULL
          END             AS project_url,
          COALESCE(
            cg.delivery_reference_stem,
            cg.best_bracket_stem,
            cc.source_image_url
          )               AS image_filename,
          cg.dropbox_preview_path  AS image_dropbox_path,
          cc.source_type           AS source_type,
          CASE
            WHEN cc.source_type = 'external_listing' AND cc.pulse_listing_id IS NOT NULL
              THEN 'pulse_listing'
            ELSE cc.source_type
          END                      AS attribution_source,
          cc.image_type            AS image_type,
          cc.room_type             AS row_room_type,
          cc.space_type            AS row_space_type,
          cc.zone_focus            AS row_zone_focus,
          cc.composition_type      AS row_composition_type,
          cc.pulse_listing_id      AS pulse_listing_id,
          CASE WHEN cc.pulse_listing_id IS NOT NULL
               THEN '/PulseListingDetail?id=' || cc.pulse_listing_id::text
               ELSE NULL
          END                      AS pulse_listing_url,
          pl.address               AS pulse_listing_address,
          cc.classified_at         AS classified_at
        FROM public.composition_classifications cc
        LEFT JOIN public.composition_groups cg ON cg.id = cc.group_id
        LEFT JOIN public.projects           p  ON p.id  = cc.project_id
        LEFT JOIN public.pulse_listings     pl ON pl.id = cc.pulse_listing_id
        WHERE cc.%I = $1
        ORDER BY cc.classified_at DESC NULLS LAST
        LIMIT 50
      ) c
    $sql$,
    p_axis
  ) INTO v_samples USING p_value;

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

COMMENT ON FUNCTION public.taxonomy_b_value_detail(text, text) IS
  'Settings/Shortlisting/TaxonomyExplorer — value detail + slot eligibility '
  'for a B-axis value. Mig 441 extends samples[] with full source attribution '
  '(project_name, project_url, pulse_listing_url, image_filename, '
  'attribution_source). Cap 50 rows.';

-- ─── 3. taxonomy_observation_filters() — new ─────────────────────────────────
-- Returns the available source attribution buckets and per-bucket totals.
-- The frontend uses this to pre-render a chip strip with counts before any
-- node is selected (e.g. operator can see globally "we have 47 raws and
-- 1247 pulse rows" before drilling in). Numbers are global, not filtered
-- to the selected node — that gives operators a sense of the dataset shape.

CREATE OR REPLACE FUNCTION public.taxonomy_observation_filters()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text;
  v_buckets jsonb;
BEGIN
  v_role := get_user_role();
  IF v_role IS NULL OR v_role NOT IN ('master_admin','admin','manager') THEN
    RAISE EXCEPTION 'taxonomy_observation_filters: unauthorized (role=%)', COALESCE(v_role,'<null>');
  END IF;

  -- Resolve attribution_source bucket then group + count. The cross-pivot
  -- between source_type and pulse_listing_id determines the bucket name.
  SELECT jsonb_object_agg(bucket, n)
    INTO v_buckets
    FROM (
      SELECT bucket, COUNT(*)::bigint AS n
        FROM (
          SELECT
            CASE
              WHEN source_type = 'external_listing' AND pulse_listing_id IS NOT NULL
                THEN 'pulse_listing'
              WHEN source_type IS NULL
                THEN 'unknown'
              ELSE source_type
            END AS bucket
          FROM public.composition_classifications
        ) s
       GROUP BY bucket
    ) g;

  RETURN jsonb_build_object(
    'source_types', jsonb_build_array(
      'internal_raw',
      'internal_finals',
      'external_listing',
      'pulse_listing',
      'floorplan_image'
    ),
    'n_per_source_total', COALESCE(v_buckets, '{}'::jsonb),
    'generated_at', now()
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.taxonomy_observation_filters() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.taxonomy_observation_filters() TO authenticated;

COMMENT ON FUNCTION public.taxonomy_observation_filters() IS
  'Settings/Shortlisting/TaxonomyExplorer — discoverability RPC. Returns '
  'the 5 attribution_source buckets the UI renders as chips '
  '(internal_raw / internal_finals / external_listing / pulse_listing / '
  'floorplan_image) plus global per-bucket counts. Mig 441.';
