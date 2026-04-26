-- Wave 6 P-audit-fix-2 Class G: mig 331: shortlisting_events 90-day retention
--
-- Audit defect #54 (P1): shortlisting_events grows unbounded. The 7,413
-- file_modified events on round 1 of 8/2 Everton (Bug D evidence) showed
-- how fast volume builds — and that was just one round. Without retention,
-- the table will be the dominant Postgres line item within 6 months.
--
-- Strategy: 90-day rolling delete of NON-MILESTONE events. Milestone events
-- (pass*_complete, shortlist_locked, benchmark_complete, pass3_complete)
-- are KEPT INDEFINITELY because they're the audit trail for cost attribution
-- and accuracy benchmarking. Per-classification telemetry (failure events,
-- per-comp slot assignments) is the volume-bearer and is what gets aged out.
--
-- Schedule: daily at 03:30 UTC (Sydney 14:30 winter / 13:30 summer; off-peak).
-- pg_cron is already enabled.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'shortlisting-events-retention') THEN
      PERFORM cron.unschedule('shortlisting-events-retention');
    END IF;
    PERFORM cron.schedule(
      'shortlisting-events-retention',
      '30 3 * * *',
      $cron$
        DELETE FROM shortlisting_events
        WHERE created_at < NOW() - INTERVAL '90 days'
          AND event_type NOT IN (
            'pass0_complete',
            'pass1_complete',
            'pass2_complete',
            'pass3_complete',
            'shortlist_locked',
            'benchmark_complete'
          )
      $cron$
    );
  END IF;
END $$;

COMMENT ON TABLE shortlisting_events IS
  'Append-only audit log for the shortlisting engine. 90-day retention via cron job shortlisting-events-retention (mig 331); milestone events (pass*_complete, shortlist_locked, benchmark_complete) retained indefinitely.';

NOTIFY pgrst, 'reload schema';
