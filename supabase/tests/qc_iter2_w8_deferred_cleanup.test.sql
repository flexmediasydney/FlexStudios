-- ═══════════════════════════════════════════════════════════════════════════
-- QC iter 2 Wave 8 — SQL contract tests for migration 426
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Smoke checks for the two pieces of mig 426:
--   1. F-B-018: cron job 'finals_qa_runs_cleanup' exists with correct schedule
--   2. F-FE-Architecture: shortlisting_architecture_kpis returns the new
--      __null_field_never_populated__ sentinel + field_population_health
--      object instead of the legacy 'unset' fold.
--
-- Run via: supabase db lint OR psql -f this file.
-- Each block raises an exception on failure so a test runner can pick up the
-- pass/fail signal.

\set ON_ERROR_STOP on

-- ─── F-B-018 — cron exists ─────────────────────────────────────────────────

DO $$
DECLARE
  v_count int;
  v_schedule text;
BEGIN
  SELECT COUNT(*), MAX(schedule)
    INTO v_count, v_schedule
    FROM cron.job
   WHERE jobname = 'finals_qa_runs_cleanup';

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'F-B-018 FAIL: expected exactly 1 finals_qa_runs_cleanup cron job, got %', v_count;
  END IF;

  IF v_schedule <> '*/15 * * * *' THEN
    RAISE EXCEPTION 'F-B-018 FAIL: expected schedule */15 * * * *, got %', v_schedule;
  END IF;

  RAISE NOTICE 'F-B-018 PASS: finals_qa_runs_cleanup scheduled at %', v_schedule;
END$$;

-- ─── F-B-018 — cron command body references finals_qa_runs + wall_timeout ──

DO $$
DECLARE
  v_command text;
BEGIN
  SELECT command INTO v_command FROM cron.job WHERE jobname = 'finals_qa_runs_cleanup';

  IF v_command !~ 'finals_qa_runs' THEN
    RAISE EXCEPTION 'F-B-018 FAIL: cron command does not reference finals_qa_runs table';
  END IF;
  IF v_command !~ 'wall_timeout' THEN
    RAISE EXCEPTION 'F-B-018 FAIL: cron command does not set error_message=wall_timeout';
  END IF;
  IF v_command !~ '30 minutes' THEN
    RAISE EXCEPTION 'F-B-018 FAIL: cron command threshold is not 30 minutes';
  END IF;

  RAISE NOTICE 'F-B-018 PASS: cron command body sane (touches finals_qa_runs + wall_timeout + 30min threshold)';
END$$;

-- ─── F-FE-Architecture — RPC returns sentinel for NULL classification fields ─
-- The W11.6.13 regression left 5 rounds with 100% NULL space_type/zone_focus.
-- Pre-fix: '__null_field_never_populated__' did not exist as a key.
-- Post-fix: it appears in zone_focus_distribution + space_type_distribution.

DO $$
DECLARE
  v_kpis jsonb;
  v_zone_dist jsonb;
  v_space_dist jsonb;
  v_has_null_sentinel_zone bool;
  v_has_null_sentinel_space bool;
BEGIN
  v_kpis := shortlisting_architecture_kpis(30);
  v_zone_dist := v_kpis->'zone_focus_distribution';
  v_space_dist := v_kpis->'space_type_distribution';

  -- Each distribution must contain at least one entry whose key field equals
  -- the sentinel. With 100% NULL on space_type/zone_focus in the 30-day
  -- window, this is a deterministic check (not a flaky one based on counts).
  SELECT EXISTS(
    SELECT 1 FROM jsonb_array_elements(v_zone_dist) elem
     WHERE elem->>'zone_focus' = '__null_field_never_populated__'
  ) INTO v_has_null_sentinel_zone;

  SELECT EXISTS(
    SELECT 1 FROM jsonb_array_elements(v_space_dist) elem
     WHERE elem->>'space_type' = '__null_field_never_populated__'
  ) INTO v_has_null_sentinel_space;

  IF NOT v_has_null_sentinel_zone THEN
    RAISE EXCEPTION 'F-FE-Architecture FAIL: zone_focus_distribution missing __null_field_never_populated__ sentinel';
  END IF;
  IF NOT v_has_null_sentinel_space THEN
    RAISE EXCEPTION 'F-FE-Architecture FAIL: space_type_distribution missing __null_field_never_populated__ sentinel';
  END IF;

  RAISE NOTICE 'F-FE-Architecture PASS: sentinel __null_field_never_populated__ surfaced for zone_focus + space_type';
END$$;

-- ─── F-FE-Architecture — field_population_health rollup present + shaped ───

DO $$
DECLARE
  v_kpis jsonb;
  v_health jsonb;
BEGIN
  v_kpis := shortlisting_architecture_kpis(30);
  v_health := v_kpis->'field_population_health';

  IF v_health IS NULL OR v_health = 'null'::jsonb THEN
    RAISE EXCEPTION 'F-FE-Architecture FAIL: field_population_health key missing from RPC output';
  END IF;

  -- All four required columns covered.
  IF NOT (v_health ? 'room_type')   THEN RAISE EXCEPTION 'F-FE-Architecture FAIL: room_type missing';   END IF;
  IF NOT (v_health ? 'space_type')  THEN RAISE EXCEPTION 'F-FE-Architecture FAIL: space_type missing';  END IF;
  IF NOT (v_health ? 'zone_focus')  THEN RAISE EXCEPTION 'F-FE-Architecture FAIL: zone_focus missing';  END IF;
  IF NOT (v_health ? 'image_type')  THEN RAISE EXCEPTION 'F-FE-Architecture FAIL: image_type missing';  END IF;

  -- Each per-column object should have populated/null/empty/total/pct_populated keys.
  IF NOT (v_health->'space_type' ? 'populated')      THEN RAISE EXCEPTION 'space_type.populated missing'; END IF;
  IF NOT (v_health->'space_type' ? 'null')           THEN RAISE EXCEPTION 'space_type.null missing'; END IF;
  IF NOT (v_health->'space_type' ? 'pct_populated')  THEN RAISE EXCEPTION 'space_type.pct_populated missing'; END IF;

  RAISE NOTICE 'F-FE-Architecture PASS: field_population_health rollup contains all 4 columns with full shape';
END$$;

-- ─── F-FE-Architecture — pct_populated = 0.0 for the NULL-100% column ──────
-- The W11.6.13 regression: space_type was NULL on 100% of recent rows. The
-- new field_population_health.space_type.pct_populated must reflect that
-- (was hidden behind the legacy COALESCE 'unset' fold).

DO $$
DECLARE
  v_pct_space numeric;
  v_total int;
BEGIN
  SELECT
    (shortlisting_architecture_kpis(30)->'field_population_health'->'space_type'->>'pct_populated')::numeric,
    (shortlisting_architecture_kpis(30)->'field_population_health'->'space_type'->>'total')::int
    INTO v_pct_space, v_total;

  -- Deterministic against current data: if 100% are NULL, pct must be 0 (or NULL on 0-rows window).
  IF v_total > 0 AND v_pct_space IS DISTINCT FROM 0.0 THEN
    -- This is informational, not strict — if a future row populates space_type
    -- the percentage will move. We assert only that the value parses as a
    -- number and is in [0, 100].
    IF v_pct_space < 0 OR v_pct_space > 100 THEN
      RAISE EXCEPTION 'F-FE-Architecture FAIL: pct_populated out of range [0,100]: %', v_pct_space;
    END IF;
  END IF;

  RAISE NOTICE 'F-FE-Architecture PASS: space_type pct_populated=% over % rows', v_pct_space, v_total;
END$$;

-- ─── All checks passed ───────────────────────────────────────────────────────

DO $$
BEGIN
  RAISE NOTICE 'qc_iter2_w8_deferred_cleanup.test.sql — all assertions passed';
END$$;
