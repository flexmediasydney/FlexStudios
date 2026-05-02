-- 435_backfill_bug_fixes_reaper_started_at.sql
--
-- BUG-FIX: stuck-round reaper uses started_at, auto-fails re-fired rounds
--
-- Mig 429 introduced cron job `shortlisting_round_stuck_reaper` (every 15
-- min) that flips shortlisting_rounds.status='processing' rows older than
-- 2h to 'failed'. The reaper's predicate is `started_at < now() - 2h`,
-- which is correct for first-time stalls but WRONG for operator re-fires.
--
-- Re-fire flow: an operator (or backfill orchestrator) bumps a previously-
-- terminal round back to status='processing' to re-run a stage with a fix
-- in place (e.g. a Stage 1 vocab backfill, or repairing NULL critical
-- fields after a schema-discovery patch). started_at still points at the
-- ORIGINAL Stage 1 timestamp (potentially days/weeks old). The reaper
-- sees the stale started_at and immediately reaps the freshly-bumped row,
-- silently killing the re-fire before it can do any work.
--
-- We hit this twice today (2026-05-02) on round
-- `3ed54b53-9184-402f-9907-d168ed1968a4` during the round-3ed54b53 vocab
-- backfill orchestration. The orchestrator's workaround was to also stamp
-- `started_at = now()` on each status bump, but that knowledge has to live
-- in every caller — the reaper itself should be re-fire-tolerant.
--
-- FIX: switch the reaper's predicate from `started_at` to `updated_at`.
-- updated_at advances on every row mutation, so a fresh status bump always
-- gives the reaper a fresh clock. Re-fires now get the full 2h budget
-- regardless of how old the original started_at is.
--
-- Both columns are already populated on every row (started_at via Stage 1
-- bootstrap; updated_at via the table-wide updated_at trigger). The
-- replacement does not require any backfill or constraint changes.
--
-- Reaper still ONLY targets `status='processing'` rows — the new predicate
-- adds rather than removes safety. A row that's been processing for >2h
-- and has not been touched in >2h is still wedged regardless of which
-- timestamp the predicate uses; in fact `updated_at` catches MORE genuine
-- wedges (e.g. a worker that took the row but never wrote progress would
-- have stale updated_at AND stale started_at — the reap fires either way).
--
-- The other guarantees from mig 429 (FOR UPDATE SKIP LOCKED, error_summary
-- append semantics, engine_run_audit mirror, shortlisting_events emission)
-- are unchanged.
--
-- ─── BUG 2 NOTE ───────────────────────────────────────────────────────────
-- This migration is the SQL half of a two-part fix wave. The companion
-- patch lives in `supabase/functions/shortlisting-shape-d/index.ts` and
-- addresses a separate-but-related skip-guard regression: shape-d treats
-- composition_classifications row EXISTENCE as proof of classification,
-- so backfill jobs that have rows-with-NULL-critical-fields short-circuit
-- Stage 1 entirely. The shape-d patch (a) extends the "primed" predicate
-- to require space_type IS NOT NULL AND zone_focus IS NOT NULL, and (b)
-- honours payload.force === true to bypass the guard. Both fixes are
-- independent — the SQL change here ships even if the edge-fn deploy is
-- rolled back, and vice-versa.
--
-- ─── ADDITIVE-THEN-SUBTRACTIVE PROVENANCE ─────────────────────────────────
-- This is a behavioural change to a SECURITY DEFINER function invoked by
-- pg_cron. Per docs/MIGRATION_SAFETY.md the safe pattern is to ship the
-- new function body in-place via CREATE OR REPLACE (the function body is
-- the unit of behaviour, not the calling cron command), and re-schedule
-- the same cron job name. The cron entry itself never disappears — it's
-- updated atomically.
--
-- Rollback (manual restoration of the mig 429 body) is documented in the
-- comment block at the bottom of this file.

BEGIN;

-- ─── Reaper function: replace body with updated_at predicate ──────────────
-- CREATE OR REPLACE preserves grants and dependencies; we re-state the
-- grants/revokes below for paranoia (idempotent — Postgres no-ops if the
-- ACL already matches).

CREATE OR REPLACE FUNCTION public.shortlisting_round_stuck_reaper()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reaped int := 0;
  v_msg text := 'wall_timeout — auto-failed by stuck-round-reaper after 2h with no row activity (updated_at)';
  r record;
BEGIN
  FOR r IN
    SELECT id, project_id
      FROM public.shortlisting_rounds
     WHERE status = 'processing'
       -- mig 435 fix: was `started_at < NOW() - INTERVAL '2 hours'`. Re-fired
       -- rounds keep their original started_at, which the prior predicate
       -- treated as "stuck" the moment status flipped back to processing.
       -- updated_at advances on every mutation, including the status bump,
       -- so re-fires now get a fresh 2h budget.
       AND updated_at < NOW() - INTERVAL '2 hours'
       FOR UPDATE SKIP LOCKED
  LOOP
    -- Flip the round to 'failed', appending the auto-fail message to any
    -- existing error_summary so operator-supplied context survives.
    UPDATE public.shortlisting_rounds
       SET status = 'failed',
           completed_at = NOW(),
           error_summary = CASE
             WHEN error_summary IS NULL OR error_summary = ''
               THEN v_msg
               ELSE error_summary || E'\n' || v_msg
           END,
           updated_at = NOW()
     WHERE id = r.id;

    -- Mirror the message to engine_run_audit.error_summary for ops visibility.
    -- Use append semantics here too. Skip silently if no audit row exists yet.
    UPDATE public.engine_run_audit
       SET error_summary = CASE
             WHEN error_summary IS NULL OR error_summary = ''
               THEN v_msg
               ELSE error_summary || E'\n' || v_msg
           END,
           updated_at = NOW()
     WHERE round_id = r.id;

    -- Emit ops event for swimlane/activity timeline visibility.
    INSERT INTO public.shortlisting_events (
      project_id, round_id, event_type, actor_type, actor_id, payload
    ) VALUES (
      r.project_id,
      r.id,
      'auto_fail_stuck_round',
      'system',
      NULL,
      jsonb_build_object(
        'reason', 'wall_timeout',
        'threshold_hours', 2,
        'reaper_version', '435',
        'predicate', 'updated_at',
        'message', v_msg
      )
    );

    v_reaped := v_reaped + 1;
  END LOOP;

  RETURN v_reaped;
END $$;

GRANT EXECUTE ON FUNCTION public.shortlisting_round_stuck_reaper() TO service_role;
REVOKE EXECUTE ON FUNCTION public.shortlisting_round_stuck_reaper() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.shortlisting_round_stuck_reaper() FROM anon, authenticated;

COMMENT ON FUNCTION public.shortlisting_round_stuck_reaper() IS
  'F-3D-005 stuck-round reaper. Idempotent. Returns number of rounds reaped. '
  'Run by cron every 15 min (job: shortlisting_round_stuck_reaper). Only '
  'touches rounds where status=''processing'' AND updated_at < NOW() - 2h. '
  'mig 435 fix: predicate was started_at; re-fired rounds keep their '
  'original started_at (days/weeks old) and were auto-failed on first reap '
  'tick after status was bumped back to ''processing''. updated_at advances '
  'on every mutation, so a fresh status bump gives the reaper a fresh clock.';

-- ─── Cron schedule: re-state the registration so the migration is fully
-- self-contained (idempotent — same name + same schedule + same command).
-- The cron job already exists from mig 429; the unschedule/schedule pair
-- here ensures even an out-of-order replay rebuilds it cleanly.
SELECT cron.unschedule('shortlisting_round_stuck_reaper')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'shortlisting_round_stuck_reaper');

SELECT cron.schedule(
  'shortlisting_round_stuck_reaper',
  '*/15 * * * *',
  $cron$SELECT public.shortlisting_round_stuck_reaper()$cron$
);

COMMIT;

-- ──────────────────────────────────────────────────────────────────────────
-- Rollback (manual restoration of the mig 429 reaper body):
--
-- BEGIN;
--
-- CREATE OR REPLACE FUNCTION public.shortlisting_round_stuck_reaper()
-- RETURNS int
-- LANGUAGE plpgsql
-- SECURITY DEFINER
-- SET search_path = public, pg_temp
-- AS $$
-- DECLARE
--   v_reaped int := 0;
--   v_msg text := 'wall_timeout — auto-failed by stuck-round-reaper after 2h in processing';
--   r record;
-- BEGIN
--   FOR r IN
--     SELECT id, project_id
--       FROM public.shortlisting_rounds
--      WHERE status = 'processing'
--        AND started_at < NOW() - INTERVAL '2 hours'
--        FOR UPDATE SKIP LOCKED
--   LOOP
--     UPDATE public.shortlisting_rounds
--        SET status = 'failed',
--            completed_at = NOW(),
--            error_summary = CASE
--              WHEN error_summary IS NULL OR error_summary = ''
--                THEN v_msg
--                ELSE error_summary || E'\n' || v_msg
--            END,
--            updated_at = NOW()
--      WHERE id = r.id;
--
--     UPDATE public.engine_run_audit
--        SET error_summary = CASE
--              WHEN error_summary IS NULL OR error_summary = ''
--                THEN v_msg
--                ELSE error_summary || E'\n' || v_msg
--            END,
--            updated_at = NOW()
--      WHERE round_id = r.id;
--
--     INSERT INTO public.shortlisting_events (
--       project_id, round_id, event_type, actor_type, actor_id, payload
--     ) VALUES (
--       r.project_id,
--       r.id,
--       'auto_fail_stuck_round',
--       'system',
--       NULL,
--       jsonb_build_object(
--         'reason', 'wall_timeout',
--         'threshold_hours', 2,
--         'reaper_version', '429',
--         'message', v_msg
--       )
--     );
--
--     v_reaped := v_reaped + 1;
--   END LOOP;
--
--   RETURN v_reaped;
-- END $$;
--
-- GRANT EXECUTE ON FUNCTION public.shortlisting_round_stuck_reaper() TO service_role;
-- REVOKE EXECUTE ON FUNCTION public.shortlisting_round_stuck_reaper() FROM PUBLIC;
-- REVOKE EXECUTE ON FUNCTION public.shortlisting_round_stuck_reaper() FROM anon, authenticated;
--
-- COMMIT;
--
-- The cron job entry name + schedule + command are unchanged across mig 429
-- and mig 435, so no cron rollback is required — only the function body
-- needs restoration.
