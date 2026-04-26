-- 283_drone_property_boundary
--
-- Wave 5 Phase 2 / S1: project-scoped persisted boundary used by render
-- pipelines and the Pin Editor (overlay positioning, sqm calc, address text).
-- Stores either the cadastral-fetched polygon or an operator-edited polygon,
-- plus per-feature toggles and offset overrides.
--
-- One row per project (UNIQUE on project_id). Updates bump version + touch
-- updated_at via the BEFORE-UPDATE trigger; identical-payload writes are
-- short-circuited so version doesn't churn.

CREATE TABLE drone_property_boundary (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid UNIQUE NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source          text NOT NULL CHECK (source IN ('cadastral','operator')),
  polygon_latlng  jsonb NOT NULL,
  cadastral_snapshot jsonb,
  side_measurements_enabled boolean NOT NULL DEFAULT true,
  side_measurements_overrides jsonb,
  sqm_total_enabled boolean NOT NULL DEFAULT true,
  sqm_total_position_offset_px jsonb,
  sqm_total_value_override numeric,
  address_overlay_enabled boolean NOT NULL DEFAULT true,
  address_overlay_position_latlng jsonb,
  address_overlay_text_override text,
  updated_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT NOW(),
  version         int NOT NULL DEFAULT 1
);

CREATE INDEX idx_drone_property_boundary_updated ON drone_property_boundary(updated_at DESC);

CREATE OR REPLACE FUNCTION drone_property_boundary_touch() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND row_to_json(NEW.*) = row_to_json(OLD.*) THEN
    RETURN OLD;
  END IF;
  NEW.version := COALESCE(OLD.version, 0) + 1;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp;

CREATE TRIGGER trg_drone_property_boundary_touch
  BEFORE UPDATE ON drone_property_boundary
  FOR EACH ROW EXECUTE FUNCTION drone_property_boundary_touch();
