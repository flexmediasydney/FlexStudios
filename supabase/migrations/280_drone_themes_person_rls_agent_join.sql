-- 280_drone_themes_person_rls_agent_join
-- ────────────────────────────────────────────────────────────────────────
-- Wave 5 P1 / QC2-5 #3 — RLS broken for person-scope themes
--
-- mig 252 wired the person-theme RLS predicates as
--   `owner_kind = 'person' AND owner_id = auth.uid()`
-- but drone_themes.owner_id is a FK to agents.id (gen_random_uuid()),
-- NOT to auth.users.id. agents.id is generated independently and can
-- never equal auth.uid(). Net effect: managers/employees can never
-- INSERT, UPDATE, or DELETE a person theme they own. The policy
-- silently denies every write attempt.
--
-- Fix: replace the broken `owner_id = auth.uid()` predicate with
--   `owner_id IN (SELECT id FROM agents WHERE assigned_to_user_id = auth.uid())`
-- across the INSERT (with_check), UPDATE (using + with_check), and
-- — implicitly via the read policy — SELECT. The DELETE policy was
-- master_admin-only and is unaffected.
--
-- The READ policy is rewritten in the sibling migration (281).
--
-- NOTE for Phase 2: the setDroneTheme Edge Function also constructs
-- person-theme inserts/updates and may need to mirror this join logic,
-- depending on whether it relies on the RLS check. Flagging for the
-- backend stream to verify after this lands.

-- ─── INSERT ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS drone_themes_insert ON drone_themes;
CREATE POLICY drone_themes_insert ON drone_themes
FOR INSERT
WITH CHECK (
  (get_user_role() = ANY (ARRAY['master_admin'::text, 'admin'::text]))
  OR (
    (get_user_role() = ANY (ARRAY['manager'::text, 'employee'::text]))
    AND owner_kind = 'person'::text
    AND owner_id IN (SELECT id FROM agents WHERE assigned_to_user_id = auth.uid())
  )
  OR (
    get_user_role() = 'manager'::text
    AND owner_kind = 'organisation'::text
  )
);

-- ─── UPDATE ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS drone_themes_update ON drone_themes;
CREATE POLICY drone_themes_update ON drone_themes
FOR UPDATE
USING (
  (get_user_role() = 'master_admin'::text)
  OR (get_user_role() = 'admin'::text AND owner_kind <> 'system'::text)
  OR (
    (get_user_role() = ANY (ARRAY['manager'::text, 'employee'::text]))
    AND owner_kind = 'person'::text
    AND owner_id IN (SELECT id FROM agents WHERE assigned_to_user_id = auth.uid())
  )
  OR (
    (get_user_role() = ANY (ARRAY['manager'::text, 'employee'::text]))
    AND owner_kind = 'organisation'::text
    AND created_by = auth.uid()
  )
)
WITH CHECK (
  (get_user_role() = 'master_admin'::text)
  OR (get_user_role() = 'admin'::text AND owner_kind <> 'system'::text)
  OR (
    (get_user_role() = ANY (ARRAY['manager'::text, 'employee'::text]))
    AND owner_kind = 'person'::text
    AND owner_id IN (SELECT id FROM agents WHERE assigned_to_user_id = auth.uid())
  )
  OR (
    (get_user_role() = ANY (ARRAY['manager'::text, 'employee'::text]))
    AND owner_kind = 'organisation'::text
    AND created_by = auth.uid()
  )
);
