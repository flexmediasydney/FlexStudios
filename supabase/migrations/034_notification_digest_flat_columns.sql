-- ============================================================================
-- 034: Add flat columns to notification_digest_settings
--
-- The table was created with only a `digest_config` JSONB column, but both
-- the frontend (SettingsNotifications.jsx) and the seed function
-- (seedNotificationPreferences) send flat fields like quiet_hours_enabled,
-- sound_enabled, etc.  Supabase silently drops unknown columns on insert/
-- update, so these settings were being lost.
--
-- Fix: add the individual columns that the frontend and seed function use.
-- The digest_config JSONB column is kept for backward compatibility but is
-- no longer the primary storage mechanism.
-- ============================================================================

ALTER TABLE notification_digest_settings
  ADD COLUMN IF NOT EXISTS quiet_hours_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS quiet_hours_start   TEXT DEFAULT '22:00',
  ADD COLUMN IF NOT EXISTS quiet_hours_end     TEXT DEFAULT '08:00',
  ADD COLUMN IF NOT EXISTS sound_enabled       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS show_previews       BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS badge_count_enabled BOOLEAN NOT NULL DEFAULT true;
