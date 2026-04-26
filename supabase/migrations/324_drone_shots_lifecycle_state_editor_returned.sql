-- ═══════════════════════════════════════════════════════════════════════════
-- 324: Wave 13 D — formalize editor_returned lifecycle state on drone_shots.
-- ───────────────────────────────────────────────────────────────────────────
-- Today the editor handoff is implicit in (lifecycle_state='raw_accepted' AND
-- edited_dropbox_path IS NOT NULL). Making it an explicit state lets the UI
-- filter swimlanes cleanly and lets RLS reason about it.
--
-- Live constraint pre-mig (verified via pg_get_constraintdef on
-- drone_shots_lifecycle_state_check):
--   CHECK ((lifecycle_state IS NULL) OR (lifecycle_state = ANY (ARRAY[
--     'raw_proposed','raw_accepted','rejected','sfm_only'])))
--
-- We preserve the NULL allowance (legacy rows pre-mig 259) and append
-- 'editor_returned' to the IN list. No earlier migration after 242 touched
-- this constraint.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE drone_shots
  DROP CONSTRAINT IF EXISTS drone_shots_lifecycle_state_check;

ALTER TABLE drone_shots
  ADD CONSTRAINT drone_shots_lifecycle_state_check
  CHECK (lifecycle_state IS NULL OR lifecycle_state = ANY (ARRAY[
    'sfm_only'::text,
    'raw_proposed'::text,
    'raw_accepted'::text,
    'editor_returned'::text,
    'final'::text,
    'rejected'::text
  ]));

-- Backfill: any raw_accepted shots that already have edited_dropbox_path set
-- get promoted (their state was implicit before).
UPDATE drone_shots
  SET lifecycle_state = 'editor_returned'
  WHERE lifecycle_state = 'raw_accepted'
    AND edited_dropbox_path IS NOT NULL;

COMMENT ON COLUMN drone_shots.lifecycle_state IS
  'Wave 13 D: explicit lifecycle state machine. Values: sfm_only (initial post-SfM) → raw_proposed (AI shortlisted) → raw_accepted (operator picked) → editor_returned (editor delivered post-prod file) → final (operator approved deliverable) | rejected (operator vetoed). NULL retained for legacy pre-mig 259 rows. Transitions enforced by drone_shots_block_direct_lifecycle_update trigger; state-machine-aware updates flow through drone-shot-lifecycle Edge Fn.';

NOTIFY pgrst, 'reload schema';
