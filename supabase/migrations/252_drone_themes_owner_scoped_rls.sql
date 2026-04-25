-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 252: drone_themes RLS — add owner-scope predicates
-- ───────────────────────────────────────────────────────────────────────────
-- Bug: migration 225's drone_themes_insert / drone_themes_update policies
-- gate ONLY on `get_user_role()`, with no per-row owner binding. Effect:
-- any non-master manager/employee can update OR insert any person-owned or
-- organisation-owned theme regardless of who actually owns it.
--
-- Migration 225's own comment (lines 80-84) acknowledges this:
--   "finer person/org binding enforced at app layer until person/org
--    membership tables exist"
-- That assumption no longer holds — the missing enforcement is the bug.
--
-- ─── ENVIRONMENT NOTES (important) ─────────────────────────────────────────
-- 1. users.id == auth.uid() (verified — get_user_role() reads users.id =
--    auth.uid()). So person-theme ownership binds via owner_id = auth.uid().
--
-- 2. There is NO public.org_members / users.agency_id / equivalent table.
--    The `agencies` table represents real-estate agency CLIENTS — internal
--    employees do not "belong to" agencies. Therefore a fully-scoped
--    `my_organisation_ids()` helper has no underlying data to query against.
--
-- 3. Fallback for organisation-owned themes:
--    - master_admin/admin: full access (existing behavior preserved)
--    - manager/employee: only the row's `created_by` may mutate it. This
--      gives the "I created the org-theme so I can edit it" property
--      without inventing a fake membership model.
--    - When/if an org-membership concept lands, replace the
--      `owner_id IN (SELECT my_organisation_ids())` predicate (currently
--      stubbed out) with the real lookup.
--
-- 4. Person-owned themes: only the person whose id = owner_id can mutate
--    (plus admin/master_admin escape hatches).
--
-- 5. System themes: master_admin only (existing rule preserved).
--
-- 6. service_role bypasses RLS entirely — workers and edge functions
--    continue to work unchanged.
-- ═══════════════════════════════════════════════════════════════════════════

-- Drop the over-broad policies first so we can recreate with scoping.
DROP POLICY IF EXISTS drone_themes_insert ON public.drone_themes;
DROP POLICY IF EXISTS drone_themes_update ON public.drone_themes;

-- ─── INSERT policy ────────────────────────────────────────────────────────
-- master_admin / admin: may insert any theme (incl. system).
-- manager / employee: may insert person-themes only if owner_id = auth.uid()
--                     may insert organisation-themes (no membership data, but
--                     created_by is auto-stamped by app layer; on insert we
--                     can only validate role + that they're not creating a
--                     person-theme for someone else).
-- system themes are master_admin/admin only (matches DELETE policy logic).
CREATE POLICY drone_themes_insert ON public.drone_themes
  FOR INSERT
  WITH CHECK (
    -- Escape hatches first
    get_user_role() IN ('master_admin','admin')
    -- Person themes: must be inserting your OWN theme
    OR (
      get_user_role() IN ('manager','employee')
      AND owner_kind = 'person'
      AND owner_id = auth.uid()
    )
    -- Organisation themes: manager+ may create (created_by binding
    -- enforces self-ownership for subsequent updates).
    OR (
      get_user_role() = 'manager'
      AND owner_kind = 'organisation'
    )
  );

-- ─── UPDATE policy ────────────────────────────────────────────────────────
-- master_admin: anything (incl. system).
-- admin: anything except system themes.
-- manager / employee:
--   * person-themes: only your own (owner_id = auth.uid())
--   * organisation-themes: only ones you created (created_by = auth.uid())
--   * never system themes.
CREATE POLICY drone_themes_update ON public.drone_themes
  FOR UPDATE
  USING (
    get_user_role() = 'master_admin'
    OR (get_user_role() = 'admin' AND owner_kind <> 'system')
    OR (
      get_user_role() IN ('manager','employee')
      AND owner_kind = 'person'
      AND owner_id = auth.uid()
    )
    OR (
      get_user_role() IN ('manager','employee')
      AND owner_kind = 'organisation'
      AND created_by = auth.uid()
    )
  )
  WITH CHECK (
    -- Re-assert on the post-update row so a row's owner_kind/owner_id
    -- can't be flipped to something the caller wouldn't be able to UPDATE.
    get_user_role() = 'master_admin'
    OR (get_user_role() = 'admin' AND owner_kind <> 'system')
    OR (
      get_user_role() IN ('manager','employee')
      AND owner_kind = 'person'
      AND owner_id = auth.uid()
    )
    OR (
      get_user_role() IN ('manager','employee')
      AND owner_kind = 'organisation'
      AND created_by = auth.uid()
    )
  );

COMMENT ON POLICY drone_themes_insert ON public.drone_themes IS
  'Owner-scoped: person-themes require owner_id=auth.uid(); org-themes require manager+ role; system themes admin/master_admin only.';
COMMENT ON POLICY drone_themes_update ON public.drone_themes IS
  'Owner-scoped: person-themes require owner_id=auth.uid(); org-themes require created_by=auth.uid() for non-admins; admin cannot touch system themes.';

NOTIFY pgrst, 'reload schema';
