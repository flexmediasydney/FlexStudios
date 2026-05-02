-- 434_tier_configs_signal_weights_resync.sql
--
-- Resync shortlisting_tier_configs.signal_weights to the 26 signal keys
-- that actually exist after mig 433.
--
-- Background: mig 344 seeded each tier's v1 signal_weights from the catalog
-- (then 4 stale v1-era keys: vantage_point, living_zone_count,
-- clutter_severity, indoor_outdoor_connection_quality). Those 4 keys never
-- matched anything Stage 1 emits, so dimensionRollup.computeDimensionScore
-- silently fell back to simple-mean for every image. Mig 433 deleted those
-- keys from the catalog, so they're now also stale here.
--
-- Behaviour: this is mathematically identical to today. With uniform 1.0
-- weights, the weighted-mean reduces to a simple mean — same number, same
-- combined_score. The visible difference is the Tiers tab now shows the
-- real 26-signal universe so admins can actually tune.

UPDATE shortlisting_tier_configs
SET signal_weights = (
  SELECT jsonb_object_agg(signal_key, 1.0)
    FROM shortlisting_signal_weights
)
WHERE is_active = TRUE;
