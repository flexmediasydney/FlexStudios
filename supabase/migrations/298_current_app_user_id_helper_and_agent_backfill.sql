-- ═══════════════════════════════════════════════════════════════════════════
-- 298: current_app_user_id() helper + Joseph agent backfill
-- ───────────────────────────────────────────────────────────────────────────
-- Wave 6 W6-T3 (QC iter 3): mig 280 person-theme RLS uses auth.uid() but
-- agents.assigned_to_user_id is FK to public.users(id). For 4 of 5 users
-- public.users.id == auth.users.id (so auth.uid() resolves correctly).
-- BUT joseph.saad91@gmail.com has DIFFERENT IDs:
--   public.users.id = 8e10f74b-675a-4fc1-bb13-278e3411709b
--   auth.users.id   = 87a27fb4-ddc8-491e-91a9-9236393589fb
--
-- Direct ID swap would cascade across 36 FK-referencing tables — too risky.
-- Bridge approach: SECURITY DEFINER helper that maps auth.uid() to the
-- correct public.users.id via email join, then mig 280 RLS uses it.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.current_app_user_id() RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
STABLE
AS $$
  SELECT id FROM public.users WHERE id = auth.uid()
  UNION ALL
  SELECT pu.id 
    FROM public.users pu
    JOIN auth.users au ON LOWER(au.email) = LOWER(pu.email)
   WHERE au.id = auth.uid()
     AND NOT EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid())
  LIMIT 1
$$;

REVOKE EXECUTE ON FUNCTION public.current_app_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_app_user_id() TO authenticated, service_role;

DROP POLICY IF EXISTS drone_themes_insert ON drone_themes;
CREATE POLICY drone_themes_insert ON drone_themes
  FOR INSERT
  WITH CHECK (
    (get_user_role() = ANY (ARRAY['master_admin'::text, 'admin'::text]))
    OR ((get_user_role() = ANY (ARRAY['manager'::text, 'employee'::text]))
        AND (owner_kind = 'person'::text)
        AND (owner_id IN (SELECT agents.id FROM agents WHERE agents.assigned_to_user_id = current_app_user_id())))
    OR ((get_user_role() = 'manager'::text) AND (owner_kind = 'organisation'::text))
  );

DROP POLICY IF EXISTS drone_themes_update ON drone_themes;
CREATE POLICY drone_themes_update ON drone_themes
  FOR UPDATE
  USING (
    (get_user_role() = ANY (ARRAY['master_admin'::text, 'admin'::text]))
    OR ((get_user_role() = ANY (ARRAY['manager'::text, 'employee'::text]))
        AND (owner_kind = 'person'::text)
        AND (owner_id IN (SELECT agents.id FROM agents WHERE agents.assigned_to_user_id = current_app_user_id())))
    OR ((get_user_role() = 'manager'::text) AND (owner_kind = 'organisation'::text)
        AND (created_by = current_app_user_id()))
  );

DROP POLICY IF EXISTS drone_themes_read ON drone_themes;
CREATE POLICY drone_themes_read ON drone_themes
  FOR SELECT
  USING (
    (get_user_role() = ANY (ARRAY['master_admin'::text, 'admin'::text, 'manager'::text, 'employee'::text]))
    OR ((get_user_role() = 'contractor'::text) AND (owner_kind = 'person'::text)
        AND (owner_id IN (SELECT agents.id FROM agents WHERE agents.assigned_to_user_id = current_app_user_id())))
  );

UPDATE agents 
   SET assigned_to_user_id = '8e10f74b-675a-4fc1-bb13-278e3411709b'
 WHERE id = 'e359cc05-ed79-4d8a-950e-371d8c1074b1'
   AND assigned_to_user_id IS NULL;
