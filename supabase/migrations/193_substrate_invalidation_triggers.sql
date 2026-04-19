-- 193_substrate_invalidation_triggers.sql
-- ═════════════════════════════════════════════════════════════════════════
-- Substrate invalidation for pulse_listing_missed_opportunity
--
-- Problem
-- -------
-- pulse_listing_missed_opportunity ("the substrate") is the cache that every
-- Market Share / Retention / Missed-Opportunity chart reads from. It's
-- populated by pulse_compute_listing_quote() — which, by design, is pure and
-- reads inputs from several tables:
--
--   pulse_listings (media, price, status)
--   price_matrices (entity_type = agency|agent)
--   packages       (standard_tier.package_price, premium_tier.package_price)
--   products       (standard_tier, premium_tier) — esp. "Sales Images" overflow
--   projects       (status, property_key) — drives captured_by_active
--   legacy_projects (property_key)        — drives captured_by_legacy
--
-- Before this migration, only pulse_listings had a "mark stale" trigger
-- (migration 160). Edits to the other five tables silently stranded every
-- dependent substrate row on stale inputs, so Market Share read cached
-- numbers derived from LAST WEEK's pricing.
--
-- This migration wires the missing paths:
--
--   1. price_matrices        → listings under matching agency/agent
--   2. packages              → listings with matching classified_package_id
--   3. products              → listings whose package contains the product
--                              (Sales Images is special — universal overflow)
--   4. projects              → listings with same property_key (capture)
--
-- Agent A simultaneously installs triggers on pulse_agencies / pulse_agents
-- linked_*_id changes (CRM mapping). Those invalidate the same column but on
-- an orthogonal path; the logic here intentionally does not overlap.
--
-- Each trigger simply flips quote_status → 'stale' where it isn't already.
-- The existing cron pulse-compute-stale-quotes (migration 161, every 10 min)
-- then drains the queue by calling pulse_compute_listing_quote() on each row.
--
-- Also shipped here:
--
--   • reason tagging — invalidation_reason text column added to track WHY each
--     row went stale (matrix_change / package_change / product_change /
--     project_change / listing_change / manual). Feeds the diagnostic RPC.
--
--   • pulse_compute_stale_quotes_for_matrix(p_matrix_id) — synchronous batch
--     recompute, used by the PriceMatrixEditor toast flow (deliverable 3).
--
--   • pulse_get_substrate_invalidation_stats() — diagnostic RPC returning
--     stale counts by reason + last cron drain time + backlog ETA
--     (deliverable 6).
--
--   • Retro-fill: every PMO row whose stored captured_by_active disagrees
--     with the live EXISTS check is marked stale so the cron picks it up
--     (deliverable 5).
--
-- Idempotent — every CREATE uses CREATE OR REPLACE / DROP TRIGGER IF EXISTS.
--
-- See also:
--   158  substrate schema
--   159  pulse_compute_listing_quote (original)
--   160  pulse_compute_stale_quotes + mark-stale trigger on pulse_listings
--   187  pulse_compute_listing_quote v1.1.0 (captured_by_{active,legacy})
--   194  timeline events on material quote changes
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 0. Schema additions ───────────────────────────────────────────────────

ALTER TABLE pulse_listing_missed_opportunity
  ADD COLUMN IF NOT EXISTS invalidation_reason text;

COMMENT ON COLUMN pulse_listing_missed_opportunity.invalidation_reason IS
  'Why this row is currently marked quote_status=stale. One of: matrix_change, package_change, product_change, project_change, listing_change, linked_entity_change, captured_drift, manual. Cleared to NULL when quote_status transitions back to fresh by pulse_compute_listing_quote.';

CREATE INDEX IF NOT EXISTS idx_pmo_invalidation_reason
  ON pulse_listing_missed_opportunity(invalidation_reason)
  WHERE invalidation_reason IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════
-- 1. price_matrices invalidation trigger
-- ══════════════════════════════════════════════════════════════════════════
-- On INSERT / UPDATE / DELETE of a price_matrices row, we invalidate every
-- pulse_listing whose billable entity resolves to the matrix's entity.
--
-- Resolution strategy:
--   • entity_type='agency' → match pulse_agencies.linked_agency_id = entity_id
--     then fall through to trigram name match ≥ 0.85 when linked_agency_id
--     is NULL. Trigram is bounded and cheap; we only run it against rows in
--     the same search space (linked_agency_id IS NULL).
--   • entity_type='agent'  → analogous via pulse_agents.linked_agent_id.
--
-- Only listings with quote_status <> 'stale' are touched (idempotent).
-- ══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION pulse_invalidate_substrate_for_matrix()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_entity_type text;
  v_entity_id uuid;
  v_entity_name text;
  v_rows int;
BEGIN
  -- Use NEW when available (INSERT/UPDATE), else OLD (DELETE).
  IF TG_OP = 'DELETE' THEN
    v_entity_type := OLD.entity_type;
    v_entity_id   := OLD.entity_id;
    v_entity_name := OLD.entity_name;
  ELSE
    v_entity_type := NEW.entity_type;
    v_entity_id   := NEW.entity_id;
    v_entity_name := NEW.entity_name;
  END IF;

  IF v_entity_type IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- ── Agency matrix ─────────────────────────────────────────────────────
  IF v_entity_type = 'agency' THEN
    -- Direct linked match
    UPDATE pulse_listing_missed_opportunity q
       SET quote_status = 'stale',
           invalidation_reason = 'matrix_change'
      FROM pulse_listings l, pulse_agencies pa
     WHERE q.listing_id = l.id
       AND l.agency_pulse_id = pa.id
       AND pa.linked_agency_id = v_entity_id
       AND v_entity_id IS NOT NULL
       AND q.quote_status <> 'stale';

    GET DIAGNOSTICS v_rows = ROW_COUNT;

    -- Trigram fallback when the pulse_agency has no linked_agency_id yet
    IF v_entity_name IS NOT NULL THEN
      UPDATE pulse_listing_missed_opportunity q
         SET quote_status = 'stale',
             invalidation_reason = 'matrix_change'
        FROM pulse_listings l, pulse_agencies pa
       WHERE q.listing_id = l.id
         AND l.agency_pulse_id = pa.id
         AND pa.linked_agency_id IS NULL
         AND pa.name IS NOT NULL
         AND similarity(lower(pa.name), lower(v_entity_name)) >= 0.85
         AND q.quote_status <> 'stale';
    END IF;
  END IF;

  -- ── Agent matrix ──────────────────────────────────────────────────────
  IF v_entity_type = 'agent' THEN
    UPDATE pulse_listing_missed_opportunity q
       SET quote_status = 'stale',
           invalidation_reason = 'matrix_change'
      FROM pulse_listings l, pulse_agents pa
     WHERE q.listing_id = l.id
       AND l.agent_pulse_id = pa.id
       AND pa.linked_agent_id = v_entity_id
       AND v_entity_id IS NOT NULL
       AND q.quote_status <> 'stale';

    IF v_entity_name IS NOT NULL THEN
      UPDATE pulse_listing_missed_opportunity q
         SET quote_status = 'stale',
             invalidation_reason = 'matrix_change'
        FROM pulse_listings l, pulse_agents pa
       WHERE q.listing_id = l.id
         AND l.agent_pulse_id = pa.id
         AND pa.linked_agent_id IS NULL
         AND pa.full_name IS NOT NULL
         AND similarity(lower(pa.full_name), lower(v_entity_name)) >= 0.85
         AND q.quote_status <> 'stale';
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$fn$;

COMMENT ON FUNCTION pulse_invalidate_substrate_for_matrix() IS
  'Trigger fn for price_matrices INSERT/UPDATE/DELETE. Marks every dependent pulse_listing_missed_opportunity row stale so the 10-min cron recomputes. See migration 193.';

DROP TRIGGER IF EXISTS trg_price_matrices_invalidate_substrate ON price_matrices;
CREATE TRIGGER trg_price_matrices_invalidate_substrate
  AFTER INSERT OR UPDATE OR DELETE ON price_matrices
  FOR EACH ROW
  EXECUTE FUNCTION pulse_invalidate_substrate_for_matrix();

-- ══════════════════════════════════════════════════════════════════════════
-- 2. packages invalidation trigger
-- ══════════════════════════════════════════════════════════════════════════
-- When a package's standard_tier or premium_tier jsonb changes, every
-- substrate row where classified_package_id = NEW.id is stale.
-- ══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION pulse_invalidate_substrate_for_package()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF (NEW.standard_tier IS DISTINCT FROM OLD.standard_tier
      OR NEW.premium_tier IS DISTINCT FROM OLD.premium_tier
      OR NEW.products IS DISTINCT FROM OLD.products) THEN
    UPDATE pulse_listing_missed_opportunity q
       SET quote_status = 'stale',
           invalidation_reason = 'package_change'
     WHERE q.classified_package_id = NEW.id
       AND q.quote_status <> 'stale';
  END IF;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION pulse_invalidate_substrate_for_package() IS
  'Trigger fn for packages UPDATE. Marks every substrate row using this package stale. See migration 193.';

DROP TRIGGER IF EXISTS trg_packages_invalidate_substrate ON packages;
CREATE TRIGGER trg_packages_invalidate_substrate
  AFTER UPDATE OF standard_tier, premium_tier, products ON packages
  FOR EACH ROW
  EXECUTE FUNCTION pulse_invalidate_substrate_for_package();

-- ══════════════════════════════════════════════════════════════════════════
-- 3. products invalidation trigger
-- ══════════════════════════════════════════════════════════════════════════
-- Special case: Sales Images (product id 30000000-0000-4000-a000-000000000001).
-- Every for_sale quote uses Sales Images for photo-count overflow — so a
-- standard/premium tier change on that product invalidates EVERY row.
--
-- For other products, invalidate:
--   (a) rows whose classified_package contains that product_id in packages.products, OR
--   (b) item-sum rows (pricing_method='item_sum_unclassifiable') — they compute
--       from products directly.
-- ══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION pulse_invalidate_substrate_for_product()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_sales_images_id uuid := '30000000-0000-4000-a000-000000000001'::uuid;
BEGIN
  IF NEW.standard_tier IS NOT DISTINCT FROM OLD.standard_tier
     AND NEW.premium_tier IS NOT DISTINCT FROM OLD.premium_tier THEN
    RETURN NEW;
  END IF;

  IF NEW.id = v_sales_images_id THEN
    -- Universal overflow — invalidate every row.
    UPDATE pulse_listing_missed_opportunity
       SET quote_status = 'stale',
           invalidation_reason = 'product_change'
     WHERE quote_status <> 'stale';
  ELSE
    -- Packages containing this product
    UPDATE pulse_listing_missed_opportunity q
       SET quote_status = 'stale',
           invalidation_reason = 'product_change'
      FROM packages pk
     WHERE q.classified_package_id = pk.id
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(pk.products, '[]'::jsonb)) p
          WHERE (p->>'product_id')::uuid = NEW.id
       )
       AND q.quote_status <> 'stale';

    -- Item-sum rows always read from products
    UPDATE pulse_listing_missed_opportunity
       SET quote_status = 'stale',
           invalidation_reason = 'product_change'
     WHERE pricing_method = 'item_sum_unclassifiable'
       AND quote_status <> 'stale';
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION pulse_invalidate_substrate_for_product() IS
  'Trigger fn for products UPDATE. Sales Images universal; others match packages containing the product or item-sum rows. See migration 193.';

DROP TRIGGER IF EXISTS trg_products_invalidate_substrate ON products;
CREATE TRIGGER trg_products_invalidate_substrate
  AFTER UPDATE OF standard_tier, premium_tier ON products
  FOR EACH ROW
  EXECUTE FUNCTION pulse_invalidate_substrate_for_product();

-- ══════════════════════════════════════════════════════════════════════════
-- 4. projects invalidation trigger (captured_by_active + pricing inheritance)
-- ══════════════════════════════════════════════════════════════════════════
-- A project change at a property affects every listing with the same
-- property_key (captured_by_active flag) AND every listing whose
-- pricing_source_ref_type = 'project' and pricing_source_ref = that project
-- (proximity_* cascade inherited from it).
--
-- Also fires on status changes between captured/uncaptured states.
--
-- Agent C owns the legacy_projects side via their own trigger.
-- ══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION pulse_invalidate_substrate_for_project()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_property_keys text[] := ARRAY[]::text[];
  v_status_changed boolean := false;
  v_property_changed boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.property_key IS NOT NULL THEN
      v_property_keys := array_append(v_property_keys, NEW.property_key);
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.property_key IS NOT NULL THEN
      v_property_keys := array_append(v_property_keys, OLD.property_key);
    END IF;
  ELSE
    v_status_changed   := NEW.status IS DISTINCT FROM OLD.status;
    v_property_changed := NEW.property_key IS DISTINCT FROM OLD.property_key;

    IF v_property_changed OR v_status_changed THEN
      IF OLD.property_key IS NOT NULL THEN
        v_property_keys := array_append(v_property_keys, OLD.property_key);
      END IF;
      IF NEW.property_key IS NOT NULL AND NEW.property_key IS DISTINCT FROM OLD.property_key THEN
        v_property_keys := array_append(v_property_keys, NEW.property_key);
      END IF;
    END IF;
  END IF;

  IF array_length(v_property_keys, 1) IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Mark any PMO row at the same property_key stale
  UPDATE pulse_listing_missed_opportunity
     SET quote_status = 'stale',
         invalidation_reason = 'project_change'
   WHERE property_key = ANY (v_property_keys)
     AND quote_status <> 'stale';

  -- Mark any PMO row whose pricing inherited from this project stale
  IF TG_OP <> 'INSERT' THEN
    UPDATE pulse_listing_missed_opportunity
       SET quote_status = 'stale',
           invalidation_reason = 'project_change'
     WHERE pricing_source_ref_type = 'project'
       AND pricing_source_ref = OLD.id
       AND quote_status <> 'stale';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$fn$;

COMMENT ON FUNCTION pulse_invalidate_substrate_for_project() IS
  'Trigger fn for projects INSERT/UPDATE/DELETE. Invalidates substrate rows at the same property_key (captured_by_active) and rows whose pricing inherited from the project. See migration 193.';

DROP TRIGGER IF EXISTS trg_projects_invalidate_substrate ON projects;
CREATE TRIGGER trg_projects_invalidate_substrate
  AFTER INSERT OR UPDATE OF status, property_key OR DELETE ON projects
  FOR EACH ROW
  EXECUTE FUNCTION pulse_invalidate_substrate_for_project();

-- ══════════════════════════════════════════════════════════════════════════
-- 5. pulse_compute_stale_quotes_for_matrix
-- ══════════════════════════════════════════════════════════════════════════
-- Synchronous batch recompute for a single price_matrix. Used by the
-- PriceMatrixEditor save flow to immediately reflect matrix edits in the
-- dashboards without waiting for the 10-min cron.
--
-- Uses the same resolver the trigger above uses so the row-set matches what
-- was just invalidated. Caps at p_limit (default 1000) to keep the HTTP
-- request bounded — larger matrices just fall through to the cron.
-- ══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION pulse_compute_stale_quotes_for_matrix(
  p_matrix_id uuid,
  p_limit int DEFAULT 1000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_start timestamptz := now();
  v_matrix record;
  v_processed int := 0;
  v_errors int := 0;
  v_rec record;
  v_err text;
  v_target_ids uuid[];
BEGIN
  SELECT entity_type, entity_id, entity_name
    INTO v_matrix
    FROM price_matrices
   WHERE id = p_matrix_id;

  IF v_matrix.entity_type IS NULL THEN
    RETURN jsonb_build_object(
      'processed', 0,
      'errors', 0,
      'reason', 'matrix_not_found',
      'matrix_id', p_matrix_id
    );
  END IF;

  -- Resolve target listing ids based on entity type
  IF v_matrix.entity_type = 'agency' THEN
    SELECT array_agg(l.id)
      INTO v_target_ids
      FROM pulse_listings l
      JOIN pulse_agencies pa ON pa.id = l.agency_pulse_id
     WHERE (
       pa.linked_agency_id = v_matrix.entity_id
       OR (pa.linked_agency_id IS NULL
           AND v_matrix.entity_name IS NOT NULL
           AND pa.name IS NOT NULL
           AND similarity(lower(pa.name), lower(v_matrix.entity_name)) >= 0.85)
     )
       AND l.listing_type = 'for_sale';
  ELSIF v_matrix.entity_type = 'agent' THEN
    SELECT array_agg(l.id)
      INTO v_target_ids
      FROM pulse_listings l
      JOIN pulse_agents pa ON pa.id = l.agent_pulse_id
     WHERE (
       pa.linked_agent_id = v_matrix.entity_id
       OR (pa.linked_agent_id IS NULL
           AND v_matrix.entity_name IS NOT NULL
           AND pa.full_name IS NOT NULL
           AND similarity(lower(pa.full_name), lower(v_matrix.entity_name)) >= 0.85)
     )
       AND l.listing_type = 'for_sale';
  END IF;

  IF v_target_ids IS NULL OR array_length(v_target_ids, 1) IS NULL THEN
    RETURN jsonb_build_object(
      'processed', 0,
      'errors', 0,
      'target_count', 0,
      'matrix_id', p_matrix_id,
      'elapsed_ms', (extract(epoch FROM (now() - v_start)) * 1000)::int
    );
  END IF;

  -- Bounded loop
  FOR v_rec IN
    SELECT unnest(v_target_ids) AS id
     LIMIT p_limit
  LOOP
    BEGIN
      PERFORM pulse_compute_listing_quote(v_rec.id);
      v_processed := v_processed + 1;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      RAISE WARNING 'matrix recompute failed for listing %: %', v_rec.id, v_err;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'processed', v_processed,
    'errors', v_errors,
    'target_count', array_length(v_target_ids, 1),
    'matrix_id', p_matrix_id,
    'elapsed_ms', (extract(epoch FROM (now() - v_start)) * 1000)::int,
    'completed_at', now()
  );
END;
$fn$;

COMMENT ON FUNCTION pulse_compute_stale_quotes_for_matrix(uuid, int) IS
  'Synchronous batch recompute of every pulse_listing under a specific price_matrix. Invoked by PriceMatrixEditor.jsx onSuccess to immediately reflect edits. Capped at p_limit (default 1000) — larger matrices fall through to the 10-min cron. See migration 193.';

GRANT EXECUTE ON FUNCTION pulse_compute_stale_quotes_for_matrix(uuid, int)
  TO authenticated, service_role;

-- ══════════════════════════════════════════════════════════════════════════
-- 6. pulse_get_substrate_invalidation_stats
-- ══════════════════════════════════════════════════════════════════════════
-- Diagnostic RPC for the Data Consistency settings page. Returns:
--   {
--     stale_total: int,
--     stale_by_reason: { matrix_change, package_change, product_change,
--                        project_change, listing_change, linked_entity_change,
--                        captured_drift, manual, unspecified },
--     last_cron_drain_at: timestamptz,  -- most recent fresh computed_at
--     oldest_stale_computed_at: timestamptz,
--     backlog_eta_minutes: numeric,     -- heuristic at 500/batch * 1 batch/10min
--     quote_status_breakdown: { fresh, stale, pending_enrichment, data_gap }
--   }
-- ══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION pulse_get_substrate_invalidation_stats()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  WITH s AS (
    SELECT quote_status, invalidation_reason, computed_at
      FROM pulse_listing_missed_opportunity
  ),
  counts AS (
    SELECT
      count(*) FILTER (WHERE quote_status = 'stale') AS stale_total,
      count(*) FILTER (WHERE quote_status = 'fresh') AS fresh_total,
      count(*) FILTER (WHERE quote_status = 'pending_enrichment') AS pending_total,
      count(*) FILTER (WHERE quote_status = 'data_gap') AS data_gap_total,
      count(*) FILTER (WHERE quote_status = 'stale' AND invalidation_reason = 'matrix_change') AS r_matrix,
      count(*) FILTER (WHERE quote_status = 'stale' AND invalidation_reason = 'package_change') AS r_package,
      count(*) FILTER (WHERE quote_status = 'stale' AND invalidation_reason = 'product_change') AS r_product,
      count(*) FILTER (WHERE quote_status = 'stale' AND invalidation_reason = 'project_change') AS r_project,
      count(*) FILTER (WHERE quote_status = 'stale' AND invalidation_reason = 'listing_change') AS r_listing,
      count(*) FILTER (WHERE quote_status = 'stale' AND invalidation_reason = 'linked_entity_change') AS r_linked,
      count(*) FILTER (WHERE quote_status = 'stale' AND invalidation_reason = 'captured_drift') AS r_drift,
      count(*) FILTER (WHERE quote_status = 'stale' AND invalidation_reason = 'manual') AS r_manual,
      count(*) FILTER (WHERE quote_status = 'stale' AND invalidation_reason IS NULL) AS r_unspec,
      max(computed_at) FILTER (WHERE quote_status = 'fresh') AS last_fresh_at,
      min(computed_at) FILTER (WHERE quote_status = 'stale') AS oldest_stale_at
    FROM s
  )
  SELECT jsonb_build_object(
    'stale_total', stale_total,
    'stale_by_reason', jsonb_build_object(
      'matrix_change',        r_matrix,
      'package_change',       r_package,
      'product_change',       r_product,
      'project_change',       r_project,
      'listing_change',       r_listing,
      'linked_entity_change', r_linked,
      'captured_drift',       r_drift,
      'manual',               r_manual,
      'unspecified',          r_unspec
    ),
    'quote_status_breakdown', jsonb_build_object(
      'fresh', fresh_total,
      'stale', stale_total,
      'pending_enrichment', pending_total,
      'data_gap', data_gap_total
    ),
    'last_cron_drain_at', last_fresh_at,
    'oldest_stale_computed_at', oldest_stale_at,
    -- Heuristic: cron runs every 10m, processes 500/batch. So backlog ETA =
    -- ceil(stale_total / 500) * 10 minutes. Purely an estimate.
    'backlog_eta_minutes', CASE
      WHEN stale_total = 0 THEN 0
      ELSE ceil(stale_total::numeric / 500.0) * 10
    END,
    'generated_at', now()
  )
  FROM counts;
$fn$;

COMMENT ON FUNCTION pulse_get_substrate_invalidation_stats() IS
  'Diagnostic RPC: counts of stale substrate rows by invalidation reason, cron drain time, and backlog ETA. Surfaced in the Data Consistency settings page. See migration 193.';

GRANT EXECUTE ON FUNCTION pulse_get_substrate_invalidation_stats()
  TO authenticated, service_role;

-- ══════════════════════════════════════════════════════════════════════════
-- 7. Retro-fill — reconcile stored captured_by_active against the live
-- EXISTS check. Any drift is marked stale so the cron recomputes the row and
-- emits the listing_captured / listing_un_captured timeline events
-- (migration 194). Runs once as part of this migration.
-- ══════════════════════════════════════════════════════════════════════════

DO $retro$
DECLARE
  v_drift_rows int;
BEGIN
  WITH drifted AS (
    SELECT q.listing_id
      FROM pulse_listing_missed_opportunity q
     WHERE q.property_key IS NOT NULL
       AND q.captured_by_active <> EXISTS (
         SELECT 1 FROM projects p
          WHERE p.property_key = q.property_key
            AND p.status IN ('delivered','scheduled','ready_for_partial','to_be_scheduled')
       )
  ),
  updated AS (
    UPDATE pulse_listing_missed_opportunity q
       SET quote_status = 'stale',
           invalidation_reason = 'captured_drift'
      FROM drifted d
     WHERE q.listing_id = d.listing_id
       AND q.quote_status <> 'stale'
    RETURNING q.listing_id
  )
  SELECT count(*) INTO v_drift_rows FROM updated;
  RAISE NOTICE 'retro-fill: captured_drift stale-marked % rows', v_drift_rows;
END $retro$;

COMMIT;
