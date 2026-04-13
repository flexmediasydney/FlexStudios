-- Archive support for all Tonomo mapping tables.
-- Archived mappings are hidden by default but preserved for history.
ALTER TABLE tonomo_mapping_tables ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT false;
ALTER TABLE tonomo_booking_flow_tiers ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT false;
ALTER TABLE tonomo_project_type_mappings ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT false;
ALTER TABLE tonomo_role_defaults ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_mappings_archived ON tonomo_mapping_tables(is_archived);
CREATE INDEX IF NOT EXISTS idx_bf_archived ON tonomo_booking_flow_tiers(is_archived);
CREATE INDEX IF NOT EXISTS idx_ptm_archived ON tonomo_project_type_mappings(is_archived);
