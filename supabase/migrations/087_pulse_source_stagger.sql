-- 087_pulse_source_stagger.sql
-- Per-source dispatch stagger config for pulseFireScrapes.
-- rea_agents (actor: websift/realestateau) gets rate-limited by REA.com.au after
-- ~7 rapid requests; setting stagger_seconds=30 prevents the silent "returns
-- empty arrays" failure mode on suburbs 8+.

ALTER TABLE pulse_source_configs
  ADD COLUMN IF NOT EXISTS stagger_seconds INTEGER;

COMMENT ON COLUMN pulse_source_configs.stagger_seconds IS
  'Seconds between per-suburb dispatches in pulseFireScrapes — bumps for rate-limited actors like websift/realestateau. NULL = use code default (2s).';

UPDATE pulse_source_configs
SET stagger_seconds = 30
WHERE source_id = 'rea_agents'
  AND stagger_seconds IS NULL;
