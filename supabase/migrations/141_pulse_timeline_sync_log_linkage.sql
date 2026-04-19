-- 141_pulse_timeline_sync_log_linkage.sql
-- ────────────────────────────────────────────────────────────────────────────
-- Purpose
--   Make Timeline → Sync-log drill-through rock-solid by adding explicit FKs
--   from pulse_timeline rows to the pulse_sync_logs row that generated them.
--
-- Today the frontend matches pulse_timeline.source (text) to
-- pulse_sync_logs.source_id (text) and overlaps created_at/started_at. That
-- works most of the time but:
--   • Multiple runs of the same source can overlap in time → wrong log picked
--   • `source` values like `rea` / `rea_sync` / `rea_listings_bridge` don't
--     map to a single source_id cleanly
--   • Stale / orphaned rows fall off the match window
--
-- This migration:
--   1. Adds pulse_timeline.sync_log_id (FK, nullable — backward compatible)
--   2. Adds pulse_timeline.apify_run_id (text, for upstream cross-ref)
--   3. Indexes both the explicit FK and the (source, created_at DESC) path
--      used by the fallback match
--   4. Backfills sync_log_id for rows produced by one of the 5 known sources
--      using the same time-range logic the frontend already applies
--
-- Writers are updated in a separate edge-function change; this SQL just adds
-- the columns and backfills history. NULL values remain legal forever.
-- ────────────────────────────────────────────────────────────────────────────

-- 1. Columns ────────────────────────────────────────────────────────────────
ALTER TABLE pulse_timeline
  ADD COLUMN IF NOT EXISTS sync_log_id uuid REFERENCES pulse_sync_logs(id)
    ON DELETE SET NULL;

ALTER TABLE pulse_timeline
  ADD COLUMN IF NOT EXISTS apify_run_id text;

-- 2. Indexes ────────────────────────────────────────────────────────────────
-- Partial index on sync_log_id: ~3.5k matchable rows today, will grow with
-- every new fire, but we only index non-null to keep the index tiny.
CREATE INDEX IF NOT EXISTS idx_pulse_timeline_sync_log
  ON pulse_timeline(sync_log_id)
  WHERE sync_log_id IS NOT NULL;

-- (source, created_at DESC) supports the frontend fallback match when
-- sync_log_id is NULL (legacy rows or non-tracked sources).
CREATE INDEX IF NOT EXISTS idx_pulse_timeline_source_created
  ON pulse_timeline(source, created_at DESC);

-- apify_run_id lookup (for cross-ref from the Apify dashboard side).
CREATE INDEX IF NOT EXISTS idx_pulse_timeline_apify_run_id
  ON pulse_timeline(apify_run_id)
  WHERE apify_run_id IS NOT NULL;

-- 3. Backfill ───────────────────────────────────────────────────────────────
-- For every pulse_timeline row whose source is one of the five tracked
-- sources, pick the matching pulse_sync_logs row whose window contains the
-- timeline created_at. "Contains" means:
--   started_at <= timeline.created_at
--   AND (completed_at IS NULL OR completed_at + interval '5 minutes'
--        >= timeline.created_at)
--
-- DISTINCT ON (timeline.id) + ORDER BY started_at DESC picks the most recent
-- qualifying run, which matches the frontend's "latest run in window" logic.
--
-- Done in LIMIT-batched loops to avoid row-locks on 44k+ rows; each batch
-- commits implicitly via the DO block statement boundary.

DO $backfill$
DECLARE
  v_updated integer := 0;
  v_batch   integer;
  v_apify_run_id text;
BEGIN
  LOOP
    WITH candidates AS (
      SELECT t.id
      FROM   pulse_timeline t
      WHERE  t.sync_log_id IS NULL
        AND  t.source IN (
               'rea_listings_bb_buy',
               'rea_listings_bb_rent',
               'rea_listings_bb_sold',
               'rea_agents',
               'rea_detail_enrich'
             )
      LIMIT  2000
      FOR UPDATE SKIP LOCKED
    ),
    matched AS (
      SELECT DISTINCT ON (t.id)
             t.id        AS timeline_id,
             s.id        AS sync_log_id,
             s.apify_run_id
      FROM   pulse_timeline t
      JOIN   candidates     c ON c.id = t.id
      JOIN   pulse_sync_logs s
             ON s.source_id = t.source
            AND s.started_at <= t.created_at
            AND (
                  s.completed_at IS NULL
               OR s.completed_at + interval '5 minutes' >= t.created_at
                )
      ORDER BY t.id, s.started_at DESC
    )
    UPDATE pulse_timeline t
       SET sync_log_id  = m.sync_log_id,
           apify_run_id = COALESCE(t.apify_run_id, m.apify_run_id)
      FROM matched m
     WHERE t.id = m.timeline_id;

    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_updated := v_updated + v_batch;
    EXIT WHEN v_batch = 0;
  END LOOP;

  RAISE NOTICE '141_pulse_timeline_sync_log_linkage: backfilled % rows',
    v_updated;
END
$backfill$;

-- 4. Migration record ───────────────────────────────────────────────────────
-- (No dedicated table; the filename itself is the ledger.)
