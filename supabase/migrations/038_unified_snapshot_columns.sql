-- Add bulk-snapshot columns to product_snapshots and package_snapshots
-- so they match the price_matrix_snapshots pattern for the unified monthly snapshot function.
-- The existing per-item columns (product_id/package_id, snapshot_data) are kept for backward compat.

ALTER TABLE product_snapshots
  ADD COLUMN IF NOT EXISTS snapshot_date   TEXT,
  ADD COLUMN IF NOT EXISTS snapshot_label  TEXT,
  ADD COLUMN IF NOT EXISTS snapshot_type   TEXT CHECK (snapshot_type IN ('manual','monthly')),
  ADD COLUMN IF NOT EXISTS total_entries   INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS data            JSONB DEFAULT '[]'::jsonb;

ALTER TABLE package_snapshots
  ADD COLUMN IF NOT EXISTS snapshot_date   TEXT,
  ADD COLUMN IF NOT EXISTS snapshot_label  TEXT,
  ADD COLUMN IF NOT EXISTS snapshot_type   TEXT CHECK (snapshot_type IN ('manual','monthly')),
  ADD COLUMN IF NOT EXISTS total_entries   INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS data            JSONB DEFAULT '[]'::jsonb;
