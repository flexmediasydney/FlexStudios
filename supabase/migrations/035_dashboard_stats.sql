CREATE TABLE IF NOT EXISTS dashboard_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stat_key TEXT NOT NULL,
  stat_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  period TEXT DEFAULT 'current',
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_stat_key_period UNIQUE (stat_key, period)
);

ALTER TABLE dashboard_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_read" ON dashboard_stats FOR SELECT USING (true);
CREATE POLICY "service_role_write" ON dashboard_stats FOR ALL USING (auth.role() = 'service_role');

CREATE INDEX idx_dashboard_stats_key ON dashboard_stats (stat_key);

NOTIFY pgrst, 'reload schema';
