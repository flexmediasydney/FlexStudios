-- Fix favorites + audit log schema for the Favorites/SocialMedia page
--
-- 1. Add favorited_by_name to media_favorites (denormalized user display name)
-- 2. Add details (JSONB) and user_id columns to audit_logs
-- 3. Expand audit_logs action CHECK constraint to allow favorite actions

-- ─── media_favorites: add favorited_by_name ────────────────────────
ALTER TABLE media_favorites
  ADD COLUMN IF NOT EXISTS favorited_by_name TEXT;

-- ─── audit_logs: add missing columns ───────────────────────────────
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS details JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS user_id UUID;

-- ─── audit_logs: expand action check constraint ────────────────────
-- Drop the old restrictive constraint and replace with one that
-- allows both the original CRM actions and the favorites actions
ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_action_check;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_action_check
  CHECK (action IN (
    'create', 'update', 'delete',
    'favorited', 'unfavorited', 'tags_updated'
  ));
