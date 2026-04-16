-- 059: Pulse Data Sources — source configs table + sync log enrichment
-- Adds dynamic source configuration and payload storage for drill-through UI

-- ═══ pulse_source_configs — dynamic source configuration ═══
CREATE TABLE IF NOT EXISTS pulse_source_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  description TEXT,
  actor_slug TEXT,
  suburbs JSONB DEFAULT '[]'::jsonb,
  state TEXT DEFAULT 'NSW',
  max_results_per_suburb INTEGER DEFAULT 30,
  extra_params JSONB DEFAULT '{}'::jsonb,
  is_enabled BOOLEAN DEFAULT true,
  schedule_cron TEXT,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE pulse_source_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_full_access" ON pulse_source_configs FOR ALL USING (auth.uid() IS NOT NULL);
ALTER PUBLICATION supabase_realtime ADD TABLE pulse_source_configs;

-- Seed default configs
INSERT INTO pulse_source_configs (source_id, label, description, actor_slug, suburbs, max_results_per_suburb)
VALUES
  ('rea_agents', 'REA Agent Intelligence', 'websift/realestateau — Agent profiles, sales data, reviews, awards from realestate.com.au', 'websift/realestateau', '["Strathfield","Burwood","Homebush","Croydon Park","Bankstown","Punchbowl","Lakemba","Canterbury","Campsie"]'::jsonb, 30),
  ('domain_agents', 'Domain Agent Data', 'shahidirfan/domain-com-au — Agent listings, sold data, ratings from domain.com.au', 'shahidirfan/domain-com-au-real-estate-agents-scraper', '["Strathfield","Burwood","Homebush"]'::jsonb, 30),
  ('rea_listings', 'REA Listings Market Data', 'azzouzana/real-estate-au-scraper-pro — Active listings with agent/agency details from realestate.com.au', 'azzouzana/real-estate-au-scraper-pro', '["Strathfield","Burwood","Bankstown","Punchbowl","Canterbury"]'::jsonb, 20)
ON CONFLICT (source_id) DO NOTHING;

-- ═══ pulse_sync_logs — add enrichment columns ═══
ALTER TABLE pulse_sync_logs ADD COLUMN IF NOT EXISTS source_id TEXT;
ALTER TABLE pulse_sync_logs ADD COLUMN IF NOT EXISTS source_label TEXT;
ALTER TABLE pulse_sync_logs ADD COLUMN IF NOT EXISTS input_config JSONB;
ALTER TABLE pulse_sync_logs ADD COLUMN IF NOT EXISTS result_summary JSONB;
ALTER TABLE pulse_sync_logs ADD COLUMN IF NOT EXISTS raw_payload JSONB;
ALTER TABLE pulse_sync_logs ADD COLUMN IF NOT EXISTS apify_run_id TEXT;
ALTER TABLE pulse_sync_logs ADD COLUMN IF NOT EXISTS triggered_by UUID;
ALTER TABLE pulse_sync_logs ADD COLUMN IF NOT EXISTS triggered_by_name TEXT;
ALTER TABLE pulse_sync_logs ADD COLUMN IF NOT EXISTS records_detail JSONB;

CREATE INDEX IF NOT EXISTS idx_pulse_sync_logs_source ON pulse_sync_logs(source_id);
CREATE INDEX IF NOT EXISTS idx_pulse_sync_logs_started ON pulse_sync_logs(started_at DESC);
