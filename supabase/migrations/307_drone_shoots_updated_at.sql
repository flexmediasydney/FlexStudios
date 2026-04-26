-- Wave 11 S1: drone_shoots.updated_at column + trigger + index
-- Reuses public.update_updated_at() from migration 001.

ALTER TABLE drone_shoots ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE drone_shoots SET updated_at = COALESCE(created_at, NOW()) WHERE updated_at IS NULL;

DROP TRIGGER IF EXISTS set_updated_at_drone_shoots ON drone_shoots;
CREATE TRIGGER set_updated_at_drone_shoots
  BEFORE UPDATE ON drone_shoots
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX IF NOT EXISTS idx_drone_shoots_updated_at ON drone_shoots(updated_at DESC);

NOTIFY pgrst, 'reload schema';
