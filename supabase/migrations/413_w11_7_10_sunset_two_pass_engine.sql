-- 413_w11_7_10_sunset_two_pass_engine.sql
--
-- W11.7.10 — pass1+pass2 deprecation + zombie engine_settings cleanup.
--
-- Sunset of the legacy two-pass engine, dispatched 2026-05-02 (~24h after
-- the W11.7.17 keystone cutover validated successfully on Gemini Pro).
-- The original spec scheduled this for ~June 1 (30-day kill-switch window);
-- Joseph approved early sunset after multiple successful Stage 4 runs
-- demonstrated Shape D stability + W11.8.1 stripped the Anthropic failover
-- code path + W11.8.2 fixed pricing/audit instrumentation.
--
-- Code-side changes (in the same commit as this migration):
--   - supabase/functions/shortlisting-pass1/  DELETED
--   - supabase/functions/shortlisting-pass2/  DELETED
--   - shortlisting-job-dispatcher: KIND_TO_FUNCTION pass1 + pass2 entries
--     removed; pass0 → next-kind chain hardcoded to 'shape_d_stage1' (was
--     conditionally pass1 OR shape_d_stage1 depending on engine_mode).
--   - _shared/anthropicVision.ts KEPT (still used by pass0 for Haiku +
--     benchmark-runner for A/B tests; not legacy-only).
--   - _shared/pass2Prompt.ts KEPT (still imported by benchmark-runner).
--
-- Historical preservation: rounds with engine_mode='two_pass' or
-- engine_mode='unified_anthropic_failover' (2 + 0 rows respectively in prod
-- as of 2026-05-02) remain immutable. No CHECK constraint added to
-- shortlisting_rounds.engine_mode (column is and remains free-form text);
-- the absence of pass1/pass2 edge fns is the structural enforcement that
-- prevents new two_pass rounds.
--
-- DB-side cleanup: remove the two zombie engine_settings rows that have
-- been dead since W11.8.1 stripped the Anthropic adapter (production_vendor
-- + failover_vendor — code now hardcodes 'google' and never reads these).

-- Step 1: Delete zombie engine_settings rows
DELETE FROM engine_settings
WHERE key IN ('production_vendor', 'failover_vendor');

-- Step 2: Observability — log row counts pre + post
DO $$
DECLARE
  v_two_pass_rounds int;
  v_shape_d_rounds  int;
  v_pass_jobs       int;
  v_remaining_settings int;
BEGIN
  SELECT COUNT(*) INTO v_two_pass_rounds
    FROM shortlisting_rounds WHERE engine_mode = 'two_pass';
  SELECT COUNT(*) INTO v_shape_d_rounds
    FROM shortlisting_rounds WHERE engine_mode LIKE 'shape_d%';
  SELECT COUNT(*) INTO v_pass_jobs
    FROM shortlisting_jobs WHERE kind IN ('pass1', 'pass2');
  SELECT COUNT(*) INTO v_remaining_settings
    FROM engine_settings;

  RAISE NOTICE
    'Migration 413 W11.7.10: sunset complete — historical_two_pass_rounds=%, shape_d_rounds=%, historical_pass1_pass2_jobs=%, engine_settings_rows_remaining=%',
    v_two_pass_rounds, v_shape_d_rounds, v_pass_jobs, v_remaining_settings;
END $$;
