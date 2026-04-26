-- Wave 11 S1: drone_renders.updated_at column + trigger + index
-- Reuses public.update_updated_at() from migration 001.

ALTER TABLE drone_renders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE drone_renders SET updated_at = COALESCE(created_at, NOW()) WHERE updated_at IS NULL;

DROP TRIGGER IF EXISTS set_updated_at_drone_renders ON drone_renders;
CREATE TRIGGER set_updated_at_drone_renders
  BEFORE UPDATE ON drone_renders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE INDEX IF NOT EXISTS idx_drone_renders_updated_at ON drone_renders(updated_at DESC);

NOTIFY pgrst, 'reload schema';
