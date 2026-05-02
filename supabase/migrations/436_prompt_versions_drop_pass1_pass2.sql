-- 435_prompt_versions_drop_pass1_pass2.sql
--
-- pass1_system / pass2_system were sunset alongside the pass1/pass2 engine
-- in W11.7.10 (commit 15b0579). Stage 1 / Stage 4 prompts are now assembled
-- in code from supabase/functions/_shared/visionPrompts/ blocks and are not
-- DB-tunable; only pass0_reject is still live (loaded by promptLoader.ts and
-- consumed by shortlisting-pass0).
--
-- This migration:
--   1. Deletes the 2 stale rows (pass1_system + pass2_system).
--   2. Tightens the pass_kind CHECK constraint to only allow 'pass0_reject'.

DELETE FROM shortlisting_prompt_versions
WHERE pass_kind IN ('pass1_system', 'pass2_system');

ALTER TABLE shortlisting_prompt_versions
  DROP CONSTRAINT IF EXISTS shortlisting_prompt_versions_pass_kind_check;

ALTER TABLE shortlisting_prompt_versions
  ADD CONSTRAINT shortlisting_prompt_versions_pass_kind_check
  CHECK (pass_kind = 'pass0_reject');
