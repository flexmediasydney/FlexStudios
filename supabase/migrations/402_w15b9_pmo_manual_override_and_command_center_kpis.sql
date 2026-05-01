-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 402 — Wave 15b.9: Pulse Missed-Opportunity Command Center
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: W15b.9 — master_admin control surface for the missed-opportunity
-- quoting engine.
--
-- Adds:
--   1. Manual override columns on pulse_listing_missed_opportunity so a
--      master_admin can override the engine's quoted_price for a specific
--      listing (e.g. the vision pipeline failed and the operator inspected
--      the listing manually). The columns let us:
--        * filter the dashboard by manually_overridden=true
--        * audit who made the override and why
--        * mark the override as final so the recompute cron skips it
--   2. engine_settings entry for the W15b vision pipeline cost cap + queue
--      pause flag — the dispatcher polls this to decide whether to dispatch
--      new vision jobs and to enforce the daily $30 cap.
--   3. RPC pulse_command_center_kpis(p_days int) — server-side aggregation
--      for the KPI strip (today's spend, vision queue count, average per
--      listing, failure rate, quote status distribution). Avoids 5 round
--      trips from the client.
--
-- Idempotency: every change uses IF NOT EXISTS / ON CONFLICT / OR REPLACE so
-- the migration is safe to re-apply against an already-patched database.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Manual override columns on pulse_listing_missed_opportunity ─────────
ALTER TABLE public.pulse_listing_missed_opportunity
  ADD COLUMN IF NOT EXISTS manually_overridden boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS manual_override_by uuid,
  ADD COLUMN IF NOT EXISTS manual_override_reason text,
  ADD COLUMN IF NOT EXISTS manual_override_at timestamptz,
  ADD COLUMN IF NOT EXISTS manual_override_final boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS manual_override_price numeric;

COMMENT ON COLUMN public.pulse_listing_missed_opportunity.manually_overridden IS
  'W15b.9 — true when a master_admin has manually overridden the engine''s '
  'quoted_price for this listing. Set via the Command Center override dialog.';
COMMENT ON COLUMN public.pulse_listing_missed_opportunity.manual_override_by IS
  'W15b.9 — auth user_id of the master_admin who set the override.';
COMMENT ON COLUMN public.pulse_listing_missed_opportunity.manual_override_reason IS
  'W15b.9 — operator-supplied reason for the override (audit trail).';
COMMENT ON COLUMN public.pulse_listing_missed_opportunity.manual_override_at IS
  'W15b.9 — when the override was set.';
COMMENT ON COLUMN public.pulse_listing_missed_opportunity.manual_override_final IS
  'W15b.9 — when true, the recompute cron and substrate-invalidation triggers '
  'must NOT recompute this row''s quoted_price. Acts as a sticky lock.';
COMMENT ON COLUMN public.pulse_listing_missed_opportunity.manual_override_price IS
  'W15b.9 — the operator-set quote (in AUD). Distinct from quoted_price so we '
  'can preserve the engine''s last computed value alongside the override.';

CREATE INDEX IF NOT EXISTS idx_pmo_manually_overridden
  ON public.pulse_listing_missed_opportunity (manually_overridden)
  WHERE manually_overridden = true;

-- ─── 2. engine_settings entry for W15b vision pipeline ─────────────────────
INSERT INTO public.engine_settings (key, value, description)
VALUES (
  'pulse_vision',
  '{"daily_cap_usd": 30, "queue_paused": false, "daily_cap_override_usd": 0, "daily_cap_override_date": null}'::jsonb,
  'W15b — config for the external listing vision pipeline. daily_cap_usd is the '
  'baseline daily spend ceiling. queue_paused stops the dispatcher kicking off '
  'new vision jobs. daily_cap_override_usd is a one-day cap extension set by the '
  'Command Center; daily_cap_override_date is the YYYY-MM-DD it applies to.'
)
ON CONFLICT (key) DO NOTHING;

-- ─── 3. KPI aggregation RPC ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pulse_command_center_kpis(p_days int DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_settings jsonb;
  v_daily_cap numeric;
  v_queue_paused boolean;
  v_today_override numeric;
  v_override_date date;
  v_today_spend numeric;
  v_queue_pending int;
  v_avg_cost numeric;
  v_failure_rate numeric;
  v_quote_dist jsonb;
  v_total_quotes_fresh int;
  v_total_quotes_stale int;
  v_total_quotes_pending int;
  v_total_quotes_failed int;
  v_total_quotes_overridden int;
BEGIN
  -- ── Engine settings ──────────────────────────────────────────────────────
  SELECT value INTO v_settings
  FROM public.engine_settings
  WHERE key = 'pulse_vision';

  v_daily_cap := COALESCE((v_settings->>'daily_cap_usd')::numeric, 30);
  v_queue_paused := COALESCE((v_settings->>'queue_paused')::boolean, false);
  v_today_override := COALESCE((v_settings->>'daily_cap_override_usd')::numeric, 0);
  BEGIN
    v_override_date := (v_settings->>'daily_cap_override_date')::date;
  EXCEPTION WHEN OTHERS THEN
    v_override_date := NULL;
  END;

  -- Only honour the override if it's for today
  IF v_override_date IS DISTINCT FROM current_date THEN
    v_today_override := 0;
  END IF;

  -- ── Cost / queue metrics ─────────────────────────────────────────────────
  -- Vision extracts table may be empty when W15b.2 hasn't landed yet — wrap
  -- in a defensive try/catch so the dashboard renders zero state instead of
  -- erroring out.
  BEGIN
    SELECT COALESCE(SUM(total_cost_usd), 0) INTO v_today_spend
    FROM public.pulse_listing_vision_extracts
    WHERE created_at::date = current_date;

    SELECT COUNT(*) INTO v_queue_pending
    FROM public.pulse_listing_vision_extracts
    WHERE status IN ('pending', 'running');

    SELECT AVG(total_cost_usd) INTO v_avg_cost
    FROM public.pulse_listing_vision_extracts
    WHERE total_cost_usd > 0
      AND created_at > now() - (p_days || ' days')::interval;

    SELECT
      ROUND(
        100.0 * COUNT(*) FILTER (WHERE status = 'failed')
        / NULLIF(COUNT(*), 0),
        1
      )
    INTO v_failure_rate
    FROM public.pulse_listing_vision_extracts
    WHERE created_at > now() - (p_days || ' days')::interval;
  EXCEPTION WHEN undefined_table THEN
    v_today_spend := 0;
    v_queue_pending := 0;
    v_avg_cost := NULL;
    v_failure_rate := NULL;
  END;

  -- ── Quote status distribution from PMO substrate ─────────────────────────
  SELECT jsonb_object_agg(quote_status, n) INTO v_quote_dist
  FROM (
    SELECT quote_status, COUNT(*) AS n
    FROM public.pulse_listing_missed_opportunity
    GROUP BY quote_status
  ) sub;

  -- Cheap discrete counts for the hero strip
  SELECT
    COUNT(*) FILTER (WHERE quote_status = 'fresh' AND COALESCE(manually_overridden, false) = false),
    COUNT(*) FILTER (WHERE quote_status = 'stale' AND COALESCE(manually_overridden, false) = false),
    COUNT(*) FILTER (WHERE quote_status = 'pending'),
    COUNT(*) FILTER (WHERE quote_status = 'failed'),
    COUNT(*) FILTER (WHERE manually_overridden = true)
  INTO
    v_total_quotes_fresh,
    v_total_quotes_stale,
    v_total_quotes_pending,
    v_total_quotes_failed,
    v_total_quotes_overridden
  FROM public.pulse_listing_missed_opportunity;

  RETURN jsonb_build_object(
    'todays_spend_usd',           COALESCE(v_today_spend, 0),
    'daily_cap_usd',              v_daily_cap,
    'daily_cap_override_usd',     v_today_override,
    'effective_cap_usd',          v_daily_cap + v_today_override,
    'queue_paused',               v_queue_paused,
    'vision_queue_pending',       COALESCE(v_queue_pending, 0),
    'avg_per_listing_usd',        v_avg_cost,
    'failure_rate_pct',           v_failure_rate,
    'failure_rate_window_days',   p_days,
    'quote_status_distribution',  COALESCE(v_quote_dist, '{}'::jsonb),
    'total_quotes_fresh',         COALESCE(v_total_quotes_fresh, 0),
    'total_quotes_stale',         COALESCE(v_total_quotes_stale, 0),
    'total_quotes_pending',       COALESCE(v_total_quotes_pending, 0),
    'total_quotes_failed',        COALESCE(v_total_quotes_failed, 0),
    'total_quotes_overridden',    COALESCE(v_total_quotes_overridden, 0),
    'computed_at',                now()
  );
END $$;

COMMENT ON FUNCTION public.pulse_command_center_kpis(int) IS
  'W15b.9 — single-roundtrip aggregation for the Pulse Missed-Opportunity '
  'Command Center KPI strip. Returns today''s vision spend, queue depth, '
  'average cost, failure rate, and substrate quote_status distribution. '
  'p_days controls the rolling window for avg/failure metrics (default 7d).';

-- Grant — read-only RPC, safe for authenticated callers; the page ALSO checks
-- master_admin in the route guard, but the RPC itself is non-mutating so we
-- expose it to authenticated for shared dashboards.
GRANT EXECUTE ON FUNCTION public.pulse_command_center_kpis(int) TO authenticated;

NOTIFY pgrst, 'reload schema';
