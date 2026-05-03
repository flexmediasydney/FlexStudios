-- ─────────────────────────────────────────────────────────────────────────
-- Mig 449 — gallery_positions.engine_role + resolver RPC repair
-- ─────────────────────────────────────────────────────────────────────────
--
-- Date: 2026-05-02
-- Wave: post-W11.6.28b QC pass on Recipe Matrix
-- Author: Joseph Saad (designed) / Stage-3 agent (executed)
--
-- ─── CONTEXT ─────────────────────────────────────────────────────────────
--
-- Joseph reported on the Recipe Matrix shipped in commits b77f370 / aec2349
-- / 8f58268 / 7cc89a4: "I can't seem to be able to save anything, add
-- positions does nothing". QC turned up the root cause:
--
--   * Mig 443 created `gallery_positions` WITHOUT an engine_role column.
--   * The Recipe Matrix UI (CellEditorDialog.jsx) groups positions into
--     engine-role tabs — Sales Images / Drone Shots / Floor Plans / Dusk
--     Images / Video Frames — and writes `engine_role: role.key` on every
--     "Add blank position" / per-row save.
--   * Postgres rejects every insert with `column "engine_role" of relation
--     "gallery_positions" does not exist`. The error surfaces as a sonner
--     toast but the user reads it as "save / add does nothing".
--   * The `resolve_gallery_positions_for_cell` RPC (mig 445 / 447) also
--     references `engine_role` in its SELECT DISTINCT ON … ORDER BY clause,
--     so even read paths through the RPC fail with the same column-missing
--     error. (The hooks.js fallback to a direct SELECT does work because
--     the table-error regex matches, but the RPC path has been broken since
--     mig 445.)
--
-- Engine role is a load-bearing UX axis on the matrix — the operator
-- thinks in terms of "5 sales positions, 2 drone positions, 1 floor plan"
-- and the engine routes each round through a single engine_role.
-- Without the column the matrix can't differentiate roles and every
-- write fails.
--
-- ─── WHAT THIS MIGRATION DOES ────────────────────────────────────────────
--
-- TRACK A — Add the column:
--   * `engine_role text NOT NULL DEFAULT 'photo_day_shortlist'` with a
--     CHECK constraint pinned to the same five values the UI ships:
--       photo_day_shortlist (Sales Images)
--       drone_shortlist     (Drone Shots)
--       floor_plans         (Floor Plans)
--       dusk_shortlist      (Dusk Images)
--       video_shortlist     (Video Frames)
--   * The default is the most common role so the 5 seeded test rows
--     (and any pre-mig backfill) get a sensible value. Joseph confirmed
--     the seeded Silver Package recipe is sales-day positions, so
--     'photo_day_shortlist' is correct.
--
-- TRACK B — Update the unique key:
--   * Old:  UNIQUE (scope_type, scope_ref_id, scope_ref_id_2,
--                   scope_ref_id_3, position_index)
--   * New:  UNIQUE (scope_type, scope_ref_id, scope_ref_id_2,
--                   scope_ref_id_3, engine_role, position_index)
--   * Per-engine-role indexing means position #1 can exist in Sales AND
--     Drone for the same scope without conflict — matches the matrix tabs.
--
-- TRACK C — Replace the resolver RPC:
--   * Same signature (uuid, uuid, uuid, uuid → jsonb).
--   * Body is a verbatim copy of mig 447 with no logic change — the
--     `engine_role` references in DISTINCT ON / ORDER BY are now valid
--     (column exists). NOTIFY pgrst reloads the cache so PostgREST picks
--     up the column immediately.
--   * Index also added: (scope_type, scope_ref_id, scope_ref_id_2,
--                        engine_role) for the cell-counts query.
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────
--
--   ALTER TABLE gallery_positions DROP COLUMN engine_role;
--   -- (UNIQUE constraint follows; restore mig 443's original UNIQUE.)
--   -- Re-run mig 447 to restore the previous resolver body.
--
-- ─── DEFENSIVE NOTES ─────────────────────────────────────────────────────
--
--   * Additive only — no row deletes, no scope_type vocabulary changes.
--   * The 5 seeded Silver Package rows (scope_type='package', mig 443
--     bootstrap) are NOT touched. They get engine_role='photo_day_shortlist'
--     via the column default. They live at scope_type='package' which the
--     matrix UI does not surface — they're test fixtures only and the
--     matrix reads scope_type='package_x_price_tier' / 'price_tier'.
--
-- ─────────────────────────────────────────────────────────────────────────

-- ═══════════════════════════════════════════════════════════════════════
-- TRACK A — Add engine_role column with CHECK + default.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.gallery_positions
  ADD COLUMN IF NOT EXISTS engine_role text NOT NULL
    DEFAULT 'photo_day_shortlist';

ALTER TABLE public.gallery_positions
  DROP CONSTRAINT IF EXISTS gallery_positions_engine_role_check;

ALTER TABLE public.gallery_positions
  ADD CONSTRAINT gallery_positions_engine_role_check
    CHECK (engine_role IN (
      'photo_day_shortlist',
      'drone_shortlist',
      'floor_plans',
      'dusk_shortlist',
      'video_shortlist'
    ));

COMMENT ON COLUMN public.gallery_positions.engine_role IS
  'Which round (engine_role) consumes this position. Maps 1:1 to '
  'shortlisting_rounds.engine_role. Vocabulary kept in sync with the UI '
  'constants (recipe-matrix/constants.js → ENGINE_ROLES). Default '
  '''photo_day_shortlist'' is the most common role.';

-- ═══════════════════════════════════════════════════════════════════════
-- TRACK B — Update UNIQUE key to include engine_role.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.gallery_positions
  DROP CONSTRAINT IF EXISTS gallery_positions_scope_type_scope_ref_id_scope_ref_id_2_sc_key;

-- Per-engine-role uniqueness so position #1 can exist in Sales AND Drone
-- for the same scope without conflict.
ALTER TABLE public.gallery_positions
  ADD CONSTRAINT gallery_positions_scope_engine_role_position_key
    UNIQUE (scope_type, scope_ref_id, scope_ref_id_2, scope_ref_id_3,
            engine_role, position_index);

-- Index aligned with the cell-counts query (scope + engine_role).
CREATE INDEX IF NOT EXISTS idx_gallery_positions_scope_role
  ON public.gallery_positions
  (scope_type, scope_ref_id, scope_ref_id_2, engine_role);

-- ═══════════════════════════════════════════════════════════════════════
-- TRACK C — Replace resolver RPC. Same body as mig 447 — engine_role
-- references now resolve against a real column.
-- ═══════════════════════════════════════════════════════════════════════

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
  'Recipe Matrix UI resolver. Returns merged gallery_positions for one '
  '(package × price tier × project_type × product) cell plus inheritance '
  'scope chain. Mig 449 repair: now reads against gallery_positions.engine_role '
  '(added in this migration) — the previous mig 445/447 versions referenced '
  'a column that didn''t exist. Reads scope_type=''package_x_price_tier'' '
  'rows (price_tier matrix axis, post mig 446).';

NOTIFY pgrst, 'reload schema';
