-- Migration 028: Add missing branding columns to agencies table
--
-- The BrandingPreferencesModule and CompactBrandingPreferences components
-- save three fields on update: branding_preferences (jsonb, already existed),
-- branding_general_notes (text), and branding_files_link (text).
-- The last two columns were missing, causing every branding save to fail with
-- "column does not exist" errors from PostgREST.

ALTER TABLE agencies ADD COLUMN IF NOT EXISTS branding_general_notes TEXT;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS branding_files_link TEXT;

-- Add comments for documentation
COMMENT ON COLUMN agencies.branding_general_notes IS 'Free-text agency-wide branding guidelines and notes';
COMMENT ON COLUMN agencies.branding_files_link IS 'URL to external branding assets (Dropbox, Google Drive, etc.)';
