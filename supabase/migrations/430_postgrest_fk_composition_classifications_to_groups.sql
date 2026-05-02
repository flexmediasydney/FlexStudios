-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 430 — PostgREST FK: composition_classifications → composition_groups
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Stage 4 (shortlisting-shape-d Stage 4 / shortlisting-finals-qa) calls
-- PostgREST with an embedded select like
--   composition_classifications?select=*,composition_groups(*)
-- For PostgREST to infer that join, there must be a foreign key
-- composition_classifications.group_id → composition_groups.id. The column
-- exists and is NOT NULL, but the FK constraint was never added — so
-- PostgREST returns "Could not find a relationship between
-- 'composition_classifications' and 'composition_groups' in the schema cache"
-- and Stage 4 fails 2s after pickup.
--
-- Discovered via Stage 4 re-fire job baaf2e74-2be1-4464-a7ee-245363d6c2fa on
-- round c55374b1 (Rainbow Cres) on 2026-05-02.
--
-- Why NOT VALID:
-- There are 5 pre-existing orphan rows in composition_classifications whose
-- group_id has no matching composition_groups.id. They all belong to project
-- 1be81086-fb7f-4203-a7ef-9a161eec6611, classified 2026-05-01 12:54, source
-- 'internal_finals', round_id=null. Validating immediately would fail the
-- constraint creation. NOT VALID:
--   - lets PostgREST see the relationship for join inference (the only thing
--     that matters for the Stage 4 unblock)
--   - enforces FK on every NEW insert / update going forward
--   - leaves the existing orphans untouched until we triage them
-- A follow-up cleanup migration can VALIDATE the constraint after the
-- orphans are deleted or repointed.
--
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Forward
ALTER TABLE public.composition_classifications
  ADD CONSTRAINT composition_classifications_group_id_fkey
  FOREIGN KEY (group_id) REFERENCES public.composition_groups(id)
  NOT VALID;

COMMENT ON CONSTRAINT composition_classifications_group_id_fkey
  ON public.composition_classifications IS
  'mig 430: NOT VALID FK so PostgREST can infer the embedded join used by '
  'Stage 4 (shortlisting-shape-d / shortlisting-finals-qa). 5 pre-existing '
  'orphan rows from project 1be81086 (2026-05-01) are not validated; cleanup '
  'and VALIDATE in a follow-up migration once triaged.';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- Rollback (run manually if this migration breaks production):
--
-- ALTER TABLE public.composition_classifications
--   DROP CONSTRAINT IF EXISTS composition_classifications_group_id_fkey;
-- NOTIFY pgrst, 'reload schema';
--
-- Note: rollback is non-destructive (no data loss). After rollback, Stage 4
-- regresses to the failing state — only do this if a worse problem emerges.
