-- 425_qc_iter2_w7_p2_cleanup.sql
-- ============================================================================
-- QC iter 2 Wave 7 — P2 batched SQL cleanup.
--
-- Bundle of three independent QC findings that all touch RLS / index hygiene
-- on shortlisting + finals tables. None of them change app-visible behaviour:
--
--   F-A-012 — Split overlapping permissive policies on the calibration_*
--             and shortlisting_*_suggestions tables. The previous policies
--             used `FOR ALL ... USING (...) WITH CHECK (...)`, which means
--             the USING clause also gates SELECT. Combined with a separate
--             `_read` policy, every SELECT row is evaluated through both
--             policies (Postgres OR-combines permissive policies, so it's
--             functionally identical, but the optimizer evaluates both
--             every time). We now split each FOR ALL into FOR INSERT /
--             FOR UPDATE / FOR DELETE so the read path goes through one
--             policy only. Behaviour unchanged: same role checks, same
--             allow/deny pattern, just leaner.
--
--   F-A-013 — Wrap auth.role() / auth.uid() calls in (SELECT ...) on the
--             shortlisting_room_types + finals_qa_runs RLS policies.
--             Postgres's optimizer can hoist the SELECT-wrapped expression
--             out of the per-row loop so the auth function fires once per
--             query rather than once per row. Documented Supabase
--             performance-best-practice; applies to large-table policies
--             (finals_qa_runs grows ~1 row/finals-run; room_types is small
--             but the same pattern keeps callers consistent).
--
--   F-A-014 — Add indexes on shortlisting_overrides.ai_proposed_group_id
--             and human_selected_group_id (both FK columns to
--             composition_groups). Currently unindexed, which means a
--             CASCADE delete on composition_groups (or a swimlane query
--             that filters by group_id) does a sequential scan over
--             every override row. Added composite indexes (col, created_at)
--             to also serve "recent overrides for this group_id" queries
--             which the swimlane history panel uses.
--
-- All migrations are idempotent (DROP POLICY IF EXISTS / CREATE INDEX IF NOT
-- EXISTS). Re-running this migration is a no-op once applied.

BEGIN;

-- ─── F-A-012: Split FOR ALL policies on calibration + suggestion tables ─────

DROP POLICY IF EXISTS cal_sessions_write ON calibration_sessions;
CREATE POLICY cal_sessions_insert ON calibration_sessions
  FOR INSERT TO authenticated
  WITH CHECK (get_user_role() IN ('master_admin','admin'));
CREATE POLICY cal_sessions_update ON calibration_sessions
  FOR UPDATE TO authenticated
  USING (get_user_role() IN ('master_admin','admin'))
  WITH CHECK (get_user_role() IN ('master_admin','admin'));
CREATE POLICY cal_sessions_delete ON calibration_sessions
  FOR DELETE TO authenticated
  USING (get_user_role() IN ('master_admin','admin'));

DROP POLICY IF EXISTS cal_editor_shortlists_write ON calibration_editor_shortlists;
CREATE POLICY cal_editor_shortlists_insert ON calibration_editor_shortlists
  FOR INSERT TO authenticated
  WITH CHECK (get_user_role() IN ('master_admin','admin'));
CREATE POLICY cal_editor_shortlists_update ON calibration_editor_shortlists
  FOR UPDATE TO authenticated
  USING (get_user_role() IN ('master_admin','admin'))
  WITH CHECK (get_user_role() IN ('master_admin','admin'));
CREATE POLICY cal_editor_shortlists_delete ON calibration_editor_shortlists
  FOR DELETE TO authenticated
  USING (get_user_role() IN ('master_admin','admin'));

DROP POLICY IF EXISTS cal_decisions_write ON calibration_decisions;
CREATE POLICY cal_decisions_insert ON calibration_decisions
  FOR INSERT TO authenticated
  WITH CHECK (get_user_role() IN ('master_admin','admin'));
CREATE POLICY cal_decisions_update ON calibration_decisions
  FOR UPDATE TO authenticated
  USING (get_user_role() IN ('master_admin','admin'))
  WITH CHECK (get_user_role() IN ('master_admin','admin'));
CREATE POLICY cal_decisions_delete ON calibration_decisions
  FOR DELETE TO authenticated
  USING (get_user_role() IN ('master_admin','admin'));

DROP POLICY IF EXISTS shortlisting_slot_suggestions_write
  ON public.shortlisting_slot_suggestions;
CREATE POLICY shortlisting_slot_suggestions_insert
  ON public.shortlisting_slot_suggestions
  FOR INSERT TO authenticated
  WITH CHECK (get_user_role() = 'master_admin');
CREATE POLICY shortlisting_slot_suggestions_update
  ON public.shortlisting_slot_suggestions
  FOR UPDATE TO authenticated
  USING (get_user_role() = 'master_admin')
  WITH CHECK (get_user_role() = 'master_admin');
CREATE POLICY shortlisting_slot_suggestions_delete
  ON public.shortlisting_slot_suggestions
  FOR DELETE TO authenticated
  USING (get_user_role() = 'master_admin');

DROP POLICY IF EXISTS shortlisting_room_type_suggestions_write
  ON public.shortlisting_room_type_suggestions;
CREATE POLICY shortlisting_room_type_suggestions_insert
  ON public.shortlisting_room_type_suggestions
  FOR INSERT TO authenticated
  WITH CHECK (get_user_role() = 'master_admin');
CREATE POLICY shortlisting_room_type_suggestions_update
  ON public.shortlisting_room_type_suggestions
  FOR UPDATE TO authenticated
  USING (get_user_role() = 'master_admin')
  WITH CHECK (get_user_role() = 'master_admin');
CREATE POLICY shortlisting_room_type_suggestions_delete
  ON public.shortlisting_room_type_suggestions
  FOR DELETE TO authenticated
  USING (get_user_role() = 'master_admin');

-- ─── F-A-013: wrap auth.role() / auth.uid() in (SELECT ...) ─────────────────

DROP POLICY IF EXISTS shortlisting_room_types_read ON public.shortlisting_room_types;
CREATE POLICY shortlisting_room_types_read ON public.shortlisting_room_types
  FOR SELECT USING (
    (SELECT auth.role()) = 'authenticated'
    OR (SELECT auth.role()) = 'service_role'
  );

DROP POLICY IF EXISTS shortlisting_room_types_write ON public.shortlisting_room_types;
CREATE POLICY shortlisting_room_types_write ON public.shortlisting_room_types
  FOR ALL
  USING (
    (SELECT auth.role()) = 'service_role'
    OR EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = (SELECT auth.uid())
        AND u.role = 'master_admin'
    )
  )
  WITH CHECK (
    (SELECT auth.role()) = 'service_role'
    OR EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = (SELECT auth.uid())
        AND u.role = 'master_admin'
    )
  );

DROP POLICY IF EXISTS finals_qa_runs_master_admin_select ON finals_qa_runs;
CREATE POLICY finals_qa_runs_master_admin_select
  ON finals_qa_runs
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = (SELECT auth.uid())
        AND u.role = 'master_admin'
    )
  );

DROP POLICY IF EXISTS finals_qa_runs_master_admin_insert ON finals_qa_runs;
CREATE POLICY finals_qa_runs_master_admin_insert
  ON finals_qa_runs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = (SELECT auth.uid())
        AND u.role = 'master_admin'
    )
  );

-- ─── F-A-014: index the unindexed FK columns on shortlisting_overrides ─────

CREATE INDEX IF NOT EXISTS idx_overrides_ai_group_created
  ON shortlisting_overrides (ai_proposed_group_id, created_at DESC)
  WHERE ai_proposed_group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_overrides_human_group_created
  ON shortlisting_overrides (human_selected_group_id, created_at DESC)
  WHERE human_selected_group_id IS NOT NULL;

COMMENT ON INDEX idx_overrides_ai_group_created IS
  'QC-iter2-W7 F-A-014: backs FK lookups + recent-overrides-by-group queries. Partial on NOT NULL since most rows have an ai_proposed_group_id but added_from_rejects rows do not.';
COMMENT ON INDEX idx_overrides_human_group_created IS
  'QC-iter2-W7 F-A-014: backs FK lookups + recent-overrides-by-group queries for the human-selected branch (swapped / added_from_rejects).';

NOTIFY pgrst, 'reload schema';

COMMIT;
