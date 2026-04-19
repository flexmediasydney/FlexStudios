-- Migration 151: pulse data cleanup + onConflict target fixes + bulk detail-count RPC
--
-- Bundles four concerns into one migration (2026-04-19):
--
--   1. Data cleanup for the size-keyword price parser bug (P1 #1).
--      Off-the-plan listings like "2-8 Wilson Street, Chatswood" had
--      `price_text` of "Up to 114 Internal!" / "83 Internal from 1.63m"
--      and our parsePrice() naively pulled the first integer as price,
--      yielding bogus $114, $147, $62 asking_prices. The parser is now
--      guarded (supabase/functions/pulseDataSync/index.ts parsePrice());
--      this migration NULLs the already-corrupted rows.
--
--   2. Address whitespace normalization (P1 #2). Same row family had
--      "2 - 8  Wilson Street" (double-space, spaces around hyphen) that
--      broke address-matching on reruns. Parser is now .replace(/\s+/g,' ')
--      .trim(); this migration backfills the existing rows.
--
--   3. Partial unique indexes on pulse_* are audited. Where we pass a
--      naked `onConflict: 'col'` from the edge fns, the matching index
--      must behave unambiguously. For `pulse_listings.source_listing_id`
--      we promote to a FULL unique (after removing 110 orphan rows
--      with NULL source_listing_id AND NULL source_url AND NULL
--      agent_rea_id — totally unlinkable). And we add a new full
--      unique on pulse_crm_mappings(entity_type, crm_entity_id) to
--      match the new upsert target in pulseDataSync.10a/10b (P1 #20).
--
--      Partial uniques that are LEFT ALONE because their existing
--      guards are sufficient:
--        * idx_pulse_agents_rea_id — code paths filter to withReaId
--          before upserting; 0 rows have null rea_agent_id in prod.
--        * idx_pulse_timeline_idempotency — 0 null rows in prod post-146.
--        * idx_pulse_signals_idempotency — similar.
--
--   4. New RPC `pulse_inc_listing_detail_count_bulk(p_ids uuid[])`
--      replaces the per-row N+1 `pulse_inc_listing_detail_count` calls
--      in pulseDetailEnrich batch loop (P1 #9).
--
-- NB: we intentionally do NOT wrap this file in BEGIN/COMMIT. The
-- pulse_listings table has triggers that fire on UPDATE/DELETE; combining
-- data mutations and DROP/CREATE INDEX inside a single transaction raises
-- "cannot CREATE INDEX because it has pending trigger events" (55006).
-- Each section below is idempotent and re-runnable independently, which
-- is how this was applied to prod on 2026-04-19.

-- ─────────────────────────────────────────────────────────────────────
-- 1. NULL out bogus asking_prices from the size-keyword parser bug.
--    Predicate mirrors the JS parser guard exactly.
--    Pre-migration count: 41 rows (2026-04-19).
-- ─────────────────────────────────────────────────────────────────────
UPDATE pulse_listings
SET asking_price = NULL
WHERE asking_price IS NOT NULL
  AND (
       price_text ILIKE '%internal%'
    OR price_text ILIKE '%sqm%'
    OR price_text ~* 'm²|\bm2\b'
  );

-- ─────────────────────────────────────────────────────────────────────
-- 2. Collapse repeated whitespace and trim address column.
--    Same regex the parser now applies on ingest.
--    Pre-migration count: 408 rows (2026-04-19).
-- ─────────────────────────────────────────────────────────────────────
UPDATE pulse_listings
SET address = regexp_replace(trim(address), '\s+', ' ', 'g')
WHERE address ~ '\s{2,}' OR address ~ '^\s+' OR address ~ '\s+$';

-- ─────────────────────────────────────────────────────────────────────
-- 3a. Delete orphan pulse_listings with no linkable ID (source_listing_id
--     NULL, source_url NULL, agent_rea_id NULL → totally untrackable,
--     can't be re-matched on the next sync). 110 rows as of audit.
-- ─────────────────────────────────────────────────────────────────────
DELETE FROM pulse_listings
WHERE source_listing_id IS NULL
  AND source_url IS NULL
  AND agent_rea_id IS NULL;

-- For any remaining rows with null source_listing_id (shouldn't be any
-- post-delete, but belt-and-braces), synthesize a stable key so the
-- promoted full unique index doesn't reject them on creation.
UPDATE pulse_listings
SET source_listing_id = CONCAT('synth:', md5(coalesce(source,'') || '|' || coalesce(source_url,'') || '|' || coalesce(address,'') || '|' || id::text))
WHERE source_listing_id IS NULL;

-- Promote partial unique to FULL. Naked `onConflict: 'source_listing_id'`
-- now resolves unambiguously.
DROP INDEX IF EXISTS idx_pulse_listings_source_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pulse_listings_source_id
  ON public.pulse_listings (source_listing_id);

-- ─────────────────────────────────────────────────────────────────────
-- 3b. pulse_crm_mappings: add a FULL unique on (entity_type, crm_entity_id).
--     This matches the edge code's dedup logic (each CRM record maps
--     to one pulse row) and gives a clean onConflict target for the
--     upserts in pulseDataSync.10a/10b (P1 #20 fix).
--
--     Collapse any duplicate (entity_type, crm_entity_id) rows first —
--     keep the confirmed one; tiebreak newest updated_at, then id.
-- ─────────────────────────────────────────────────────────────────────
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY entity_type, crm_entity_id
           ORDER BY
             CASE WHEN confidence = 'confirmed' THEN 0 ELSE 1 END,
             COALESCE(updated_at, created_at, NOW()) DESC,
             id DESC
         ) AS rn
  FROM pulse_crm_mappings
  WHERE crm_entity_id IS NOT NULL
)
DELETE FROM pulse_crm_mappings
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- FULL unique (no partial predicate) so PostgREST's upsert resolver
-- sees an unambiguous target for `onConflict: 'entity_type,crm_entity_id'`.
-- All 27 existing rows have crm_entity_id set (audit 2026-04-19).
CREATE UNIQUE INDEX IF NOT EXISTS idx_pulse_crm_map_entity_crm
  ON public.pulse_crm_mappings (entity_type, crm_entity_id);

-- ─────────────────────────────────────────────────────────────────────
-- 4. Bulk atomic-increment RPC for detail_enrich_count.
--    Replaces the N+1 per-row RPC inside pulseDetailEnrich batch loop.
--    Accepts an array of listing IDs and does a single UPDATE.
--    COALESCE guards against never-incremented rows (NULL detail_enrich_count).
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pulse_inc_listing_detail_count_bulk(p_ids uuid[])
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH upd AS (
    UPDATE pulse_listings
    SET detail_enrich_count = COALESCE(detail_enrich_count, 0) + 1
    WHERE id = ANY(p_ids)
    RETURNING 1
  )
  SELECT COUNT(*)::int FROM upd;
$$;

GRANT EXECUTE ON FUNCTION public.pulse_inc_listing_detail_count_bulk(uuid[]) TO service_role;
