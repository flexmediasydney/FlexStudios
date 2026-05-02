-- 429_stuck_round_reaper.sql
-- F-3D-005: shortlisting_rounds can get stuck in 'processing' status if Stage 1
-- or Stage 4 errors mid-flight without writing the terminal status. Rainbow
-- Cres (round c55374b1-1d10-4875-aaad-8dbba646ed3d) was stuck for 26h+ at
-- $35.82+ — well over the W6a cost cap (which couldn't fire pre-deploy).
--
-- This reaper runs every 15 min and auto-fails any 'processing' round that
-- has been alive for > 2 hours. It mirrors `pulse-sync-logs-stuck-reaper`
-- (jobid 49) in spirit but targets a different table with different
-- semantics:
--   - status filter: ONLY 'processing' (never reaps 'pending', 'proposed',
--     'locked', 'failed' or any other lifecycle state)
--   - threshold: 2 hours (Stage 4 worst-case wall = ~7 minutes; 2h leaves
--     plenty of headroom for legit long-tail runs while catching real wedges)
--   - error_summary: appended (not overwritten) so any operator-supplied
--     context survives the reap
--
-- The reaper writes the auto-fail explanation to shortlisting_rounds.error_summary
-- (new column added below — previously the round had no place to surface a
-- terminal error string outside of engine_run_audit) AND mirrors the message
-- to engine_run_audit.error_summary for ops visibility, AND emits a
-- shortlisting_events row of event_type='auto_fail_stuck_round' so the
-- swimlane / activity timeline shows the reap.

BEGIN;

-- ─── Schema ────────────────────────────────────────────────────────────────
-- Extend the status check constraint to include 'failed'.
-- ROOT CAUSE FINDING: the existing check only permitted
--   ['pending','processing','proposed','locked','delivered','manual','backfilled']
-- — 'failed' was missing. The Stage 4 background worker (index.ts:518) writes
-- status='failed' on terminal Gemini failure, and those UPDATEs were silently
-- rejected by the constraint, leaving rounds wedged in 'processing' forever.
-- This is *the* underlying reason Rainbow Cres was stuck for 26h+: not
-- because Stage 4 didn't fail, but because the row couldn't be flipped to a
-- valid terminal state. Adding 'failed' is a strict superset — no existing
-- row violates the new constraint.
ALTER TABLE public.shortlisting_rounds
  DROP CONSTRAINT IF EXISTS shortlisting_rounds_status_check;

ALTER TABLE public.shortlisting_rounds
  ADD CONSTRAINT shortlisting_rounds_status_check
  CHECK (status = ANY (ARRAY[
    'pending'::text,
    'processing'::text,
    'proposed'::text,
    'locked'::text,
    'delivered'::text,
    'manual'::text,
    'backfilled'::text,
    'failed'::text
  ]));

COMMENT ON CONSTRAINT shortlisting_rounds_status_check ON public.shortlisting_rounds IS
  'Allowed lifecycle statuses. ''failed'' added in mig 429: the prior list '
  'omitted ''failed'', so any worker UPDATE setting status=''failed'' was '
  'silently rejected, leaving rounds stranded in ''processing''.';

-- Add error_summary column to shortlisting_rounds for terminal failure messages.
-- Idempotent — safe to re-run.
ALTER TABLE public.shortlisting_rounds
  ADD COLUMN IF NOT EXISTS error_summary TEXT;

COMMENT ON COLUMN public.shortlisting_rounds.error_summary IS
  'Terminal error string when status=''failed''. Populated by stuck-round-reaper '
  'and Stage 1/Stage 4 background workers on terminal failure. Multi-line; '
  'newer entries appended with newline.';

-- ─── Reaper function ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.shortlisting_round_stuck_reaper()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reaped int := 0;
  v_msg text := 'wall_timeout — auto-failed by stuck-round-reaper after 2h in processing';
  r record;
BEGIN
  FOR r IN
    SELECT id, project_id
      FROM public.shortlisting_rounds
     WHERE status = 'processing'
       AND started_at < NOW() - INTERVAL '2 hours'
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
        'reaper_version', '429',
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
  'touches rounds where status=''processing'' AND started_at < NOW() - 2h. '
  'Never touches rounds in ''pending''/''proposed''/''locked''/''failed''/etc.';

-- ─── Cron schedule ─────────────────────────────────────────────────────────
-- Idempotent: drop any prior registration first.
SELECT cron.unschedule('shortlisting_round_stuck_reaper')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'shortlisting_round_stuck_reaper');

SELECT cron.schedule(
  'shortlisting_round_stuck_reaper',
  '*/15 * * * *',
  $cron$SELECT public.shortlisting_round_stuck_reaper()$cron$
);

COMMIT;
