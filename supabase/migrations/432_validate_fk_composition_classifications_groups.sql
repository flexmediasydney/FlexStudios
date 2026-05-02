-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 432 — VALIDATE FK composition_classifications.group_id
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Mig 430 added the FK constraint as NOT VALID because 5 pre-existing orphan
-- rows in composition_classifications had no parent in composition_groups
-- (project 1be81086, classified 2026-05-01 12:54, source internal_finals,
-- round_id null). The NOT VALID form let PostgREST infer the embedded-select
-- relationship without forcing immediate cleanup.
--
-- Pre-flight on 2026-05-02 confirmed those 5 rows are unreferenced anywhere:
--   raw_attribute_observations.group_id        — 0 references
--   shortlisting_events.group_id               — 0 references
--   composition_classification_overrides       — 0 references
-- They are safe to delete, after which the FK can be VALIDATEd to enforce
-- the constraint over the entire table.
--
-- This migration:
--   1. Deletes the 5 orphan classifications.
--   2. VALIDATEs the FK so future inserts/updates AND existing rows are all
--      enforced by Postgres.
--
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Forward — delete the 5 known orphans by exact id (audit trail in mig 430
-- comment + the orchestrator's 2026-05-02 SQL log).
DELETE FROM public.composition_classifications
 WHERE id IN (
   'c200f7cc-fc0c-41c1-bbff-f3a1679f67f2',
   '8b5ea65c-8e4c-49f4-b338-6ebbbe886351',
   '1d6984f2-0d67-4e21-a43d-89a8262b7d8b',
   '68e2edd3-b69b-4249-a92d-450f6af0a7c4',
   '8ce03691-3001-42dc-aaa1-d080036f9d4b'
 );

-- Belt & braces — defensive sweep for any other orphan that may have been
-- written between mig 430 and this migration (the FK was NOT VALID, so new
-- inserts WERE constraint-checked, but a logical bug could still in theory
-- leak one through). Catch + delete those before VALIDATE.
DELETE FROM public.composition_classifications cc
 WHERE NOT EXISTS (
   SELECT 1 FROM public.composition_groups cg WHERE cg.id = cc.group_id
 );

-- Promote the FK from NOT VALID to fully validated. With the orphans gone,
-- this is a metadata-only change (no full table scan needed beyond the
-- one Postgres does automatically — fast on this table).
ALTER TABLE public.composition_classifications
  VALIDATE CONSTRAINT composition_classifications_group_id_fkey;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- Rollback (run manually if this migration breaks production):
--
-- 1) The deletes are non-recoverable without a backup. Snapshot first if you
--    plan to roll back:
--      CREATE TABLE _rollback_432_orphan_classifications AS
--        SELECT * FROM public.composition_classifications WHERE id IN (...);
--    (Can't be done after the fact — the rows are gone.)
--
-- 2) To downgrade the constraint back to NOT VALID:
--      ALTER TABLE public.composition_classifications
--        DROP CONSTRAINT composition_classifications_group_id_fkey;
--      ALTER TABLE public.composition_classifications
--        ADD CONSTRAINT composition_classifications_group_id_fkey
--        FOREIGN KEY (group_id) REFERENCES public.composition_groups(id)
--        NOT VALID;
--      NOTIFY pgrst, 'reload schema';
