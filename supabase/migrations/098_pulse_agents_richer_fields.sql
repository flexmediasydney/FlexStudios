-- 098_pulse_agents_richer_fields.sql
-- Capture more of what websift/realestateau actually returns.
--
-- Prior to this migration pulseDataSync was dropping fields that have real
-- intelligence value — most notably the reviews.compliments[] array
-- (e.g. "Professional: 254, Great negotiator: 68" per agent) and the
-- latest_review content. These are exactly the soft-signal data points a
-- CRM wants for competitive intelligence.
--
-- Also preserves the search_stats (suburb-scoped) vs profile_stats
-- (all-suburbs) distinction the actor returns — previously we were
-- conflating the two and picking the larger, which destroyed useful
-- per-suburb context.
--
-- New columns:
--   reviews_compliments    jsonb — [{tag, count}, ...] aggregated review tags
--   reviews_latest         jsonb — {role, rating, content, ...} most recent review
--   search_sales_breakdown jsonb — suburb-scoped count/medianPrice/medianDOM
--   friendly_name          text  — first-name/nickname from the actor
--
-- All nullable. No backfill required — new runs will populate them.
-- Existing rows keep their null-as-unknown semantics.

BEGIN;

ALTER TABLE pulse_agents
  ADD COLUMN IF NOT EXISTS reviews_compliments    JSONB,
  ADD COLUMN IF NOT EXISTS reviews_latest         JSONB,
  ADD COLUMN IF NOT EXISTS search_sales_breakdown JSONB,
  ADD COLUMN IF NOT EXISTS friendly_name          TEXT;

COMMENT ON COLUMN pulse_agents.reviews_compliments IS
  'Aggregated review-tag counts from realestate.com.au reviews page. '
  'Shape: [{tag: "Professional", count: 254}, ...]. Captured by migration 098.';

COMMENT ON COLUMN pulse_agents.reviews_latest IS
  'Most recent review from the actor payload. Shape: {role, rating, content}. '
  'Used for recent-sentiment surfacing. Captured by migration 098.';

COMMENT ON COLUMN pulse_agents.search_sales_breakdown IS
  'Suburb-scoped sales breakdown from websift search_stats. Differs from '
  'sales_breakdown (profile_sales_breakdown), which is agent-lifetime. '
  'Captured by migration 098.';

COMMENT ON COLUMN pulse_agents.friendly_name IS
  'Agent first-name/nickname (e.g. "Sonia" for "Sonia Poulos"). Captured by migration 098.';

COMMIT;
