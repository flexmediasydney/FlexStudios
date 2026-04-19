-- ============================================================================
-- Migration 153: Data-quality cleanup for 5 P0 bugs from Q1 audit
-- ============================================================================
-- Addresses:
--   A) Phone-as-price parser false positives (pulse_listings.asking_price)
--   B) Multi-email in email column (pulse_agents + pulse_agencies)
--   C) Landline numbers misclassified as mobile (pulse_agents.mobile)
--   D) Agency phone formatting junk (pulse_agencies.phone)
--   E) email_source / mobile_source NULL backfill (pulse_agents)
--   F) Agent stat hygiene (stale avg_sold_price + sold rows missing sold_date)
--   G) Full_name placeholders ('Unknown'/'undefined'/'null'/'Null')
--
-- Pre-counts captured 2026-04-19 (via Supabase Mgmt API query):
--   A: 92 listings match
--   B: 28 agents + 54 agencies with comma-joined emails
--   C: 269 agents with landline-looking value in mobile (1 already has business_phone)
--   D: 1,762 agencies with non-digit/non-plus chars in phone
--   E: 3,614 agent rows w/ email set but email_source NULL
--       3,530 agent rows w/ mobile set but mobile_source NULL
--   F: 322 agents with avg_sold_price and zero sold listings
--       57 listings marked 'sold' with sold_date NULL
--   G: 0 placeholder full_name rows (defensive — included for idempotency)
--
-- All changes wrapped in a single transaction.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Section A — Phone-as-price parser false positives
-- ----------------------------------------------------------------------------
-- Listings where asking_price is obviously a phone fragment or garbage number
-- derived from free-text in price_text (see audit samples like "0451106967",
-- "942000000", "2166", "Final Inspections 0412188023" etc.).
--
-- Strategy: null out asking_price when it is:
--   - >$50M (no plausible residential asking price in this DB)
--   - a 10-digit mobile prefix (04xxxxxxxx) — matched on bigint truncation
--   - a 1300/1800 national number
--   - <$50K and >10 (sub-$50K residential sale is phone-fragment / year / sqm)
-- ----------------------------------------------------------------------------

UPDATE pulse_listings
SET asking_price = NULL
WHERE asking_price IS NOT NULL
  AND listing_type IN ('for_sale','under_contract','sold')
  AND (
    asking_price > 50000000
    OR (asking_price::bigint)::text ~ '^04[0-9]{8}$'
    OR (asking_price::bigint)::text ~ '^1[38]00[0-9]{6}$'
    OR (asking_price < 50000 AND asking_price > 10)
  );

-- ----------------------------------------------------------------------------
-- Section B — Multi-email split (pulse_agents + pulse_agencies)
-- ----------------------------------------------------------------------------
-- Both tables have jsonb `alternate_emails` (verified via information_schema).
-- Primary = first comma-split token; extras appended to alternate_emails jsonb.
-- We trim whitespace on the appended values so " jcho@..." → "jcho@...".
-- ----------------------------------------------------------------------------

UPDATE pulse_agents
SET
  alternate_emails = COALESCE(alternate_emails, '[]'::jsonb)
    || to_jsonb(
         ARRAY(
           SELECT trim(x)
           FROM unnest(string_to_array(substring(email FROM position(',' IN email) + 1), ',')) AS x
           WHERE trim(x) <> ''
         )
       ),
  email = trim(split_part(email, ',', 1))
WHERE email LIKE '%,%';

UPDATE pulse_agencies
SET
  alternate_emails = COALESCE(alternate_emails, '[]'::jsonb)
    || to_jsonb(
         ARRAY(
           SELECT trim(x)
           FROM unnest(string_to_array(substring(email FROM position(',' IN email) + 1), ',')) AS x
           WHERE trim(x) <> ''
         )
       ),
  email = trim(split_part(email, ',', 1))
WHERE email LIKE '%,%';

-- ----------------------------------------------------------------------------
-- Section C — Landlines misclassified as mobile
-- ----------------------------------------------------------------------------
-- AU mobile prefix is 04xx. Anything starting with 02/03/07/08/13/1300/1800
-- sitting in `mobile` is a landline/virtual number. Move to business_phone
-- only if business_phone is currently NULL; otherwise preserve business_phone
-- and just clear mobile (1 row matches the preserve-path per pre-audit).
-- ----------------------------------------------------------------------------

UPDATE pulse_agents
SET
  business_phone = COALESCE(business_phone, mobile),
  mobile         = NULL
WHERE mobile ~ '^(02|03|07|08|13|1300|1800)';

-- ----------------------------------------------------------------------------
-- Section D — Agency phone formatting junk
-- ----------------------------------------------------------------------------
-- Normalize by stripping non-digit/non-plus chars. If the resulting length is
-- outside the 8–15 range (AU shortest 8-digit, ITU max 15) the source was
-- unparseable → NULL it so downstream code can flag for re-enrichment.
-- ----------------------------------------------------------------------------

UPDATE pulse_agencies
SET phone = CASE
  WHEN length(regexp_replace(phone, '[^\d+]', '', 'g')) BETWEEN 8 AND 15
    THEN regexp_replace(phone, '[^\d+]', '', 'g')
  ELSE NULL
END
WHERE phone IS NOT NULL AND phone ~ '[^\d+]';

-- ----------------------------------------------------------------------------
-- Section E — email_source / mobile_source NULL backfill
-- ----------------------------------------------------------------------------
-- Legacy rows pre-date the source-tracking feature. Tag them 'legacy' so we
-- can distinguish pre-instrumentation data from truly-null sources going fwd.
-- ----------------------------------------------------------------------------

UPDATE pulse_agents
SET email_source = 'legacy'
WHERE email IS NOT NULL AND email_source IS NULL;

UPDATE pulse_agents
SET mobile_source = 'legacy'
WHERE mobile IS NOT NULL AND mobile_source IS NULL;

-- ----------------------------------------------------------------------------
-- Section F — Agent stat hygiene
-- ----------------------------------------------------------------------------
-- F1: Null avg_sold_price where the agent has no 'sold' listings on record.
-- F2: Sold listings without sold_date → backfill from last_synced_at.
-- ----------------------------------------------------------------------------

UPDATE pulse_agents pa
SET avg_sold_price = NULL
WHERE avg_sold_price IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM pulse_listings pl
    WHERE pl.agent_rea_id = pa.rea_agent_id
      AND pl.listing_type = 'sold'
  );

UPDATE pulse_listings
SET sold_date = last_synced_at::date
WHERE listing_type = 'sold'
  AND sold_date IS NULL
  AND last_synced_at IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Section G — Full_name placeholder scrub
-- ----------------------------------------------------------------------------
-- Defensive / idempotent: current count is 0 but keep for future drift.
-- ----------------------------------------------------------------------------

UPDATE pulse_agents
SET full_name = NULL
WHERE full_name IN ('Unknown', 'undefined', 'null', 'Null');

COMMIT;
