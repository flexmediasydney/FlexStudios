-- ════════════════════════════════════════════════════════════════════════
-- Migration 317 — Wave 12 Stream A.1
-- drone_renders_update RLS tightening — remove contractor branch.
--
-- Background:
--   Migration 296 narrowed drone_renders_update to scope contractor writes
--   by my_project_ids(). The follow-on architect plan removes the contractor
--   branch entirely: contractors mutate renders ONLY through service_role
--   Edge Functions (drone-render-approve, drone-shot-lifecycle,
--   drone-render-edited). Removing the branch eliminates the only
--   contractor-direct PostgREST update path on this table.
--
--   manager / employee retain RLS access and remain scoped by
--   my_project_ids() (defense-in-depth). master_admin / admin keep the
--   broad branch. Migration 318 layers a column-level block trigger on
--   top of this RLS so even allowed callers cannot mutate sensitive
--   columns directly — those writes must flow through service_role
--   Edge Functions regardless of role.
--
--   shot_id-based scoping is preserved for non-admin roles by joining
--   to drone_shots and drone_shoots, matching the structure mig 296
--   established.
-- ════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS drone_renders_update ON public.drone_renders;

CREATE POLICY drone_renders_update ON public.drone_renders
  FOR UPDATE
  USING (
    get_user_role() IN ('master_admin','admin')
    OR (
      get_user_role() IN ('manager','employee')
      AND EXISTS (
        SELECT 1 FROM drone_shots ds
        WHERE ds.id = drone_renders.shot_id
          AND ds.shoot_id IN (
            SELECT sh.id FROM drone_shoots sh
            WHERE sh.project_id IN (SELECT my_project_ids())
          )
      )
    )
  )
  WITH CHECK (
    get_user_role() IN ('master_admin','admin')
    OR (
      get_user_role() IN ('manager','employee')
      AND EXISTS (
        SELECT 1 FROM drone_shots ds
        WHERE ds.id = drone_renders.shot_id
          AND ds.shoot_id IN (
            SELECT sh.id FROM drone_shoots sh
            WHERE sh.project_id IN (SELECT my_project_ids())
          )
      )
    )
  );

COMMENT ON POLICY drone_renders_update ON public.drone_renders IS
  'Wave 12 A.1: contractors removed. They mutate renders only via service_role Edge Functions (drone-render-approve, drone-shot-lifecycle, drone-render-edited). Manager/employee scoped by my_project_ids().';

NOTIFY pgrst, 'reload schema';
