-- ============================================================
-- 056: Client Retention Engine
-- Central table for tracking coverage gaps as retention risks
-- ============================================================

CREATE TABLE IF NOT EXISTS retention_alerts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id              UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  agency_id             UUID REFERENCES agencies(id) ON DELETE SET NULL,
  domain_listing_id     TEXT NOT NULL,
  address               TEXT NOT NULL,
  headline              TEXT,
  display_price         TEXT,
  listing_status        TEXT,
  date_listed           TIMESTAMPTZ,

  -- Investigation workflow
  investigation_status  TEXT NOT NULL DEFAULT 'identified'
    CHECK (investigation_status IN ('identified','investigating','passed','checked','red_flag')),

  -- Risk classification
  engagement_type       TEXT,
  risk_level            TEXT NOT NULL DEFAULT 'medium'
    CHECK (risk_level IN ('low','medium','high','critical')),

  -- Investigation metadata
  investigated_by       UUID,
  investigated_by_name  TEXT,
  investigated_at       TIMESTAMPTZ,
  resolved_at           TIMESTAMPTZ,
  notes                 TEXT,
  notes_updated_at      TIMESTAMPTZ,
  notes_updated_by      TEXT,

  -- Sweep tracking
  sweep_date            DATE NOT NULL DEFAULT CURRENT_DATE,
  first_detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  times_seen            INTEGER NOT NULL DEFAULT 1,
  is_active             BOOLEAN NOT NULL DEFAULT true,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dedup key: one alert per agent+listing
CREATE UNIQUE INDEX IF NOT EXISTS idx_retention_alerts_dedup
  ON retention_alerts(agent_id, domain_listing_id);

CREATE INDEX IF NOT EXISTS idx_retention_alerts_agent
  ON retention_alerts(agent_id);

CREATE INDEX IF NOT EXISTS idx_retention_alerts_agency
  ON retention_alerts(agency_id);

CREATE INDEX IF NOT EXISTS idx_retention_alerts_active
  ON retention_alerts(is_active, investigation_status)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_retention_alerts_risk
  ON retention_alerts(risk_level)
  WHERE is_active = true;

-- RLS: same pattern as other CRM tables
ALTER TABLE retention_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_full_access" ON retention_alerts
  FOR ALL USING (auth.uid() IS NOT NULL);

-- Enable realtime for live investigation updates
ALTER PUBLICATION supabase_realtime ADD TABLE retention_alerts;
