-- Add missing _flow_unmapped and _type_unmapped columns to projects table
-- These are set by processTonomoQueue when a booking flow or project type has no mapping
ALTER TABLE projects ADD COLUMN IF NOT EXISTS _flow_unmapped BOOLEAN DEFAULT false;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS _type_unmapped BOOLEAN DEFAULT false;
