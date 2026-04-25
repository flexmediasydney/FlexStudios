-- Migration 225: Drone module schemas (Phases 2/3/4 bundled)
--
-- Adds the 9 tables that back the drone module per
-- ~/flexmedia-drone-spike/IMPLEMENTATION_PLAN_V2.md §2 (Data Model) and §3
-- (Theme System). Schema-only — no seed data, no edge functions, no UI.
--
-- Tables (creation order respects FKs):
--   Phase 4 (themes — referenced by drone_shoots/drone_renders):
--     drone_themes              owner-based polymorphic theme storage
--     drone_theme_revisions     immutable per-version history
--   Phase 2 (drone domain):
--     drone_shoots              one row per onsite drone session
--     drone_shots               individual frames captured during a shoot
--     drone_sfm_runs            structure-from-motion reconstruction runs
--     drone_renders             theme-driven rendered outputs (raw→final)
--     drone_jobs                worker queue (sfm, render, ingest, etc.)
--     drone_custom_pins         operator-added pins from Pin Editor
--     drone_events              append-only domain audit log
--
-- RLS pattern follows migration 221:
--   - master_admin/admin/manager/employee: full access via get_user_role()
--   - contractor: scoped to their assigned projects via my_project_ids()
--   - drone_themes: owner-based (person can edit own person-themes; org admins
--     can edit org-themes; system themes read-only except master_admin)
--   - drone_events: append-only (SELECT + INSERT only)
--
-- Theme inheritance / polymorphic owner:
--   drone_themes.owner_id has NO foreign key — owner_kind drives interpretation
--   ('system' → null; 'person' → person id; 'organisation' → org id;
--   'brand' → brand id, deferred to v2). CHECK constraint validates the enum.
--
-- Custom pin XOR:
--   drone_custom_pins is either world-anchored (world_lat + world_lng) OR
--   pixel-anchored (pixel_anchored_shot_id + pixel_x + pixel_y), never both,
--   never neither. Enforced via CHECK constraint.

-- ============================================================================
-- 1. drone_themes (Phase 4 — Theme System)
-- ============================================================================

CREATE TABLE IF NOT EXISTS drone_themes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('system','person','organisation','brand')),
  owner_id UUID,
  inherits_from UUID REFERENCES drone_themes(id) ON DELETE SET NULL,
  config JSONB NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','archived')),
  version INT NOT NULL DEFAULT 1,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- system themes have null owner_id; all others must have an owner_id
  CONSTRAINT drone_themes_owner_id_consistency CHECK (
    (owner_kind = 'system' AND owner_id IS NULL)
    OR (owner_kind <> 'system' AND owner_id IS NOT NULL)
  ),
  UNIQUE(owner_kind, owner_id, name)
);

CREATE INDEX IF NOT EXISTS idx_drone_themes_owner
  ON drone_themes(owner_kind, owner_id);
CREATE INDEX IF NOT EXISTS idx_drone_themes_default
  ON drone_themes(owner_kind, owner_id) WHERE is_default = TRUE;

COMMENT ON TABLE drone_themes IS
  'Polymorphic theme storage. owner_kind drives interpretation of owner_id (no FK because person/org/brand are heterogeneous). Resolution chain: person → org → brand → system. See IMPLEMENTATION_PLAN_V2 §3.';
COMMENT ON COLUMN drone_themes.config IS
  'Sparse JSONB — only non-default fields stored. Field-level inheritance fills missing fields from inherits_from chain at render time.';

ALTER TABLE drone_themes ENABLE ROW LEVEL SECURITY;

-- Read: everyone authenticated can read all themes (resolution must walk system+org+person chains)
CREATE POLICY "drone_themes_read" ON drone_themes FOR SELECT
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee','contractor')
  );

-- Insert: master_admin/admin always; others can only create themes they own
-- (person-themes only by the person; org-themes only by org admins — both
-- collapse to 'manager'/'employee' role gates here; finer person/org binding
-- enforced at app layer until person/org membership tables exist).
CREATE POLICY "drone_themes_insert" ON drone_themes FOR INSERT
  WITH CHECK (
    get_user_role() IN ('master_admin','admin')
    OR (
      get_user_role() IN ('manager','employee')
      AND owner_kind IN ('person','organisation')
    )
  );

-- Update: same gating as insert; system themes are master_admin only
CREATE POLICY "drone_themes_update" ON drone_themes FOR UPDATE
  USING (
    get_user_role() = 'master_admin'
    OR (get_user_role() = 'admin' AND owner_kind <> 'system')
    OR (
      get_user_role() IN ('manager','employee')
      AND owner_kind IN ('person','organisation')
    )
  );

-- Delete: master_admin only (preserve audit lineage)
CREATE POLICY "drone_themes_delete" ON drone_themes FOR DELETE
  USING (get_user_role() = 'master_admin');

-- ============================================================================
-- 2. drone_theme_revisions (Phase 4 — immutable per-version history)
-- ============================================================================

CREATE TABLE IF NOT EXISTS drone_theme_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  theme_id UUID NOT NULL REFERENCES drone_themes(id) ON DELETE CASCADE,
  version INT NOT NULL,
  config JSONB NOT NULL,
  diff JSONB,
  changed_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(theme_id, version)
);

CREATE INDEX IF NOT EXISTS idx_drone_theme_revisions_theme
  ON drone_theme_revisions(theme_id, version DESC);

ALTER TABLE drone_theme_revisions ENABLE ROW LEVEL SECURITY;

-- Append-only: SELECT + INSERT, no UPDATE/DELETE policies
CREATE POLICY "drone_theme_revisions_read" ON drone_theme_revisions FOR SELECT
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee','contractor')
  );
CREATE POLICY "drone_theme_revisions_insert" ON drone_theme_revisions FOR INSERT
  WITH CHECK (
    get_user_role() IN ('master_admin','admin','manager','employee')
  );

-- ============================================================================
-- 3. drone_shoots (Phase 2)
-- ============================================================================

CREATE TABLE IF NOT EXISTS drone_shoots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  flight_started_at TIMESTAMPTZ,
  flight_ended_at TIMESTAMPTZ,
  drone_model TEXT,
  pilot_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  has_nadir_grid BOOLEAN NOT NULL DEFAULT FALSE,
  image_count INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ingested' CHECK (status IN (
    'ingested','analysing','sfm_running','sfm_complete','sfm_failed',
    'rendering','proposed_ready','adjustments_ready','final_ready','delivered'
  )),
  sfm_residual_median_m DECIMAL(6,2),
  theme_id UUID REFERENCES drone_themes(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_drone_shoots_project ON drone_shoots(project_id);
CREATE INDEX IF NOT EXISTS idx_drone_shoots_status  ON drone_shoots(status);

ALTER TABLE drone_shoots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "drone_shoots_read" ON drone_shoots FOR SELECT
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "drone_shoots_insert" ON drone_shoots FOR INSERT
  WITH CHECK (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "drone_shoots_update" ON drone_shoots FOR UPDATE
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "drone_shoots_delete_owner_only" ON drone_shoots FOR DELETE
  USING (get_user_role() = 'master_admin');

-- ============================================================================
-- 4. drone_shots (Phase 2)
-- ============================================================================

CREATE TABLE IF NOT EXISTS drone_shots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shoot_id UUID NOT NULL REFERENCES drone_shoots(id) ON DELETE CASCADE,
  dropbox_path TEXT NOT NULL,
  filename TEXT NOT NULL,
  dji_index INT,
  captured_at TIMESTAMPTZ,
  gps_lat DECIMAL(10,8),
  gps_lon DECIMAL(11,8),
  relative_altitude DECIMAL(6,2),
  flight_yaw DECIMAL(7,3),
  gimbal_pitch DECIMAL(6,3),
  gimbal_roll DECIMAL(6,3),
  flight_roll DECIMAL(6,3),
  gps_status TEXT,
  shot_role TEXT CHECK (shot_role IN (
    'nadir_grid','orbital','oblique_hero','ground_level','unclassified'
  )),
  registered_in_sfm BOOLEAN NOT NULL DEFAULT FALSE,
  sfm_pose JSONB,
  exif_raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(shoot_id, filename)
);

CREATE INDEX IF NOT EXISTS idx_drone_shots_shoot ON drone_shots(shoot_id);

ALTER TABLE drone_shots ENABLE ROW LEVEL SECURITY;

-- Project scoping flows via shoot_id → drone_shoots.project_id
CREATE POLICY "drone_shots_read" ON drone_shots FOR SELECT
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (
      get_user_role() = 'contractor'
      AND shoot_id IN (
        SELECT id FROM drone_shoots WHERE project_id IN (SELECT my_project_ids())
      )
    )
  );
CREATE POLICY "drone_shots_insert" ON drone_shots FOR INSERT
  WITH CHECK (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (
      get_user_role() = 'contractor'
      AND shoot_id IN (
        SELECT id FROM drone_shoots WHERE project_id IN (SELECT my_project_ids())
      )
    )
  );
CREATE POLICY "drone_shots_update" ON drone_shots FOR UPDATE
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (
      get_user_role() = 'contractor'
      AND shoot_id IN (
        SELECT id FROM drone_shoots WHERE project_id IN (SELECT my_project_ids())
      )
    )
  );
CREATE POLICY "drone_shots_delete_owner_only" ON drone_shots FOR DELETE
  USING (get_user_role() = 'master_admin');

-- ============================================================================
-- 5. drone_sfm_runs (Phase 2)
-- ============================================================================

CREATE TABLE IF NOT EXISTS drone_sfm_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shoot_id UUID NOT NULL REFERENCES drone_shoots(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  images_registered INT,
  points_3d INT,
  residual_median_m DECIMAL(5,2),
  residual_max_m DECIMAL(5,2),
  sparse_bin_dropbox_path TEXT,
  ortho_dropbox_path TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_drone_sfm_runs_shoot ON drone_sfm_runs(shoot_id);

ALTER TABLE drone_sfm_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "drone_sfm_runs_read" ON drone_sfm_runs FOR SELECT
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (
      get_user_role() = 'contractor'
      AND shoot_id IN (
        SELECT id FROM drone_shoots WHERE project_id IN (SELECT my_project_ids())
      )
    )
  );
CREATE POLICY "drone_sfm_runs_insert" ON drone_sfm_runs FOR INSERT
  WITH CHECK (get_user_role() IN ('master_admin','admin','manager','employee'));
CREATE POLICY "drone_sfm_runs_update" ON drone_sfm_runs FOR UPDATE
  USING (get_user_role() IN ('master_admin','admin','manager','employee'));
CREATE POLICY "drone_sfm_runs_delete_owner_only" ON drone_sfm_runs FOR DELETE
  USING (get_user_role() = 'master_admin');

-- ============================================================================
-- 6. drone_renders (Phase 2)
-- ============================================================================

CREATE TABLE IF NOT EXISTS drone_renders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shot_id UUID NOT NULL REFERENCES drone_shots(id) ON DELETE CASCADE,
  column_state TEXT NOT NULL CHECK (column_state IN (
    'raw','proposed','adjustments','final','rejected'
  )),
  kind TEXT NOT NULL CHECK (kind IN ('poi','boundary','poi_plus_boundary')),
  dropbox_path TEXT NOT NULL,
  theme_id UUID REFERENCES drone_themes(id) ON DELETE SET NULL,
  theme_snapshot JSONB,
  property_coord_used JSONB,
  pin_overrides JSONB,
  output_variant TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by UUID,
  approved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_drone_renders_shot ON drone_renders(shot_id);
CREATE INDEX IF NOT EXISTS idx_drone_renders_column_state ON drone_renders(column_state);

COMMENT ON COLUMN drone_renders.theme_snapshot IS
  'Immutable snapshot of resolved theme at render time — protects old deliverables from later theme config changes.';

ALTER TABLE drone_renders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "drone_renders_read" ON drone_renders FOR SELECT
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (
      get_user_role() = 'contractor'
      AND shot_id IN (
        SELECT s.id FROM drone_shots s
        JOIN drone_shoots sh ON sh.id = s.shoot_id
        WHERE sh.project_id IN (SELECT my_project_ids())
      )
    )
  );
CREATE POLICY "drone_renders_insert" ON drone_renders FOR INSERT
  WITH CHECK (get_user_role() IN ('master_admin','admin','manager','employee'));
CREATE POLICY "drone_renders_update" ON drone_renders FOR UPDATE
  USING (get_user_role() IN ('master_admin','admin','manager','employee'));
CREATE POLICY "drone_renders_delete_owner_only" ON drone_renders FOR DELETE
  USING (get_user_role() = 'master_admin');

-- ============================================================================
-- 7. drone_jobs (Phase 2 — worker queue)
-- ============================================================================

CREATE TABLE IF NOT EXISTS drone_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  shoot_id UUID REFERENCES drone_shoots(id) ON DELETE CASCADE,
  shot_id UUID REFERENCES drone_shots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'ingest','sfm','render','render_preview','poi_fetch','cadastral_fetch'
  )),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','running','succeeded','failed','dead_letter'
  )),
  attempt_count INT NOT NULL DEFAULT 0,
  payload JSONB,
  result JSONB,
  error_message TEXT,
  scheduled_for TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_drone_jobs_status ON drone_jobs(status);
CREATE INDEX IF NOT EXISTS idx_drone_jobs_pending_scheduled
  ON drone_jobs(scheduled_for) WHERE status = 'pending';

ALTER TABLE drone_jobs ENABLE ROW LEVEL SECURITY;

-- Workers run as service_role and bypass RLS. Human read access for ops UI:
CREATE POLICY "drone_jobs_read" ON drone_jobs FOR SELECT
  USING (get_user_role() IN ('master_admin','admin','manager','employee'));
CREATE POLICY "drone_jobs_insert" ON drone_jobs FOR INSERT
  WITH CHECK (get_user_role() IN ('master_admin','admin','manager','employee'));
CREATE POLICY "drone_jobs_update" ON drone_jobs FOR UPDATE
  USING (get_user_role() IN ('master_admin','admin'));
CREATE POLICY "drone_jobs_delete" ON drone_jobs FOR DELETE
  USING (get_user_role() = 'master_admin');

-- ============================================================================
-- 8. drone_custom_pins (Phase 2)
-- ============================================================================

CREATE TABLE IF NOT EXISTS drone_custom_pins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shoot_id UUID NOT NULL REFERENCES drone_shoots(id) ON DELETE CASCADE,
  pin_type TEXT NOT NULL CHECK (pin_type IN ('poi_manual','text','line','measurement')),
  -- World-anchored coords
  world_lat DECIMAL(10,8),
  world_lng DECIMAL(11,8),
  -- Pixel-anchored coords (per-shot)
  pixel_anchored_shot_id UUID REFERENCES drone_shots(id) ON DELETE CASCADE,
  pixel_x INT,
  pixel_y INT,
  content JSONB,
  style_overrides JSONB,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A pin is either world-anchored OR pixel-anchored, never both, never neither
  CONSTRAINT drone_custom_pins_anchor_xor CHECK (
    (
      world_lat IS NOT NULL AND world_lng IS NOT NULL
      AND pixel_anchored_shot_id IS NULL AND pixel_x IS NULL AND pixel_y IS NULL
    )
    OR
    (
      world_lat IS NULL AND world_lng IS NULL
      AND pixel_anchored_shot_id IS NOT NULL AND pixel_x IS NOT NULL AND pixel_y IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_drone_custom_pins_shoot ON drone_custom_pins(shoot_id);

ALTER TABLE drone_custom_pins ENABLE ROW LEVEL SECURITY;

CREATE POLICY "drone_custom_pins_read" ON drone_custom_pins FOR SELECT
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (
      get_user_role() = 'contractor'
      AND shoot_id IN (
        SELECT id FROM drone_shoots WHERE project_id IN (SELECT my_project_ids())
      )
    )
  );
CREATE POLICY "drone_custom_pins_insert" ON drone_custom_pins FOR INSERT
  WITH CHECK (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (
      get_user_role() = 'contractor'
      AND shoot_id IN (
        SELECT id FROM drone_shoots WHERE project_id IN (SELECT my_project_ids())
      )
    )
  );
CREATE POLICY "drone_custom_pins_update" ON drone_custom_pins FOR UPDATE
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (
      get_user_role() = 'contractor'
      AND shoot_id IN (
        SELECT id FROM drone_shoots WHERE project_id IN (SELECT my_project_ids())
      )
    )
  );
CREATE POLICY "drone_custom_pins_delete" ON drone_custom_pins FOR DELETE
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (
      get_user_role() = 'contractor'
      AND shoot_id IN (
        SELECT id FROM drone_shoots WHERE project_id IN (SELECT my_project_ids())
      )
    )
  );

-- ============================================================================
-- 9. drone_events (Phase 2 — append-only domain audit log)
-- ============================================================================
-- Distinct from project_folder_events (file-system layer). drone_events tracks
-- domain transitions: render approvals, pin edits, theme resolutions, SfM
-- progression, etc.

CREATE TABLE IF NOT EXISTS drone_events (
  id BIGSERIAL PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  shoot_id UUID REFERENCES drone_shoots(id) ON DELETE CASCADE,
  shot_id UUID REFERENCES drone_shots(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system','user','worker')),
  actor_id UUID,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_drone_events_project_time
  ON drone_events(project_id, created_at DESC);

ALTER TABLE drone_events ENABLE ROW LEVEL SECURITY;

-- Append-only: SELECT + INSERT only. Service role bypasses for workers.
CREATE POLICY "drone_events_read" ON drone_events FOR SELECT
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "drone_events_insert" ON drone_events FOR INSERT
  WITH CHECK (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );

-- ============================================================================
-- Notify PostgREST to refresh schema cache
-- ============================================================================

NOTIFY pgrst, 'reload schema';
