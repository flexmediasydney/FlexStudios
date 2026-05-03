-- 461_rls_initplan_wrap_auth_calls.sql
--
-- Fixes Supabase advisor `auth_rls_initplan` lints (63 occurrences across
-- 43 tables). Without the wrap, every row inside a SELECT/UPDATE/DELETE
-- re-invokes `auth.uid()` / `auth.jwt()` / `auth.role()` / `auth.email()`.
-- With the wrap `(SELECT auth.uid())` Postgres treats the call as an
-- INITPLAN — evaluated ONCE per query and cached for every row.
--
-- Per Supabase docs (https://supabase.com/docs/guides/database/postgres/row-level-security#performance):
--   "It's faster to wrap auth.uid() inside a SELECT statement"
--
-- Pure mechanical rewrite — semantics are identical:
--   (user_id = auth.uid())          →  (user_id = (SELECT auth.uid()))
--   (auth.uid() IS NOT NULL)        →  ((SELECT auth.uid()) IS NOT NULL)
--   (auth.uid() IN (SELECT…))       →  ((SELECT auth.uid()) IN (SELECT…))
--
-- Approach: iterate pg_policies; DROP + CREATE each policy with the
-- transformed qual / with_check. Idempotent — the regex skip-clause means
-- already-wrapped policies are not rewritten.
--
-- Single transaction. If any policy fails to recreate, ALL changes roll
-- back, leaving the original policies intact. No silent half-state.

DO $$
DECLARE
  r RECORD;
  v_qual TEXT;
  v_with_check TEXT;
  v_roles TEXT;
  v_sql TEXT;
  v_count INT := 0;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname, cmd, permissive, roles,
           qual, with_check
      FROM pg_policies
     WHERE schemaname = 'public'
       AND (
         (qual ~* '\mauth\.(uid|jwt|role|email)\s*\('
          AND qual !~* '\(\s*SELECT\s+auth\.(uid|jwt|role|email)')
         OR
         (with_check ~* '\mauth\.(uid|jwt|role|email)\s*\('
          AND with_check !~* '\(\s*SELECT\s+auth\.(uid|jwt|role|email)')
       )
  LOOP
    -- Wrap every direct auth.X() call in a SELECT subquery. The capture
    -- group `\1` preserves which auth function was used. Already-wrapped
    -- calls (followed by ')') are skipped by the qual/with_check filter
    -- in the FOR loop's WHERE clause.
    v_qual := regexp_replace(
      COALESCE(r.qual, ''),
      '\mauth\.(uid|jwt|role|email)\s*\(\)',
      '(SELECT auth.\1())',
      'g'
    );
    v_with_check := regexp_replace(
      COALESCE(r.with_check, ''),
      '\mauth\.(uid|jwt|role|email)\s*\(\)',
      '(SELECT auth.\1())',
      'g'
    );

    -- pg_policies.roles is text[] but PostgreSQL renders it surrounded by
    -- braces in SQL form ({admin,user}). Convert back to a comma-joined
    -- list for the CREATE POLICY clause.
    SELECT string_agg(quote_ident(role_name), ', ')
      INTO v_roles
      FROM unnest(r.roles) AS role_name;

    -- Drop the policy first; recreate with transformed expressions.
    EXECUTE format('DROP POLICY %I ON %I.%I',
                   r.policyname, r.schemaname, r.tablename);

    -- Build the CREATE POLICY clause respecting cmd-specific constraints:
    --   FOR INSERT  → only WITH CHECK is valid (no USING)
    --   FOR SELECT  → only USING is valid (no WITH CHECK)
    --   FOR DELETE  → only USING is valid (no WITH CHECK)
    --   FOR UPDATE  → both USING and WITH CHECK valid
    --   FOR ALL     → both USING and WITH CHECK valid
    v_sql := format(
      'CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s',
      r.policyname, r.schemaname, r.tablename,
      r.permissive,
      r.cmd,
      v_roles
    );

    IF r.qual IS NOT NULL AND r.cmd <> 'INSERT' THEN
      v_sql := v_sql || ' USING (' || v_qual || ')';
    END IF;
    IF r.with_check IS NOT NULL AND r.cmd NOT IN ('SELECT', 'DELETE') THEN
      v_sql := v_sql || ' WITH CHECK (' || v_with_check || ')';
    END IF;

    EXECUTE v_sql;
    v_count := v_count + 1;
  END LOOP;

  RAISE NOTICE 'Rewrote % RLS policies to use (SELECT auth.X()) initplan optimization', v_count;
END $$;
