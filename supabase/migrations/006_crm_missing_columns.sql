-- ============================================================================
-- Migration 006: CRM/Contacts system fixes
-- Fixes discovered during frontend-to-database field audit
-- ============================================================================

-- ── agencies: add onboarding_date column ─────────────────────────────────────
-- Used by Organisations.jsx to display "Since" column
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS onboarding_date TIMESTAMPTZ;

-- ── agencies: expand relationship_state CHECK to include 'Do Not Contact' ────
-- The frontend (ClientAgents.jsx, Organisations.jsx, People.jsx) allows setting
-- 'Do Not Contact' but the DB constraint only allows Prospecting/Active/Dormant.
ALTER TABLE agencies DROP CONSTRAINT IF EXISTS agencies_relationship_state_check;
ALTER TABLE agencies ADD CONSTRAINT agencies_relationship_state_check
  CHECK (relationship_state IN ('Prospecting', 'Active', 'Dormant', 'Do Not Contact'));

-- ── agents: expand relationship_state CHECK to include 'Do Not Contact' ──────
-- Same issue as agencies — bulk state change in ClientAgents allows 'Do Not Contact'
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_relationship_state_check;
ALTER TABLE agents ADD CONSTRAINT agents_relationship_state_check
  CHECK (relationship_state IN ('Prospecting', 'Active', 'Dormant', 'Do Not Contact'));

-- ── agents: add title column if missing ──────────────────────────────────────
-- Used by ProspectDetails.jsx and ProspectEditPanel.jsx
ALTER TABLE agents ADD COLUMN IF NOT EXISTS title TEXT;

-- ── agents: add source column if missing ─────────────────────────────────────
-- Used by ProspectEditPanel.jsx for lead source tracking
ALTER TABLE agents ADD COLUMN IF NOT EXISTS source TEXT;

-- ── agents: add value_potential column if missing ────────────────────────────
-- Used by ProspectEditPanel.jsx for lead qualification
ALTER TABLE agents ADD COLUMN IF NOT EXISTS value_potential TEXT
  CHECK (value_potential IN ('Low', 'Medium', 'High', 'Enterprise'));

-- ── agents: add media_needs column if missing ────────────────────────────────
-- Used by ProspectEditPanel.jsx for tracking service needs
ALTER TABLE agents ADD COLUMN IF NOT EXISTS media_needs JSONB DEFAULT '[]'::jsonb;

-- ── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_agencies_relationship_state ON agencies(relationship_state);
CREATE INDEX IF NOT EXISTS idx_agencies_onboarding_date ON agencies(onboarding_date);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agents_source ON agents(source);
