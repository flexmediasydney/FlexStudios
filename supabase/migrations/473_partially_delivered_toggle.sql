-- 473_partially_delivered_toggle.sql
--
-- Adds a 'partially delivered' toggle to projects, replacing the unused
-- Won/Lost outcome UI. The toggle is independent of the project stage —
-- a project can be partially_delivered=true while still in any
-- production stage. Audit fields capture who flipped the toggle and when.
--
-- Columns follow the same TEXT convention as archived_by /
-- last_stage_change_by (denormalised user name) so card-field rendering
-- doesn't need to resolve a uuid → name lookup.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS partially_delivered     BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS partially_delivered_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS partially_delivered_by  TEXT;

COMMENT ON COLUMN projects.partially_delivered    IS 'Operator-set flag indicating partial delivery has been made.';
COMMENT ON COLUMN projects.partially_delivered_at IS 'Timestamp of the most recent toggle (set on every flip, also when toggling off).';
COMMENT ON COLUMN projects.partially_delivered_by IS 'Full name of the user who most recently flipped the toggle.';
