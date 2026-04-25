-- ═══════════════════════════════════════════════════════════════════════════
-- 276: drone_custom_pins — contractor RLS extended for project-scoped pins
-- ───────────────────────────────────────────────────────────────────────────
-- Migration 268 unified the pin model: drone_custom_pins now holds BOTH
-- shoot-scoped pins (shoot_id NOT NULL) AND project-scoped AI pins
-- (shoot_id IS NULL, project_id NOT NULL). The scope check enforces that
-- at least one of (shoot_id, project_id) is set.
--
-- The contractor RLS branches on drone_custom_pins (SELECT/INSERT/UPDATE/
-- DELETE) only matched on `shoot_id IN (… my_project_ids …)`. Project-scoped
-- pins (where shoot_id IS NULL) were therefore invisible to contractors,
-- even when they had access to the underlying project via my_project_ids().
--
-- This migration extends each contractor branch to ALSO match rows where
-- project_id is set and the contractor has project access. Admin/manager/
-- employee branches are unchanged.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── SELECT ─────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS drone_custom_pins_read ON drone_custom_pins;
CREATE POLICY drone_custom_pins_read ON drone_custom_pins
  FOR SELECT
  USING (
    get_user_role() = ANY (ARRAY['master_admin'::text, 'admin'::text, 'manager'::text, 'employee'::text])
    OR (
      get_user_role() = 'contractor'::text
      AND (
        shoot_id IN (
          SELECT s.id FROM drone_shoots s
          WHERE s.project_id IN (SELECT my_project_ids())
        )
        OR (
          project_id IS NOT NULL
          AND project_id IN (SELECT my_project_ids())
        )
      )
    )
  );

-- ── INSERT ─────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS drone_custom_pins_insert ON drone_custom_pins;
CREATE POLICY drone_custom_pins_insert ON drone_custom_pins
  FOR INSERT
  WITH CHECK (
    get_user_role() = ANY (ARRAY['master_admin'::text, 'admin'::text, 'manager'::text, 'employee'::text])
    OR (
      get_user_role() = 'contractor'::text
      AND (
        shoot_id IN (
          SELECT s.id FROM drone_shoots s
          WHERE s.project_id IN (SELECT my_project_ids())
        )
        OR (
          project_id IS NOT NULL
          AND project_id IN (SELECT my_project_ids())
        )
      )
    )
  );

-- ── UPDATE ─────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS drone_custom_pins_update ON drone_custom_pins;
CREATE POLICY drone_custom_pins_update ON drone_custom_pins
  FOR UPDATE
  USING (
    get_user_role() = ANY (ARRAY['master_admin'::text, 'admin'::text, 'manager'::text, 'employee'::text])
    OR (
      get_user_role() = 'contractor'::text
      AND (
        shoot_id IN (
          SELECT s.id FROM drone_shoots s
          WHERE s.project_id IN (SELECT my_project_ids())
        )
        OR (
          project_id IS NOT NULL
          AND project_id IN (SELECT my_project_ids())
        )
      )
    )
  );

-- ── DELETE ─────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS drone_custom_pins_delete ON drone_custom_pins;
CREATE POLICY drone_custom_pins_delete ON drone_custom_pins
  FOR DELETE
  USING (
    get_user_role() = ANY (ARRAY['master_admin'::text, 'admin'::text, 'manager'::text, 'employee'::text])
    OR (
      get_user_role() = 'contractor'::text
      AND (
        shoot_id IN (
          SELECT s.id FROM drone_shoots s
          WHERE s.project_id IN (SELECT my_project_ids())
        )
        OR (
          project_id IS NOT NULL
          AND project_id IN (SELECT my_project_ids())
        )
      )
    )
  );

NOTIFY pgrst, 'reload schema';
