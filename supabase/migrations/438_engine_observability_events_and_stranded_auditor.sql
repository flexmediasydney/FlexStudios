-- 438_engine_observability_events_and_stranded_auditor.sql
--
-- Numbered 438 because origin/main 437 (`mig 437: shortlisting engine canary
-- round + daily SLA check`, commit ee38c33) landed concurrently with this
-- worktree. Per docs/MIGRATION_SAFETY.md "never re-use a number" — this is
-- the bumped re-number. The DB carries both as already-applied entries
-- under their respective Supabase-MCP timestamps; the schema_migrations
-- table treats them as distinct historical records.
--
-- Engine observability — three new event_type surfaces on shortlisting_events:
--
--   1. engine_vendor_failure   (emitted by edge fns shape-d / shape-d-stage4
--                                from W11.8.3 patch — non-2xx response from
--                                Gemini surfaces here without silent failover)
--   2. manual_chain_required   (emitted by shape-d when Stage 1 succeeded but
--                                Stage 4 did not auto-dispatch — captured the
--                                gating reason)
--   3. stage1_stranded         (emitted by THIS migration's auditor every 5min
--                                — matches rounds where Stage 1 succeeded
--                                >10min ago + no chained Stage 4 row)
--
-- Plus a 4th existing event 'canary_regression' is wired into the same
-- notification fan-out so any future regression auditor benefits from the
-- same plumbing.
--
-- Origin: 2026-05-02 — three silent failure modes hit production today
--   (a) 3× Gemini 4xx schema errors that took manual triage to find
--   (b) 1× Saladine round where Stage 1 succeeded with stage4_dispatched=false
--       and the operator only noticed when the swimlane had no slot output.
--       Root cause: an idempotency-check race on shortlisting_jobs that left
--       Stage 4 unscheduled despite a clean Stage 1 result.
--   (c) 1× dead-letter Stage 1 from a stale-`started_at` reaper false-positive
--       (mig 435 fixed reaper logic but left no proactive alert).
--
-- Per Joseph's explicit instruction (W11.8.1 sunset): NO Anthropic vendor
-- failover. When Gemini fails we want to KNOW, not silently retry through a
-- second vendor. This migration is observation-only — it never mutates rounds
-- or jobs, only inserts events and notifications.
--
-- ─── Rollback ──────────────────────────────────────────────────────────────
--
-- BEGIN;
-- DROP TRIGGER IF EXISTS trg_shortlisting_events_to_notifications ON public.shortlisting_events;
-- DROP FUNCTION IF EXISTS public._shortlisting_event_fanout_to_notifications();
-- SELECT cron.unschedule('shortlisting_stranded_round_auditor');
-- DROP FUNCTION IF EXISTS public.shortlisting_stranded_round_auditor();
-- COMMIT;
--

BEGIN;

-- ─── 1. Stranded-round auditor function ────────────────────────────────────
--
-- Walks shortlisting_jobs for the latest shape_d_stage1 per round, joins
-- against any stage4_synthesis row created at-or-after the stage1 finished_at,
-- and emits a `stage1_stranded` event for any round where:
--
--   * latest shape_d_stage1.status = 'succeeded'
--   * stage1.finished_at < now() - interval '10 minutes'
--   * NO stage4_synthesis row exists for that round with status IN
--     ('pending','running','succeeded') created at or after that finished_at
--   * NO existing 'stage1_stranded' event already references this stage1 job
--     (dedupe — we want one alert per stranded stage1, not one per cron tick)
--
-- This is the SAFETY NET. Stage 1's edge fn already emits
-- `manual_chain_required` synchronously when its dispatchStage4Job() returns
-- null, but if the edge fn process dies between writing
-- shape_d_stage1_complete and the chain insert, only the auditor catches it.

CREATE OR REPLACE FUNCTION public.shortlisting_stranded_round_auditor()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inserted int := 0;
  r record;
BEGIN
  FOR r IN
    WITH latest_stage1 AS (
      -- DISTINCT ON gives us the most-recent shape_d_stage1 per round.
      SELECT DISTINCT ON (j.round_id)
        j.id           AS stage1_job_id,
        j.project_id,
        j.round_id,
        j.status,
        j.finished_at
      FROM public.shortlisting_jobs j
      WHERE j.kind = 'shape_d_stage1'
      ORDER BY j.round_id, j.finished_at DESC NULLS LAST, j.created_at DESC
    )
    SELECT
      ls.stage1_job_id,
      ls.project_id,
      ls.round_id,
      ls.finished_at AS stage1_finished_at
    FROM latest_stage1 ls
    WHERE ls.status = 'succeeded'
      AND ls.finished_at IS NOT NULL
      AND ls.finished_at < (now() - interval '10 minutes')
      AND ls.round_id IS NOT NULL
      -- Stage 4 chain absent: no non-failed stage4_synthesis for the round
      -- created at or after the stage1 finished_at. We accept failed rows as
      -- "absent" because operators re-fire from the swimlane Re-fire button
      -- and a failed-then-never-retried stage4 IS effectively stranded.
      AND NOT EXISTS (
        SELECT 1 FROM public.shortlisting_jobs s4
        WHERE s4.round_id   = ls.round_id
          AND s4.kind       = 'stage4_synthesis'
          AND s4.created_at >= ls.finished_at
          AND s4.status     IN ('pending','running','succeeded')
      )
      -- Dedupe: skip rounds we already alerted on for THIS specific stage1 job
      AND NOT EXISTS (
        SELECT 1 FROM public.shortlisting_events e
        WHERE e.event_type = 'stage1_stranded'
          AND e.round_id   = ls.round_id
          AND (e.payload->>'stage1_job_id')::uuid = ls.stage1_job_id
      )
  LOOP
    INSERT INTO public.shortlisting_events (
      project_id,
      round_id,
      event_type,
      actor_type,
      actor_id,
      payload
    ) VALUES (
      r.project_id,
      r.round_id,
      'stage1_stranded',
      'system',
      NULL,
      jsonb_build_object(
        'stage1_job_id',          r.stage1_job_id,
        'stage1_finished_at',     r.stage1_finished_at,
        'minutes_since_stage1',   round(extract(epoch FROM (now() - r.stage1_finished_at)) / 60.0),
        'auditor_version',        '438',
        'detection_threshold_min', 10
      )
    );
    v_inserted := v_inserted + 1;
  END LOOP;

  RETURN v_inserted;
END;
$$;

COMMENT ON FUNCTION public.shortlisting_stranded_round_auditor() IS
  'Mig 438: every 5min via cron, finds rounds where shape_d_stage1 succeeded '
  '>10min ago without a chained stage4_synthesis row, emits stage1_stranded '
  'event. Observation-only — never mutates jobs or rounds. Dedupes by '
  '(round_id, stage1_job_id) so each stranded stage1 alerts once.';

-- ─── 2. Schedule the auditor every 5 minutes ───────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'shortlisting_stranded_round_auditor'
  ) THEN
    PERFORM cron.schedule(
      'shortlisting_stranded_round_auditor',
      '*/5 * * * *',
      'SELECT public.shortlisting_stranded_round_auditor()'
    );
  END IF;
END $$;

-- ─── 3. Trigger fanout: shortlisting_events → notifications + email queue ──
--
-- For each event_type in our observability allow-list, fan out a
-- public.notifications row per admin/master_admin user. The existing
-- after-insert trigger on notifications populates notification_email_queue
-- (mig 367) so we don't double-write here.
--
-- DEFENSIVE GUARDS:
--   * Trigger uses EXCEPTION-WHEN-OTHERS to catch any downstream failure
--     (e.g. a wedged email queue) and degrade to RAISE NOTICE — the original
--     shortlisting_events insert MUST always succeed; events visibility in
--     the Audit tab is the floor of our observability.
--   * Idempotency_key composes event id + event_type + user_id so a re-fired
--     trigger (rare — only if the event row is re-inserted via backfill)
--     can't double-alert.
--   * Severity: 'critical' for engine_vendor_failure, 'warning' for the
--     others. CTA points at the Shortlisting Command Center for the round.

CREATE OR REPLACE FUNCTION public._shortlisting_event_fanout_to_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_severity   text;
  v_title      text;
  v_message    text;
  v_cta_url    text;
  v_admin_id   uuid;
  v_round_text text := COALESCE(substring(NEW.round_id::text, 1, 8), 'no-round');
  v_proj_text  text := COALESCE(substring(NEW.project_id::text, 1, 8), 'no-proj');
  v_payload_excerpt text := COALESCE(substring(NEW.payload::text, 1, 600), '');
BEGIN
  -- Only fan-out a small allow-list of event_types. Everything else is
  -- still recorded in shortlisting_events (this trigger is fire-and-forget
  -- additive) but doesn't cut a notification.
  IF NEW.event_type NOT IN (
    'engine_vendor_failure',
    'manual_chain_required',
    'stage1_stranded',
    'canary_regression'
  ) THEN
    RETURN NEW;
  END IF;

  -- Per-event severity + copy.
  CASE NEW.event_type
    WHEN 'engine_vendor_failure' THEN
      v_severity := 'critical';
      v_title    := 'Gemini vendor failure — ' || COALESCE(NEW.payload->>'stage', '?')
                    || ' (round ' || v_round_text || ')';
      v_message  := 'Gemini returned ' || COALESCE(NEW.payload->>'status_code', '?')
                    || ' / code=' || COALESCE(NEW.payload->>'gemini_error_code', '?')
                    || ' on ' || COALESCE(NEW.payload->>'stage', 'stage?') || '. '
                    || 'No vendor failover (per W11.8.1). Operator must investigate.';
    WHEN 'manual_chain_required' THEN
      v_severity := 'warning';
      v_title    := 'Stage 4 did not auto-chain — round ' || v_round_text;
      v_message  := 'Stage 1 succeeded but Stage 4 was not dispatched. Reason: '
                    || COALESCE(NEW.payload->>'reason', 'unknown')
                    || '. Re-fire from the Shortlisting Command Center.';
    WHEN 'stage1_stranded' THEN
      v_severity := 'warning';
      v_title    := 'Round stranded after Stage 1 — ' || v_round_text;
      v_message  := 'Stage 1 finished '
                    || COALESCE(NEW.payload->>'minutes_since_stage1', '?')
                    || ' min ago with no Stage 4 chained. Auditor flagged for human review.';
    WHEN 'canary_regression' THEN
      v_severity := 'warning';
      v_title    := 'Canary regression detected — round ' || v_round_text;
      v_message  := 'Engine canary regressed — payload: ' || v_payload_excerpt;
    ELSE
      RETURN NEW;
  END CASE;

  v_cta_url := '/shortlisting/command-center?project_id=' || v_proj_text
               || '&round_id=' || v_round_text;

  -- Fan out one notification row per admin / master_admin. We could route via
  -- notification_routing_rules.recipient_user_ids when populated, but those
  -- are currently empty arrays — fall back to all admins. The existing
  -- after-insert trigger on notifications enqueues notification_email_queue.
  --
  -- DEFENSIVE: wrap in EXCEPTION block so a downstream-trigger crash on the
  -- email queue side never cancels the shortlisting_events insert.
  -- Idempotency: shortlisting_events.id is the bigserial PK (unique by
  -- definition) and we only fire AFTER INSERT, so per-event-per-admin
  -- duplication isn't possible from this trigger. The idempotency_key still
  -- carries the composed identifier so any external de-dupe flow (or the
  -- existing notification_email_queue's per-notification_id ON CONFLICT in
  -- mig 367 line 137) can use it.
  BEGIN
    FOR v_admin_id IN
      SELECT u.id
      FROM public.users u
      WHERE u.role IN ('master_admin','admin')
    LOOP
      INSERT INTO public.notifications (
        user_id,
        type,
        category,
        severity,
        title,
        message,
        project_id,
        entity_type,
        entity_id,
        cta_url,
        cta_label,
        source,
        idempotency_key
      ) VALUES (
        v_admin_id,
        NEW.event_type,
        'shortlisting',
        v_severity,
        v_title,
        v_message,
        NEW.project_id,
        'shortlisting_round',
        NEW.round_id,
        v_cta_url,
        'Open Round',
        -- notifications.source is constrained — 'system' is the closest
        -- allowed bucket for engine-emitted observability events.
        'system',
        'shortlisting_event:' || NEW.id::text || ':' || NEW.event_type || ':' || v_admin_id::text
      );
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'shortlisting_event fanout failed (event_id=% type=%): %',
      NEW.id, NEW.event_type, SQLERRM;
    -- Swallow — the original shortlisting_events insert MUST commit.
  END;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public._shortlisting_event_fanout_to_notifications() IS
  'Mig 438: fan-out trigger that emits a public.notifications row per admin '
  'whenever a shortlisting_events row of an alertable type lands. Wrapped '
  'in EXCEPTION-WHEN-OTHERS so a wedged email queue can never roll back the '
  'event insert. Allow-list: engine_vendor_failure, manual_chain_required, '
  'stage1_stranded, canary_regression.';

DROP TRIGGER IF EXISTS trg_shortlisting_events_to_notifications
  ON public.shortlisting_events;

CREATE TRIGGER trg_shortlisting_events_to_notifications
  AFTER INSERT ON public.shortlisting_events
  FOR EACH ROW
  EXECUTE FUNCTION public._shortlisting_event_fanout_to_notifications();

-- ─── 4. Notification routing rule rows for new event types ─────────────────
--
-- Versioning rule (mig docs say): edits insert at version+1 and deactivate
-- the prior. These are NEW types — version 1, is_active true, empty
-- recipient_user_ids (the trigger fans out via role lookup).

INSERT INTO public.notification_routing_rules (
  notification_type, recipient_user_ids, version, is_active
) VALUES
  ('engine_vendor_failure', ARRAY[]::uuid[], 1, true),
  ('manual_chain_required', ARRAY[]::uuid[], 1, true),
  ('stage1_stranded',       ARRAY[]::uuid[], 1, true)
ON CONFLICT (notification_type, version) DO NOTHING;

-- ─── 5. Sanity-comment touchpoint on shortlisting_events ───────────────────
COMMENT ON TABLE public.shortlisting_events IS
  'Append-only audit log for the shortlisting engine. 90-day retention via '
  'cron job shortlisting-events-retention (mig 331); milestone events '
  '(pass*_complete, shortlist_locked, benchmark_complete) retained '
  'indefinitely. Mig 438 added engine observability event_types: '
  'engine_vendor_failure, manual_chain_required, stage1_stranded — these '
  'fire admin notifications via trigger fanout.';

COMMIT;
