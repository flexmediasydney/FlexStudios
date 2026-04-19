-- Migration 152: fix 4 P0 pipeline bugs found by QC audit (2026-04-19)
--
-- This migration fixes three server-side issues; a fourth bug (direct
-- INSERTs from pulseFireScrapes + pulseCircuitReset that miss sync_log_id
-- and idempotency_key) is fixed in the companion edge-function deploys.
--
-- ── Bug 1 — Bridge RPCs emit pulse_timeline rows without sync_log_id ────
-- `pulse_reconcile_bridge_agents_from_listings()` (5,311 rows/day) and
-- `pulse_reconcile_bridge_agencies_from_refs()` (311 rows/day) write
-- companion rows into pulse_timeline in a CTE. Their column list did NOT
-- include `sync_log_id`, so every emitted row landed with NULL — 5,464
-- rows in the last 24h, ~95% of today's NULL backlog.
--
-- Fix: add `p_sync_log_id uuid DEFAULT NULL` param to both signatures and
-- include `sync_log_id` in the timeline INSERT column list using the new
-- param. DEFAULT NULL keeps existing zero-arg callers working. Caller
-- pulseReconcileOrphans/index.ts now passes its `ctx.syncLogId`.
-- Also added explicit idempotency_key on the timeline insert
-- (`first_seen:<rea_id>` convention) — matches existing rows and lets
-- ON CONFLICT rollup filters in migration 147 dedupe properly.
--
-- ── Bug 2 — pulse-coverage-watchdog cron 100% failing since 04-18 22:30 ─
-- The cron INSERTs into pulse_timeline with a CASE-derived title from a
-- SELECT ... FROM pulse_source_coverage GROUP BY (implicit). When the view
-- returns zero eligible rows (is_enabled=true + config predicate), the
-- MIN() returns NULL, string_agg returns NULL, and the aggregate query
-- STILL emits one row with NULL title → NOT NULL violation.
--
-- Fix: use `cron.alter_job` to wrap the INSERT in a HAVING count(*) > 0
-- guard (the aggregate row only emits when at least one source is
-- enabled) AND supply a default 'Coverage report — no sources' fallback
-- title via COALESCE. Also explicitly set `sync_log_id := NULL` and a
-- deterministic idempotency_key so the nightly row dedupes idempotently
-- (`coverage_report:<YYYY-MM-DD>`) and stops being flagged by the audit
-- RPCs in migration 148.
--
-- ── Bug 3 — tonomo-drift-detector cron 80% failing ────────────────────
-- detect_tonomo_drift() calls `jsonb_array_length(manually_locked_product_ids)`
-- and `jsonb_array_length(manually_locked_package_ids)`. But production
-- data shows these columns can be jsonb of type 'string' (not 'array') —
-- 3 rows at least. `jsonb_array_length` raises "cannot get array length
-- of a scalar" on anything other than an array.
--
-- Fix: guard both calls with `CASE WHEN jsonb_typeof(x) = 'array' THEN
-- jsonb_array_length(x) ELSE 0 END`. Preserve every other clause of the
-- detector. ALSO: the pre-existing INSERT INTO pulse_timeline inside the
-- function never set idempotency_key — once the scalar guard stopped
-- hiding the first error, the NOT NULL constraint on idempotency_key
-- would surface next. Add a deterministic per-project-per-day key so
-- the detector can re-run 4x/day without duplicating rows.
--
-- ────────────────────────────────────────────────────────────────────────

BEGIN;

-- Drop the prior zero-arg versions FIRST so the new signatures don't
-- create an overload ambiguity for PostgREST callers (which resolve by
-- overload set). The new p_sync_log_id-typed functions follow below.
DROP FUNCTION IF EXISTS public.pulse_reconcile_bridge_agents_from_listings();
DROP FUNCTION IF EXISTS public.pulse_reconcile_bridge_agencies_from_refs();


-- ═══════════════════════════════════════════════════════════════════════
-- Bug 1a — pulse_reconcile_bridge_agents_from_listings
-- ═══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.pulse_reconcile_bridge_agents_from_listings(
  p_sync_log_id uuid DEFAULT NULL
)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inserted integer := 0;
BEGIN
  WITH ins AS (
    INSERT INTO pulse_agents (
      rea_agent_id,
      full_name,
      agency_name,
      agency_rea_id,
      source,
      data_sources,
      data_integrity_score,
      total_listings_active,
      first_seen_at,
      last_synced_at,
      last_sync_log_id,
      is_in_crm,
      is_prospect
    )
    SELECT
      src.agent_rea_id,
      src.full_name,
      src.agency_name,
      src.agency_rea_id,
      'rea_listings_bridge'::text,
      '["rea_listings"]'::jsonb,
      30,
      src.total_listings_active,
      src.first_seen_at,
      src.last_synced_at,
      -- Prefer the caller-supplied sync_log_id (from the active
      -- pulseReconcileOrphans run) over the per-listing last_sync_log_id;
      -- falling back lets legacy paths keep working.
      COALESCE(p_sync_log_id, src.last_sync_log_id),
      false,
      false
    FROM (
      SELECT
        l.agent_rea_id,
        (array_agg(l.agent_name  ORDER BY length(l.agent_name)  DESC NULLS LAST))[1] AS full_name,
        (array_agg(l.agency_name ORDER BY length(l.agency_name) DESC NULLS LAST))[1] AS agency_name,
        (array_agg(l.agency_rea_id) FILTER (WHERE l.agency_rea_id IS NOT NULL))[1]   AS agency_rea_id,
        count(*)::int                                                                AS total_listings_active,
        min(l.first_seen_at)                                                         AS first_seen_at,
        max(l.last_synced_at)                                                        AS last_synced_at,
        (array_agg(l.last_sync_log_id ORDER BY l.last_synced_at DESC NULLS LAST)
          FILTER (WHERE l.last_sync_log_id IS NOT NULL))[1]                          AS last_sync_log_id
      FROM pulse_listings l
      WHERE l.agent_rea_id IS NOT NULL
        AND l.agent_name   IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pulse_agents pa WHERE pa.rea_agent_id = l.agent_rea_id)
      GROUP BY l.agent_rea_id
    ) src
    ON CONFLICT (rea_agent_id) DO NOTHING
    RETURNING id, rea_agent_id, full_name, agency_name, agency_rea_id, first_seen_at
  ),
  tl AS (
    -- Companion timeline rows for the agents we actually inserted.
    -- NEW in 152: include sync_log_id so rollup + audit RPCs (migrations
    -- 141/147/148) can link these events back to the reconciler run.
    INSERT INTO pulse_timeline (
      entity_type, pulse_entity_id, rea_id,
      event_type, event_category, title, description,
      new_value, source, created_at,
      sync_log_id, idempotency_key
    )
    SELECT
      'agent', ins.id, ins.rea_agent_id,
      'first_seen', 'system',
      COALESCE(ins.full_name, 'Unknown agent') || ' first detected',
      'Agent first seen via listing bridge'
        || CASE WHEN ins.agency_name IS NOT NULL
                THEN ' at ' || ins.agency_name ELSE '' END,
      jsonb_build_object(
        'agency_name', ins.agency_name,
        'agency_rea_id', ins.agency_rea_id,
        'source', 'rea_listings_bridge'
      ),
      'rea_listings_bridge',
      COALESCE(ins.first_seen_at, now()),
      p_sync_log_id,
      'first_seen:' || ins.rea_agent_id
    FROM ins
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::int INTO v_inserted FROM ins;
  RETURN v_inserted;
END;
$function$;

COMMENT ON FUNCTION public.pulse_reconcile_bridge_agents_from_listings(uuid) IS
  'Reconciler: creates pulse_agents rows for listings that reference an '
  'agent_rea_id without a matching pulse_agents row. Emits companion '
  'pulse_timeline first_seen events linked to the supplied sync_log_id '
  '(migration 152 — fixes 5,311 NULL sync_log_id rows/day).';


-- ═══════════════════════════════════════════════════════════════════════
-- Bug 1b — pulse_reconcile_bridge_agencies_from_refs
-- ═══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.pulse_reconcile_bridge_agencies_from_refs(
  p_sync_log_id uuid DEFAULT NULL
)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inserted integer := 0;
BEGIN
  WITH ins AS (
    INSERT INTO pulse_agencies (
      rea_agency_id,
      name,
      source,
      data_sources,
      active_listings,
      first_seen_at,
      last_synced_at,
      last_sync_log_id,
      is_in_crm
    )
    SELECT DISTINCT ON (lower(trim(src.name)))
      src.rea_agency_id,
      src.name,
      'rea_listings_bridge'::text,
      '["rea_listings"]'::jsonb,
      src.active_listings,
      src.first_seen_at,
      src.last_synced_at,
      COALESCE(p_sync_log_id, src.last_sync_log_id),
      false
    FROM (
      SELECT
        l.agency_rea_id                                                              AS rea_agency_id,
        (array_agg(l.agency_name ORDER BY length(l.agency_name) DESC NULLS LAST))[1] AS name,
        count(*)::int                                                                AS active_listings,
        min(l.first_seen_at)                                                         AS first_seen_at,
        max(l.last_synced_at)                                                        AS last_synced_at,
        (array_agg(l.last_sync_log_id ORDER BY l.last_synced_at DESC NULLS LAST)
          FILTER (WHERE l.last_sync_log_id IS NOT NULL))[1]                          AS last_sync_log_id
      FROM pulse_listings l
      WHERE l.agency_rea_id IS NOT NULL
        AND l.agency_name   IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pulse_agencies ag WHERE ag.rea_agency_id = l.agency_rea_id)
      GROUP BY l.agency_rea_id

      UNION ALL

      SELECT
        pa.agency_rea_id                                                              AS rea_agency_id,
        (array_agg(pa.agency_name ORDER BY length(pa.agency_name) DESC NULLS LAST))[1] AS name,
        NULL::int                                                                     AS active_listings,
        min(pa.first_seen_at)                                                         AS first_seen_at,
        max(pa.last_synced_at)                                                        AS last_synced_at,
        NULL::uuid                                                                    AS last_sync_log_id
      FROM pulse_agents pa
      WHERE pa.agency_rea_id IS NOT NULL
        AND pa.agency_name   IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pulse_agencies ag WHERE ag.rea_agency_id = pa.agency_rea_id)
      GROUP BY pa.agency_rea_id
    ) src
    ORDER BY lower(trim(src.name)), src.active_listings DESC NULLS LAST
    ON CONFLICT (lower(trim(name))) DO NOTHING
    RETURNING id, rea_agency_id, name, first_seen_at
  ),
  tl AS (
    -- Companion timeline rows for the agencies we actually inserted.
    -- NEW in 152: include sync_log_id + explicit idempotency_key.
    INSERT INTO pulse_timeline (
      entity_type, pulse_entity_id, rea_id,
      event_type, event_category, title, description,
      new_value, source, created_at,
      sync_log_id, idempotency_key
    )
    SELECT
      'agency', ins.id, ins.rea_agency_id,
      'first_seen', 'system',
      COALESCE(ins.name, 'Unknown agency') || ' first detected',
      'Agency first seen via listing bridge',
      jsonb_build_object(
        'name', ins.name,
        'rea_agency_id', ins.rea_agency_id,
        'source', 'rea_listings_bridge'
      ),
      'rea_listings_bridge',
      COALESCE(ins.first_seen_at, now()),
      p_sync_log_id,
      'first_seen:agency:' || ins.rea_agency_id
    FROM ins
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::int INTO v_inserted FROM ins;
  RETURN v_inserted;
END;
$function$;

COMMENT ON FUNCTION public.pulse_reconcile_bridge_agencies_from_refs(uuid) IS
  'Reconciler: creates pulse_agencies rows for listings + agents that '
  'reference an agency_rea_id without a matching pulse_agencies row. '
  'Emits companion pulse_timeline first_seen events linked to the '
  'supplied sync_log_id (migration 152 — fixes 311 NULL rows/day).';


-- ═══════════════════════════════════════════════════════════════════════
-- Bug 3 — detect_tonomo_drift: guard scalar vs array on jsonb_array_length
-- ═══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.detect_tonomo_drift()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  drift_count INTEGER := 0;
  r RECORD;
BEGIN
  FOR r IN
    SELECT p.id,
           p.title,
           p.property_address,
           p.tonomo_order_id,
           p.tonomo_service_tiers,
           p.manually_overridden_fields,
           p.manually_locked_product_ids,
           p.manually_locked_package_ids
      FROM projects p
     WHERE p.tonomo_service_tiers IS NOT NULL
       AND p.tonomo_service_tiers <> '[]'
       AND p.tonomo_service_tiers <> ''
       AND p.tonomo_pending_delta IS NULL
       AND (
            COALESCE(p.manually_overridden_fields::text, '') ILIKE '%products%'
         OR COALESCE(p.manually_overridden_fields::text, '') ILIKE '%packages%'
         -- NEW in 152: guard scalar/object values. Prod data has 3+ rows
         -- where these columns are jsonb strings, not arrays — which
         -- made jsonb_array_length raise 22023 ("cannot get array length
         -- of a scalar") and killed the drift cron 80% of the time.
         OR (
              p.manually_locked_product_ids IS NOT NULL
              AND jsonb_typeof(p.manually_locked_product_ids) = 'array'
              AND jsonb_array_length(p.manually_locked_product_ids) > 0
            )
         OR (
              p.manually_locked_package_ids IS NOT NULL
              AND jsonb_typeof(p.manually_locked_package_ids) = 'array'
              AND jsonb_array_length(p.manually_locked_package_ids) > 0
            )
           )
       AND NOT EXISTS (
             SELECT 1
               FROM pulse_timeline pt
              WHERE pt.crm_entity_id = p.id
                AND pt.event_type = 'tonomo_drift_detected'
                AND pt.created_at > NOW() - INTERVAL '24 hours'
           )
  LOOP
    INSERT INTO pulse_timeline (
      entity_type, crm_entity_id,
      event_type, event_category,
      title, description, source, metadata, created_at,
      sync_log_id, idempotency_key
    ) VALUES (
      'project', r.id,
      'tonomo_drift_detected', 'data_drift',
      'Tonomo drift: ' || COALESCE(r.title, r.property_address, 'project ' || r.id::text),
      'Project has Tonomo service tiers set but a manual-override lock on products/packages and no pending delta. The runtime detector may have missed this event. Review in the Project Details banner.',
      'tonomo_drift_cron',
      jsonb_build_object('tonomo_order_id', r.tonomo_order_id, 'detected_at', NOW()),
      NOW(),
      NULL::uuid,
      'tonomo_drift_detected:' || r.id::text || ':' || to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD')
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
    drift_count := drift_count + 1;
  END LOOP;

  RETURN drift_count;
END;
$function$;

COMMENT ON FUNCTION public.detect_tonomo_drift() IS
  'Periodic detector for Tonomo product/package override drift. '
  'Migration 152: guards jsonb_array_length with jsonb_typeof to survive '
  'non-array values in manually_locked_{product,package}_ids (was failing '
  '80% of cron runs with 22023 cannot get array length of a scalar).';


-- ═══════════════════════════════════════════════════════════════════════
-- Bug 2 — pulse-coverage-watchdog cron: guard zero-rows + explicit
-- sync_log_id / idempotency_key on the emitted pulse_timeline row.
-- ═══════════════════════════════════════════════════════════════════════
-- Before: aggregate query emitted one row even when pulse_source_coverage
--   returned zero — with a NULL title (MIN over empty set). NOT NULL
--   constraint on title made every run fail.
-- After: HAVING count(*) > 0 suppresses the emit when there are no
--   enabled sources (there will almost always be some, so this is
--   defensive). A COALESCE wraps the CASE-derived title so we never
--   ship NULL even if one of the aggregates returns NULL. sync_log_id
--   is set explicitly to NULL (this is a run-level cron event, not a
--   per-sync audit). idempotency_key is day-deterministic so re-runs
--   within the same UTC day don't spam the timeline.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pulse-coverage-watchdog') THEN
    PERFORM cron.alter_job(
      job_id  := (SELECT jobid FROM cron.job WHERE jobname = 'pulse-coverage-watchdog'),
      command := $cron$
        INSERT INTO pulse_timeline (
          entity_type, event_type, event_category,
          title, description, new_value, source, created_at,
          sync_log_id, idempotency_key
        )
        SELECT
          'system',
          'coverage_report',
          'system',
          COALESCE(
            CASE
              WHEN MIN(COALESCE(coverage_pct_24h, 0)) < 95
                THEN '⚠ Coverage below SLO: ' || ROUND(MIN(COALESCE(coverage_pct_24h, 0))) || '%'
              ELSE '✓ Coverage SLO met (' || ROUND(MIN(COALESCE(coverage_pct_24h, 100))) || '%+ all sources)'
            END,
            'Coverage report — no sources'
          ),
          COALESCE(
            'Per-source 24h coverage: ' ||
              string_agg(source_id || '=' || COALESCE(coverage_pct_24h, 0) || '%', ', ' ORDER BY source_id),
            'No enabled sources'
          ),
          jsonb_build_object(
            'min_coverage_pct', MIN(COALESCE(coverage_pct_24h, 0)),
            'sources', COALESCE(
              jsonb_agg(jsonb_build_object(
                'source_id', source_id,
                'coverage_pct_24h', coverage_pct_24h,
                'suburbs_synced_24h', suburbs_synced_24h,
                'items_dead_lettered_24h', items_dead_lettered_24h,
                'items_pending', items_pending,
                'items_running', items_running,
                'circuit_state', circuit_state,
                'pool_size', pool_size
              ) ORDER BY source_id),
              '[]'::jsonb
            )
          ),
          'watchdog',
          NOW(),
          NULL::uuid,
          'coverage_report:' || to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD')
        FROM pulse_source_coverage
        WHERE is_enabled = true
        HAVING count(*) > 0
        ON CONFLICT (idempotency_key) DO NOTHING
      $cron$
    );
    RAISE NOTICE 'pulse-coverage-watchdog cron updated';
  ELSE
    RAISE NOTICE 'pulse-coverage-watchdog cron not found; skipping';
  END IF;
END;
$$;

COMMIT;
