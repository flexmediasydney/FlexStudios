-- 242: drone_shots lifecycle state, edited dropbox path, AI recommendation flag,
-- and a new nadir_hero shot_role for isolated MLS-hero nadirs.
--
-- Context:
--   The drone Curation flow (Wave 2) introduces operator-managed swimlanes:
--     - raw_proposed: AI-suggested candidate set the operator triages
--     - raw_accepted: operator promoted (will be delivered)
--     - rejected: operator rejected (un-rejectable, never delivered)
--     - sfm_only: nadir-grid SfM input, never delivered
--   `lifecycle_state` records that decision per drone_shots row.
--
--   Post-prod team drops edited JPGs in Drones/Editors/Edited Post Production/.
--   `edited_dropbox_path` records that path; drone-render uses it as the source
--   for non-SfM shots when present (otherwise the raw drone JPG is used).
--
--   The smart shortlist algorithm (Wave 2) sets `is_ai_recommended` on the
--   shots it picks. Operator can ignore.
--
--   `nadir_hero` (new shot_role) distinguishes isolated single nadirs (MLS hero
--   shots — delivered) from sequential nadir-grid bursts (SfM input — not
--   delivered). The classifier post-pass refineNadirClassifications() in
--   _shared/droneIngest.ts assigns this role.

-- ─── 1. lifecycle_state column + check constraint ───────────────────────────

ALTER TABLE drone_shots
  ADD COLUMN IF NOT EXISTS lifecycle_state text DEFAULT NULL;

-- Postgres has no `ADD CONSTRAINT IF NOT EXISTS` for CHECK constraints, so we
-- guard the ADD with a DO-block exception handler.
DO $$
BEGIN
  ALTER TABLE drone_shots
    ADD CONSTRAINT drone_shots_lifecycle_state_check
    CHECK (lifecycle_state IS NULL OR lifecycle_state = ANY (ARRAY[
      'raw_proposed'::text,
      'raw_accepted'::text,
      'rejected'::text,
      'sfm_only'::text
    ]));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN drone_shots.lifecycle_state IS
  'Operator curation state. NULL = not yet classified (legacy rows). raw_proposed = candidate. raw_accepted = promoted. rejected = un-rejectable but excluded. sfm_only = nadir-grid SfM input.';

-- ─── 2. edited_dropbox_path column ──────────────────────────────────────────

ALTER TABLE drone_shots
  ADD COLUMN IF NOT EXISTS edited_dropbox_path text DEFAULT NULL;

COMMENT ON COLUMN drone_shots.edited_dropbox_path IS
  'Dropbox path of the post-production-edited version of this raw shot. NULL until team drops the edited file in Drones/Editors/Edited Post Production/. drone-render uses this as source for non-SfM shots.';

-- ─── 3. is_ai_recommended flag ──────────────────────────────────────────────

ALTER TABLE drone_shots
  ADD COLUMN IF NOT EXISTS is_ai_recommended boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN drone_shots.is_ai_recommended IS
  'True when the AI smart-shortlist algorithm picked this shot for the operator''s curated set. Operator can ignore.';

-- ─── 4. shot_role CHECK widened to allow nadir_hero ─────────────────────────
-- Drop-and-recreate is the only way to change a CHECK on an existing column.
-- The DROP IF EXISTS makes this idempotent across re-applies.

ALTER TABLE drone_shots
  DROP CONSTRAINT IF EXISTS drone_shots_shot_role_check;

ALTER TABLE drone_shots
  ADD CONSTRAINT drone_shots_shot_role_check
  CHECK (shot_role = ANY (ARRAY[
    'nadir_grid'::text,
    'nadir_hero'::text,
    'orbital'::text,
    'oblique_hero'::text,
    'building_hero'::text,
    'ground_level'::text,
    'unclassified'::text
  ]));

-- ─── 5. Backfill lifecycle_state for existing rows ──────────────────────────
-- nadir_grid shots are SfM input → 'sfm_only'. Everything else is a candidate
-- the operator hasn't triaged yet → 'raw_proposed'. Existing nadir_hero rows
-- (none yet, but in case the migration re-runs after the post-pass classifier
-- is shipped) follow the everything-else branch and become raw_proposed.

UPDATE drone_shots
SET lifecycle_state = CASE
  WHEN shot_role = 'nadir_grid' THEN 'sfm_only'
  ELSE 'raw_proposed'
END
WHERE lifecycle_state IS NULL;

NOTIFY pgrst, 'reload schema';
