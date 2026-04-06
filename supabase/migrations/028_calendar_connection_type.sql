-- Add connection_type and is_auto_connected columns to calendar_connections
-- Supports domain-wide delegation alongside existing OAuth connections
ALTER TABLE calendar_connections ADD COLUMN IF NOT EXISTS connection_type TEXT DEFAULT 'oauth';
ALTER TABLE calendar_connections ADD COLUMN IF NOT EXISTS is_auto_connected BOOLEAN DEFAULT false;
