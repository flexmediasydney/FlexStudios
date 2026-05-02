-- ─────────────────────────────────────────────────────────────────────────
-- Mig 447 — resolve_gallery_positions_for_cell v2 (price_tier axis)
-- ─────────────────────────────────────────────────────────────────────────
--
-- Date: 2026-05-02
-- Wave: post-Mig 446 / Mig 447
-- Author: Joseph Saad (designed) / Stage-3 agent (executed)
--
-- ─── CONTEXT ─────────────────────────────────────────────────────────────
--
-- Mig 445 shipped resolve_gallery_positions_for_cell with a `p_price_tier_id`
-- arg name but a body that read `scope_type='package_grade'` rows. Joseph
-- reset the matrix axis to PRICE TIER (Standard / Premium) in W11.6.28b,
-- so the resolver must read from `scope_type='package_x_price_tier'` rows
-- (per the mig 443 vocabulary).
--
-- The function signature stays the same — only the body changes — so
-- existing callers (the Recipe Matrix UI) keep working.
--
-- Engine grade is NOT part of the matrix any more; it's a per-round
-- derived value. The breadcrumb labels are also re-worded to reflect that.
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────
--
--   Re-run Mig 445 to restore the previous body.
--
-- ─────────────────────────────────────────────────────────────────────────

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
  v_count_pkg_x_price int := 0;
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
    SELECT COUNT(*) INTO v_count_pkg_x_price
      FROM gallery_positions
     WHERE scope_type = 'package_x_price_tier'
       AND scope_ref_id = p_package_id
       AND scope_ref_id_2 = p_price_tier_id;
  END IF;

  SELECT COUNT(*) INTO v_count_price_tier
    FROM gallery_positions
   WHERE scope_type = 'price_tier'
     AND scope_ref_id = p_price_tier_id
     AND scope_ref_id_2 IS NULL;

  v_count_cell := COALESCE(v_count_pkg_x_price, 0);

  -- Resolved position list = merge of (project_type, price_tier defaults,
  -- package_x_price_tier) where narrower scopes override broader by
  -- (engine_role, position_index). The full mig 443 chain has more
  -- levels — the resolver agent owns the canonical version. Here we
  -- merge the slices the matrix UI cares about.
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
    SELECT *, 2 AS scope_rank, 'package_x_price_tier'::text AS scope_label
      FROM gallery_positions
     WHERE p_package_id IS NOT NULL
       AND scope_type = 'package_x_price_tier'
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

  -- Breadcrumb chain (top is broadest, last is narrowest). Note we don't
  -- mention engine grade — it's not a recipe axis any more.
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
      'scope', 'package_x_price_tier',
      'override_count', v_count_cell
    )
  );

  RETURN jsonb_build_object(
    'positions', v_positions,
    'scopeChain', v_scope_chain
  );
END;
$$;

COMMENT ON FUNCTION public.resolve_gallery_positions_for_cell(uuid, uuid, uuid, uuid) IS
  'W11.6.28b Recipe Matrix UI helper. Returns the merged gallery_positions list for one (package × price tier × project_type × product) cell plus the inheritance scope chain metadata. Updated in Mig 447 to read scope_type=''package_x_price_tier'' rows (price_tier axis) instead of ''package_grade'' (engine grade was the wrong column axis).';

NOTIFY pgrst, 'reload schema';
