-- ============================================================================
-- Migration 008: Add missing columns to Tonomo integration tables
--
-- The initial schema used JSONB blobs for many Tonomo tables, but the
-- application code (both frontend and Edge Functions) reads/writes individual
-- columns. This migration adds every column the code expects.
-- ============================================================================

-- ── tonomo_integration_settings ──────────────────────────────────────────────
-- Code reads/writes: auto_approve_enabled, urgent_review_hours,
-- auto_approve_on_imminent, imminent_threshold_hours, business_calendar_id,
-- auto_link_calendar_events
ALTER TABLE tonomo_integration_settings
  ADD COLUMN IF NOT EXISTS auto_approve_enabled       BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS urgent_review_hours         INTEGER DEFAULT 24,
  ADD COLUMN IF NOT EXISTS auto_approve_on_imminent    BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS imminent_threshold_hours     INTEGER DEFAULT 2,
  ADD COLUMN IF NOT EXISTS business_calendar_id        TEXT,
  ADD COLUMN IF NOT EXISTS auto_link_calendar_events   BOOLEAN DEFAULT true;


-- ── tonomo_mapping_tables ────────────────────────────────────────────────────
-- Original schema had: tonomo_service_name, flexmedia_product_id,
-- flexmedia_product_name, is_confirmed, last_seen_at, mapping_data
-- Code expects a generic mapping entity with:
--   tonomo_id, tonomo_label, mapping_type, flexmedia_entity_id,
--   flexmedia_label, auto_suggested, confidence, seen_count,
--   detected_tier_hint, tier_hint_override
ALTER TABLE tonomo_mapping_tables
  ADD COLUMN IF NOT EXISTS tonomo_id             TEXT,
  ADD COLUMN IF NOT EXISTS tonomo_label          TEXT,
  ADD COLUMN IF NOT EXISTS mapping_type          TEXT DEFAULT 'service',
  ADD COLUMN IF NOT EXISTS flexmedia_entity_id   UUID,
  ADD COLUMN IF NOT EXISTS flexmedia_label       TEXT,
  ADD COLUMN IF NOT EXISTS auto_suggested        BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS confidence            TEXT DEFAULT 'low',
  ADD COLUMN IF NOT EXISTS seen_count            INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS detected_tier_hint    TEXT,
  ADD COLUMN IF NOT EXISTS tier_hint_override    BOOLEAN DEFAULT false;

-- Backfill from old columns into new columns (one-time migration)
UPDATE tonomo_mapping_tables
SET tonomo_label          = COALESCE(tonomo_label, tonomo_service_name),
    flexmedia_entity_id   = COALESCE(flexmedia_entity_id, flexmedia_product_id),
    flexmedia_label       = COALESCE(flexmedia_label, flexmedia_product_name)
WHERE tonomo_label IS NULL
   OR flexmedia_entity_id IS NULL;

-- Index for the mapping_type + tonomo_id lookup used by the processor
CREATE INDEX IF NOT EXISTS idx_tonomo_mapping_tables_type_id
  ON tonomo_mapping_tables(mapping_type, tonomo_id);

CREATE INDEX IF NOT EXISTS idx_tonomo_mapping_tables_last_seen
  ON tonomo_mapping_tables(last_seen_at);


-- ── tonomo_role_defaults ─────────────────────────────────────────────────────
-- Code reads/writes: owner_fallback_team_id, onsite_fallback_team_id,
-- editing_fallback_team_id
ALTER TABLE tonomo_role_defaults
  ADD COLUMN IF NOT EXISTS owner_fallback_team_id    UUID REFERENCES internal_teams(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS onsite_fallback_team_id   UUID REFERENCES internal_teams(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS editing_fallback_team_id  UUID REFERENCES internal_teams(id) ON DELETE SET NULL;


-- ── tonomo_booking_flow_tiers ────────────────────────────────────────────────
-- Code reads/writes: tonomo_flow_id, tonomo_flow_name, tonomo_flow_type,
-- pricing_tier, last_seen_at, seen_count
ALTER TABLE tonomo_booking_flow_tiers
  ADD COLUMN IF NOT EXISTS tonomo_flow_id    TEXT,
  ADD COLUMN IF NOT EXISTS tonomo_flow_name  TEXT,
  ADD COLUMN IF NOT EXISTS tonomo_flow_type  TEXT,
  ADD COLUMN IF NOT EXISTS pricing_tier      TEXT CHECK (pricing_tier IN ('standard', 'premium')),
  ADD COLUMN IF NOT EXISTS last_seen_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS seen_count        INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_tonomo_booking_flow_tiers_flow_id
  ON tonomo_booking_flow_tiers(tonomo_flow_id);


-- ── tonomo_project_type_mappings ─────────────────────────────────────────────
-- Code reads/writes: tonomo_flow_type, is_default, last_seen_at, seen_count
-- DB has tonomo_type but code uses tonomo_flow_type
ALTER TABLE tonomo_project_type_mappings
  ADD COLUMN IF NOT EXISTS tonomo_flow_type  TEXT,
  ADD COLUMN IF NOT EXISTS is_default        BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_seen_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS seen_count        INTEGER DEFAULT 0;

-- Backfill from old column
UPDATE tonomo_project_type_mappings
SET tonomo_flow_type = COALESCE(tonomo_flow_type, tonomo_type)
WHERE tonomo_flow_type IS NULL AND tonomo_type IS NOT NULL;


-- ── tonomo_audit_logs ────────────────────────────────────────────────────────
-- Code writes tonomo_event_id in writeAudit() calls
ALTER TABLE tonomo_audit_logs
  ADD COLUMN IF NOT EXISTS tonomo_event_id TEXT;


-- ── project_automation_rules ─────────────────────────────────────────────────
-- Code reads/writes: description, rule_group, is_system, trigger_config,
-- conditions_json (DB has "conditions"), cooldown_minutes, notes
ALTER TABLE project_automation_rules
  ADD COLUMN IF NOT EXISTS description       TEXT,
  ADD COLUMN IF NOT EXISTS rule_group        TEXT DEFAULT 'quality',
  ADD COLUMN IF NOT EXISTS is_system         BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS trigger_config    TEXT,
  ADD COLUMN IF NOT EXISTS conditions_json   TEXT,
  ADD COLUMN IF NOT EXISTS cooldown_minutes  INTEGER DEFAULT 60,
  ADD COLUMN IF NOT EXISTS notes             TEXT;

-- Backfill conditions_json from the old "conditions" JSONB column
UPDATE project_automation_rules
SET conditions_json = COALESCE(conditions_json, conditions::text)
WHERE conditions_json IS NULL AND conditions IS NOT NULL;


-- ── calendar_events ──────────────────────────────────────────────────────────
-- Processor writes tonomo_appointment_id and event_source
ALTER TABLE calendar_events
  ADD COLUMN IF NOT EXISTS tonomo_appointment_id TEXT,
  ADD COLUMN IF NOT EXISTS event_source          TEXT;

CREATE INDEX IF NOT EXISTS idx_calendar_events_tonomo_appointment_id
  ON calendar_events(tonomo_appointment_id);


-- ── projects (Tonomo-related fields used by the processor) ───────────────────
-- Some of these may already exist from prior migrations; IF NOT EXISTS is safe.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS tonomo_order_id           TEXT,
  ADD COLUMN IF NOT EXISTS tonomo_event_id           TEXT,
  ADD COLUMN IF NOT EXISTS tonomo_appointment_ids    TEXT,
  ADD COLUMN IF NOT EXISTS tonomo_raw_services       TEXT,
  ADD COLUMN IF NOT EXISTS tonomo_service_tiers      TEXT,
  ADD COLUMN IF NOT EXISTS tonomo_package            TEXT,
  ADD COLUMN IF NOT EXISTS tonomo_video_project      BOOLEAN,
  ADD COLUMN IF NOT EXISTS tonomo_invoice_amount     NUMERIC,
  ADD COLUMN IF NOT EXISTS tonomo_invoice_link       TEXT,
  ADD COLUMN IF NOT EXISTS tonomo_payment_status     TEXT,
  ADD COLUMN IF NOT EXISTS tonomo_photographer_ids   TEXT,
  ADD COLUMN IF NOT EXISTS tonomo_booking_flow       TEXT,
  ADD COLUMN IF NOT EXISTS tonomo_booking_flow_id    TEXT,
  ADD COLUMN IF NOT EXISTS tonomo_is_twilight        BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS tonomo_order_status       TEXT,
  ADD COLUMN IF NOT EXISTS tonomo_lifecycle_stage    TEXT,
  ADD COLUMN IF NOT EXISTS tonomo_deliverable_link   TEXT,
  ADD COLUMN IF NOT EXISTS tonomo_deliverable_path   TEXT,
  ADD COLUMN IF NOT EXISTS tonomo_delivered_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tonomo_delivered_files    TEXT,
  ADD COLUMN IF NOT EXISTS tonomo_brokerage_code     TEXT,
  ADD COLUMN IF NOT EXISTS is_first_order            BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS mapping_confidence        TEXT,
  ADD COLUMN IF NOT EXISTS mapping_gaps              TEXT,
  ADD COLUMN IF NOT EXISTS service_assignment_uncertain BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS products_mapping_gaps     TEXT,
  ADD COLUMN IF NOT EXISTS products_auto_applied     BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS products_needs_recalc     BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS pricing_tier              TEXT DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS pending_review_type       TEXT,
  ADD COLUMN IF NOT EXISTS pending_review_reason     TEXT,
  ADD COLUMN IF NOT EXISTS pre_revision_stage        TEXT,
  ADD COLUMN IF NOT EXISTS urgent_review             BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_approved             BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS manually_overridden_fields TEXT,
  ADD COLUMN IF NOT EXISTS property_suburb           TEXT,
  ADD COLUMN IF NOT EXISTS shoot_time                TEXT;

CREATE INDEX IF NOT EXISTS idx_projects_tonomo_order_id
  ON projects(tonomo_order_id);


-- ── project_activities (Tonomo-related fields written by processor) ───────────
ALTER TABLE project_activities
  ADD COLUMN IF NOT EXISTS actor_type        TEXT,
  ADD COLUMN IF NOT EXISTS actor_source      TEXT,
  ADD COLUMN IF NOT EXISTS tonomo_order_id   TEXT,
  ADD COLUMN IF NOT EXISTS tonomo_event_type TEXT;


-- ── notifications (idempotency key used by processor) ────────────────────────
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS idempotency_key   TEXT,
  ADD COLUMN IF NOT EXISTS source            TEXT,
  ADD COLUMN IF NOT EXISTS project_id        UUID REFERENCES projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS project_name      TEXT,
  ADD COLUMN IF NOT EXISTS cta_label         TEXT;

CREATE INDEX IF NOT EXISTS idx_notifications_idempotency_key
  ON notifications(idempotency_key);


-- ── updated_at triggers for new/altered tables ───────────────────────────────
-- Make sure the auto-update trigger is attached to every table that got columns
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.triggers
    WHERE trigger_name = 'update_tonomo_integration_settings_updated_at'
  ) THEN
    CREATE TRIGGER update_tonomo_integration_settings_updated_at
      BEFORE UPDATE ON tonomo_integration_settings
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.triggers
    WHERE trigger_name = 'update_tonomo_mapping_tables_updated_at'
  ) THEN
    CREATE TRIGGER update_tonomo_mapping_tables_updated_at
      BEFORE UPDATE ON tonomo_mapping_tables
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.triggers
    WHERE trigger_name = 'update_tonomo_role_defaults_updated_at'
  ) THEN
    CREATE TRIGGER update_tonomo_role_defaults_updated_at
      BEFORE UPDATE ON tonomo_role_defaults
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.triggers
    WHERE trigger_name = 'update_tonomo_booking_flow_tiers_updated_at'
  ) THEN
    CREATE TRIGGER update_tonomo_booking_flow_tiers_updated_at
      BEFORE UPDATE ON tonomo_booking_flow_tiers
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.triggers
    WHERE trigger_name = 'update_tonomo_project_type_mappings_updated_at'
  ) THEN
    CREATE TRIGGER update_tonomo_project_type_mappings_updated_at
      BEFORE UPDATE ON tonomo_project_type_mappings
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;
