-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 413 — Wave 11.6.21: Shortlisting Command Center KPI RPC
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: W11.6.21 — Shortlisting Command Center umbrella consolidates 9+
-- master_admin shortlisting settings pages under one tabbed admin surface.
-- This migration ships the Overview-tab KPI aggregation RPC.
--
-- Why one RPC, not seven:
--   * Each KPI aggregates over a different table (engine_run_audit,
--     shortlisting_rounds, pulse_listing_missed_opportunity,
--     shortlisting_overrides, shortlisting_events, calibration_sessions,
--     object_registry, object_registry_candidates) but the Overview tab
--     wants them all together. Single RPC = single round-trip = simple
--     useQuery state model — same pattern as W15b.9
--     (pulse_command_center_kpis) and W11.6
--     (pulse_or_engine_admin_kpis_for_rejection_dashboard).
--   * Read-only — no DDL, no DML; safe to drop/replace at any time.
--   * SECURITY DEFINER so the page can call without granting SELECT on
--     every underlying engine table to the authenticated role.
--
-- Returned blob shape (jsonb):
--   {
--     "todays_spend_usd": number,         -- engine_run_audit.total_cost_usd today
--     "rounds_today": int,                -- shortlisting_rounds count today
--     "avg_round_cost_usd_7d": number,    -- engine_run_audit.total_cost_usd avg 7d
--     "v2_vision_rollout_pct": number,    -- pmo.quoted_via in v2 / total
--     "override_rate_7d_pct": number,     -- non-approved actions / slot decisions 7d
--     "calibration_session_total": int,   -- calibration_sessions total
--     "calibration_session_by_status": jsonb,
--     "object_registry_size": int,        -- object_registry where status=canonical
--     "object_queue_pending": int,        -- object_registry_candidates status=pending
--     "window_days": int,
--     "computed_at": timestamptz
--   }
--
-- Defensive zero-state:
--   Every block wraps its aggregation in EXCEPTION WHEN undefined_table OR
--   undefined_column to return sensible defaults when a table/column hasn't
--   shipped yet. Critical for fresh-deploy environments and to keep the
--   Overview tab rendering even mid-wave.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.shortlisting_command_center_kpis(
  p_days int DEFAULT 7
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_window_start timestamptz;
  v_today_start timestamptz;
  v_todays_spend numeric;
  v_rounds_today int;
  v_avg_round_cost numeric;
  v_v2_total int;
  v_v2_match int;
  v_v2_rollout_pct numeric;
  v_override_count int;
  v_slot_decision_count int;
  v_override_rate_pct numeric;
  v_calibration_total int;
  v_calibration_by_status jsonb;
  v_registry_size int;
  v_queue_pending int;
BEGIN
  IF p_days IS NULL OR p_days < 1 THEN
    p_days := 7;
  ELSIF p_days > 365 THEN
    p_days := 365;
  END IF;

  v_window_start := now() - (p_days || ' days')::interval;
  v_today_start := date_trunc('day', now());

  -- ── 1. Today's spend (engine_run_audit) ─────────────────────────────────
  BEGIN
    SELECT COALESCE(SUM(total_cost_usd), 0)
      INTO v_todays_spend
      FROM engine_run_audit
     WHERE created_at >= v_today_start;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_todays_spend := 0;
  END;

  -- ── 2. Rounds today (shortlisting_rounds) ───────────────────────────────
  BEGIN
    SELECT COUNT(*)
      INTO v_rounds_today
      FROM shortlisting_rounds
     WHERE created_at >= v_today_start;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_rounds_today := 0;
  END;

  -- ── 3. Average round cost (7d, engine_run_audit) ────────────────────────
  BEGIN
    SELECT AVG(total_cost_usd)
      INTO v_avg_round_cost
      FROM engine_run_audit
     WHERE total_cost_usd > 0
       AND created_at >= v_window_start;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_avg_round_cost := NULL;
  END;

  -- ── 4. V2 vision rollout % (pulse_listing_missed_opportunity) ───────────
  -- Cross-track signal — surfaced here because it gates W15b.10 dropping
  -- the rule-based fallback and the shortlisting team needs to know how
  -- aggressively the vision pipeline is replacing rule-based quoting.
  BEGIN
    SELECT
      COUNT(*),
      COUNT(*) FILTER (
        WHERE quoted_via IN ('vision_v2', 'vision_v2_unclassifiable')
      )
      INTO v_v2_total, v_v2_match
      FROM pulse_listing_missed_opportunity;

    v_v2_rollout_pct := CASE
      WHEN COALESCE(v_v2_total, 0) = 0 THEN NULL
      ELSE ROUND(100.0 * v_v2_match / NULLIF(v_v2_total, 0), 1)
    END;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_v2_total := 0;
    v_v2_match := 0;
    v_v2_rollout_pct := NULL;
  END;

  -- ── 5. Override rate (7d, shortlisting_overrides vs shortlisting_events) ─
  -- Override rate = (non-approved override rows) / (slot decision events)
  -- Slot decision events: any event_type containing 'slot_assigned' or
  -- 'pass2_slot_assigned' — the engine always logs one per slot decision
  -- regardless of whether a human touched it afterwards. shortlisting_overrides
  -- only persists rows where a slot decision was committed (one row per slot,
  -- the human_action column captures whether the human accepted or modified
  -- the AI's proposal).
  BEGIN
    SELECT COUNT(*)
      INTO v_override_count
      FROM shortlisting_overrides
     WHERE human_action IS DISTINCT FROM 'approved_as_proposed'
       AND created_at >= v_window_start;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_override_count := 0;
  END;

  BEGIN
    SELECT COUNT(*)
      INTO v_slot_decision_count
      FROM shortlisting_events
     WHERE (event_type LIKE '%slot_assigned%' OR event_type LIKE '%pass2_slot%')
       AND created_at >= v_window_start;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_slot_decision_count := 0;
  END;

  -- Fall back to override row count as denominator if events table didn't
  -- record matching event_types yet — better to undercount than divide by 0.
  IF COALESCE(v_slot_decision_count, 0) = 0 THEN
    BEGIN
      SELECT COUNT(*)
        INTO v_slot_decision_count
        FROM shortlisting_overrides
       WHERE created_at >= v_window_start;
    EXCEPTION WHEN undefined_table OR undefined_column THEN
      v_slot_decision_count := 0;
    END;
  END IF;

  v_override_rate_pct := CASE
    WHEN COALESCE(v_slot_decision_count, 0) = 0 THEN NULL
    ELSE ROUND(100.0 * v_override_count / NULLIF(v_slot_decision_count, 0), 1)
  END;

  -- ── 6. Calibration sessions count + status breakdown ────────────────────
  BEGIN
    SELECT COUNT(*)
      INTO v_calibration_total
      FROM calibration_sessions;

    SELECT COALESCE(jsonb_object_agg(status, n), '{}'::jsonb)
      INTO v_calibration_by_status
      FROM (
        SELECT status, COUNT(*) AS n
          FROM calibration_sessions
         GROUP BY status
      ) t;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_calibration_total := 0;
    v_calibration_by_status := '{}'::jsonb;
  END;

  -- ── 7. Object registry size + queue depth ───────────────────────────────
  BEGIN
    SELECT COUNT(*)
      INTO v_registry_size
      FROM object_registry
     WHERE status = 'canonical';
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_registry_size := 0;
  END;

  BEGIN
    SELECT COUNT(*)
      INTO v_queue_pending
      FROM object_registry_candidates
     WHERE status = 'pending';
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    v_queue_pending := 0;
  END;

  -- ── Build the blob ──────────────────────────────────────────────────────
  RETURN jsonb_build_object(
    'todays_spend_usd',           COALESCE(v_todays_spend, 0),
    'rounds_today',               COALESCE(v_rounds_today, 0),
    'avg_round_cost_usd_7d',      v_avg_round_cost,
    'v2_vision_rollout_pct',      v_v2_rollout_pct,
    'v2_vision_total',            COALESCE(v_v2_total, 0),
    'v2_vision_match',            COALESCE(v_v2_match, 0),
    'override_rate_7d_pct',       v_override_rate_pct,
    'override_count_7d',          COALESCE(v_override_count, 0),
    'slot_decision_count_7d',     COALESCE(v_slot_decision_count, 0),
    'calibration_session_total',  COALESCE(v_calibration_total, 0),
    'calibration_session_by_status', COALESCE(v_calibration_by_status, '{}'::jsonb),
    'object_registry_size',       COALESCE(v_registry_size, 0),
    'object_queue_pending',       COALESCE(v_queue_pending, 0),
    'window_days',                p_days,
    'computed_at',                now()
  );
END $$;

COMMENT ON FUNCTION public.shortlisting_command_center_kpis(int) IS
  'W11.6.21 — single-roundtrip aggregation for the Shortlisting Command '
  'Center Overview tab. Returns today''s engine spend, rounds, V2 vision '
  'rollout %, 7d override rate, avg round cost, calibration session counts, '
  'and object registry size + queue depth. Defensive fallbacks for any '
  'underlying table/column that may not exist yet.';

GRANT EXECUTE ON FUNCTION public.shortlisting_command_center_kpis(int) TO authenticated;

NOTIFY pgrst, 'reload schema';
