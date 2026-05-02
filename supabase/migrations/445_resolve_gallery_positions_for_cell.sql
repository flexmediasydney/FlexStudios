-- ============================================================================
-- Migration 445 — resolve_gallery_positions_for_cell RPC
-- ----------------------------------------------------------------------------
-- Authoring helper used by the W11.6.28 Recipe Matrix UI to render one cell
-- with the merged position list + inheritance breadcrumb metadata.
--
-- This is the SQL companion to R2's in-memory `resolveGalleryPositions.ts`
-- resolver — the UI calls it directly so we don't need a service-role
-- edge function for read-only authoring.
--
-- Inputs:
--   p_package_id       uuid  — the cell's package (NULL for tier-defaults row)
--   p_price_tier_id    uuid  — the cell's price tier / grade id
--   p_project_type_id  uuid  — narrowing scope (NULL = inherit broader)
--   p_product_id       uuid  — narrowing scope (NULL = inherit broader)
--
-- Output: a JSONB object {
--   positions:   array of merged position rows (the same column set as
--                gallery_positions, plus is_overridden_at_cell + an
--                inherited_from_scope tag)
--   scopeChain:  array of { label, scope, override_count } describing the
--                inheritance path for the breadcrumb.
-- }
--
-- Scope chain (broadest → narrowest, mirrors mig 443 doc):
--   project_type
--     → package_grade
--     → package_x_price_tier
--     → product
--     → product_x_price_tier
--     → package_x_price_tier_x_project_type
--
-- For the operator-facing matrix the cell scope is `package_grade`
-- (one row per package × engine grade) and the "tier defaults" pseudo-
-- row above the matrix is `price_tier` — neither of which is in the
-- canonical merge order yet because the resolver agent (R2) owns the
-- final lookup logic. The breadcrumb here surfaces what's queryable.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.resolve_gallery_positions_for_cell(
  p_package_id uuid,
  p_price_tier_id uuid,
  p_project_type_id uuid DEFAULT NULL,
  p_product_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text;
  v_table_exists boolean;
  v_positions jsonb := '[]'::jsonb;
  v_scope_chain jsonb := '[]'::jsonb;
  v_count_project int := 0;
  v_count_pkg_grade int := 0;
  v_count_price_tier int := 0;
  v_count_cell int := 0;
BEGIN
  -- Authorisation: master_admin / admin / manager (config table read).
  v_role := get_user_role();
  IF v_role IS NULL OR v_role NOT IN ('master_admin','admin','manager') THEN
    RAISE EXCEPTION 'resolve_gallery_positions_for_cell: unauthorized (role=%)', COALESCE(v_role,'<null>');
  END IF;

  -- Defensive: gallery_positions may not exist (pre-mig 443).
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'gallery_positions'
  ) INTO v_table_exists;

  IF NOT v_table_exists THEN
    RETURN jsonb_build_object(
      'positions', '[]'::jsonb,
      'scopeChain', jsonb_build_array(
        jsonb_build_object(
          'label', 'Schema not ready',
          'scope', 'missing_table',
          'override_count', 0
        )
      )
    );
  END IF;

  -- Per-scope counts for the breadcrumb chips.
  IF p_project_type_id IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count_project
      FROM gallery_positions
     WHERE scope_type = 'project_type'
       AND scope_ref_id = p_project_type_id;
  END IF;

  IF p_package_id IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count_pkg_grade
      FROM gallery_positions
     WHERE scope_type = 'package_grade'
       AND scope_ref_id = p_package_id
       AND scope_ref_id_2 = p_price_tier_id;
  END IF;

  SELECT COUNT(*) INTO v_count_price_tier
    FROM gallery_positions
   WHERE scope_type = 'price_tier'
     AND scope_ref_id = p_price_tier_id
     AND scope_ref_id_2 IS NULL;

  -- For the matrix we surface 'cell' === 'package_grade' for sanity.
  v_count_cell := COALESCE(v_count_pkg_grade, 0);

  -- Resolved position list = merge of (project_type, price_tier
  -- defaults, package_grade) where narrower scopes override broader by
  -- (engine_role, position_index). The full mig 443 chain has more
  -- levels — the resolver agent owns the canonical version. Here we
  -- merge the slices the matrix UI cares about so the cell editor can
  -- render the operator's effective list.
  WITH
  project_scope AS (
    SELECT *, 0 AS scope_rank, 'project_type'::text AS scope_label
      FROM gallery_positions
     WHERE p_project_type_id IS NOT NULL
       AND scope_type = 'project_type'
       AND scope_ref_id = p_project_type_id
  ),
  tier_defaults AS (
    SELECT *, 1 AS scope_rank, 'price_tier'::text AS scope_label
      FROM gallery_positions
     WHERE scope_type = 'price_tier'
       AND scope_ref_id = p_price_tier_id
       AND scope_ref_id_2 IS NULL
  ),
  cell_rows AS (
    SELECT *, 2 AS scope_rank, 'package_grade'::text AS scope_label
      FROM gallery_positions
     WHERE p_package_id IS NOT NULL
       AND scope_type = 'package_grade'
       AND scope_ref_id = p_package_id
       AND scope_ref_id_2 = p_price_tier_id
  ),
  unioned AS (
    SELECT * FROM project_scope
    UNION ALL
    SELECT * FROM tier_defaults
    UNION ALL
    SELECT * FROM cell_rows
  ),
  winners AS (
    SELECT DISTINCT ON (engine_role, position_index)
           *,
           (scope_rank = 2) AS is_overridden_at_cell
      FROM unioned
      ORDER BY engine_role, position_index, scope_rank DESC
  )
  SELECT COALESCE(jsonb_agg(
           to_jsonb(w) - 'scope_rank' || jsonb_build_object(
             'is_overridden_at_cell', w.is_overridden_at_cell,
             'inherited_from_scope', w.scope_label
           )
           ORDER BY w.engine_role, w.position_index
         ), '[]'::jsonb)
    INTO v_positions
    FROM winners w;

  -- Breadcrumb chain (top is broadest, last is narrowest).
  v_scope_chain := jsonb_build_array(
    jsonb_build_object(
      'label', 'Project type',
      'scope', 'project_type',
      'override_count', v_count_project
    ),
    jsonb_build_object(
      'label', 'Tier defaults',
      'scope', 'price_tier',
      'override_count', v_count_price_tier
    ),
    jsonb_build_object(
      'label', 'This cell',
      'scope', 'package_grade',
      'override_count', v_count_cell
    )
  );

  RETURN jsonb_build_object(
    'positions', v_positions,
    'scopeChain', v_scope_chain
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.resolve_gallery_positions_for_cell(uuid, uuid, uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.resolve_gallery_positions_for_cell(uuid, uuid, uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.resolve_gallery_positions_for_cell(uuid, uuid, uuid, uuid) IS
  'W11.6.28 Recipe Matrix UI helper. Returns the merged gallery_positions list for one (package × grade × project_type × product) cell plus the inheritance scope chain metadata. Companion read-side helper to R2''s resolveGalleryPositions.ts; calls into the same scope_type vocabulary. Defensive: returns an empty result if gallery_positions has not been created yet.';
