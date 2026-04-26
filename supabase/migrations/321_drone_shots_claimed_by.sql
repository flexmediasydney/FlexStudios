-- Wave 12 Cluster D: drone_shots.claimed_by — advisory ownership tracking
-- for multi-contractor projects. NOT used by RLS yet (Wave 13 will wire it
-- in alongside UI for claim/unclaim). Adding the column now lets future
-- streams reference it without a schema dependency.

ALTER TABLE drone_shots
  ADD COLUMN IF NOT EXISTS claimed_by uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE drone_shots
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_drone_shots_claimed_by
  ON drone_shots(claimed_by) WHERE claimed_by IS NOT NULL;

COMMENT ON COLUMN drone_shots.claimed_by IS
  'Wave 12 D: advisory ownership tracking. NULL = unclaimed. Wave 13 will hook this into per-shot RLS for multi-contractor isolation.';
COMMENT ON COLUMN drone_shots.claimed_at IS
  'Wave 12 D: when the claimed_by user took ownership.';

NOTIFY pgrst, 'reload schema';
