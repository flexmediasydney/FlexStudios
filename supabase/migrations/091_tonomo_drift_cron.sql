-- Migration 091: tonomo-drift-detector cron
--
-- Scans for projects where tonomo_service_tiers is non-empty AND a
-- products/packages lock is on (manually_overridden_fields contains
-- 'products' or 'packages') AND no pending delta is stashed yet.
--
-- These projects are drift candidates — Tonomo has been trying to update
-- them but the lock silently rejected the change. A pulse_timeline event
-- is emitted per detected project so the Pulse dashboard surfaces them.
--
-- Runtime-level protection (runtime detector in handlers + applyTonomoDelta
-- action) is the primary defense. This cron is a safety net catching
-- anything that pre-dates the new detection path.

-- Helper function: scan + emit events. Written so a cron job can invoke it
-- without shipping an edge function call.
CREATE OR REPLACE FUNCTION detect_tonomo_drift()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  drift_count INTEGER := 0;
  r RECORD;
BEGIN
  FOR r IN
    SELECT
      p.id,
      p.title,
      p.property_address,
      p.tonomo_order_id,
      p.tonomo_service_tiers,
      p.manually_overridden_fields,
      p.manually_locked_product_ids,
      p.manually_locked_package_ids
    FROM projects p
    WHERE
      p.tonomo_service_tiers IS NOT NULL
      AND p.tonomo_service_tiers <> '[]'
      AND p.tonomo_service_tiers <> ''
      AND p.tonomo_pending_delta IS NULL
      AND (
        COALESCE(p.manually_overridden_fields::text, '') ILIKE '%products%'
        OR COALESCE(p.manually_overridden_fields::text, '') ILIKE '%packages%'
        OR (p.manually_locked_product_ids IS NOT NULL AND jsonb_array_length(p.manually_locked_product_ids) > 0)
        OR (p.manually_locked_package_ids IS NOT NULL AND jsonb_array_length(p.manually_locked_package_ids) > 0)
      )
      AND NOT EXISTS (
        -- Skip projects we already reported in the last 24 hours
        SELECT 1 FROM pulse_timeline pt
        WHERE pt.crm_entity_id = p.id
          AND pt.event_type = 'tonomo_drift_detected'
          AND pt.created_at > NOW() - INTERVAL '24 hours'
      )
  LOOP
    INSERT INTO pulse_timeline (
      entity_type, crm_entity_id, event_type, event_category,
      title, description, source, metadata, created_at
    ) VALUES (
      'project',
      r.id,
      'tonomo_drift_detected',
      'data_drift',
      'Tonomo drift: ' || COALESCE(r.title, r.property_address, 'project ' || r.id::text),
      'Project has Tonomo service tiers set but a manual-override lock on products/packages and no pending delta. The runtime detector may have missed this event. Review in the Project Details banner.',
      'tonomo_drift_cron',
      jsonb_build_object(
        'tonomo_order_id', r.tonomo_order_id,
        'detected_at', NOW()
      ),
      NOW()
    );
    drift_count := drift_count + 1;
  END LOOP;

  RETURN drift_count;
END;
$func$;

COMMENT ON FUNCTION detect_tonomo_drift() IS 'Scans projects for Tonomo drift (locked products + no pending delta). Emits pulse_timeline events. Invoked by pg_cron job tonomo-drift-detector every 6 hours.';

-- Remove any prior run of the cron job (idempotent re-run)
DO $$
DECLARE
  existing_jobid INTEGER;
BEGIN
  SELECT jobid INTO existing_jobid FROM cron.job WHERE jobname = 'tonomo-drift-detector';
  IF existing_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(existing_jobid);
  END IF;
END $$;

-- Schedule every 6 hours (at minute 17 past hours 1/7/13/19 to spread load)
SELECT cron.schedule(
  'tonomo-drift-detector',
  '17 1,7,13,19 * * *',
  $cron$SELECT detect_tonomo_drift()$cron$
);
