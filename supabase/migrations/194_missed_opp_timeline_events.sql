-- 194_missed_opp_timeline_events.sql
-- ═════════════════════════════════════════════════════════════════════════
-- Material-change timeline events for pulse_listing_missed_opportunity.
--
-- Context
-- -------
-- Every 10 minutes the cron `pulse-compute-stale-quotes` drains the stale
-- substrate by calling pulse_compute_listing_quote() per row, which UPSERTs
-- back into pulse_listing_missed_opportunity. Before this migration, a quote
-- flipping from $2,800 to $3,400 left no trace: dashboards just showed the
-- new number with no "why did this happen?" narrative.
--
-- This migration adds an AFTER INSERT/UPDATE trigger on the substrate that
-- emits pulse_timeline events for MATERIALLY interesting changes:
--
--   quote_materially_changed
--     |quote_new - quote_old| / GREATEST(quote_old, 1) > 0.20   — ≥20% swing
--     OR resolved_tier changed
--     OR pricing_method changed
--
--   listing_captured
--     captured_by_active or captured_by_legacy flipped false → true
--
--   listing_un_captured
--     captured_by_active or captured_by_legacy flipped true → false
--
--   classification_changed
--     classified_package_name changed (rename-safe via package_id fallback)
--
--   tier_changed
--     resolved_tier changed (subset of quote_materially_changed, emitted
--     separately so the timeline can group tier-only shifts)
--
-- Idempotency
-- -----------
-- The trigger never fires on the INSERT of the very first row (no prior
-- state to compare). On UPDATE, it only emits when the tracked fields
-- differ. Each emit uses an idempotency_key so a re-run of the cron won't
-- duplicate rows (the unique partial index from migration 110 blocks it).
--
-- Anti-scope: does NOT touch pulse_compute_listing_quote's core body. The
-- emission is purely a downstream observer of the substrate UPSERT.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Register new event types ───────────────────────────────────────────
INSERT INTO pulse_timeline_event_types (event_type, category, description) VALUES
  ('quote_materially_changed', 'market', 'Missed-opportunity quote moved >20% or changed tier/method'),
  ('listing_captured',         'market', 'Listing newly covered by an active or legacy project'),
  ('listing_un_captured',      'market', 'Listing no longer covered by an active or legacy project'),
  ('classification_changed',   'market', 'Listing re-classified into a different package'),
  ('tier_changed',             'market', 'Listing resolved_tier changed (standard ↔ premium)')
ON CONFLICT (event_type) DO UPDATE SET
  category    = EXCLUDED.category,
  description = EXCLUDED.description;

-- ── 2. Emitter function ───────────────────────────────────────────────────
-- Receives OLD/NEW via the trigger. Inserts one or more pulse_timeline rows
-- keyed by (event_type + listing_id + computed_at) so re-runs don't dup.
--
-- Emits ON UPDATE only. The first INSERT has no prior state, so we skip it
-- — the retro-fill in migration 193 will have flipped every drifted row to
-- stale, and the next compute will UPDATE (not INSERT) and emit correctly.

CREATE OR REPLACE FUNCTION pulse_emit_missed_opp_timeline_events()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_quote_old numeric;
  v_quote_new numeric;
  v_pct_change numeric;
  v_material boolean;
  v_tier_changed boolean;
  v_method_changed boolean;
  v_package_changed boolean;
  v_cap_active_flipped_up boolean;
  v_cap_active_flipped_down boolean;
  v_cap_legacy_flipped_up boolean;
  v_cap_legacy_flipped_down boolean;
  v_listing_row record;
BEGIN
  -- Only act on UPDATE; INSERT has no prior snapshot.
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  -- Skip pure pending/data-gap transitions — those are not material.
  IF NEW.quote_status IN ('pending_enrichment') AND OLD.quote_status IN ('pending_enrichment') THEN
    RETURN NEW;
  END IF;

  v_quote_old := COALESCE(OLD.quoted_price, 0);
  v_quote_new := COALESCE(NEW.quoted_price, 0);
  v_pct_change := CASE
    WHEN GREATEST(v_quote_old, 1) = 0 THEN 0
    ELSE abs(v_quote_new - v_quote_old) / GREATEST(v_quote_old, 1)
  END;

  v_tier_changed    := NEW.resolved_tier  IS DISTINCT FROM OLD.resolved_tier;
  v_method_changed  := NEW.pricing_method IS DISTINCT FROM OLD.pricing_method;
  v_package_changed := NEW.classified_package_name IS DISTINCT FROM OLD.classified_package_name
                       OR NEW.classified_package_id IS DISTINCT FROM OLD.classified_package_id;

  v_material := (v_pct_change > 0.20) OR v_tier_changed OR v_method_changed;

  v_cap_active_flipped_up   := COALESCE(NEW.captured_by_active, false) = true
                              AND COALESCE(OLD.captured_by_active, false) = false;
  v_cap_active_flipped_down := COALESCE(NEW.captured_by_active, false) = false
                              AND COALESCE(OLD.captured_by_active, false) = true;
  v_cap_legacy_flipped_up   := COALESCE(NEW.captured_by_legacy, false) = true
                              AND COALESCE(OLD.captured_by_legacy, false) = false;
  v_cap_legacy_flipped_down := COALESCE(NEW.captured_by_legacy, false) = false
                              AND COALESCE(OLD.captured_by_legacy, false) = true;

  -- Early exit — nothing interesting changed
  IF NOT v_material
     AND NOT v_package_changed
     AND NOT v_cap_active_flipped_up AND NOT v_cap_active_flipped_down
     AND NOT v_cap_legacy_flipped_up AND NOT v_cap_legacy_flipped_down THEN
    RETURN NEW;
  END IF;

  -- Resolve the underlying listing for entity anchoring on the timeline.
  SELECT l.id, l.source_listing_id AS rea_listing_id, l.property_key, l.suburb, l.agent_pulse_id, l.agency_pulse_id, l.address
    INTO v_listing_row
    FROM pulse_listings l
   WHERE l.id = NEW.listing_id;

  -- ── quote_materially_changed ──────────────────────────────────────────
  IF v_material THEN
    INSERT INTO pulse_timeline (
      entity_type, pulse_entity_id, rea_id,
      event_type, event_category, title, description,
      previous_value, new_value, source,
      idempotency_key, created_at
    )
    VALUES (
      'listing',
      NEW.listing_id,
      v_listing_row.rea_listing_id,
      'quote_materially_changed',
      'market',
      'Missed-opp quote shifted $'
        || to_char(COALESCE(OLD.quoted_price, 0), 'FM999,999,999')
        || ' → $'
        || to_char(COALESCE(NEW.quoted_price, 0), 'FM999,999,999'),
      format('Quote moved %s%% (%s → %s). tier=%s method=%s',
        round(v_pct_change * 100, 1),
        COALESCE(OLD.resolved_tier, '—'),
        COALESCE(NEW.resolved_tier, '—'),
        COALESCE(NEW.resolved_tier, '—'),
        COALESCE(NEW.pricing_method, '—')),
      jsonb_build_object(
        'tier', OLD.resolved_tier,
        'package', OLD.classified_package_name,
        'quote', OLD.quoted_price,
        'pricing_method', OLD.pricing_method,
        'captured_by_active', OLD.captured_by_active,
        'captured_by_legacy', OLD.captured_by_legacy
      ),
      jsonb_build_object(
        'tier', NEW.resolved_tier,
        'package', NEW.classified_package_name,
        'quote', NEW.quoted_price,
        'pricing_method', NEW.pricing_method,
        'captured_by_active', NEW.captured_by_active,
        'captured_by_legacy', NEW.captured_by_legacy,
        'delta', jsonb_build_object(
          'quote_abs', NEW.quoted_price - OLD.quoted_price,
          'quote_pct', round(v_pct_change * 100, 2),
          'reason', NEW.invalidation_reason,
          'tier_source', NEW.tier_source
        )
      ),
      'pulse_compute_listing_quote',
      'quote_materially_changed:' || NEW.listing_id::text || ':' || extract(epoch from NEW.computed_at)::bigint::text,
      NEW.computed_at
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  -- ── tier_changed (separate event for granular timeline grouping) ──────
  IF v_tier_changed THEN
    INSERT INTO pulse_timeline (
      entity_type, pulse_entity_id, rea_id,
      event_type, event_category, title, description,
      previous_value, new_value, source,
      idempotency_key, created_at
    )
    VALUES (
      'listing',
      NEW.listing_id,
      v_listing_row.rea_listing_id,
      'tier_changed',
      'market',
      'Tier changed: '
        || COALESCE(OLD.resolved_tier, '—')
        || ' → '
        || COALESCE(NEW.resolved_tier, '—'),
      'tier_source=' || COALESCE(NEW.tier_source, '—'),
      jsonb_build_object('tier', OLD.resolved_tier, 'tier_source', OLD.tier_source),
      jsonb_build_object('tier', NEW.resolved_tier, 'tier_source', NEW.tier_source),
      'pulse_compute_listing_quote',
      'tier_changed:' || NEW.listing_id::text || ':' || extract(epoch from NEW.computed_at)::bigint::text,
      NEW.computed_at
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  -- ── classification_changed ────────────────────────────────────────────
  IF v_package_changed THEN
    INSERT INTO pulse_timeline (
      entity_type, pulse_entity_id, rea_id,
      event_type, event_category, title, description,
      previous_value, new_value, source,
      idempotency_key, created_at
    )
    VALUES (
      'listing',
      NEW.listing_id,
      v_listing_row.rea_listing_id,
      'classification_changed',
      'market',
      'Re-classified: '
        || COALESCE(OLD.classified_package_name, 'UNCLASSIFIABLE')
        || ' → '
        || COALESCE(NEW.classified_package_name, 'UNCLASSIFIABLE'),
      'reason=' || COALESCE(NEW.invalidation_reason, 'compute'),
      jsonb_build_object(
        'package_id', OLD.classified_package_id,
        'package_name', OLD.classified_package_name
      ),
      jsonb_build_object(
        'package_id', NEW.classified_package_id,
        'package_name', NEW.classified_package_name
      ),
      'pulse_compute_listing_quote',
      'classification_changed:' || NEW.listing_id::text || ':' || extract(epoch from NEW.computed_at)::bigint::text,
      NEW.computed_at
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  -- ── listing_captured ──────────────────────────────────────────────────
  IF v_cap_active_flipped_up OR v_cap_legacy_flipped_up THEN
    INSERT INTO pulse_timeline (
      entity_type, pulse_entity_id, rea_id,
      event_type, event_category, title, description,
      previous_value, new_value, source,
      idempotency_key, created_at
    )
    VALUES (
      'listing',
      NEW.listing_id,
      v_listing_row.rea_listing_id,
      'listing_captured',
      'market',
      'Now captured by '
        || CASE
          WHEN v_cap_active_flipped_up AND v_cap_legacy_flipped_up THEN 'active + legacy project'
          WHEN v_cap_active_flipped_up THEN 'active project'
          ELSE 'legacy project'
        END,
      'property_key=' || COALESCE(v_listing_row.property_key, '—'),
      jsonb_build_object(
        'captured_by_active', OLD.captured_by_active,
        'captured_by_legacy', OLD.captured_by_legacy
      ),
      jsonb_build_object(
        'captured_by_active', NEW.captured_by_active,
        'captured_by_legacy', NEW.captured_by_legacy,
        'flipped_active', v_cap_active_flipped_up,
        'flipped_legacy', v_cap_legacy_flipped_up
      ),
      'pulse_compute_listing_quote',
      'listing_captured:' || NEW.listing_id::text || ':' || extract(epoch from NEW.computed_at)::bigint::text,
      NEW.computed_at
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  -- ── listing_un_captured ───────────────────────────────────────────────
  IF v_cap_active_flipped_down OR v_cap_legacy_flipped_down THEN
    INSERT INTO pulse_timeline (
      entity_type, pulse_entity_id, rea_id,
      event_type, event_category, title, description,
      previous_value, new_value, source,
      idempotency_key, created_at
    )
    VALUES (
      'listing',
      NEW.listing_id,
      v_listing_row.rea_listing_id,
      'listing_un_captured',
      'market',
      'No longer captured ('
        || CASE
          WHEN v_cap_active_flipped_down AND v_cap_legacy_flipped_down THEN 'active + legacy'
          WHEN v_cap_active_flipped_down THEN 'active'
          ELSE 'legacy'
        END
        || ' lost)',
      'property_key=' || COALESCE(v_listing_row.property_key, '—'),
      jsonb_build_object(
        'captured_by_active', OLD.captured_by_active,
        'captured_by_legacy', OLD.captured_by_legacy
      ),
      jsonb_build_object(
        'captured_by_active', NEW.captured_by_active,
        'captured_by_legacy', NEW.captured_by_legacy,
        'flipped_active', v_cap_active_flipped_down,
        'flipped_legacy', v_cap_legacy_flipped_down
      ),
      'pulse_compute_listing_quote',
      'listing_un_captured:' || NEW.listing_id::text || ':' || extract(epoch from NEW.computed_at)::bigint::text,
      NEW.computed_at
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION pulse_emit_missed_opp_timeline_events() IS
  'Trigger fn on pulse_listing_missed_opportunity UPDATE. Emits pulse_timeline rows for: quote_materially_changed (>20% or tier/method), tier_changed, classification_changed, listing_captured, listing_un_captured. Idempotent via idempotency_key. See migration 194.';

DROP TRIGGER IF EXISTS trg_pmo_emit_timeline_events ON pulse_listing_missed_opportunity;
CREATE TRIGGER trg_pmo_emit_timeline_events
  AFTER UPDATE ON pulse_listing_missed_opportunity
  FOR EACH ROW
  EXECUTE FUNCTION pulse_emit_missed_opp_timeline_events();

COMMIT;
