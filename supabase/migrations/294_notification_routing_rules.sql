-- Wave 6 P1.5 SHORTLIST: mig 294: notification_routing_rules table for dynamic per-type recipient config
--
-- Phase 1.5 of the FlexStudios Photo Shortlisting Engine. Replaces the hardcoded
-- `userId` recipient at each fireNotif call site with a DB-driven per-type
-- routing rule. After this migration, master_admin can configure who receives
-- each notification type (by role, by specific user, or both) without code
-- changes. The notificationService edge function reads this table at fire-time
-- and fans out to all configured recipients.
--
-- Resolution order (implemented in notificationService):
--   1. If active rule exists for the type → use rule's recipient_roles +
--      recipient_user_ids (deduped).
--   2. If no rule → fall back to NOTIFICATION_TYPES[type].default_roles in
--      code (existing behaviour).
--   3. If neither → fire to no one and log a warning.
--
-- Versioning contract (mirrors shortlisting_slot_definitions):
--   When admin saves a change → INSERT new row at version+1 with
--   is_active=TRUE, then UPDATE prior row to is_active=FALSE. We NEVER mutate
--   in-place — preserves a full audit trail of routing decisions.
--
-- recipient_user_ids stores public.users.id (NOT auth.users.id). Validation
-- that the IDs exist in public.users is enforced in the app, not via FK, to
-- keep the table independent of user lifecycle.
--
-- RLS:
--   SELECT — master_admin/admin/manager/employee/contractor (everyone needs
--     to know who's routed, even contractors viewing their own notif config).
--   INSERT/UPDATE — master_admin/admin only (admins configure routing).
--   DELETE — master_admin only (rare; usually deactivate via is_active=FALSE).

-- ============================================================================
-- Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS notification_routing_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_type TEXT NOT NULL,                       -- e.g. 'shortlist_ready_for_review'
  recipient_roles TEXT[] NOT NULL DEFAULT '{}'::TEXT[],  -- e.g. ARRAY['master_admin','admin']
  recipient_user_ids UUID[] NOT NULL DEFAULT '{}'::UUID[], -- specific public.users.id values
  notes TEXT,                                            -- admin's note about why this routing
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE notification_routing_rules IS
  'Per-notification-type recipient routing config (Wave 6 P1.5). One active row per type drives notificationService fan-out. recipient_user_ids stores public.users.id (validated in app). Versioned: edits INSERT a new row at version+1 and deactivate the prior row — never UPDATE in place.';
COMMENT ON COLUMN notification_routing_rules.recipient_roles IS
  'Roles to fan out to: master_admin | admin | manager | employee | contractor | photographer | image_editor | video_editor | project_owner | assigned_users';
COMMENT ON COLUMN notification_routing_rules.recipient_user_ids IS
  'Specific public.users.id values to ALWAYS notify (in addition to roles). Validation enforced in app, not via FK constraint.';

-- A given (type, version) pair must be unique — guards against accidental
-- duplicate version inserts during admin saves.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_notification_routing_rules_type_version
  ON notification_routing_rules(notification_type, version);

-- Only ONE active row per type at a time — the resolver must always pick a
-- single rule deterministically. The partial unique index makes this a hard
-- DB invariant rather than relying on app discipline alone.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_notification_routing_rules_active_per_type
  ON notification_routing_rules(notification_type)
  WHERE is_active = TRUE;

-- Hot path: fan-out resolver looks up active row by type.
CREATE INDEX IF NOT EXISTS idx_notification_routing_rules_active_type
  ON notification_routing_rules(notification_type) WHERE is_active = TRUE;

-- ============================================================================
-- RLS
-- ============================================================================

ALTER TABLE notification_routing_rules ENABLE ROW LEVEL SECURITY;

-- SELECT: visible to everyone in the org (read-only for non-admins so they
-- can see who's notified for a given type).
CREATE POLICY "notification_routing_rules_select_all" ON notification_routing_rules FOR SELECT
  USING (
    get_user_role() = ANY (ARRAY[
      'master_admin'::text,
      'admin'::text,
      'manager'::text,
      'employee'::text,
      'contractor'::text
    ])
  );

-- INSERT: master_admin / admin (admins configure routing).
CREATE POLICY "notification_routing_rules_insert_admin" ON notification_routing_rules FOR INSERT
  WITH CHECK (
    get_user_role() = ANY (ARRAY['master_admin'::text, 'admin'::text])
  );

-- UPDATE: master_admin / admin (e.g. flipping is_active).
CREATE POLICY "notification_routing_rules_update_admin" ON notification_routing_rules FOR UPDATE
  USING (
    get_user_role() = ANY (ARRAY['master_admin'::text, 'admin'::text])
  )
  WITH CHECK (
    get_user_role() = ANY (ARRAY['master_admin'::text, 'admin'::text])
  );

-- DELETE: master_admin only (rare; admins should deactivate via is_active).
CREATE POLICY "notification_routing_rules_delete_master" ON notification_routing_rules FOR DELETE
  USING (get_user_role() = 'master_admin'::text);

-- ============================================================================
-- updated_at trigger (mirrors other config tables)
-- ============================================================================

CREATE OR REPLACE FUNCTION set_notification_routing_rules_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notification_routing_rules_updated_at ON notification_routing_rules;
CREATE TRIGGER trg_notification_routing_rules_updated_at
  BEFORE UPDATE ON notification_routing_rules
  FOR EACH ROW EXECUTE FUNCTION set_notification_routing_rules_updated_at();

-- ============================================================================
-- Seed: shortlist_ready_for_review → master_admin
--   Mirrors the Phase 5 hardcoded behaviour so Phase 1.5 ships with no
--   functional change for this notification type — it's just now editable.
-- ============================================================================

INSERT INTO notification_routing_rules (
  notification_type,
  recipient_roles,
  recipient_user_ids,
  notes,
  is_active,
  version
)
VALUES (
  'shortlist_ready_for_review',
  ARRAY['master_admin']::TEXT[],
  ARRAY[]::UUID[],
  'Wave 6 P1.5 seed: matches Phase 5 hardcoded default. Edit via /NotificationsPage → Routing Rules.',
  TRUE,
  1
)
ON CONFLICT (notification_type, version) DO NOTHING;

NOTIFY pgrst, 'reload schema';
