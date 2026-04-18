-- Atomic increment helper so concurrent pulseDetailEnrich invocations can't
-- race each other on detail_enrich_count. Each call increments by 1 in a
-- single UPDATE statement; Postgres row-locking handles the ordering.
BEGIN;

CREATE OR REPLACE FUNCTION pulse_inc_listing_detail_count(p_listing_id UUID)
RETURNS INT LANGUAGE SQL SECURITY DEFINER SET search_path = public AS $$
  UPDATE pulse_listings
  SET detail_enrich_count = COALESCE(detail_enrich_count, 0) + 1
  WHERE id = p_listing_id
  RETURNING detail_enrich_count;
$$;

COMMENT ON FUNCTION pulse_inc_listing_detail_count IS
  'Atomic per-row increment of detail_enrich_count. Used by pulseDetailEnrich '
  'to avoid concurrent-run races where two invocations both read 0 and both write 1.';

-- Backfill the currently-stuck 5 rows from history
UPDATE pulse_listings l
SET detail_enrich_count = (
  SELECT count(*) FROM pulse_entity_sync_history h
  WHERE h.entity_id = l.id AND h.action = 'detail_enriched'
)
WHERE detail_enrich_count IS NOT NULL
  AND detail_enrich_count < (
    SELECT count(*) FROM pulse_entity_sync_history h
    WHERE h.entity_id = l.id AND h.action = 'detail_enriched'
  );

COMMIT;
