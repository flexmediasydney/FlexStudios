-- Add `toast_enabled` to per-user notification digest settings.
-- Controls whether new notifications pop a transient toast in the
-- bottom-right corner. Defaults to true (opt-out, not opt-in) so existing
-- users keep getting toasts without having to toggle it themselves —
-- only those who find it noisy will turn it off.
ALTER TABLE notification_digest_settings
  ADD COLUMN IF NOT EXISTS toast_enabled boolean NOT NULL DEFAULT true;
