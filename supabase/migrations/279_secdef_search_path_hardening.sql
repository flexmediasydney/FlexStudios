-- 279_secdef_search_path_hardening
-- ────────────────────────────────────────────────────────────────────────
-- Wave 5 P1 / QC2-6 #17 — security hardening
--
-- my_project_ids() and get_user_role() are SECURITY DEFINER but had
-- proconfig=NULL (no explicit search_path). Both are load-bearing for
-- contractor RLS across drone_custom_pins, drone_themes, projects, etc.
-- A non-superuser with CREATE on pg_temp could shadow auth.uid() or the
-- projects table and elevate privilege.
--
-- The audit query
--   SELECT proname FROM pg_proc
--    WHERE prosecdef = true AND proconfig IS NULL
--      AND proname ~ '(drone|theme|pin|render|sfm|cadastral|ingest|dropbox|my_project_ids|get_user_role)';
-- returned exactly two functions in scope: my_project_ids, get_user_role.
-- Both are pinned here.

ALTER FUNCTION public.my_project_ids() SET search_path = public, pg_temp;
ALTER FUNCTION public.get_user_role()  SET search_path = public, pg_temp;
