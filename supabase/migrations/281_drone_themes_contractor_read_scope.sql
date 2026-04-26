-- 281_drone_themes_contractor_read_scope
-- ────────────────────────────────────────────────────────────────────────
-- Wave 5 P1 / QC2-7 E31 — contractor read-all leak
--
-- The current `drone_themes_read` policy permits all of
--   master_admin, admin, manager, employee, contractor
-- to read every row. Contractors thereby see every system template
-- (master pricing/render baselines), every org-level theme, and every
-- person theme — leaking pricing rules and editorial defaults the
-- contractor has no business reading.
--
-- Theme resolution for a contractor session never needs direct
-- drone_themes reads: it happens server-side via the Edge Function
-- `setDroneTheme` (and friends), which run as service_role and
-- inherit the resolved theme into the project's render config.
--
-- The safest interpretation:
--   master_admin / admin     → read all
--   manager / employee       → read all (they need template browse)
--   contractor               → read ONLY their own person themes
--                              (where owner_kind='person' AND owner_id
--                              maps to an agent assigned to auth.uid())
-- Contractors do NOT see system templates, org themes, or other
-- contractors' personal themes. If they need a project's resolved
-- theme they hit the resolved-theme RPC / Edge Function, never the
-- raw table.
--
-- This also reuses the agent.id ↔ auth.uid join introduced in mig 280
-- so the person-scope check is consistent across read and write paths.

DROP POLICY IF EXISTS drone_themes_read ON drone_themes;
CREATE POLICY drone_themes_read ON drone_themes
FOR SELECT
USING (
  -- Internal staff can browse everything
  get_user_role() = ANY (ARRAY[
    'master_admin'::text,
    'admin'::text,
    'manager'::text,
    'employee'::text
  ])
  OR
  -- Contractors are restricted to their own person themes
  (
    get_user_role() = 'contractor'::text
    AND owner_kind = 'person'::text
    AND owner_id IN (
      SELECT id FROM agents WHERE assigned_to_user_id = auth.uid()
    )
  )
);
