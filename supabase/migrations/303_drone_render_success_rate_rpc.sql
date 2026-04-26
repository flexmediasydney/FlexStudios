-- ═══════════════════════════════════════════════════════════════════════════
-- 303: get_shoot_render_success_rate RPC for render observability
-- ───────────────────────────────────────────────────────────────────────────
-- Wave 10 architect Section D: single RPC for "X/Y rendered, Z failed"
-- per shoot. Used by Command Center + DronePipelineBanner.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_shoot_render_success_rate(
  p_shoot_id UUID,
  p_pipeline TEXT DEFAULT 'raw'
)
RETURNS TABLE (
  shoot_id UUID,
  pipeline TEXT,
  expected_shots INT,
  rendered_shots INT,
  missing_shot_ids UUID[],
  success_rate_pct NUMERIC(5,2),
  per_kind JSONB
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH eligible AS (
    SELECT s.id AS shot_id
    FROM drone_shots s
    WHERE s.shoot_id = p_shoot_id
      AND s.shot_role IN ('nadir_hero','orbital','oblique_hero','building_hero','unclassified')
      AND (p_pipeline <> 'edited' OR s.edited_dropbox_path IS NOT NULL)
  ),
  rendered AS (
    SELECT DISTINCT r.shot_id, r.kind
    FROM drone_renders r
    JOIN eligible e ON e.shot_id = r.shot_id
    WHERE r.pipeline = p_pipeline
      AND r.column_state IN ('pool','accepted','adjustments','final')
  ),
  rendered_for_default_kind AS (
    SELECT DISTINCT shot_id FROM rendered WHERE kind = 'poi_plus_boundary'
  )
  SELECT
    p_shoot_id AS shoot_id,
    p_pipeline AS pipeline,
    (SELECT count(*)::INT FROM eligible)              AS expected_shots,
    (SELECT count(*)::INT FROM rendered_for_default_kind) AS rendered_shots,
    ARRAY(SELECT e.shot_id FROM eligible e WHERE NOT EXISTS
       (SELECT 1 FROM rendered_for_default_kind r WHERE r.shot_id = e.shot_id))
                                                       AS missing_shot_ids,
    CASE WHEN (SELECT count(*) FROM eligible)=0 THEN 0
         ELSE round(100.0 * (SELECT count(*) FROM rendered_for_default_kind)
                          / (SELECT count(*) FROM eligible), 2) END
                                                       AS success_rate_pct,
    (SELECT jsonb_object_agg(kind, n) FROM
        (SELECT kind, count(*) AS n FROM rendered GROUP BY kind) k)
                                                       AS per_kind;
$$;

REVOKE EXECUTE ON FUNCTION public.get_shoot_render_success_rate(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_shoot_render_success_rate(UUID, TEXT) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
