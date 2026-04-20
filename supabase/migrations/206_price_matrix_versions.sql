-- 206_price_matrix_versions.sql
-- Versioned price-matrix archive — every mutation to price_matrices writes a
-- row to price_matrix_versions capturing the PRE-mutation state. Each project
-- pins itself to a specific snapshot via projects.price_matrix_version_id
-- so its stored calculated_price can always be reproduced exactly, no matter
-- how many times the underlying matrix is edited afterwards.
--
-- INVARIANT (post-migration + Phase 3b save-path changes):
--   For any project with price_matrix_version_id set, invoking
--   computePrice() against the referenced snapshot + the project's stored
--   products/packages/discounts must reproduce projects.calculated_price
--   exactly. If it doesn't, that's a bug; parity tests catch drift.
--
-- Design decisions:
--   • Table stores the FULL matrix row state (not a diff) so replay is
--     straightforward — point computePrice() at the snapshot, done.
--   • Each row is immutable once written. No UPDATE; new versions get new
--     rows via the trigger.
--   • `superseded_at` marks when a snapshot was replaced by a newer one
--     for the same matrix (the row stays; "superseded" is just informational).
--   • Engine version stamp lets us reproduce historical math even if
--     computePrice() itself changes.

BEGIN;

CREATE TABLE IF NOT EXISTS price_matrix_versions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  matrix_id            uuid NOT NULL,
  entity_type          text NOT NULL CHECK (entity_type IN ('agent','agency')),
  entity_id            uuid NOT NULL,
  entity_name          text,
  project_type_id      uuid,
  project_type_name    text,
  default_tier         text,
  use_default_pricing  boolean,
  package_pricing      jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_pricing      jsonb NOT NULL DEFAULT '[]'::jsonb,
  blanket_discount     jsonb,
  engine_version       text NOT NULL,
  snapshot_at          timestamptz NOT NULL DEFAULT now(),
  snapshot_by          uuid,          -- user_id if known, else null (system/webhook)
  snapshot_reason      text NOT NULL, -- 'initial' | 'matrix_edit' | 'backfill' | 'delete'
  superseded_at        timestamptz    -- set when a newer snapshot replaces this one
);

-- Fast lookup: "latest snapshot per matrix" and "all snapshots for a matrix"
CREATE INDEX IF NOT EXISTS idx_matrix_versions_matrix_time
  ON price_matrix_versions (matrix_id, snapshot_at DESC);

-- Reverse lookup: "what matrix did this snapshot come from"
CREATE INDEX IF NOT EXISTS idx_matrix_versions_matrix_id
  ON price_matrix_versions (matrix_id);

-- Active/current snapshots (superseded_at IS NULL) — most common query
CREATE INDEX IF NOT EXISTS idx_matrix_versions_current
  ON price_matrix_versions (matrix_id) WHERE superseded_at IS NULL;

COMMENT ON TABLE price_matrix_versions IS
  'Immutable archive of every price_matrices row state. Projects reference a specific snapshot via projects.price_matrix_version_id to pin their stored calculated_price against a known matrix version.';

-- FK on projects — points at the specific snapshot this project was priced
-- against. NULL for historical projects until backfill runs, or for projects
-- priced without a matrix (no agent/agency).
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS price_matrix_version_id uuid;

-- We don't enforce RESTRICT on delete — if a snapshot is ever cleaned up,
-- projects would just lose provenance. In practice snapshots are permanent.
-- FK kept nullable + ON DELETE SET NULL.
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_price_matrix_version_id_fkey;
ALTER TABLE projects
  ADD CONSTRAINT projects_price_matrix_version_id_fkey
  FOREIGN KEY (price_matrix_version_id)
  REFERENCES price_matrix_versions(id)
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_projects_matrix_version_id
  ON projects (price_matrix_version_id) WHERE price_matrix_version_id IS NOT NULL;

-- ── Trigger: archive every price_matrices mutation ─────────────────────
-- Fires BEFORE UPDATE so we archive the OLD state (pre-change) before the
-- row is overwritten. Also fires on INSERT to capture the initial state as
-- snapshot #1 for every new matrix.
CREATE OR REPLACE FUNCTION archive_price_matrix_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_src record;
  v_reason text;
  v_engine_version text := 'v2.0.0-shared';
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_src := NEW;
    v_reason := 'initial';
  ELSE
    -- UPDATE — archive the prior state. Skip no-op writes where nothing
    -- pricing-relevant changed (common when a tool just bumps updated_at).
    IF NEW.default_tier IS NOT DISTINCT FROM OLD.default_tier
       AND NEW.use_default_pricing IS NOT DISTINCT FROM OLD.use_default_pricing
       AND NEW.package_pricing IS NOT DISTINCT FROM OLD.package_pricing
       AND NEW.product_pricing IS NOT DISTINCT FROM OLD.product_pricing
       AND NEW.blanket_discount IS NOT DISTINCT FROM OLD.blanket_discount
    THEN
      RETURN NEW;
    END IF;
    v_src := OLD;  -- archive PRE-change state
    v_reason := 'matrix_edit';
    -- Mark the previously-current snapshot as superseded.
    UPDATE price_matrix_versions
      SET superseded_at = now()
      WHERE matrix_id = NEW.id AND superseded_at IS NULL;
  END IF;

  INSERT INTO price_matrix_versions (
    matrix_id, entity_type, entity_id, entity_name,
    project_type_id, project_type_name,
    default_tier, use_default_pricing,
    package_pricing, product_pricing, blanket_discount,
    engine_version, snapshot_reason, snapshot_at
  ) VALUES (
    v_src.id, v_src.entity_type, v_src.entity_id, v_src.entity_name,
    v_src.project_type_id, v_src.project_type_name,
    v_src.default_tier, v_src.use_default_pricing,
    COALESCE(v_src.package_pricing, '[]'::jsonb),
    COALESCE(v_src.product_pricing, '[]'::jsonb),
    v_src.blanket_discount,
    v_engine_version, v_reason,
    CASE WHEN TG_OP = 'INSERT' THEN COALESCE(v_src.created_at, now()) ELSE now() END
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_archive_price_matrix_version ON price_matrices;
CREATE TRIGGER trg_archive_price_matrix_version
AFTER INSERT OR UPDATE ON price_matrices
FOR EACH ROW
EXECUTE FUNCTION archive_price_matrix_version();

-- ── Backfill: one snapshot per existing matrix (as "initial" state) ────
-- Each surviving matrix gets exactly one row capturing its current state.
-- snapshot_reason = 'backfill' so we can tell these apart from future
-- organically-captured snapshots.
INSERT INTO price_matrix_versions (
  matrix_id, entity_type, entity_id, entity_name,
  project_type_id, project_type_name,
  default_tier, use_default_pricing,
  package_pricing, product_pricing, blanket_discount,
  engine_version, snapshot_reason, snapshot_at
)
SELECT
  m.id, m.entity_type, m.entity_id, m.entity_name,
  m.project_type_id, m.project_type_name,
  m.default_tier, m.use_default_pricing,
  COALESCE(m.package_pricing, '[]'::jsonb),
  COALESCE(m.product_pricing, '[]'::jsonb),
  m.blanket_discount,
  'v2.0.0-shared', 'backfill',
  COALESCE(m.last_modified_at, m.updated_at, m.created_at, now())
FROM price_matrices m
WHERE NOT EXISTS (
  SELECT 1 FROM price_matrix_versions s
  WHERE s.matrix_id = m.id AND s.superseded_at IS NULL
);

-- ── Backfill projects to point at the current snapshot of their matrix ──
-- Matches by entity_id in the jsonb snapshot (existing denormalised blob
-- on projects.price_matrix_snapshot). If no match, leaves FK null — some
-- historical projects were priced without a matrix or lost their snapshot.
UPDATE projects p
SET price_matrix_version_id = s.id
FROM price_matrix_versions s
WHERE s.superseded_at IS NULL
  AND s.matrix_id = (p.price_matrix_snapshot->>'id')::uuid
  AND p.price_matrix_version_id IS NULL
  AND p.price_matrix_snapshot IS NOT NULL;

COMMIT;
