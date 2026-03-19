-- ============================================================================
-- Migration 007: Pricing system missing columns
-- Adds columns required by the products, packages, and price matrix UI
-- that were not in the initial schema.
-- ============================================================================

-- ── packages ─────────────────────────────────────────────────────────────────
-- PackageFormDialog reads/writes description
ALTER TABLE packages ADD COLUMN IF NOT EXISTS description TEXT;

-- ── price_matrices ───────────────────────────────────────────────────────────
-- PriceMatrix page stores the project type name as a denormalized field
ALTER TABLE price_matrices ADD COLUMN IF NOT EXISTS project_type_name TEXT;

-- PriceMatrixEditor writes last_modified_at and last_modified_by on save
ALTER TABLE price_matrices ADD COLUMN IF NOT EXISTS last_modified_at TIMESTAMPTZ;
ALTER TABLE price_matrices ADD COLUMN IF NOT EXISTS last_modified_by TEXT;

-- ── product_snapshots ────────────────────────────────────────────────────────
-- The snapshot panels create *bulk* product snapshots (all products at once)
-- with these fields, rather than per-product snapshots.
ALTER TABLE product_snapshots ADD COLUMN IF NOT EXISTS product_name TEXT;
ALTER TABLE product_snapshots ADD COLUMN IF NOT EXISTS snapshot_date TEXT;
ALTER TABLE product_snapshots ADD COLUMN IF NOT EXISTS snapshot_label TEXT;
ALTER TABLE product_snapshots ADD COLUMN IF NOT EXISTS snapshot_type TEXT
  CHECK (snapshot_type IS NULL OR snapshot_type IN ('manual', 'monthly'));
ALTER TABLE product_snapshots ADD COLUMN IF NOT EXISTS total_entries INTEGER DEFAULT 0;
ALTER TABLE product_snapshots ADD COLUMN IF NOT EXISTS data JSONB DEFAULT '[]'::jsonb;

-- ── package_snapshots ────────────────────────────────────────────────────────
-- Same bulk snapshot pattern as product_snapshots
ALTER TABLE package_snapshots ADD COLUMN IF NOT EXISTS package_name TEXT;
ALTER TABLE package_snapshots ADD COLUMN IF NOT EXISTS snapshot_date TEXT;
ALTER TABLE package_snapshots ADD COLUMN IF NOT EXISTS snapshot_label TEXT;
ALTER TABLE package_snapshots ADD COLUMN IF NOT EXISTS snapshot_type TEXT
  CHECK (snapshot_type IS NULL OR snapshot_type IN ('manual', 'monthly'));
ALTER TABLE package_snapshots ADD COLUMN IF NOT EXISTS total_entries INTEGER DEFAULT 0;
ALTER TABLE package_snapshots ADD COLUMN IF NOT EXISTS data JSONB DEFAULT '[]'::jsonb;

-- ── product_audit_logs ───────────────────────────────────────────────────────
-- ProductsManagement and ProductActivityFeed write/read changes_summary
ALTER TABLE product_audit_logs ADD COLUMN IF NOT EXISTS changes_summary TEXT;

-- ── package_audit_logs ───────────────────────────────────────────────────────
-- PackagesPage and PackageActivityFeed write/read changes_summary
ALTER TABLE package_audit_logs ADD COLUMN IF NOT EXISTS changes_summary TEXT;

-- ── price_matrix_audit_logs ──────────────────────────────────────────────────
-- PriceMatrixActivityFeed reads changes_summary, logPriceMatrixChange writes it
ALTER TABLE price_matrix_audit_logs ADD COLUMN IF NOT EXISTS changes_summary TEXT;

-- ── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_price_matrices_last_modified
  ON price_matrices(last_modified_at);
CREATE INDEX IF NOT EXISTS idx_product_snapshots_snapshot_date
  ON product_snapshots(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_package_snapshots_snapshot_date
  ON package_snapshots(snapshot_date);
