-- ============================================================================
-- FlexMedia: Full Postgres Schema Migration
-- Migrated from Base44 BaaS → Supabase
-- 68 tables, ordered by foreign-key dependency
-- ============================================================================

-- 0. EXTENSIONS & HELPERS ====================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- trigram indexes for text search

-- Auto-update updated_at on every row change
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ============================================================================
-- 1. INDEPENDENT TABLES (no foreign keys to other app tables)
-- ============================================================================

-- 1a. USERS -------------------------------------------------------------------
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL UNIQUE,
  full_name       TEXT,
  role            TEXT NOT NULL DEFAULT 'contractor'
                    CHECK (role IN ('master_admin','admin','employee','contractor')),
  is_active       BOOLEAN NOT NULL DEFAULT true,
  internal_team_id UUID,           -- FK added after internal_teams exists
  internal_team_name TEXT,         -- denormalized
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1b. INTERNAL TEAMS ----------------------------------------------------------
CREATE TABLE internal_teams (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  description     TEXT,
  color           TEXT DEFAULT '#3b82f6',
  team_function   TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Now add the FK from users → internal_teams
ALTER TABLE users
  ADD CONSTRAINT fk_users_internal_team
  FOREIGN KEY (internal_team_id) REFERENCES internal_teams(id) ON DELETE SET NULL;

-- 1c. PRODUCT CATEGORIES ------------------------------------------------------
CREATE TABLE product_categories (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  slug            TEXT,
  description     TEXT,
  "order"         INTEGER DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1d. PROJECT TYPES -----------------------------------------------------------
CREATE TABLE project_types (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  slug            TEXT,
  description     TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  is_default      BOOLEAN NOT NULL DEFAULT false,
  "order"         INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1e. PERMISSIONS -------------------------------------------------------------
CREATE TABLE permissions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL UNIQUE,
  display_name    TEXT,
  resource        TEXT,
  action          TEXT,
  risk_level      TEXT DEFAULT 'low'
                    CHECK (risk_level IN ('low','medium','high','critical')),
  requires_approval BOOLEAN NOT NULL DEFAULT false,
  requires_mfa    BOOLEAN NOT NULL DEFAULT false,
  is_system_permission BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1f. ROLES -------------------------------------------------------------------
CREATE TABLE roles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL UNIQUE,
  display_name    TEXT,
  description     TEXT,
  is_system_role  BOOLEAN NOT NULL DEFAULT false,
  hierarchy_level INTEGER DEFAULT 0,
  scope           TEXT DEFAULT 'global' CHECK (scope IN ('global','team')),
  permission_ids  JSONB DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1g. NOTE TAGS ---------------------------------------------------------------
CREATE TABLE note_tags (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1h. EMAIL LABELS ------------------------------------------------------------
CREATE TABLE email_labels (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1i. DELIVERY SETTINGS (singleton-ish) --------------------------------------
CREATE TABLE delivery_settings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  working_hours   JSONB DEFAULT '{}'::jsonb,
  countdown_thresholds JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1j. REVISION TEMPLATES -----------------------------------------------------
CREATE TABLE revision_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  request_kind    TEXT CHECK (request_kind IN ('revision','change_request')),
  revision_type   TEXT CHECK (revision_type IN ('images','drones','floorplan','video')),
  description     TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  task_templates  JSONB DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================================
-- 2. CRM TABLES
-- ============================================================================

-- 2a. AGENCIES ----------------------------------------------------------------
CREATE TABLE agencies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  address         TEXT,
  phone           TEXT,
  email           TEXT,
  notes           TEXT,
  relationship_state TEXT DEFAULT 'Prospecting'
                    CHECK (relationship_state IN ('Prospecting','Active','Dormant')),
  agent_count     INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2b. TEAMS (real-estate teams, not internal teams) --------------------------
CREATE TABLE teams (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  agency_id       UUID REFERENCES agencies(id) ON DELETE CASCADE,
  agency_name     TEXT,                          -- denormalized
  phone           TEXT,
  email           TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2c. AGENTS ------------------------------------------------------------------
CREATE TABLE agents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  email           TEXT,
  phone           TEXT,
  title           TEXT,
  notes           TEXT,
  current_agency_id   UUID REFERENCES agencies(id) ON DELETE SET NULL,
  current_agency_name TEXT,                      -- denormalized
  current_team_id     UUID REFERENCES teams(id) ON DELETE SET NULL,
  current_team_name   TEXT,                      -- denormalized
  relationship_state  TEXT DEFAULT 'Prospecting'
                        CHECK (relationship_state IN ('Prospecting','Active','Dormant')),
  status          TEXT,
  source          TEXT,
  value_potential TEXT CHECK (value_potential IN ('Low','Medium','High','Enterprise')),
  media_needs     JSONB DEFAULT '[]'::jsonb,
  contact_frequency_days INTEGER,
  tags            JSONB DEFAULT '[]'::jsonb,
  assigned_to_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  became_active_date  TIMESTAMPTZ,
  became_dormant_date TIMESTAMPTZ,
  last_contact_date   TIMESTAMPTZ,
  last_contacted_at   TIMESTAMPTZ,
  next_follow_up_date TIMESTAMPTZ,
  onboarding_date     TIMESTAMPTZ,
  is_at_risk      BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2d. CLIENTS -----------------------------------------------------------------
CREATE TABLE clients (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name      TEXT,
  agent_email     TEXT,
  agent_phone     TEXT,
  team_name       TEXT,
  agency_name     TEXT,
  agency_address  TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================================
-- 3. PRODUCTS & PRICING
-- ============================================================================

-- 3a. PRODUCTS ----------------------------------------------------------------
CREATE TABLE products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  description     TEXT,
  product_type    TEXT DEFAULT 'core',
  category        TEXT CHECK (category IN ('photography','video','drone','editing','virtual_staging','other')),
  pricing_type    TEXT DEFAULT 'fixed' CHECK (pricing_type IN ('fixed','per_unit')),
  min_quantity    INTEGER DEFAULT 1,
  max_quantity    INTEGER,
  dusk_only       BOOLEAN NOT NULL DEFAULT false,
  project_type_ids JSONB DEFAULT '[]'::jsonb,
  standard_tier   JSONB DEFAULT '{}'::jsonb,   -- {base_price, unit_price, onsite_time, ...}
  premium_tier    JSONB DEFAULT '{}'::jsonb,
  standard_task_templates JSONB DEFAULT '[]'::jsonb,
  premium_task_templates  JSONB DEFAULT '[]'::jsonb,
  task_templates  JSONB DEFAULT '[]'::jsonb,   -- legacy
  notes           TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3b. PACKAGES ----------------------------------------------------------------
CREATE TABLE packages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  products        JSONB DEFAULT '[]'::jsonb,   -- [{product_id, product_name, quantity}]
  project_type_ids JSONB DEFAULT '[]'::jsonb,
  standard_tier   JSONB DEFAULT '{}'::jsonb,   -- {package_price}
  premium_tier    JSONB DEFAULT '{}'::jsonb,
  standard_task_templates JSONB DEFAULT '[]'::jsonb,
  premium_task_templates  JSONB DEFAULT '[]'::jsonb,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3c. PRICE MATRICES ----------------------------------------------------------
CREATE TABLE price_matrices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type     TEXT CHECK (entity_type IN ('agency','agent')),
  entity_id       UUID,                        -- FK to agencies or agents (polymorphic)
  entity_name     TEXT,                        -- denormalized
  project_type_id UUID REFERENCES project_types(id) ON DELETE SET NULL,
  use_default_pricing BOOLEAN NOT NULL DEFAULT true,
  product_pricing JSONB DEFAULT '[]'::jsonb,
  package_pricing JSONB DEFAULT '[]'::jsonb,
  blanket_discount JSONB DEFAULT '{}'::jsonb,
  snapshot_date   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3d. PRICE MATRIX SNAPSHOTS --------------------------------------------------
CREATE TABLE price_matrix_snapshots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date   TEXT,
  snapshot_label  TEXT,
  snapshot_type   TEXT CHECK (snapshot_type IN ('manual','monthly')),
  total_entries   INTEGER DEFAULT 0,
  data            JSONB DEFAULT '[]'::jsonb,
  created_by_name TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3e. PRODUCT SNAPSHOTS -------------------------------------------------------
CREATE TABLE product_snapshots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      UUID REFERENCES products(id) ON DELETE SET NULL,
  snapshot_data   JSONB DEFAULT '{}'::jsonb,
  created_by_name TEXT,
  created_by_email TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3f. PACKAGE SNAPSHOTS -------------------------------------------------------
CREATE TABLE package_snapshots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id      UUID REFERENCES packages(id) ON DELETE SET NULL,
  snapshot_data   JSONB DEFAULT '{}'::jsonb,
  created_by_name TEXT,
  created_by_email TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================================
-- 4. PROJECTS (core entity)
-- ============================================================================

CREATE TABLE projects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT,
  title_desc      TEXT,

  -- Client / CRM links
  agent_id        UUID REFERENCES agents(id) ON DELETE SET NULL,
  agent_name      TEXT,
  agency_id       UUID REFERENCES agencies(id) ON DELETE SET NULL,
  client_id       UUID REFERENCES clients(id) ON DELETE SET NULL,
  client_name     TEXT,

  -- Property
  property_address TEXT,
  property_type   TEXT DEFAULT 'residential'
                    CHECK (property_type IN ('residential','commercial')),
  latitude        DOUBLE PRECISION,
  longitude       DOUBLE PRECISION,

  -- Status
  status          TEXT DEFAULT 'pending_review'
                    CHECK (status IN (
                      'pending_review','to_be_scheduled','scheduled','onsite',
                      'uploaded','submitted','in_progress','ready_for_partial',
                      'in_revision','delivered','cancelled'
                    )),
  previous_status TEXT,
  last_status_change TIMESTAMPTZ,

  -- Type & pricing
  project_type_id   UUID REFERENCES project_types(id) ON DELETE SET NULL,
  project_type_name TEXT,
  pricing_tier    TEXT DEFAULT 'standard' CHECK (pricing_tier IN ('standard','premium')),
  products        JSONB DEFAULT '[]'::jsonb,   -- [{product_id, product_name, quantity}]
  packages        JSONB DEFAULT '[]'::jsonb,   -- [{package_id, quantity, products[]}]
  price           NUMERIC(12,2),
  calculated_price NUMERIC(12,2),
  price_matrix_snapshot JSONB,

  -- Schedule
  shoot_date      TIMESTAMPTZ,
  shoot_time      TEXT,
  delivery_date   TIMESTAMPTZ,
  shooting_started_at TIMESTAMPTZ,

  -- Staff assignments
  project_owner_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  project_owner_name TEXT,
  project_owner_type TEXT,
  photographer_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  photographer_name  TEXT,
  videographer_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  videographer_name  TEXT,
  image_editor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  image_editor_name  TEXT,
  video_editor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  video_editor_name  TEXT,
  floorplan_editor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  floorplan_editor_name TEXT,
  drone_editor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  drone_editor_name  TEXT,
  onsite_staff_1_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  onsite_staff_1_name TEXT,
  onsite_staff_2_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  onsite_staff_2_name TEXT,
  assigned_users  JSONB DEFAULT '[]'::jsonb,   -- [user_id, ...]

  -- Integration
  tonomo_order_id TEXT,

  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================================
-- 5. PROJECT CHILD TABLES
-- ============================================================================

-- 5a. PROJECT TASKS -----------------------------------------------------------
CREATE TABLE project_tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT,
  auto_generated  BOOLEAN NOT NULL DEFAULT false,
  template_id     TEXT,
  product_id      UUID REFERENCES products(id) ON DELETE SET NULL,
  package_id      UUID REFERENCES packages(id) ON DELETE SET NULL,

  -- Assignment
  auto_assign_role TEXT DEFAULT 'none',
  assigned_to     UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_to_name TEXT,
  assigned_to_type TEXT,

  -- Effort
  estimated_minutes INTEGER,
  task_type       TEXT DEFAULT 'back_office'
                    CHECK (task_type IN ('back_office','onsite')),

  -- Timer / deadline
  timer_trigger   TEXT DEFAULT 'none',
  deadline_type   TEXT DEFAULT 'custom' CHECK (deadline_type IN ('custom','preset')),
  deadline_preset TEXT,
  deadline_hours_after_trigger INTEGER,
  due_date        TIMESTAMPTZ,

  -- State
  is_completed    BOOLEAN NOT NULL DEFAULT false,
  is_blocked      BOOLEAN NOT NULL DEFAULT false,
  is_deleted      BOOLEAN NOT NULL DEFAULT false,

  -- Dependencies
  depends_on_task_ids JSONB DEFAULT '[]'::jsonb,
  depends_on_indices  JSONB DEFAULT '[]'::jsonb,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5b. PROJECT ACTIVITY --------------------------------------------------------
CREATE TABLE project_activities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_title   TEXT,
  action          TEXT,
  activity_type   TEXT,
  changed_fields  JSONB DEFAULT '[]'::jsonb,
  description     TEXT,
  user_name       TEXT,
  user_email      TEXT,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  "timestamp"     TIMESTAMPTZ DEFAULT now(),
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5c. PROJECT NOTES -----------------------------------------------------------
CREATE TABLE project_notes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  content         TEXT,
  content_html    TEXT,
  author_name     TEXT,
  author_email    TEXT,
  is_pinned       BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5d. PROJECT MEDIA -----------------------------------------------------------
CREATE TABLE project_media (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  dropbox_link    TEXT,
  access_code     TEXT,
  is_published    BOOLEAN NOT NULL DEFAULT false,
  expiry_date     TEXT,
  download_enabled  BOOLEAN NOT NULL DEFAULT true,
  watermark_enabled BOOLEAN NOT NULL DEFAULT false,
  last_viewed     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5e. PROJECT REVISIONS -------------------------------------------------------
CREATE TABLE project_revisions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_title   TEXT,
  revision_number INTEGER,
  request_kind    TEXT CHECK (request_kind IN ('revision','change_request')),
  revision_type   TEXT CHECK (revision_type IN ('images','drones','floorplan','video')),
  template_id     UUID REFERENCES revision_templates(id) ON DELETE SET NULL,
  template_name   TEXT,
  title           TEXT,
  description     TEXT,
  priority        TEXT,
  due_date        TIMESTAMPTZ,
  attachments     JSONB DEFAULT '[]'::jsonb,
  status          TEXT DEFAULT 'identified'
                    CHECK (status IN ('identified','in_progress','completed','delivered','cancelled','rejected')),
  requested_by_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  requested_by_name TEXT,
  requested_date  TIMESTAMPTZ,
  pricing_impact  JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5f. PROJECT STAGE TIMERS ----------------------------------------------------
CREATE TABLE project_stage_timers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage           TEXT NOT NULL,
  entry_time      TIMESTAMPTZ NOT NULL,
  exit_time       TIMESTAMPTZ,
  duration_seconds INTEGER DEFAULT 0,
  visit_number    INTEGER DEFAULT 1,
  is_current      BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5g. PROJECT EFFORT ----------------------------------------------------------
CREATE TABLE project_efforts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  effort_data     JSONB DEFAULT '{}'::jsonb,   -- aggregated effort data
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5h. PROJECT PRESENCE (realtime) ---------------------------------------------
CREATE TABLE project_presences (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_name       TEXT,
  user_email      TEXT,
  user_role       TEXT,
  last_seen       TIMESTAMPTZ DEFAULT now(),
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================================
-- 6. TIME TRACKING
-- ============================================================================

-- 6a. TASK TIME LOGS ----------------------------------------------------------
CREATE TABLE task_time_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
  task_id         UUID REFERENCES project_tasks(id) ON DELETE SET NULL,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  status          TEXT DEFAULT 'running' CHECK (status IN ('running','completed')),
  is_active       BOOLEAN NOT NULL DEFAULT true,
  start_time      TIMESTAMPTZ,
  end_time        TIMESTAMPTZ,
  pause_time      TIMESTAMPTZ,
  total_seconds   INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6b. TASK CHAT ---------------------------------------------------------------
CREATE TABLE task_chats (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         UUID REFERENCES project_tasks(id) ON DELETE CASCADE,
  project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
  author_email    TEXT,
  author_name     TEXT,
  content         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================================
-- 7. EMAIL SYSTEM
-- ============================================================================

-- 7a. EMAIL ACCOUNTS ----------------------------------------------------------
CREATE TABLE email_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_address   TEXT NOT NULL,
  display_name    TEXT,
  assigned_to_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_to_name    TEXT,
  team_id         UUID,
  access_token    TEXT,              -- TODO: move to Supabase Vault
  refresh_token   TEXT,              -- TODO: move to Supabase Vault
  is_active       BOOLEAN NOT NULL DEFAULT true,
  last_sync       TIMESTAMPTZ,
  sync_start_date TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 7b. EMAIL MESSAGES ----------------------------------------------------------
CREATE TABLE email_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  gmail_message_id TEXT,
  gmail_thread_id  TEXT,
  "from"          TEXT,
  from_name       TEXT,
  "to"            JSONB DEFAULT '[]'::jsonb,
  cc              JSONB DEFAULT '[]'::jsonb,
  subject         TEXT,
  body            TEXT,
  is_unread       BOOLEAN NOT NULL DEFAULT true,
  is_starred      BOOLEAN NOT NULL DEFAULT false,
  is_draft        BOOLEAN NOT NULL DEFAULT false,
  is_sent         BOOLEAN NOT NULL DEFAULT false,
  is_visible      BOOLEAN NOT NULL DEFAULT true,
  attachments     JSONB DEFAULT '[]'::jsonb,
  received_at     TIMESTAMPTZ,
  visibility      TEXT DEFAULT 'private' CHECK (visibility IN ('private','shared')),
  project_id      UUID REFERENCES projects(id) ON DELETE SET NULL,
  project_title   TEXT,
  label_ids       JSONB DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 7c. EMAIL ACTIVITY ----------------------------------------------------------
CREATE TABLE email_activities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_message_id UUID REFERENCES email_messages(id) ON DELETE CASCADE,
  email_account_id UUID REFERENCES email_accounts(id) ON DELETE CASCADE,
  action_type     TEXT,
  old_value       TEXT,
  new_value       TEXT,
  description     TEXT,
  performed_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  performed_by_name TEXT,
  "timestamp"     TIMESTAMPTZ DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 7d. EMAIL TEMPLATES ---------------------------------------------------------
CREATE TABLE email_templates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  subject         TEXT,
  body_html       TEXT,
  category        TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 7e. EMAIL BLOCKED ADDRESSES ------------------------------------------------
CREATE TABLE email_blocked_addresses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_address   TEXT NOT NULL,
  reason          TEXT,
  blocked_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  blocked_by_name TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 7f. USER SIGNATURES ---------------------------------------------------------
CREATE TABLE user_signatures (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_name       TEXT,
  user_email      TEXT,
  signature_html  TEXT,
  is_default      BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================================
-- 8. CALENDAR
-- ============================================================================

-- 8a. CALENDAR CONNECTIONS ----------------------------------------------------
CREATE TABLE calendar_connections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_email   TEXT,
  account_name    TEXT,
  is_enabled      BOOLEAN NOT NULL DEFAULT true,
  color           TEXT,
  google_calendar_id TEXT,
  access_token    TEXT,              -- TODO: move to Supabase Vault
  refresh_token   TEXT,              -- TODO: move to Supabase Vault
  last_synced     TIMESTAMPTZ,
  created_by      TEXT,              -- user email
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 8b. CALENDAR EVENTS --------------------------------------------------------
CREATE TABLE calendar_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT,
  start_time      TIMESTAMPTZ,
  end_time        TIMESTAMPTZ,
  project_id      UUID REFERENCES projects(id) ON DELETE SET NULL,
  agent_id        UUID REFERENCES agents(id) ON DELETE SET NULL,
  agency_id       UUID REFERENCES agencies(id) ON DELETE SET NULL,
  owner_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  color           TEXT,
  recurrence      TEXT DEFAULT 'none',
  event_source    TEXT DEFAULT 'flexmedia'
                    CHECK (event_source IN ('flexmedia','tonomo','google')),
  location        TEXT,
  description     TEXT,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  tonomo_appointment_id TEXT,
  google_event_id TEXT,
  calendar_connection_id UUID REFERENCES calendar_connections(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================================
-- 9. NOTIFICATIONS
-- ============================================================================

-- 9a. NOTIFICATIONS -----------------------------------------------------------
CREATE TABLE notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            TEXT,
  category        TEXT,
  severity        TEXT DEFAULT 'info'
                    CHECK (severity IN ('info','warning','critical')),
  title           TEXT,
  message         TEXT,
  project_id      UUID REFERENCES projects(id) ON DELETE SET NULL,
  project_name    TEXT,
  entity_type     TEXT,
  entity_id       UUID,
  cta_url         TEXT,
  cta_label       TEXT,
  cta_params      TEXT,
  is_read         BOOLEAN NOT NULL DEFAULT false,
  is_dismissed    BOOLEAN NOT NULL DEFAULT false,
  source          TEXT DEFAULT 'system'
                    CHECK (source IN ('system','automation','user')),
  source_rule_id  UUID,
  source_user_id  UUID,
  idempotency_key TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 9b. NOTIFICATION PREFERENCES ------------------------------------------------
CREATE TABLE notification_preferences (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type TEXT,
  category        TEXT,
  in_app_enabled  BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 9c. NOTIFICATION DIGEST SETTINGS -------------------------------------------
CREATE TABLE notification_digest_settings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  digest_config   JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================================
-- 10. AUDIT & LOGGING
-- ============================================================================

-- 10a. AUDIT LOGS (generic) ---------------------------------------------------
CREATE TABLE audit_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type     TEXT,
  entity_id       UUID,
  entity_name     TEXT,
  action          TEXT CHECK (action IN ('create','update','delete')),
  changed_fields  JSONB DEFAULT '[]'::jsonb,
  previous_state  JSONB,
  new_state       JSONB,
  user_name       TEXT,
  user_email      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 10b. PRODUCT AUDIT LOGS ----------------------------------------------------
CREATE TABLE product_audit_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      UUID REFERENCES products(id) ON DELETE SET NULL,
  product_name    TEXT,
  action          TEXT,
  changed_fields  JSONB DEFAULT '[]'::jsonb,
  previous_state  JSONB,
  new_state       JSONB,
  user_name       TEXT,
  user_email      TEXT,
  "timestamp"     TIMESTAMPTZ DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 10c. PACKAGE AUDIT LOGS ----------------------------------------------------
CREATE TABLE package_audit_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id      UUID REFERENCES packages(id) ON DELETE SET NULL,
  package_name    TEXT,
  action          TEXT,
  changed_fields  JSONB DEFAULT '[]'::jsonb,
  previous_state  JSONB,
  new_state       JSONB,
  user_name       TEXT,
  user_email      TEXT,
  "timestamp"     TIMESTAMPTZ DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 10d. PRICE MATRIX AUDIT LOGS -----------------------------------------------
CREATE TABLE price_matrix_audit_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  price_matrix_id UUID REFERENCES price_matrices(id) ON DELETE SET NULL,
  entity_type     TEXT,
  entity_id       UUID,
  entity_name     TEXT,
  action          TEXT,
  changed_fields  JSONB DEFAULT '[]'::jsonb,
  previous_state  JSONB,
  new_state       JSONB,
  user_name       TEXT,
  user_email      TEXT,
  "timestamp"     TIMESTAMPTZ DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 10e. PERMISSION AUDIT LOGS -------------------------------------------------
CREATE TABLE permission_audit_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permission_id   UUID REFERENCES permissions(id) ON DELETE SET NULL,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  action          TEXT,
  details         JSONB DEFAULT '{}'::jsonb,
  performed_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  performed_by_name TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 10f. INTERACTION LOGS -------------------------------------------------------
CREATE TABLE interaction_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type     TEXT,
  entity_id       UUID,
  entity_name     TEXT,
  interaction_type TEXT,
  date_time       TIMESTAMPTZ DEFAULT now(),
  summary         TEXT,
  details         TEXT,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  user_name       TEXT,
  sentiment       TEXT,
  relationship_state_at_time TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 10g. TEAM ACTIVITY FEED ----------------------------------------------------
CREATE TABLE team_activity_feeds (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type      TEXT,
  category        TEXT,
  severity        TEXT DEFAULT 'info',
  actor_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_name      TEXT,
  title           TEXT,
  description     TEXT,
  project_id      UUID REFERENCES projects(id) ON DELETE SET NULL,
  project_name    TEXT,
  project_address TEXT,
  project_stage   TEXT,
  entity_type     TEXT,
  entity_id       UUID,
  metadata        JSONB,
  visible_to_roles TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 10h. PROJECT AUTOMATION RULES (created here so automation_rule_logs can FK) -
CREATE TABLE project_automation_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT,
  trigger_type    TEXT,
  is_enabled      BOOLEAN NOT NULL DEFAULT true,
  dry_run_only    BOOLEAN NOT NULL DEFAULT false,
  priority        INTEGER DEFAULT 0,
  conditions      JSONB DEFAULT '[]'::jsonb,
  condition_logic TEXT,
  action_type     TEXT,
  action_config   JSONB DEFAULT '{}'::jsonb,
  fire_count      INTEGER DEFAULT 0,
  skip_count      INTEGER DEFAULT 0,
  last_fired_at   TIMESTAMPTZ,
  last_skipped_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 10i. AUTOMATION RULE LOGS ---------------------------------------------------
CREATE TABLE automation_rule_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id         UUID REFERENCES project_automation_rules(id) ON DELETE SET NULL,
  rule_name       TEXT,
  project_id      UUID REFERENCES projects(id) ON DELETE SET NULL,
  project_name    TEXT,
  trigger_type    TEXT,
  action_taken    TEXT,
  result          TEXT,
  result_detail   TEXT,
  idempotency_key TEXT,
  dry_run         BOOLEAN NOT NULL DEFAULT false,
  fired_at        TIMESTAMPTZ DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================================
-- 11. NOTES (org-level)
-- ============================================================================

CREATE TABLE org_notes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id       UUID REFERENCES agencies(id) ON DELETE SET NULL,
  project_id      UUID REFERENCES projects(id) ON DELETE SET NULL,
  agent_id        UUID REFERENCES agents(id) ON DELETE SET NULL,
  team_id         UUID REFERENCES teams(id) ON DELETE SET NULL,
  entity_type     TEXT,
  entity_id       UUID,
  context_type    TEXT,
  context_label   TEXT,
  content         TEXT,
  content_html    TEXT,
  author_name     TEXT,
  author_email    TEXT,
  mentions        JSONB DEFAULT '[]'::jsonb,
  attachments     JSONB DEFAULT '[]'::jsonb,
  focus_tags      JSONB DEFAULT '[]'::jsonb,
  is_pinned       BOOLEAN NOT NULL DEFAULT false,
  parent_note_id  UUID REFERENCES org_notes(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================================
-- 12. AUTOMATION
-- ============================================================================

-- 12a. APPROVAL WORKFLOWS -----------------------------------------------------
CREATE TABLE approval_workflows (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_data   JSONB DEFAULT '{}'::jsonb,
  status          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================================
-- 13. PERMISSIONS & USER PERMISSIONS
-- ============================================================================

CREATE TABLE user_permissions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_id   UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  granted_by_name TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  expires_at      TIMESTAMPTZ,
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE role_category_mappings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role            TEXT NOT NULL,
  label           TEXT,
  categories      JSONB DEFAULT '[]'::jsonb,
  always_required BOOLEAN NOT NULL DEFAULT false,
  description     TEXT,
  "order"         INTEGER DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================================
-- 14. HR / STAFFING
-- ============================================================================

-- 14a. EMPLOYEE ROLES ---------------------------------------------------------
CREATE TABLE employee_roles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_name       TEXT,
  user_email      TEXT,
  role            TEXT,
  team_id         UUID REFERENCES internal_teams(id) ON DELETE SET NULL,
  team_name       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 14b. EMPLOYEE UTILIZATION ---------------------------------------------------
CREATE TABLE employee_utilizations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_email      TEXT,
  user_name       TEXT,
  role            TEXT,
  team_id         UUID REFERENCES internal_teams(id) ON DELETE SET NULL,
  team_name       TEXT,
  period          TEXT CHECK (period IN ('day','week','month')),
  period_date     TEXT,
  estimated_seconds INTEGER DEFAULT 0,
  actual_seconds  INTEGER DEFAULT 0,
  utilization_percent NUMERIC(5,2) DEFAULT 0,
  status          TEXT CHECK (status IN ('balanced','underutilized','overutilized')),
  project_ids     JSONB DEFAULT '[]'::jsonb,
  last_updated    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 14c. PHOTOGRAPHER AVAILABILITY ----------------------------------------------
CREATE TABLE photographer_availabilities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_of_week     TEXT,
  is_available    BOOLEAN NOT NULL DEFAULT true,
  start_time      TEXT,
  end_time        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================================
-- 15. EXTERNAL / CRM
-- ============================================================================

CREATE TABLE external_listings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID REFERENCES agents(id) ON DELETE SET NULL,
  agent_name      TEXT,
  agency_id       UUID REFERENCES agencies(id) ON DELETE SET NULL,
  agency_name     TEXT,
  address         TEXT,
  price           NUMERIC(12,2),
  property_type   TEXT CHECK (property_type IN ('residential','commercial','land')),
  status          TEXT CHECK (status IN ('for_sale','sold','withdrawn')),
  source_portal   TEXT CHECK (source_portal IN ('domain','realestate','other')),
  match_status    TEXT DEFAULT 'unmatched',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================================
-- 16. TONOMO INTEGRATION
-- ============================================================================

-- 16a. TONOMO INTEGRATION SETTINGS -------------------------------------------
CREATE TABLE tonomo_integration_settings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  processing_lock_at TIMESTAMPTZ,
  heartbeat_at    TIMESTAMPTZ,
  processor_version TEXT,
  config          JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 16b. TONOMO INTEGRATIONS (per-connection) -----------------------------------
CREATE TABLE tonomo_integrations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_data JSONB DEFAULT '{}'::jsonb,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 16c. TONOMO WEBHOOK LOGS ----------------------------------------------------
CREATE TABLE tonomo_webhook_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type      TEXT,
  received_at     TIMESTAMPTZ DEFAULT now(),
  raw_payload     TEXT,
  summary         TEXT,
  has_photographer  BOOLEAN NOT NULL DEFAULT false,
  has_services      BOOLEAN NOT NULL DEFAULT false,
  has_address       BOOLEAN NOT NULL DEFAULT false,
  has_agent         BOOLEAN NOT NULL DEFAULT false,
  has_appointment_time BOOLEAN NOT NULL DEFAULT false,
  parse_error     TEXT,
  request_headers TEXT,
  source_ip       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 16d. TONOMO PROCESSING QUEUE ------------------------------------------------
CREATE TABLE tonomo_processing_queue (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_log_id  UUID REFERENCES tonomo_webhook_logs(id) ON DELETE SET NULL,
  action          TEXT,
  order_id        TEXT,
  event_id        TEXT,
  status          TEXT DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','completed','failed','dead_letter','superseded','skipped')),
  retry_count     INTEGER DEFAULT 0,
  processor_version TEXT,
  error_message   TEXT,
  result_summary  TEXT,
  processed_at    TIMESTAMPTZ,
  last_failed_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 16e. TONOMO AUDIT LOGS -----------------------------------------------------
CREATE TABLE tonomo_audit_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_item_id   UUID REFERENCES tonomo_processing_queue(id) ON DELETE SET NULL,
  action          TEXT,
  entity_type     TEXT,
  entity_id       UUID,
  operation       TEXT,
  tonomo_order_id TEXT,
  notes           TEXT,
  processor_version TEXT,
  processed_at    TIMESTAMPTZ DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 16f. TONOMO MAPPING TABLE ---------------------------------------------------
CREATE TABLE tonomo_mapping_tables (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tonomo_service_name TEXT,
  flexmedia_product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  flexmedia_product_name TEXT,
  is_confirmed    BOOLEAN NOT NULL DEFAULT false,
  last_seen_at    TIMESTAMPTZ,
  mapping_data    JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 16g. TONOMO ROLE DEFAULTS ---------------------------------------------------
CREATE TABLE tonomo_role_defaults (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  defaults_data   JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 16h. TONOMO BOOKING FLOW TIERS ----------------------------------------------
CREATE TABLE tonomo_booking_flow_tiers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_data       JSONB DEFAULT '{}'::jsonb,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 16i. TONOMO PROJECT TYPE MAPPINGS -------------------------------------------
CREATE TABLE tonomo_project_type_mappings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tonomo_type     TEXT,
  project_type_id UUID REFERENCES project_types(id) ON DELETE SET NULL,
  project_type_name TEXT,
  mapping_config  JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================================
-- 17. INDEXES
-- ============================================================================

-- Foreign key indexes (Postgres doesn't auto-index FK columns)
CREATE INDEX idx_users_internal_team ON users(internal_team_id);
CREATE INDEX idx_teams_agency ON teams(agency_id);
CREATE INDEX idx_agents_agency ON agents(current_agency_id);
CREATE INDEX idx_agents_team ON agents(current_team_id);
CREATE INDEX idx_agents_assigned_user ON agents(assigned_to_user_id);

CREATE INDEX idx_price_matrices_entity ON price_matrices(entity_type, entity_id);
CREATE INDEX idx_price_matrices_project_type ON price_matrices(project_type_id);
CREATE INDEX idx_product_snapshots_product ON product_snapshots(product_id);
CREATE INDEX idx_package_snapshots_package ON package_snapshots(package_id);

-- Projects (heavily queried)
CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_projects_agent ON projects(agent_id);
CREATE INDEX idx_projects_agency ON projects(agency_id);
CREATE INDEX idx_projects_client ON projects(client_id);
CREATE INDEX idx_projects_project_type ON projects(project_type_id);
CREATE INDEX idx_projects_owner ON projects(project_owner_id);
CREATE INDEX idx_projects_photographer ON projects(photographer_id);
CREATE INDEX idx_projects_videographer ON projects(videographer_id);
CREATE INDEX idx_projects_image_editor ON projects(image_editor_id);
CREATE INDEX idx_projects_video_editor ON projects(video_editor_id);
CREATE INDEX idx_projects_tonomo_order ON projects(tonomo_order_id);
CREATE INDEX idx_projects_shoot_date ON projects(shoot_date);
CREATE INDEX idx_projects_delivery_date ON projects(delivery_date);

-- Project children
CREATE INDEX idx_project_tasks_project ON project_tasks(project_id);
CREATE INDEX idx_project_tasks_assigned ON project_tasks(assigned_to);
CREATE INDEX idx_project_tasks_product ON project_tasks(product_id);
CREATE INDEX idx_project_tasks_completed ON project_tasks(project_id, is_completed, is_deleted);
CREATE INDEX idx_project_activities_project ON project_activities(project_id);
CREATE INDEX idx_project_notes_project ON project_notes(project_id);
CREATE INDEX idx_project_media_project ON project_media(project_id);
CREATE INDEX idx_project_revisions_project ON project_revisions(project_id);
CREATE INDEX idx_project_stage_timers_project ON project_stage_timers(project_id);
CREATE INDEX idx_project_efforts_project ON project_efforts(project_id);
CREATE INDEX idx_project_presences_project ON project_presences(project_id);
CREATE INDEX idx_project_presences_user ON project_presences(user_id);

-- Time tracking (heavily filtered)
CREATE INDEX idx_task_time_logs_project ON task_time_logs(project_id);
CREATE INDEX idx_task_time_logs_task ON task_time_logs(task_id);
CREATE INDEX idx_task_time_logs_user ON task_time_logs(user_id);
CREATE INDEX idx_task_time_logs_active ON task_time_logs(is_active, status);
CREATE INDEX idx_task_chats_task ON task_chats(task_id);
CREATE INDEX idx_task_chats_project ON task_chats(project_id);

-- Email
CREATE INDEX idx_email_accounts_user ON email_accounts(assigned_to_user_id);
CREATE INDEX idx_email_messages_account ON email_messages(email_account_id);
CREATE INDEX idx_email_messages_thread ON email_messages(gmail_thread_id);
CREATE INDEX idx_email_messages_project ON email_messages(project_id);
CREATE INDEX idx_email_messages_visible ON email_messages(email_account_id, is_visible);
CREATE INDEX idx_email_messages_received ON email_messages(received_at DESC);
CREATE INDEX idx_email_activities_message ON email_activities(email_message_id);
CREATE INDEX idx_email_activities_account ON email_activities(email_account_id);
CREATE INDEX idx_user_signatures_user ON user_signatures(user_id);

-- Calendar
CREATE INDEX idx_calendar_events_project ON calendar_events(project_id);
CREATE INDEX idx_calendar_events_time ON calendar_events(start_time, end_time);
CREATE INDEX idx_calendar_events_owner ON calendar_events(owner_user_id);
CREATE INDEX idx_calendar_events_creator ON calendar_events(created_by_user_id);

-- Notifications (filtered by user + read status)
CREATE INDEX idx_notifications_user ON notifications(user_id);
CREATE INDEX idx_notifications_user_unread ON notifications(user_id, is_read) WHERE is_read = false;
CREATE INDEX idx_notification_prefs_user ON notification_preferences(user_id);
CREATE INDEX idx_notification_digest_user ON notification_digest_settings(user_id);

-- Audit logs (filtered by entity)
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_product_audit_logs_product ON product_audit_logs(product_id);
CREATE INDEX idx_package_audit_logs_package ON package_audit_logs(package_id);
CREATE INDEX idx_price_matrix_audit_logs_matrix ON price_matrix_audit_logs(price_matrix_id);
CREATE INDEX idx_interaction_logs_entity ON interaction_logs(entity_type, entity_id);
CREATE INDEX idx_interaction_logs_user ON interaction_logs(user_id);
CREATE INDEX idx_automation_rule_logs_rule ON automation_rule_logs(rule_id);
CREATE INDEX idx_automation_rule_logs_project ON automation_rule_logs(project_id);
CREATE INDEX idx_team_activity_feeds_project ON team_activity_feeds(project_id);
CREATE INDEX idx_team_activity_feeds_created ON team_activity_feeds(created_at DESC);

-- Org notes
CREATE INDEX idx_org_notes_agency ON org_notes(agency_id);
CREATE INDEX idx_org_notes_agent ON org_notes(agent_id);
CREATE INDEX idx_org_notes_project ON org_notes(project_id);
CREATE INDEX idx_org_notes_entity ON org_notes(entity_type, entity_id);

-- User permissions
CREATE INDEX idx_user_permissions_user ON user_permissions(user_id);
CREATE INDEX idx_user_permissions_permission ON user_permissions(permission_id);

-- Employee
CREATE INDEX idx_employee_roles_user ON employee_roles(user_id);
CREATE INDEX idx_employee_utilizations_user ON employee_utilizations(user_id);
CREATE INDEX idx_employee_utilizations_period ON employee_utilizations(period, period_date);
CREATE INDEX idx_photographer_avail_user ON photographer_availabilities(user_id);

-- External listings
CREATE INDEX idx_external_listings_agent ON external_listings(agent_id);
CREATE INDEX idx_external_listings_agency ON external_listings(agency_id);

-- Tonomo
CREATE INDEX idx_tonomo_queue_status ON tonomo_processing_queue(status);
CREATE INDEX idx_tonomo_queue_webhook ON tonomo_processing_queue(webhook_log_id);
CREATE INDEX idx_tonomo_queue_created ON tonomo_processing_queue(created_at DESC);
CREATE INDEX idx_tonomo_audit_queue ON tonomo_audit_logs(queue_item_id);
CREATE INDEX idx_tonomo_mappings_product ON tonomo_mapping_tables(flexmedia_product_id);
CREATE INDEX idx_tonomo_type_mappings_type ON tonomo_project_type_mappings(project_type_id);


-- ============================================================================
-- 18. UPDATED_AT TRIGGERS
-- ============================================================================

DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name != 'schema_migrations'
  LOOP
    EXECUTE format(
      'CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION update_updated_at()',
      t
    );
  END LOOP;
END;
$$;


-- ============================================================================
-- DONE. 68 tables created.
-- Next: Auth migration (Supabase Auth + RLS), then SDK wrapper.
-- ============================================================================
