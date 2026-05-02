-- ═══════════════════════════════════════════════════════════════════════════
-- F-3D-005 stuck-round-reaper — SQL contract tests for migration 429
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Tests:
--   1. Cron job 'shortlisting_round_stuck_reaper' is registered with the
--      correct schedule */15 * * * *.
--   2. Synthetic round inserted with status='processing' AND started_at older
--      than 2 hours → reaper run → row flipped to 'failed' AND error_summary
--      populated AND completed_at set AND shortlisting_events row emitted.
--   3. Round with status='processing' AND started_at = NOW() - 1 hour is NOT
--      reaped (under threshold).
--   4. Reaper preserves a pre-existing error_summary (append, not replace).
--   5. Round with status='proposed'/'pending'/'locked'/'failed' (any non-
--      'processing' status) is NEVER reaped, regardless of age.
--
-- Run via: supabase db lint OR psql -f this file. Tests run inside a
-- transaction that rolls back at the end so they don't leave fixture rows
-- behind.

\set ON_ERROR_STOP on

BEGIN;

-- ─── Test 1: cron registration ────────────────────────────────────────────
DO $$
DECLARE
  v_count int;
  v_schedule text;
BEGIN
  SELECT COUNT(*), MAX(schedule)
    INTO v_count, v_schedule
    FROM cron.job
   WHERE jobname = 'shortlisting_round_stuck_reaper';

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'F-3D-005 T1 FAIL: expected exactly 1 reaper cron job, got %', v_count;
  END IF;
  IF v_schedule <> '*/15 * * * *' THEN
    RAISE EXCEPTION 'F-3D-005 T1 FAIL: expected schedule */15 * * * *, got %', v_schedule;
  END IF;

  RAISE NOTICE 'F-3D-005 T1 PASS: reaper scheduled at %', v_schedule;
END$$;

-- ─── Setup: pick a real project_id so FK constraints don't blow up ────────
DO $$
DECLARE
  v_project_id uuid;
  v_round_a uuid := gen_random_uuid();  -- stuck > 2h, processing, no prior err
  v_round_b uuid := gen_random_uuid();  -- young (1h), processing — should NOT reap
  v_round_c uuid := gen_random_uuid();  -- stuck, proposed — should NOT reap
  v_round_d uuid := gen_random_uuid();  -- stuck, processing, with prior err
  v_reaped int;
  v_status_a text;
  v_status_b text;
  v_status_c text;
  v_status_d text;
  v_err_a text;
  v_err_d text;
  v_completed_a timestamptz;
  v_event_count int;
BEGIN
  -- Borrow any real project_id (FK-safe). Tests scope by ID below.
  SELECT id INTO v_project_id FROM public.projects LIMIT 1;
  IF v_project_id IS NULL THEN
    RAISE EXCEPTION 'F-3D-005 setup FAIL: no projects in DB to borrow id from';
  END IF;

  -- Insert four fixture rounds.
  INSERT INTO public.shortlisting_rounds (
    id, project_id, round_number, status, started_at, total_compositions
  ) VALUES
    (v_round_a, v_project_id, 9001, 'processing', NOW() - INTERVAL '3 hours', 0),
    (v_round_b, v_project_id, 9002, 'processing', NOW() - INTERVAL '1 hour',  0),
    (v_round_c, v_project_id, 9003, 'proposed',   NOW() - INTERVAL '5 hours', 0),
    (v_round_d, v_project_id, 9004, 'processing', NOW() - INTERVAL '4 hours', 0);

  -- Pre-existing error on round D so we can verify append semantics.
  UPDATE public.shortlisting_rounds
     SET error_summary = 'pre-existing operator note'
   WHERE id = v_round_d;

  -- Run the reaper.
  SELECT public.shortlisting_round_stuck_reaper() INTO v_reaped;

  -- ─── T2: round A (stuck, no prior err) flipped to failed ─────────────────
  SELECT status, error_summary, completed_at
    INTO v_status_a, v_err_a, v_completed_a
    FROM public.shortlisting_rounds WHERE id = v_round_a;

  IF v_status_a <> 'failed' THEN
    RAISE EXCEPTION 'F-3D-005 T2 FAIL: round A status expected ''failed'', got ''%''', v_status_a;
  END IF;
  IF v_err_a IS NULL OR v_err_a NOT LIKE '%wall_timeout%stuck-round-reaper%' THEN
    RAISE EXCEPTION 'F-3D-005 T2 FAIL: round A error_summary not set: ''%''', v_err_a;
  END IF;
  IF v_completed_a IS NULL THEN
    RAISE EXCEPTION 'F-3D-005 T2 FAIL: round A completed_at not set';
  END IF;

  -- shortlisting_events row should have been emitted
  SELECT COUNT(*) INTO v_event_count
    FROM public.shortlisting_events
   WHERE round_id = v_round_a AND event_type = 'auto_fail_stuck_round';
  IF v_event_count <> 1 THEN
    RAISE EXCEPTION 'F-3D-005 T2 FAIL: expected 1 auto_fail_stuck_round event for A, got %', v_event_count;
  END IF;

  RAISE NOTICE 'F-3D-005 T2 PASS: stuck round flipped to failed + event emitted';

  -- ─── T3: round B (1h old) preserved ──────────────────────────────────────
  SELECT status INTO v_status_b FROM public.shortlisting_rounds WHERE id = v_round_b;
  IF v_status_b <> 'processing' THEN
    RAISE EXCEPTION 'F-3D-005 T3 FAIL: round B (1h old) was reaped; expected status ''processing'', got ''%''', v_status_b;
  END IF;
  RAISE NOTICE 'F-3D-005 T3 PASS: under-threshold round preserved';

  -- ─── T4: round C (proposed, age irrelevant) preserved ────────────────────
  SELECT status INTO v_status_c FROM public.shortlisting_rounds WHERE id = v_round_c;
  IF v_status_c <> 'proposed' THEN
    RAISE EXCEPTION 'F-3D-005 T4 FAIL: round C (proposed) was reaped; expected status ''proposed'', got ''%''', v_status_c;
  END IF;
  RAISE NOTICE 'F-3D-005 T4 PASS: non-processing round preserved';

  -- ─── T5: round D (had prior err) preserved + appended ────────────────────
  SELECT status, error_summary INTO v_status_d, v_err_d
    FROM public.shortlisting_rounds WHERE id = v_round_d;
  IF v_status_d <> 'failed' THEN
    RAISE EXCEPTION 'F-3D-005 T5 FAIL: round D status expected ''failed'', got ''%''', v_status_d;
  END IF;
  IF v_err_d NOT LIKE 'pre-existing operator note%' THEN
    RAISE EXCEPTION 'F-3D-005 T5 FAIL: round D lost its prior error: ''%''', v_err_d;
  END IF;
  IF v_err_d NOT LIKE '%wall_timeout%' THEN
    RAISE EXCEPTION 'F-3D-005 T5 FAIL: round D missing reaper message: ''%''', v_err_d;
  END IF;
  RAISE NOTICE 'F-3D-005 T5 PASS: existing error_summary preserved + reaper msg appended';

  -- Sanity: reap count should be exactly 2 (A + D)
  IF v_reaped <> 2 THEN
    RAISE EXCEPTION 'F-3D-005 reap-count FAIL: expected 2 reaped, got %', v_reaped;
  END IF;
  RAISE NOTICE 'F-3D-005 reap-count PASS: % reaped', v_reaped;
END$$;

ROLLBACK;
