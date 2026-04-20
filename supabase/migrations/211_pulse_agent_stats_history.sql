-- Migration 211 — pulse_agent_stats_history
--
-- Time-series snapshot of the quantitative agent signals we compute from
-- the weekly REA sync. Two derived views (v_pulse_agent_trajectory and
-- v_pulse_agency_retention in migration 212) depend on this table having
-- at least two snapshots per agent to produce non-NULL deltas.
--
-- Column names mirror the actual pulse_agents schema at time of writing:
--   - total_sold_12m         (not "properties_sold")
--   - rea_median_sold_price  (not "median_sold_price")
--   - rea_rating
--   - rea_review_count
--   - avg_days_on_market
--   - linked_agency_pulse_id (agent→agency link at snapshot time)
--   - agency_name            (denormalised for readability in the view)
--   - suburbs_active         (jsonb)
--
-- Inserts are fire-and-forget from supabase/functions/pulseDataSync/index.ts
-- immediately after the pulse_agents upsert completes. Missing values are
-- NULL rather than zero — the trajectory view handles NULL priors.

BEGIN;

CREATE TABLE IF NOT EXISTS pulse_agent_stats_history (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_rea_id           text NOT NULL,
  pulse_agent_id         uuid REFERENCES pulse_agents(id) ON DELETE CASCADE,
  total_sold_12m         integer,
  rea_median_sold_price  numeric,
  avg_days_on_market     integer,
  rea_rating             numeric,
  rea_review_count       integer,
  reviews_count          integer,
  current_agency_id      uuid,        -- snapshot of linked_agency_pulse_id at this point
  current_agency_name    text,
  current_agency_rea_id  text,
  suburbs_active         jsonb,
  snapshot_at            timestamptz NOT NULL DEFAULT now(),
  sync_log_id            uuid         -- nullable; links to pulse_sync_logs row when available
);

CREATE INDEX IF NOT EXISTS idx_pulse_agent_stats_history_agent_time
  ON pulse_agent_stats_history (agent_rea_id, snapshot_at DESC);

CREATE INDEX IF NOT EXISTS idx_pulse_agent_stats_history_agency_time
  ON pulse_agent_stats_history (current_agency_id, snapshot_at DESC)
  WHERE current_agency_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pulse_agent_stats_history_sync_log
  ON pulse_agent_stats_history (sync_log_id)
  WHERE sync_log_id IS NOT NULL;

-- Match existing pulse_* table permissions (anon + authenticated + service_role).
GRANT SELECT, INSERT, UPDATE, DELETE ON pulse_agent_stats_history TO anon, authenticated, service_role;

COMMENT ON TABLE pulse_agent_stats_history IS
  'Weekly snapshot of pulse_agents quantitative fields. Populated by pulseDataSync; consumed by v_pulse_agent_trajectory / v_pulse_agency_retention.';

COMMIT;
