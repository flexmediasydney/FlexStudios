-- Add missing columns to tonomo_mapping_tables that processTonomoQueue expects
ALTER TABLE tonomo_mapping_tables ADD COLUMN IF NOT EXISTS flexmedia_entity_type TEXT;
ALTER TABLE tonomo_mapping_tables ADD COLUMN IF NOT EXISTS flexmedia_label TEXT;
ALTER TABLE tonomo_mapping_tables ADD COLUMN IF NOT EXISTS tonomo_field TEXT;
ALTER TABLE tonomo_mapping_tables ADD COLUMN IF NOT EXISTS flexmedia_field TEXT;
ALTER TABLE tonomo_mapping_tables ADD COLUMN IF NOT EXISTS transform TEXT;
ALTER TABLE tonomo_mapping_tables ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE tonomo_mapping_tables ADD COLUMN IF NOT EXISTS notes TEXT;
