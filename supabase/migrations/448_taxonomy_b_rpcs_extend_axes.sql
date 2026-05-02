-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 448 — extend taxonomy_b_* RPCs to cover C1's 3 new axes
-- (shot_scale, perspective_compression, orientation).
--
-- Background:
--   Mig 442 (C1) added three orthogonal axes to composition_classifications.
--   Mig 439's RPCs (taxonomy_b_axis_distribution, taxonomy_b_value_detail) hard-
--   coded the allow-list to the original 5 axes (image_type/room_type/
--   space_type/zone_focus/composition_type). Calling those RPCs with a new
--   axis raised "invalid axis %".
--
-- This migration:
--   1. Extends the allow-list in BOTH RPCs to include the 3 new axes.
--   2. Returns an empty eligible_slots[] for the new axes — they have no
--      `eligible_*` column on shortlisting_slot_definitions yet, and may never
--      get one. The CASE expression below leaves v_eligible_column NULL for
--      those axes; the slot lookup is then short-circuited.
--
-- Idempotent: CREATE OR REPLACE on both functions, no schema changes.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ─── 1. taxonomy_b_axis_distribution ─────────────────────────────────────────
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

  IF p_axis NOT IN (
    'image_type','room_type','space_type','zone_focus','composition_type',
    'shot_scale','perspective_compression','orientation'
  ) THEN
    RAISE EXCEPTION 'taxonomy_b_axis_distribution: invalid axis %', p_axis;
  END IF;

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

COMMENT ON FUNCTION public.taxonomy_b_axis_distribution(text) IS
  'Settings/Shortlisting/TaxonomyExplorer — distribution of one '
  'composition_classifications axis. Mig 448 extends the allow-list to '
  'cover shot_scale / perspective_compression / orientation (C1 / mig 442).';

-- ─── 2. taxonomy_b_value_detail ──────────────────────────────────────────────
-- Source-attribution shape from mig 441 preserved.
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

  IF p_axis NOT IN (
    'image_type','room_type','space_type','zone_focus','composition_type',
    'shot_scale','perspective_compression','orientation'
  ) THEN
    RAISE EXCEPTION 'taxonomy_b_value_detail: invalid axis %', p_axis;
  END IF;

  -- Map axis → eligibility column on shortlisting_slot_definitions.
  -- The 3 new axes (shot_scale / perspective_compression / orientation) have
  -- no slot-eligibility column yet — leave v_eligible_column NULL and the
  -- slot lookup below short-circuits to an empty array.
  v_eligible_column := CASE p_axis
    WHEN 'image_type'       THEN 'eligible_image_types'
    WHEN 'room_type'        THEN 'eligible_room_types'
    WHEN 'space_type'       THEN 'eligible_space_types'
    WHEN 'zone_focus'       THEN 'eligible_zone_focuses'
    WHEN 'composition_type' THEN 'eligible_composition_types'
    ELSE NULL
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

  IF v_eligible_column IS NULL THEN
    v_eligible_slots := '[]'::jsonb;
  ELSE
    EXECUTE format(
      'SELECT jsonb_agg(DISTINCT slot_id ORDER BY slot_id)
         FROM public.shortlisting_slot_definitions
        WHERE is_active = true
          AND %I @> ARRAY[$1]::text[]',
      v_eligible_column
    ) INTO v_eligible_slots USING p_value;
  END IF;

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
  'for a B-axis value. Mig 441 extends samples[] with full source attribution. '
  'Mig 448 extends the allow-list to cover shot_scale / perspective_compression '
  '/ orientation (C1 / mig 442) and returns an empty eligible_slots[] for those '
  'axes (no slot-eligibility column).';

COMMIT;
