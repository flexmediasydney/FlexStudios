-- ════════════════════════════════════════════════════════════════════════
-- Migration 330 — Wave 14 Stream 2
-- drone_shots_update RLS — narrow contractor branch by claimed_by.
--
-- Background:
--   Migration 225 created drone_shots_update with an unconditional
--   contractor branch (any contractor on a project could mutate any shot
--   on that project). Wave 12 D added projects.drone_editor_id gating in
--   the drone-shot-lifecycle Edge Function, but DIRECT PostgREST writes
--   from a contractor still hit the broad RLS USING expression. This is
--   the per-shot ownership tightening promised in mig 321 (which added
--   the claimed_by column but deferred the RLS wiring).
--
--   New rule for contractors on UPDATE:
--     - shoot belongs to a project they're assigned to (preserved)
--     - AND (claimed_by IS NULL OR claimed_by = current_app_user_id())
--
--   master_admin / admin / manager / employee branch unchanged
--   (preserved unconditionally to allow manager-override / steal-from-
--   stuck-contractor scenarios).
--
--   Auto-claim semantics live in drone-shot-lifecycle (W14-S2 Task 3):
--   on the first contractor lifecycle transition where claimed_by is NULL,
--   the Edge Fn stamps claimed_by=user.id + claimed_at=NOW() inside the
--   same UPDATE that flips lifecycle_state (atomic, no race window).
--
--   Defense-in-depth note: W12 mig 319 sensitive-column trigger already
--   blocks ANY non-service_role mutation of lifecycle_state, shot_role,
--   etc. So contractor direct PostgREST writes are already shut off for
--   the ground-truth columns. This RLS narrowing prevents direct mutation
--   of the remaining (non-sensitive) columns by an unclaimed contractor.
--
--   Bridge note: contractors authenticate as auth.users; their app-side
--   identity is mig 298's current_app_user_id() (handles Joseph's email-
--   bridged ID and the standard same-id mapping for everyone else).
-- ════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS drone_shots_update ON public.drone_shots;

CREATE POLICY drone_shots_update ON public.drone_shots
  FOR UPDATE
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (
      get_user_role() = 'contractor'
      AND shoot_id IN (
        SELECT id FROM drone_shoots WHERE project_id IN (SELECT my_project_ids())
      )
      AND (claimed_by IS NULL OR claimed_by = current_app_user_id())
    )
  )
  WITH CHECK (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (
      get_user_role() = 'contractor'
      AND shoot_id IN (
        SELECT id FROM drone_shoots WHERE project_id IN (SELECT my_project_ids())
      )
      AND (claimed_by IS NULL OR claimed_by = current_app_user_id())
    )
  );

COMMENT ON POLICY drone_shots_update ON public.drone_shots IS
  'Wave 14 S2: contractor UPDATE scoped to (claimed_by NULL OR claimed_by=current_app_user_id()). Auto-claim happens in drone-shot-lifecycle Edge Fn on first transition. Manager+ unrestricted (admits manager-override / steal-from-stuck-contractor). Defense-in-depth on top of W12 mig 319 sensitive-column block trigger which still blocks ALL non-service_role writes to ground-truth columns regardless of claim ownership.';

NOTIFY pgrst, 'reload schema';
