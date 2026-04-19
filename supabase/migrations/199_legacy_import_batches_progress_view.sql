-- 199_legacy_import_batches_progress_view.sql
-- Fix stale counters on legacy_import_batches. The cron workers
-- (pulse-legacy-geocode, pulse-legacy-pkg-map) update each legacy_project row
-- but never roll the counts back up to the batch row — so the Batch History
-- UI read geocoded_count / mapped_count as NULL even though the actual work
-- was happening. Ground-truth count of the pipedrive_import_2026_04_19_A
-- batch right now:
--   stored:    geocoded_count=NULL, mapped_count=NULL
--   actual:    596 geocoded, 2,112 mapped
--
-- Rather than wire triggers on every legacy_projects write (noisy, error-
-- prone), compute the counts on-demand via a view. The UI reads from the
-- view instead of the base table. Always fresh, zero trigger churn.

BEGIN;

CREATE OR REPLACE VIEW legacy_import_batches_with_progress AS
SELECT
  b.*,
  COALESCE(counts.actual_imported, 0)    AS live_imported_count,
  COALESCE(counts.actual_geocoded, 0)    AS live_geocoded_count,
  COALESCE(counts.actual_mapped,   0)    AS live_mapped_count,
  -- Percent completion for progress bars. Use actual_imported as denominator
  -- so a partial import (e.g. 3,400/3,480 imported, 3,000 geocoded) shows
  -- 88% geocoded not 86% — answers "of the rows I actually have, how many
  -- are enriched?"
  CASE WHEN COALESCE(counts.actual_imported, 0) = 0 THEN 0
       ELSE round(100.0 * COALESCE(counts.actual_geocoded, 0) / counts.actual_imported, 1) END AS geocoded_pct,
  CASE WHEN COALESCE(counts.actual_imported, 0) = 0 THEN 0
       ELSE round(100.0 * COALESCE(counts.actual_mapped,   0) / counts.actual_imported, 1) END AS mapped_pct
FROM legacy_import_batches b
LEFT JOIN LATERAL (
  SELECT
    count(*) AS actual_imported,
    count(*) FILTER (WHERE lp.geocoded_at IS NOT NULL)         AS actual_geocoded,
    count(*) FILTER (WHERE lp.mapped_package_id IS NOT NULL)    AS actual_mapped
  FROM legacy_projects lp
  WHERE lp.import_batch_id = b.id
) counts ON true;

-- Also backfill the stored counters for historical consistency (admin tools
-- may read the table directly). These are a best-effort sync right now; the
-- view is the source of truth going forward.
UPDATE legacy_import_batches b
SET imported_count = v.live_imported_count,
    geocoded_count = v.live_geocoded_count,
    mapped_count   = v.live_mapped_count
FROM legacy_import_batches_with_progress v
WHERE v.id = b.id
  AND (b.imported_count IS DISTINCT FROM v.live_imported_count
    OR b.geocoded_count IS DISTINCT FROM v.live_geocoded_count
    OR b.mapped_count   IS DISTINCT FROM v.live_mapped_count);

COMMIT;
