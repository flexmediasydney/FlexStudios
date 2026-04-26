-- Wave 6 P1 SHORTLIST: mig 286: shortlisting config tables
--   shortlisting_slot_definitions
--   shortlisting_signal_weights
--   shortlisting_stream_b_anchors
--
-- Three configuration-style tables that drive the shortlisting engine's
-- decisions. All three are versioned (version INT) and gated by is_active so
-- changes can be staged without breaking running rounds. New rows replace
-- the active row at each cut-over rather than mutating existing rows —
-- preserves historical rounds' lineage to whatever config was live at run
-- time.
--
-- shortlisting_slot_definitions — the three-phase slot taxonomy from spec
--   §12. Slot IDs like exterior_front_hero, master_bedroom_hero, etc. Phase
--   1 = mandatory; Phase 2 = conditional (only filled if room found by
--   vision); Phase 3 = AI free recommendations (no predefined IDs — engine
--   nominates). package_types is a TEXT[] of which packages this slot
--   applies to ('Gold', 'Day to Dusk', 'Premium'). eligible_room_types is a
--   TEXT[] of room_type values from Pass 1 that can fill this slot.
--   NO seed data — Phase 4 will populate after validator confirms shape.
--
-- shortlisting_signal_weights — per-signal weights driving the combined
--   score. Spec §9 + §13. signal_key is the canonical name (e.g.
--   'composition_balance', 'lighting_quality'). dimension is one of
--   compositional|aesthetic|technical|lighting. per_room_modifiers is a
--   JSONB map of room_type → multiplier (e.g. {"kitchen_main": 1.2,
--   "bedroom_secondary": 0.9}).
--
-- shortlisting_stream_b_anchors — Tier S/P/A descriptors injected into Pass
--   1 prompts to anchor scoring (spec §10). tier S=5.0 anchor, P=8.0,
--   A=9.5. descriptor is the prompt-injectable text that grounds the model.
--   NO seed data — Phase 4 will populate.
--
-- RLS: master_admin/admin/manager/employee read; insert/update gated to
-- master_admin/admin (these are config tables, not transactional).

-- ============================================================================
-- 1. shortlisting_slot_definitions
-- ============================================================================

CREATE TABLE IF NOT EXISTS shortlisting_slot_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id TEXT NOT NULL,                    -- e.g. 'exterior_front_hero'
  display_name TEXT NOT NULL,
  phase INT NOT NULL CHECK (phase IN (1,2,3)),
  package_types TEXT[] NOT NULL DEFAULT '{}',     -- which packages this applies to
  eligible_room_types TEXT[] NOT NULL DEFAULT '{}',
  max_images INT NOT NULL DEFAULT 1,
  min_images INT NOT NULL DEFAULT 0,
  notes TEXT,
  version INT NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Enforce one active row per (slot_id, version)
  CONSTRAINT shortlisting_slot_definitions_unique_slot_version
    UNIQUE (slot_id, version)
);

-- Most reads filter by is_active+slot_id; cover that hot path.
CREATE INDEX IF NOT EXISTS idx_slot_definitions_active_slot
  ON shortlisting_slot_definitions(slot_id) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_slot_definitions_active_phase
  ON shortlisting_slot_definitions(phase) WHERE is_active = TRUE;

COMMENT ON TABLE shortlisting_slot_definitions IS
  'Three-phase slot taxonomy from spec §12. Phase 1 = mandatory (always filled), Phase 2 = conditional (room found by vision), Phase 3 = AI free recommendations. Versioned + gated by is_active so changes can be staged. NO seed data; Phase 4 populates per spec §12.';
COMMENT ON COLUMN shortlisting_slot_definitions.package_types IS
  'TEXT[] of which packages this slot applies to: Gold | Day to Dusk | Premium. Empty = all.';
COMMENT ON COLUMN shortlisting_slot_definitions.eligible_room_types IS
  'TEXT[] of room_type values from Pass 1 that can fill this slot.';

ALTER TABLE shortlisting_slot_definitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "slot_definitions_read" ON shortlisting_slot_definitions FOR SELECT
  USING (get_user_role() IN ('master_admin','admin','manager','employee','contractor'));
CREATE POLICY "slot_definitions_insert" ON shortlisting_slot_definitions FOR INSERT
  WITH CHECK (get_user_role() IN ('master_admin','admin'));
CREATE POLICY "slot_definitions_update" ON shortlisting_slot_definitions FOR UPDATE
  USING (get_user_role() IN ('master_admin','admin'));
CREATE POLICY "slot_definitions_delete" ON shortlisting_slot_definitions FOR DELETE
  USING (get_user_role() = 'master_admin');

-- ============================================================================
-- 2. shortlisting_signal_weights
-- ============================================================================

CREATE TABLE IF NOT EXISTS shortlisting_signal_weights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_key TEXT NOT NULL,                 -- e.g. 'composition_balance'
  dimension TEXT NOT NULL CHECK (dimension IN (
    'compositional','aesthetic','technical','lighting'
  )),
  weight NUMERIC(5,3) NOT NULL DEFAULT 1.000,
  per_room_modifiers JSONB NOT NULL DEFAULT '{}'::jsonb,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT shortlisting_signal_weights_unique_key_version
    UNIQUE (signal_key, version)
);

CREATE INDEX IF NOT EXISTS idx_signal_weights_active_key
  ON shortlisting_signal_weights(signal_key) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_signal_weights_active_dimension
  ON shortlisting_signal_weights(dimension) WHERE is_active = TRUE;

COMMENT ON TABLE shortlisting_signal_weights IS
  'Per-signal weights driving the combined score. Spec §9 + §13. per_room_modifiers is a JSONB map of room_type to multiplier (e.g. {"kitchen_main": 1.2}). Versioned; UNIQUE(signal_key, version) — to bump weights, INSERT a new row at version+1 and flip is_active. NO seed data; Phase 4 populates.';
COMMENT ON COLUMN shortlisting_signal_weights.per_room_modifiers IS
  'JSONB map: room_type -> numeric multiplier. Applied on top of base weight at scoring time.';

ALTER TABLE shortlisting_signal_weights ENABLE ROW LEVEL SECURITY;

CREATE POLICY "signal_weights_read" ON shortlisting_signal_weights FOR SELECT
  USING (get_user_role() IN ('master_admin','admin','manager','employee','contractor'));
CREATE POLICY "signal_weights_insert" ON shortlisting_signal_weights FOR INSERT
  WITH CHECK (get_user_role() IN ('master_admin','admin'));
CREATE POLICY "signal_weights_update" ON shortlisting_signal_weights FOR UPDATE
  USING (get_user_role() IN ('master_admin','admin'));
CREATE POLICY "signal_weights_delete" ON shortlisting_signal_weights FOR DELETE
  USING (get_user_role() = 'master_admin');

-- ============================================================================
-- 3. shortlisting_stream_b_anchors
-- ============================================================================

CREATE TABLE IF NOT EXISTS shortlisting_stream_b_anchors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier TEXT NOT NULL CHECK (tier IN ('S','P','A')),
  -- Anchor scores per spec §10: S=5, P=8, A=9.5 (precision 4,2 covers all)
  score_anchor NUMERIC(4,2) NOT NULL,
  descriptor TEXT NOT NULL,                 -- prompt-injectable text
  version INT NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT shortlisting_stream_b_anchors_unique_tier_version
    UNIQUE (tier, version)
);

CREATE INDEX IF NOT EXISTS idx_stream_b_anchors_active_tier
  ON shortlisting_stream_b_anchors(tier) WHERE is_active = TRUE;

COMMENT ON TABLE shortlisting_stream_b_anchors IS
  'Stream B tier descriptors injected into Pass 1 prompts to anchor scoring (spec §10). S = standard real estate (5/10), P = premium/prestige (8/10), A = architectural/editorial (9.5/10). NO seed data; Phase 4 populates with v2 spec descriptors.';

ALTER TABLE shortlisting_stream_b_anchors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "stream_b_anchors_read" ON shortlisting_stream_b_anchors FOR SELECT
  USING (get_user_role() IN ('master_admin','admin','manager','employee','contractor'));
CREATE POLICY "stream_b_anchors_insert" ON shortlisting_stream_b_anchors FOR INSERT
  WITH CHECK (get_user_role() IN ('master_admin','admin'));
CREATE POLICY "stream_b_anchors_update" ON shortlisting_stream_b_anchors FOR UPDATE
  USING (get_user_role() IN ('master_admin','admin'));
CREATE POLICY "stream_b_anchors_delete" ON shortlisting_stream_b_anchors FOR DELETE
  USING (get_user_role() = 'master_admin');

NOTIFY pgrst, 'reload schema';
