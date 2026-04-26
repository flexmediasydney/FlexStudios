-- Wave 11 S1: drone_shots.updated_at column + trigger + index
-- Reuses public.update_updated_at() from migration 001.

ALTER TABLE drone_shots ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE drone_shots SET updated_at = COALESCE(created_at, NOW()) WHERE updated_at IS NULL;

DROP TRIGGER IF EXISTS set_updated_at_drone_shots ON drone_shots;
CREATE TRIGGER set_updated_at_drone_shots
  BEFORE UPDATE ON drone_shots
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX IF NOT EXISTS idx_drone_shots_updated_at ON drone_shots(updated_at DESC);

NOTIFY pgrst, 'reload schema';
