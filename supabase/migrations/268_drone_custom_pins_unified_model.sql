-- ═══════════════════════════════════════════════════════════════════════════
-- 268: Unified pin model — drone_custom_pins becomes the single source of truth
-- ───────────────────────────────────────────────────────────────────────────
-- Joseph's call: AI POIs and operator pins are conceptually the same thing —
-- pins on a project's renders. The previous design had two parallel universes:
--
--   drone_pois_cache (JSONB blob, refreshed by drone-pois)  ← AI POIs
--   drone_custom_pins                                       ← operator pins
--
-- The Pin Editor showed AI POIs as read-only "virtual" layers and required a
-- "promote to override" dance to edit them. Cache refreshes blindly overwrote
-- everything, losing operator nuance.
--
-- This migration unifies the model. drone_custom_pins now holds BOTH:
--
--   source = 'ai'      ← materialised from Google Places by drone-pois
--   source = 'manual'  ← operator-created via Pin Editor
--
-- Smart-merge contract on drone-pois refresh:
--   - new place_id                       → INSERT (source='ai', updated_by=NULL)
--   - existing & updated_by IS NULL      → overwrite world coords + content
--   - existing & updated_by IS NOT NULL  → preserve operator coords + content;
--                                          refresh latest_ai_snapshot only
--   - vanished from fetch                → mark lifecycle='superseded'
--
-- drone-render now runs ONE query (lifecycle='active', scope by shoot_id OR
-- project_id) and passes a single scene.custom_pins[] to Modal.
--
-- Pin Editor treats every row identically: AI badge if source='ai', Reset to
-- AI button when operator-edited, Suppress button to hide without deleting.
--
-- Backwards-compat: drone_pois_cache table is retained as a raw audit log of
-- API responses; readers will be migrated incrementally.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Columns ────────────────────────────────────────────────────────────────
ALTER TABLE drone_custom_pins
  ADD COLUMN IF NOT EXISTS source            text          NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS subsource         text,
  ADD COLUMN IF NOT EXISTS external_ref      text,
  ADD COLUMN IF NOT EXISTS lifecycle         text          NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS priority          int           NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS latest_ai_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS updated_by        uuid          REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at        timestamptz   NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS version           int           NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS project_id        uuid          REFERENCES projects(id) ON DELETE CASCADE;

-- ── Make shoot_id nullable so project-scoped pins are valid ───────────────
ALTER TABLE drone_custom_pins
  ALTER COLUMN shoot_id DROP NOT NULL;

-- ── Constraints ────────────────────────────────────────────────────────────
ALTER TABLE drone_custom_pins
  DROP CONSTRAINT IF EXISTS drone_custom_pins_source_check,
  ADD  CONSTRAINT           drone_custom_pins_source_check
    CHECK (source IN ('manual', 'ai'));

ALTER TABLE drone_custom_pins
  DROP CONSTRAINT IF EXISTS drone_custom_pins_lifecycle_check,
  ADD  CONSTRAINT           drone_custom_pins_lifecycle_check
    CHECK (lifecycle IN ('active', 'suppressed', 'superseded', 'deleted'));

-- A pin is either shoot-scoped OR project-scoped (or both — a shoot-scoped
-- pin always implies its project via the shoot row, but app-level cascades
-- key off project_id when present so we let either be set).
ALTER TABLE drone_custom_pins
  DROP CONSTRAINT IF EXISTS drone_custom_pins_scope_check,
  ADD  CONSTRAINT           drone_custom_pins_scope_check
    CHECK (shoot_id IS NOT NULL OR project_id IS NOT NULL);

-- ── Indexes ────────────────────────────────────────────────────────────────
-- Active-pins lookup, primary read path for drone-render. priority DESC so
-- the renderer's max_pins_per_shot truncation surfaces highest-priority pins
-- first.
CREATE INDEX IF NOT EXISTS idx_drone_custom_pins_project_lifecycle
  ON drone_custom_pins (project_id, lifecycle, priority DESC)
  WHERE lifecycle = 'active';

CREATE INDEX IF NOT EXISTS idx_drone_custom_pins_shoot_lifecycle
  ON drone_custom_pins (shoot_id, lifecycle, priority DESC)
  WHERE lifecycle = 'active';

-- Smart-merge dedup key. partial unique because (project_id, external_ref)
-- only needs to be unique among AI-sourced pins; operator pins don't carry
-- a place_id.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_drone_custom_pins_ai_external_ref
  ON drone_custom_pins (project_id, external_ref)
  WHERE source = 'ai' AND external_ref IS NOT NULL;

-- ── Trigger: bump version + touch updated_at on every UPDATE ──────────────
CREATE OR REPLACE FUNCTION drone_custom_pins_bump_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.version    = COALESCE(OLD.version, 0) + 1;
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_drone_custom_pins_bump_version ON drone_custom_pins;
CREATE TRIGGER trg_drone_custom_pins_bump_version
  BEFORE UPDATE ON drone_custom_pins
  FOR EACH ROW
  EXECUTE FUNCTION drone_custom_pins_bump_version();

NOTIFY pgrst, 'reload schema';
