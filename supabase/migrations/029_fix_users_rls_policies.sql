-- 029_fix_users_rls_policies.sql
-- Fix critical RLS bugs on the users table that block admin operations:
--
-- Bug 1: No admin UPDATE policy. Both "update_self" and "users_update_own" only
--         allow users to update their own record (id = auth.uid()). Admins cannot
--         change other users' roles, deactivate them, or edit their profiles.
--
-- Bug 2: "admin_delete" policy uses USING(false) which blocks ALL deletes,
--         conflicting with the correct "users_delete_admin" policy. Since both are
--         PERMISSIVE (OR'd together), the false one is harmless in theory, but it
--         is confusing dead weight. Drop it.
--
-- Bug 3: The duplicate "update_self" and "users_update_own" policies do the same
--         thing. Drop "update_self" to avoid confusion.
--
-- Bug 4: Missing WITH CHECK on update policies. Even when USING passes, the row
--         could be rejected if the new values don't pass a WITH CHECK. Adding
--         WITH CHECK (true) for admin updates and WITH CHECK (id = auth.uid())
--         for self-updates to be explicit.
--
-- Bug 5: "admin_insert" has WITH CHECK (true) allowing ANY authenticated user to
--         insert rows. Drop it; "users_insert_admin" correctly restricts to admins.
--
-- Bug 6: "authenticated_read" duplicates "users_select". Drop it.
--
-- Bug 7: No trigger to sync role changes from public.users to auth.users metadata.
--         When admin changes a user's role, RLS policies still see the old role.

BEGIN;

-- 1. Drop the broken "admin_delete" policy that blocks all deletes
DROP POLICY IF EXISTS "admin_delete" ON public.users;

-- 2. Drop the duplicate "update_self" (keep "users_update_own" for self-updates)
DROP POLICY IF EXISTS "update_self" ON public.users;

-- 2b. Drop insecure "admin_insert" that allows any user to insert (WITH CHECK true)
DROP POLICY IF EXISTS "admin_insert" ON public.users;

-- 2c. Drop duplicate "authenticated_read" (keep "users_select")
DROP POLICY IF EXISTS "authenticated_read" ON public.users;

-- 3. Add WITH CHECK to "users_update_own" so self-updates are fully allowed
--    (recreate to add WITH CHECK since ALTER POLICY can't add it if missing)
DROP POLICY IF EXISTS "users_update_own" ON public.users;
CREATE POLICY "users_update_own" ON public.users
  FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- 4. Add the missing admin UPDATE policy: admins can update ANY user
CREATE POLICY "users_update_admin" ON public.users
  FOR UPDATE
  USING (
    auth.uid() IN (
      SELECT u.id FROM auth.users u
      WHERE (u.raw_user_meta_data ->> 'role') = ANY(ARRAY['master_admin', 'admin'])
    )
  )
  WITH CHECK (true);

-- 5. Sync role changes from public.users to auth.users.raw_user_meta_data.
--    RLS policies for admin operations check auth.users.raw_user_meta_data ->> 'role',
--    so when an admin changes a user's role via the Edit User dialog, the auth metadata
--    must be updated too, otherwise the new role won't be recognized by RLS.
CREATE OR REPLACE FUNCTION fn_sync_user_role_to_auth()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    UPDATE auth.users
    SET raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('role', NEW.role)
    WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_user_role ON public.users;
CREATE TRIGGER trg_sync_user_role
  AFTER UPDATE OF role ON public.users
  FOR EACH ROW EXECUTE FUNCTION fn_sync_user_role_to_auth();

COMMIT;
