-- AI Assistant Settings (global + per-user)
CREATE TABLE IF NOT EXISTS ai_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_scope TEXT NOT NULL DEFAULT 'global' CHECK (setting_scope IN ('global', 'user')),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  daily_limit INTEGER NOT NULL DEFAULT 50,
  daily_used INTEGER NOT NULL DEFAULT 0,
  daily_reset_at TIMESTAMPTZ,
  confirmation_level TEXT NOT NULL DEFAULT 'destructive' CHECK (confirmation_level IN ('all', 'destructive', 'none')),
  allowed_actions TEXT[] DEFAULT ARRAY['create_note','complete_task','start_timer','stop_timer','log_manual_time','get_project_summary','get_tasks','get_notes','get_timers'],
  blocked_actions TEXT[] DEFAULT '{}',
  voice_enabled BOOLEAN NOT NULL DEFAULT true,
  auto_execute_safe BOOLEAN NOT NULL DEFAULT true,
  tts_enabled BOOLEAN NOT NULL DEFAULT false,
  consent_given_at TIMESTAMPTZ,
  cost_budget_daily DECIMAL(10,2) DEFAULT 5.00,
  model_preference TEXT DEFAULT 'sonnet' CHECK (model_preference IN ('sonnet', 'haiku')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_ai_settings_scope UNIQUE (setting_scope, user_id)
);

-- AI Action Logs (full audit trail)
CREATE TABLE IF NOT EXISTS ai_action_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_name TEXT,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  project_name TEXT,
  prompt_text TEXT NOT NULL,
  prompt_source TEXT NOT NULL DEFAULT 'text' CHECK (prompt_source IN ('text', 'voice')),
  intent_detected TEXT,
  actions_planned JSONB DEFAULT '[]'::jsonb,
  actions_executed JSONB DEFAULT '[]'::jsonb,
  actions_results JSONB DEFAULT '[]'::jsonb,
  confirmation_required BOOLEAN DEFAULT false,
  confirmation_given BOOLEAN,
  model_used TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  estimated_cost DECIMAL(10,4) DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_ai_settings_user ON ai_settings (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_ai_action_logs_user ON ai_action_logs (user_id, created_at DESC);
CREATE INDEX idx_ai_action_logs_project ON ai_action_logs (project_id, created_at DESC);
CREATE INDEX idx_ai_action_logs_session ON ai_action_logs (session_id, created_at);
CREATE INDEX idx_ai_action_logs_created ON ai_action_logs (created_at DESC);

-- RLS
ALTER TABLE ai_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_action_logs ENABLE ROW LEVEL SECURITY;

-- AI Settings: admins can read/write all, users can read/write their own
CREATE POLICY "admin_all_ai_settings" ON ai_settings FOR ALL
  USING (get_user_role() IN ('master_admin', 'admin'));
CREATE POLICY "user_own_ai_settings" ON ai_settings FOR ALL
  USING (user_id = auth.uid() OR setting_scope = 'global')
  WITH CHECK (user_id = auth.uid());

-- AI Action Logs: admins see all, users see their own
CREATE POLICY "admin_all_ai_logs" ON ai_action_logs FOR ALL
  USING (get_user_role() IN ('master_admin', 'admin'));
CREATE POLICY "user_own_ai_logs" ON ai_action_logs FOR SELECT
  USING (user_id = auth.uid());
CREATE POLICY "service_write_ai_logs" ON ai_action_logs FOR INSERT
  USING (true);

-- Seed global settings row
INSERT INTO ai_settings (setting_scope, user_id, enabled, daily_limit, confirmation_level)
VALUES ('global', NULL, false, 50, 'destructive')
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
