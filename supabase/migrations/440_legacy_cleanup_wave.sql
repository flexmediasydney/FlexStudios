-- ─────────────────────────────────────────────────────────────────────────
-- Mig 439 — Legacy cleanup wave
-- ─────────────────────────────────────────────────────────────────────────
--
-- Date: 2026-05-02
-- Wave: post-W11.7.10 sunset cleanup
--
-- Joseph: "this has all been under testing, why are we still trying to
-- accommodate old legacy thinking and code — clean this up, we don't need
-- to account for them."
--
-- This migration is the DATA half of the wave. The CODE half (Tracks A, B,
-- C — see commit log) lands separately. Together they retire the last
-- traces of the two-pass shortlisting engine and the W11.7 / W15b7 testing
-- snapshots that have been accumulating during the schema thrash.
--
-- ─── SCOPE — what this migration does ────────────────────────────────────
--
-- 1. DROP TABLE _saladine_two_pass_snapshot  (42 rows, 128 kB)
-- 2. DROP TABLE _w11_7_null_classifications_backup  (33 rows, 320 kB)
-- 3. DROP TABLE w15b7_smoke_50_baseline  (50 rows, 32 kB)
--
-- All three are testing-era snapshot tables. Mig 431 listed them as Class A
-- (master_admin SELECT only) so they had no live consumers and live
-- consumers can't have appeared since. Verified pre-migration:
--
--   $ grep -rn "_saladine_two_pass_snapshot\|_w11_7_null_classifications_backup\|w15b7_smoke_50_baseline" \
--       flexmedia-src/src/ supabase/functions/
--   (no output — zero references in code)
--
-- And the FK survey:
--
--   SELECT … FROM information_schema.table_constraints
--   WHERE … any of these three tables appear as either side of an FK …
--   (no output — zero foreign keys in or out)
--
-- ─── SCOPE — what this migration does NOT do ─────────────────────────────
--
-- Surveyed but DEFERRED (still load-bearing):
--
-- - legacy_package_aliases (61 rows): consumed by the Pulse market-share
--   captured-projects flow. Keep.
-- - legacy_import_batches (1 row) + legacy_projects (3,480 rows): consumed
--   by importLegacyProjects, geocodeLegacyProjects, pulseRecomputeLegacy
--   edge fns + LegacyMarketShareReport / LegacyRecomputeButton frontend.
--   Keep.
-- - shortlisting_rounds.engine_mode column: still required (every round
--   stamps shape_d_full or shape_d_partial). Just the 'two_pass' VALUE is
--   retired — but since the column is plain TEXT (verified: udt_name='text'),
--   there's no enum to ALTER. The code-side block (Track A) is what
--   enforces the 'two_pass' rejection at the orchestrator boundary.
-- - engine_run_audit.legacy_pass1_*/legacy_pass2_* columns: every
--   production row has them as 0 since the W11.7.10 sunset. Columns
--   retained as immutable history — pre-W11.7.10 audit rows still need
--   to be read from this table for the cost-per-round audit page even
--   after Track C drops the live cost-line render.
--
-- ─── ROW COUNTS AT DELETE TIME ───────────────────────────────────────────
--
-- The numbers here are recorded so a manual pg_dump restore from a Supabase
-- automatic backup is auditable if ever needed. Snapshot timestamp:
-- 2026-05-02 (mig 439 apply day).
--
--   _saladine_two_pass_snapshot              42 rows
--   _w11_7_null_classifications_backup       33 rows
--   w15b7_smoke_50_baseline                  50 rows
--
-- ─── ROLLBACK ────────────────────────────────────────────────────────────
--
-- 1. Restore from a Supabase automatic point-in-time backup taken before
--    the 2026-05-02 mig-439 apply window. Use the dashboard's
--    Database → Backups page; pick a timestamp ≤ the mig 439 apply time.
--
-- 2. After PITR, the three tables will exist again with their original
--    rows (snapshot row counts above). The mig 439 entry in
--    schema_migrations will have been rolled back along with the rest of
--    the database state, so re-applying mig 439 is a no-op until you
--    decide to re-drop them.
--
-- 3. If a partial restore is needed (e.g. only one of the three tables),
--    use pg_restore -t <table_name> from a downloaded backup against a
--    staging instance, then COPY the row data into a fresh table on prod.
--    The schemas were:
--
--      -- _saladine_two_pass_snapshot:
--      --   group_id text PRIMARY KEY
--      --   stem text
--      --   raw_classification jsonb
--      --   created_at timestamptz default now()
--      -- (Mig 431 added: ENABLE ROW LEVEL SECURITY + master_admin-only SELECT)
--
--      -- _w11_7_null_classifications_backup:
--      --   group_id uuid PRIMARY KEY
--      --   round_id uuid
--      --   stem text
--      --   raw jsonb
--      --   created_at timestamptz default now()
--      -- (Mig 431 added: ENABLE ROW LEVEL SECURITY + master_admin-only SELECT)
--
--      -- w15b7_smoke_50_baseline:
--      --   group_id uuid
--      --   stem text
--      --   combined_score numeric
--      --   classification jsonb
--      --   captured_at timestamptz default now()
--      -- (Mig 431 added: ENABLE ROW LEVEL SECURITY + master_admin-only SELECT)
--
--    These are approximations from the mig 431 RLS bindings — the exact
--    shape is whatever a `\d <table>` dumped at the time of mig 431 would
--    show. PITR restore returns the exact shape.
--
-- ─────────────────────────────────────────────────────────────────────────

BEGIN;

-- ─── (1) Drop the testing-era snapshot tables ───────────────────────────
--
-- DROP TABLE … RESTRICT (the default) — fails if a dependent object
-- exists that we missed in the FK survey. We want that fail-loud
-- behaviour: better to abort the migration than silently CASCADE
-- something that wasn't audited.

DROP TABLE IF EXISTS public._saladine_two_pass_snapshot RESTRICT;
DROP TABLE IF EXISTS public._w11_7_null_classifications_backup RESTRICT;
DROP TABLE IF EXISTS public.w15b7_smoke_50_baseline RESTRICT;

-- ─── (2) Verify the drop took effect ────────────────────────────────────
--
-- Belt-and-braces guard: if the DROPs above silently no-op'd (the
-- IF EXISTS clauses make that possible if the table name is wrong)
-- the assertion below would pass anyway. The point of the DO block
-- is to make the apply log explicit — a downstream reader of the
-- migration log can grep for "mig 439 dropped" and confirm.

DO $$
DECLARE
  drop_count int;
BEGIN
  SELECT COUNT(*) INTO drop_count
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN (
      '_saladine_two_pass_snapshot',
      '_w11_7_null_classifications_backup',
      'w15b7_smoke_50_baseline'
    );
  IF drop_count > 0 THEN
    RAISE EXCEPTION 'mig 439: expected zero rows after drop, found %', drop_count;
  END IF;
  RAISE NOTICE 'mig 439 dropped 3 testing-era snapshot tables';
END;
$$;

COMMIT;
