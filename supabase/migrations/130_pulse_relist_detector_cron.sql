-- 130_pulse_relist_detector_cron.sql
-- Register the pulseRelistDetector event type + cron schedule.
--
-- ── Why ──────────────────────────────────────────────────────────────────
-- When a property was listed, withdrawn (owner pulled it), then re-listed,
-- there's a strong chance:
--   - The re-listed property needs fresh photos
--   - A different agent is handling the re-list
--   - The owner is ready to invest in better marketing
-- This is a high-value re-shoot signal that the existing pulseSignalGenerator
-- doesn't detect — it groups by property_key across the whole listing history
-- rather than looking at a single timeline event.
--
-- ── Components ───────────────────────────────────────────────────────────
--   1. pulse_relist_candidates RPC — returns the GROUP BY/HAVING query result
--      the edge function needs. Pushing the SQL server-side keeps the function
--      fast and lets us reuse the compound index on (property_key, first_seen_at).
--   2. pulse_timeline_event_types row for event_type='listing_relisted' so the
--      per-signal timeline entries pass the drift-warning trigger (migration
--      116) and show up on the PulseTimeline UI's event filter.
--   3. cron.schedule row for the daily trigger at 19:00 UTC (05:00 AEST next
--      day). Runs after pulseDetailEnrich (04:00 UTC) so the withdrawn-detector
--      flag is as fresh as possible.

BEGIN;

-- ── 1. Register the new event_type ───────────────────────────────────────
INSERT INTO pulse_timeline_event_types (event_type, category, description) VALUES
  ('listing_relisted', 'movement', 'Withdrawn property re-listed (re-shoot candidate)')
ON CONFLICT (event_type) DO UPDATE SET
  category = EXCLUDED.category,
  description = EXCLUDED.description;

-- ── 2. Server-side RPC for the relist-candidates query ───────────────────
-- Returns one row per property_key that has (a) more than one listing, (b) at
-- least one listing_withdrawn_at timestamp, and (c) a currently-active
-- listing whose first_seen_at is AFTER the most recent withdrawal. The
-- latest_active_at cutoff is parametrised so callers can widen or narrow the
-- "recent relist" window.
CREATE OR REPLACE FUNCTION public.pulse_relist_candidates(
  p_since timestamptz DEFAULT (now() - interval '30 days'),
  p_limit integer     DEFAULT 200
)
RETURNS TABLE (
  property_key             text,
  address                  text,
  suburb                   text,
  listing_count            bigint,
  last_withdrawn           timestamptz,
  latest_active_at         timestamptz,
  latest_active_listing_id uuid,
  latest_listing_type      text,
  agent_rea_ids            text[],
  agency_rea_ids           text[],
  agent_pulse_ids          uuid[],
  agency_pulse_ids         uuid[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH active_rows AS (
    SELECT
      property_key,
      first_seen_at,
      id AS listing_id,
      listing_type,
      agent_pulse_id,
      agency_pulse_id
    FROM pulse_listings
    WHERE property_key IS NOT NULL
      AND listing_type IN ('for_sale', 'for_rent', 'under_contract')
      AND listing_withdrawn_at IS NULL
  ),
  latest_active AS (
    -- Pick the most-recently-surfaced active listing per property so we can
    -- attribute the re-list to a single listing row (agent, listing_id).
    SELECT DISTINCT ON (property_key)
      property_key, first_seen_at, listing_id, listing_type,
      agent_pulse_id, agency_pulse_id
    FROM active_rows
    ORDER BY property_key, first_seen_at DESC NULLS LAST
  ),
  grouped AS (
    SELECT
      pl.property_key,
      min(pl.address)   AS address,
      min(pl.suburb)    AS suburb,
      count(*)          AS listing_count,
      max(pl.listing_withdrawn_at) AS last_withdrawn,
      array_remove(array_agg(DISTINCT pl.agent_rea_id),  NULL) AS agent_rea_ids,
      array_remove(array_agg(DISTINCT pl.agency_rea_id), NULL) AS agency_rea_ids,
      array_remove(array_agg(DISTINCT pl.agent_pulse_id),  NULL) AS agent_pulse_ids,
      array_remove(array_agg(DISTINCT pl.agency_pulse_id), NULL) AS agency_pulse_ids
    FROM pulse_listings pl
    WHERE pl.property_key IS NOT NULL
    GROUP BY pl.property_key
    HAVING count(*) > 1
       AND max(pl.listing_withdrawn_at) IS NOT NULL
  )
  SELECT
    g.property_key,
    g.address,
    g.suburb,
    g.listing_count,
    g.last_withdrawn,
    la.first_seen_at  AS latest_active_at,
    la.listing_id     AS latest_active_listing_id,
    la.listing_type   AS latest_listing_type,
    g.agent_rea_ids,
    g.agency_rea_ids,
    g.agent_pulse_ids,
    g.agency_pulse_ids
  FROM grouped g
  JOIN latest_active la USING (property_key)
  WHERE la.first_seen_at IS NOT NULL
    AND la.first_seen_at > g.last_withdrawn
    AND la.first_seen_at > p_since
  ORDER BY la.first_seen_at DESC
  LIMIT p_limit;
$$;

COMMENT ON FUNCTION public.pulse_relist_candidates IS
  'Relist-candidates for pulseRelistDetector. Returns properties with at least '
  'one withdrawn + one subsequent active listing (for_sale/for_rent/under_contract). '
  'p_since limits to relists whose active listing first_seen_at is in the window.';

-- ── 3. Cron registration ─────────────────────────────────────────────────
-- 19:00 UTC = 05:00 AEST next day. Runs after pulseDetailEnrich (04:00 UTC)
-- so withdrawn flags are as fresh as possible.
SELECT cron.schedule(
  'pulse-relist-detector',
  '0 19 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/pulseRelistDetector',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pulse_cron_jwt' LIMIT 1),
      'Content-Type',  'application/json',
      'x-caller-context', 'cron:pulse-relist-detector'
    ),
    body := '{"trigger":"cron"}'::jsonb
  );
  $cron$
);

COMMIT;
