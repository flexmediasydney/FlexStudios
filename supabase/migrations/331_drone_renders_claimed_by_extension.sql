-- ════════════════════════════════════════════════════════════════════════
-- Migration 331 — Wave 14 Stream 2
-- drone_renders_update RLS — re-introduce contractor branch scoped by
-- parent shot's claimed_by.
--
-- Background:
--   Migration 317 (Wave 12 A.1) removed the contractor branch from
--   drone_renders_update entirely. The justification at the time was
--   "contractors mutate renders only via service_role Edge Functions
--   (drone-render-approve, drone-shot-lifecycle, drone-render-edited)".
--
--   Wave 14 S2 reinstates a NARROW contractor branch — narrowly scoped
--   by the parent shot's claimed_by — for any non-sensitive column the
--   contractor needs to touch directly via PostgREST (e.g. notes /
--   sidecar metadata that doesn't go through one of the canonical Edge
--   Functions). The W12 mig 318 sensitive-column trigger still blocks
--   all non-service_role writes to ground-truth columns (column_state,
--   delivery_url, etc.), so this re-introduction is defense-in-depth,
--   not a privilege expansion.
--
--   Predicate for contractors:
--     - parent shot is in a project they're assigned to (matches mig
--       317 manager/employee scoping, joined the same way)
--     - AND parent shot's claimed_by IS NULL OR equals current_app_user_id()
--
--   master_admin / admin: unchanged (broad)
--   manager / employee:   unchanged (project-scoped — mig 317 preserved verbatim)
--   contractor:           NEW — scoped to project-membership AND claimed parent shot
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
    OR (
      get_user_role() = 'contractor'
      AND EXISTS (
        SELECT 1 FROM drone_shots ds
        WHERE ds.id = drone_renders.shot_id
          AND ds.shoot_id IN (
            SELECT sh.id FROM drone_shoots sh
            WHERE sh.project_id IN (SELECT my_project_ids())
          )
          AND (ds.claimed_by IS NULL OR ds.claimed_by = current_app_user_id())
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
    OR (
      get_user_role() = 'contractor'
      AND EXISTS (
        SELECT 1 FROM drone_shots ds
        WHERE ds.id = drone_renders.shot_id
          AND ds.shoot_id IN (
            SELECT sh.id FROM drone_shoots sh
            WHERE sh.project_id IN (SELECT my_project_ids())
          )
          AND (ds.claimed_by IS NULL OR ds.claimed_by = current_app_user_id())
      )
    )
  );

COMMENT ON POLICY drone_renders_update ON public.drone_renders IS
  'Wave 14 S2: extends mig 317 by re-introducing a NARROW contractor branch scoped by (project membership AND parent shot claimed_by NULL/self). W12 mig 318 sensitive-column trigger still blocks all non-service_role mutations of ground-truth columns (column_state, delivery_url, etc.) — this RLS branch only admits non-sensitive contractor writes (defense-in-depth, not privilege expansion).';

NOTIFY pgrst, 'reload schema';
