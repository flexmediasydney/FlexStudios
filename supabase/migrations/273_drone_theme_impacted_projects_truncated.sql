-- 273_drone_theme_impacted_projects_truncated.sql
-- QC6 #25: drone_theme_impacted_projects() returns LIMIT 200 silently. The
-- Theme Editor's "impacted projects" panel has no way to know whether the
-- list is complete or capped, so on themes used by 200+ projects the panel
-- shows the truncated list with no warning — the operator may believe the
-- impact is contained when there are dozens more projects affected.
--
-- Fix: add an `is_truncated boolean` column. The function still returns at
-- most LIMIT_CAP rows (200, unchanged) but stamps every row with whether
-- the underlying query exceeded the cap. The UI can then surface a "+N
-- more" line beneath the visible rows.
--
-- We compute the flag with a single COUNT(DISTINCT) over the same CTE so
-- we don't re-execute the join.
--
-- Function signature changes (added column at the end), so we DROP and
-- recreate with the new signature; CREATE OR REPLACE alone refuses to
-- change the return TABLE shape.

DROP FUNCTION IF EXISTS public.drone_theme_impacted_projects(uuid);

CREATE OR REPLACE FUNCTION public.drone_theme_impacted_projects(p_theme_id uuid)
RETURNS TABLE(
  project_id uuid,
  project_address text,
  shoot_id uuid,
  shoot_status text,
  renders_count integer,
  in_flight boolean,
  is_truncated boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH theme_renders AS (
    SELECT dr.id, dr.shot_id, ds.shoot_id, s.project_id, s.status AS shoot_status
    FROM drone_renders dr
    JOIN drone_shots ds ON ds.id = dr.shot_id
    JOIN drone_shoots s ON s.id = ds.shoot_id
    WHERE dr.theme_id_at_render = p_theme_id
      AND dr.column_state IN ('proposed','adjustments','final')
  ),
  grouped AS (
    SELECT
      tr.project_id,
      p.property_address AS project_address,
      tr.shoot_id,
      tr.shoot_status,
      COUNT(*)::int AS renders_count,
      (tr.shoot_status NOT IN ('delivered'))::boolean AS in_flight
    FROM theme_renders tr
    JOIN projects p ON p.id = tr.project_id
    GROUP BY tr.project_id, p.property_address, tr.shoot_id, tr.shoot_status
  ),
  total AS (
    SELECT COUNT(*)::int AS n FROM grouped
  )
  SELECT
    g.project_id,
    g.project_address,
    g.shoot_id,
    g.shoot_status,
    g.renders_count,
    g.in_flight,
    (SELECT n FROM total) > 200 AS is_truncated
  FROM grouped g
  ORDER BY g.in_flight DESC, g.renders_count DESC
  LIMIT 200;
$function$;

GRANT EXECUTE ON FUNCTION public.drone_theme_impacted_projects(uuid)
  TO authenticated;
