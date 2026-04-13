-- ============================================================
-- 058: Sales Nurturing Engine + Industry Pulse
-- Touchpoints, pulse signals, cadence rules, milestones, referrals
-- ============================================================

-- ── Touchpoint Types (configurable lookup) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS touchpoint_types (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  icon_name   TEXT NOT NULL DEFAULT 'MessageSquare',
  category    TEXT NOT NULL CHECK (category IN ('outbound','inbound','meeting','content','event','trigger','gift')),
  color       TEXT DEFAULT '#3b82f6',
  is_active   BOOLEAN NOT NULL DEFAULT true,
  sort_order  INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE touchpoint_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_full_access" ON touchpoint_types FOR ALL USING (auth.uid() IS NOT NULL);

-- Seed touchpoint types
INSERT INTO touchpoint_types (name, icon_name, category, color, sort_order) VALUES
  ('Phone Call Out',   'PhoneOutgoing',   'outbound', '#3b82f6', 1),
  ('Phone Call In',    'PhoneIncoming',   'inbound',  '#06b6d4', 2),
  ('Voicemail',        'Voicemail',       'outbound', '#8b5cf6', 3),
  ('Email',            'Mail',            'outbound', '#6366f1', 4),
  ('WhatsApp',         'MessageCircle',   'outbound', '#22c55e', 5),
  ('SMS',              'MessageSquare',   'outbound', '#14b8a6', 6),
  ('MMS',              'Image',           'outbound', '#0ea5e9', 7),
  ('Video Message',    'Video',           'outbound', '#a855f7', 8),
  ('Walk-In',          'Footprints',      'outbound', '#f59e0b', 9),
  ('Open Home',        'Home',            'event',    '#ef4444', 10),
  ('Flyer / Brochure', 'FileText',       'content',  '#f97316', 11),
  ('Gift / Swag',      'Gift',            'gift',     '#ec4899', 12),
  ('Facebook',         'Facebook',        'outbound', '#1877f2', 13),
  ('Instagram',        'Instagram',       'outbound', '#e4405f', 14),
  ('LinkedIn',         'Linkedin',        'outbound', '#0a66c2', 15),
  ('Sales Meeting',    'Briefcase',       'meeting',  '#059669', 16),
  ('Pitch Meeting',    'Presentation',    'meeting',  '#7c3aed', 17),
  ('Drop-In Visit',    'MapPin',          'outbound', '#d97706', 18),
  ('Discovery Call',   'PhoneCall',       'meeting',  '#0891b2', 19)
ON CONFLICT DO NOTHING;

-- ── Pulse Signals (industry intelligence feed) ──────────────────────────────
CREATE TABLE IF NOT EXISTS pulse_signals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  level             TEXT NOT NULL CHECK (level IN ('industry','organisation','person')),
  category          TEXT NOT NULL CHECK (category IN ('event','movement','milestone','market','custom')),
  title             TEXT NOT NULL,
  description       TEXT,
  source_url        TEXT,
  source_type       TEXT DEFAULT 'manual' CHECK (source_type IN ('observed','social_media','news','domain_api','manual')),
  event_date        TIMESTAMPTZ,
  is_actionable     BOOLEAN NOT NULL DEFAULT false,
  suggested_action  TEXT,
  linked_agent_ids  JSONB DEFAULT '[]'::jsonb,
  linked_agency_ids JSONB DEFAULT '[]'::jsonb,
  status            TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','acknowledged','actioned','dismissed')),
  actioned_at       TIMESTAMPTZ,
  actioned_by       UUID,
  actioned_by_name  TEXT,
  created_by        UUID,
  created_by_name   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE pulse_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_full_access" ON pulse_signals FOR ALL USING (auth.uid() IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_pulse_signals_status ON pulse_signals(status) WHERE status IN ('new', 'acknowledged');
CREATE INDEX IF NOT EXISTS idx_pulse_signals_level ON pulse_signals(level);
CREATE INDEX IF NOT EXISTS idx_pulse_signals_created ON pulse_signals(created_at DESC);
ALTER PUBLICATION supabase_realtime ADD TABLE pulse_signals;

-- ── Touchpoints (core activity log) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS touchpoints (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id               UUID REFERENCES agents(id) ON DELETE CASCADE,
  agency_id              UUID REFERENCES agencies(id) ON DELETE CASCADE,
  touchpoint_type_id     UUID NOT NULL REFERENCES touchpoint_types(id),
  touchpoint_type_name   TEXT,
  direction              TEXT CHECK (direction IN ('outbound','inbound')),
  notes                  TEXT,
  duration_minutes       INTEGER,
  outcome                TEXT CHECK (outcome IN ('positive','neutral','negative','no_response')),
  sentiment              TEXT CHECK (sentiment IN ('positive','neutral','negative')),
  logged_by              UUID,
  logged_by_name         TEXT,
  logged_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_planned             BOOLEAN NOT NULL DEFAULT false,
  completed_at           TIMESTAMPTZ,
  follow_up_date         DATE,
  follow_up_notes        TEXT,
  linked_pulse_signal_id UUID REFERENCES pulse_signals(id) ON DELETE SET NULL,
  cost                   NUMERIC(10,2),
  gift_item              TEXT,
  gift_delivery_method   TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE touchpoints ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_full_access" ON touchpoints FOR ALL USING (auth.uid() IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_touchpoints_agent ON touchpoints(agent_id);
CREATE INDEX IF NOT EXISTS idx_touchpoints_agency ON touchpoints(agency_id);
CREATE INDEX IF NOT EXISTS idx_touchpoints_logged ON touchpoints(logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_touchpoints_planned ON touchpoints(follow_up_date) WHERE is_planned = true AND completed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_touchpoints_follow_up ON touchpoints(follow_up_date) WHERE follow_up_date IS NOT NULL;
ALTER PUBLICATION supabase_realtime ADD TABLE touchpoints;

-- ── Cadence Rules (position-based defaults) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS cadence_rules (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  position              TEXT NOT NULL UNIQUE,
  default_interval_days INTEGER NOT NULL,
  priority_level        INTEGER NOT NULL DEFAULT 3,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE cadence_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_full_access" ON cadence_rules FOR ALL USING (auth.uid() IS NOT NULL);

INSERT INTO cadence_rules (position, default_interval_days, priority_level) VALUES
  ('Partner',   14, 1),
  ('Senior',    21, 2),
  ('Junior',    45, 4),
  ('Admin',     60, 5),
  ('Payroll',   90, 5),
  ('Marketing', 45, 4)
ON CONFLICT (position) DO NOTHING;

-- ── Conversion Milestones ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversion_milestones (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  milestone_type  TEXT NOT NULL CHECK (milestone_type IN (
    'asked_pricing','visited_website','accepted_meeting','requested_samples',
    'mentioned_competitor_issue','attended_event','requested_proposal','verbal_commitment'
  )),
  notes           TEXT,
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  detected_by     UUID,
  detected_by_name TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE conversion_milestones ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_full_access" ON conversion_milestones FOR ALL USING (auth.uid() IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_milestones_agent ON conversion_milestones(agent_id);

-- ── Referrals ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referrals (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_agent_id   UUID REFERENCES agents(id) ON DELETE SET NULL,
  referred_agent_id   UUID REFERENCES agents(id) ON DELETE SET NULL,
  referred_agency_id  UUID REFERENCES agencies(id) ON DELETE SET NULL,
  notes               TEXT,
  referral_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  outcome             TEXT DEFAULT 'pending' CHECK (outcome IN ('pending','converted','lost')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_full_access" ON referrals FOR ALL USING (auth.uid() IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_agent_id);

-- ── Agent table additions ───────────────────────────────────────────────────
ALTER TABLE agents ADD COLUMN IF NOT EXISTS cadence_interval_days INTEGER;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS warmth_score INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS warmth_trend TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_touchpoint_at TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS touchpoint_count INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS cadence_health TEXT DEFAULT 'on_track';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS referral_count INTEGER DEFAULT 0;

-- ── Agency table additions ──────────────────────────────────────────────────
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS lat NUMERIC;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS lng NUMERIC;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS warmth_score INTEGER DEFAULT 0;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS last_touchpoint_at TIMESTAMPTZ;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS touchpoint_count INTEGER DEFAULT 0;
