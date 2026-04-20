-- Migration 212 — Industry Pulse derived-metric views
--
-- Four VIEWs on top of pulse_agents / pulse_listings / pulse_agent_stats_history.
-- Plain views (not materialized) — refresh cost matters later; for now we
-- read them on demand.
--
-- Schema notes / workarounds (vs the original spec):
--   1. pulse_agents.reviews_latest has NO date field (top-level keys are
--      only {role, rating, content}). We therefore cannot compute days-since.
--      We instead bucket by presence + `updated_at` as a proxy for "when we
--      last observed review data". This is honest about the data we have.
--   2. Column names mirror actual pulse_agents schema: total_sold_12m,
--      rea_median_sold_price, rea_rating, rea_review_count,
--      linked_agency_pulse_id.
--   3. pulse_listings recency uses first_seen_at OR last_synced_at
--      (26,904 of 27,177 listings have agent_rea_id; all have suburb).

BEGIN;

-- ── 1. v_pulse_agent_market_share_by_suburb ────────────────────────────────
-- Per (agent_rea_id, suburb) over the last 90 days of listings:
--   agent_listings / suburb_total * 100 = share_pct.
-- A suburb-local dominance signal — who controls the stock in which suburb.
CREATE OR REPLACE VIEW v_pulse_agent_market_share_by_suburb AS
WITH recent AS (
  SELECT agent_rea_id, suburb
  FROM pulse_listings
  WHERE suburb IS NOT NULL
    AND (
      first_seen_at  >= now() - interval '90 days'
      OR last_synced_at >= now() - interval '90 days'
    )
),
suburb_totals AS (
  SELECT suburb, count(*) AS suburb_total
  FROM recent
  GROUP BY suburb
),
agent_counts AS (
  SELECT agent_rea_id, suburb, count(*) AS agent_listings
  FROM recent
  WHERE agent_rea_id IS NOT NULL
  GROUP BY agent_rea_id, suburb
)
SELECT
  a.agent_rea_id,
  a.suburb,
  a.agent_listings,
  s.suburb_total,
  round((a.agent_listings::numeric / NULLIF(s.suburb_total, 0)) * 100, 2) AS share_pct
FROM agent_counts a
JOIN suburb_totals s USING (suburb);

COMMENT ON VIEW v_pulse_agent_market_share_by_suburb IS
  'Agent share of listings in each suburb over the last 90 days.';


-- ── 2. v_pulse_agent_review_freshness ──────────────────────────────────────
-- reviews_latest is {role, rating, content} — NO date. We fall back to
-- agents.updated_at as a proxy for "last time review data was observed".
-- Bucket semantics:
--   no_reviews : reviews_latest IS NULL or reviews_count = 0
--   fresh      : updated_at >= now() - 90 days AND reviews present
--   aging      : updated_at >= now() - 12 months AND reviews present
--   stale      : otherwise (reviews present but not refreshed recently)
CREATE OR REPLACE VIEW v_pulse_agent_review_freshness AS
SELECT
  id,
  rea_agent_id                             AS agent_rea_id,
  full_name                                AS name,
  linked_agency_pulse_id                   AS current_agency_id,
  agency_name                              AS current_agency_name,
  reviews_latest,
  reviews_count,
  rea_review_count,
  rea_rating,
  updated_at                               AS latest_review_observed_at,
  GREATEST(0, EXTRACT(DAY FROM (now() - updated_at))::int) AS days_since_latest_review_observed,
  CASE
    WHEN reviews_latest IS NULL OR COALESCE(reviews_count, 0) = 0 THEN 'no_reviews'
    WHEN updated_at >= now() - interval '90 days'                  THEN 'fresh'
    WHEN updated_at >= now() - interval '12 months'                THEN 'aging'
    ELSE 'stale'
  END AS freshness_bucket
FROM pulse_agents;

COMMENT ON VIEW v_pulse_agent_review_freshness IS
  'Per-agent review presence + updated_at proxy (reviews_latest has no date field).';


-- ── 3. v_pulse_agent_trajectory ────────────────────────────────────────────
-- MoM delta on total_sold_12m / rea_median_sold_price / rea_rating.
-- Uses pulse_agent_stats_history. "Prior" snapshot is the newest snapshot
-- that is at least 14 days older than the current one.
-- Returns a row for every agent who has a current snapshot; prior-fields
-- are NULL if history is too thin.
CREATE OR REPLACE VIEW v_pulse_agent_trajectory AS
WITH ranked AS (
  SELECT
    agent_rea_id,
    total_sold_12m,
    rea_median_sold_price,
    rea_rating,
    rea_review_count,
    snapshot_at,
    row_number() OVER (PARTITION BY agent_rea_id ORDER BY snapshot_at DESC) AS rn
  FROM pulse_agent_stats_history
),
current_snap AS (
  SELECT * FROM ranked WHERE rn = 1
),
prev_snap AS (
  SELECT DISTINCT ON (h.agent_rea_id)
    h.agent_rea_id,
    h.total_sold_12m,
    h.rea_median_sold_price,
    h.rea_rating,
    h.rea_review_count,
    h.snapshot_at
  FROM pulse_agent_stats_history h
  JOIN current_snap c ON c.agent_rea_id = h.agent_rea_id
  WHERE h.snapshot_at <= c.snapshot_at - interval '14 days'
  ORDER BY h.agent_rea_id, h.snapshot_at DESC
)
SELECT
  c.agent_rea_id,
  c.total_sold_12m         AS current_sold_12m,
  p.total_sold_12m         AS prior_sold_12m,
  (c.total_sold_12m - p.total_sold_12m)                                           AS delta_sold,
  CASE
    WHEN p.total_sold_12m IS NULL OR p.total_sold_12m = 0 THEN NULL
    ELSE round(((c.total_sold_12m - p.total_sold_12m)::numeric / p.total_sold_12m) * 100, 2)
  END                                                                              AS delta_sold_pct,
  c.rea_median_sold_price  AS current_median_price,
  p.rea_median_sold_price  AS prior_median_price,
  c.rea_rating             AS current_rating,
  p.rea_rating             AS prior_rating,
  c.rea_review_count       AS current_reviews,
  p.rea_review_count       AS prior_reviews,
  c.snapshot_at            AS current_snapshot_at,
  p.snapshot_at            AS prior_snapshot_at
FROM current_snap c
LEFT JOIN prev_snap p USING (agent_rea_id);

COMMENT ON VIEW v_pulse_agent_trajectory IS
  'Per-agent delta between latest snapshot and the most recent snapshot >=14 days older. NULL priors mean insufficient history.';


-- ── 4. v_pulse_agency_retention ────────────────────────────────────────────
-- Diff an agent's current_agency_id between the latest snapshot and
-- the most recent snapshot that is >= 30 days old.
-- movement:
--   new_in_dataset — no prior snapshot
--   retained       — same agency then and now
--   switched       — different agency
CREATE OR REPLACE VIEW v_pulse_agency_retention AS
WITH latest AS (
  SELECT DISTINCT ON (agent_rea_id)
    agent_rea_id,
    current_agency_id,
    current_agency_name,
    snapshot_at
  FROM pulse_agent_stats_history
  ORDER BY agent_rea_id, snapshot_at DESC
),
prior AS (
  SELECT DISTINCT ON (agent_rea_id)
    agent_rea_id,
    current_agency_id     AS prior_agency_id,
    current_agency_name   AS prior_agency_name,
    snapshot_at           AS prior_snapshot_at
  FROM pulse_agent_stats_history
  WHERE snapshot_at <= now() - interval '30 days'
  ORDER BY agent_rea_id, snapshot_at DESC
)
SELECT
  l.agent_rea_id,
  l.current_agency_id,
  l.current_agency_name,
  l.snapshot_at,
  p.prior_agency_id,
  p.prior_agency_name,
  p.prior_snapshot_at,
  CASE
    WHEN p.prior_agency_id IS NULL                      THEN 'new_in_dataset'
    WHEN p.prior_agency_id IS NOT DISTINCT FROM l.current_agency_id THEN 'retained'
    ELSE 'switched'
  END AS movement
FROM latest l
LEFT JOIN prior p USING (agent_rea_id);

COMMENT ON VIEW v_pulse_agency_retention IS
  'Agency movement: agents whose current_agency_id differs between latest snapshot and one >=30 days old.';


-- ── Permissions: match pulse_* pattern ────────────────────────────────────
GRANT SELECT ON v_pulse_agent_market_share_by_suburb TO anon, authenticated, service_role;
GRANT SELECT ON v_pulse_agent_review_freshness       TO anon, authenticated, service_role;
GRANT SELECT ON v_pulse_agent_trajectory             TO anon, authenticated, service_role;
GRANT SELECT ON v_pulse_agency_retention             TO anon, authenticated, service_role;

COMMIT;
