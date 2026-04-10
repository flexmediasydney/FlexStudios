-- Team Role Assignments: maps internal teams to project roles
-- Replaces the hardcoded ROLE_FALLBACK_TIER map in applyProjectRoleDefaults

CREATE TABLE IF NOT EXISTS team_role_assignments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id             UUID NOT NULL REFERENCES internal_teams(id) ON DELETE CASCADE,
  role                TEXT NOT NULL,
  is_primary_fallback BOOLEAN NOT NULL DEFAULT false,
  fallback_priority   INTEGER NOT NULL DEFAULT 0,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, role)
);

-- Only one primary fallback per role
CREATE UNIQUE INDEX idx_one_primary_fallback_per_role
  ON team_role_assignments (role) WHERE is_primary_fallback = true AND is_active = true;

-- Fast lookup for edge function: "give me the fallback team for this role"
CREATE INDEX idx_team_role_assignments_role_active
  ON team_role_assignments (role, fallback_priority) WHERE is_active = true;

-- RLS
ALTER TABLE team_role_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "team_role_assignments_select" ON team_role_assignments
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "team_role_assignments_admin_all" ON team_role_assignments
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
        AND users.role IN ('master_admin', 'admin')
    )
  );

-- Seed from existing tonomo_role_defaults (if any)
-- This migrates the old tier-based fallback into the new per-role system
DO $$
DECLARE
  v_owner_team   UUID;
  v_onsite_team  UUID;
  v_editing_team UUID;
BEGIN
  SELECT
    (defaults_data->>'owner_fallback_team_id')::UUID,
    (defaults_data->>'onsite_fallback_team_id')::UUID,
    (defaults_data->>'editing_fallback_team_id')::UUID
  INTO v_owner_team, v_onsite_team, v_editing_team
  FROM tonomo_role_defaults
  ORDER BY created_at DESC
  LIMIT 1;

  -- Owner tier
  IF v_owner_team IS NOT NULL THEN
    INSERT INTO team_role_assignments (team_id, role, is_primary_fallback)
    VALUES (v_owner_team, 'project_owner', true)
    ON CONFLICT (team_id, role) DO NOTHING;
  END IF;

  -- Onsite tier
  IF v_onsite_team IS NOT NULL THEN
    INSERT INTO team_role_assignments (team_id, role, is_primary_fallback) VALUES
      (v_onsite_team, 'photographer', true),
      (v_onsite_team, 'videographer', true)
    ON CONFLICT (team_id, role) DO NOTHING;
  END IF;

  -- Editing tier
  IF v_editing_team IS NOT NULL THEN
    INSERT INTO team_role_assignments (team_id, role, is_primary_fallback) VALUES
      (v_editing_team, 'image_editor', true),
      (v_editing_team, 'video_editor', true),
      (v_editing_team, 'floorplan_editor', true),
      (v_editing_team, 'drone_editor', true)
    ON CONFLICT (team_id, role) DO NOTHING;
  END IF;
END $$;

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE team_role_assignments;
