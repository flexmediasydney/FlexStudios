-- Wave 6 P5 SHORTLIST: mig 293: register shortlist_ready_for_review notification type
--
-- Notification types are NOT a database table on this project — the registry
-- lives in supabase/functions/notificationService/index.ts (NOTIFICATION_TYPES
-- constant). Per the Phase 5 brief, this migration is therefore intentionally
-- a no-op; the registry entry was added in code as part of the same commit.
--
-- Type added in code:
--   shortlist_ready_for_review:
--     category: 'workflow'
--     severity: 'info'
--     cta_label: 'Review shortlist'
--     default_roles: ['master_admin']  (Phase 1.5 makes routing dynamic)
--
-- Recipient is resolved at fire-time by shortlisting-pass3 (project_owner_id
-- with master_admin fallback via the notificationService role resolver), so
-- no DB-side default-roles plumbing is required for v1.

SELECT 1; -- intentional no-op — see header comment
