-- 156_pulse_signals_fixes.sql
-- Three-part fix for the Signals subtab:
--   1. Relabel auto-generated signals — pulse_signals.source_type was defaulting
--      to 'manual' for every pulseSignalGenerator row because the generator
--      didn't explicitly set source_type and the column default is 'manual'.
--      Result: the UI couldn't distinguish auto vs hand-entered signals.
--   2. Delete low-signal / zero-change price drops created by the generator
--      before the quality threshold was applied (e.g. "$1k → $1k" rows where
--      the rounding collapsed the visual delta, and weekly-rent drops below
--      the $25/wk threshold).
--   3. Widen the source_type CHECK constraint to include the new 'auto' and
--      'system' values so generators can record real provenance.
--
-- Safe to re-run — all statements use UPDATE/DELETE guarded by source_generator
-- and the constraint rebuild is idempotent.

BEGIN;

-- ── 1. Widen CHECK constraint first (needed before UPDATE can set 'auto') ───
-- Original constraint from migration 058:
--   CHECK (source_type IN ('observed','social_media','news','domain_api','manual'))
-- We keep the historical values so existing rows remain valid and add the two
-- generator-facing values. 'system' is reserved for background/cron rows that
-- aren't user-visible signals (future-proofing).
ALTER TABLE pulse_signals DROP CONSTRAINT IF EXISTS pulse_signals_source_type_check;
ALTER TABLE pulse_signals
  ADD CONSTRAINT pulse_signals_source_type_check
  CHECK (source_type IN ('observed','social_media','news','domain_api','manual','auto','system'));

-- ── 2. Relabel auto-generated signals ──────────────────────────────────────
-- Every row written by pulseSignalGenerator (identified by source_generator)
-- was defaulting to source_type='manual'. Correct the lie so the UI can show
-- "Auto" vs "Manual" provenance and filters can split them.
UPDATE pulse_signals
SET    source_type = 'auto'
WHERE  source_generator = 'pulseSignalGenerator'
  AND  source_type = 'manual';

-- ── 3. Delete zero-change / sub-threshold price drop signals ───────────────
-- The regex \$([0-9.]+[kKmM]?) catches "$1k", "$1.4M", "$700", "$67.5M" etc.
-- Matching the same captured token on both sides of " → " identifies rows
-- where the printed delta is visually identical (rounding artefact).
--
-- We also delete drops where the absolute dollar delta is immaterial:
--   • Weekly rent: <$25/wk drop
--   • Sale price : <$5k absolute AND <2% of old price
-- Bounds are computed from source_data.drops[0].old/new when populated.
WITH candidates AS (
  SELECT
    id,
    title,
    description,
    (source_data->'drops'->0->>'old')::numeric AS old_price,
    (source_data->'drops'->0->>'new')::numeric AS new_price
  FROM pulse_signals
  WHERE source_generator = 'pulseSignalGenerator'
    AND category = 'market'
    AND title LIKE 'Price drop:%'
),
bad AS (
  SELECT id FROM candidates
  WHERE
    -- Zero-change visual: "$1k → $1k", "$1.4M → $1.4M", etc.
    description ~ '(\$[0-9.]+[kKmM]?) → \1'
    -- Immaterial sale-price drops (weekly rent usually < $2000 per week;
    -- everything below is treated as rent and held to $25 minimum).
    OR (
      old_price IS NOT NULL AND new_price IS NOT NULL
      AND old_price < 2000
      AND (old_price - new_price) < 25
    )
    -- Immaterial sale-price drops: need both $5k absolute AND 2% relative.
    OR (
      old_price IS NOT NULL AND new_price IS NOT NULL
      AND old_price >= 2000
      AND (old_price - new_price) < 5000
      AND (old_price - new_price) / old_price < 0.02
    )
)
DELETE FROM pulse_signals
WHERE id IN (SELECT id FROM bad);

COMMIT;

-- Report counts — these surface in the SQL endpoint response body so the
-- deploy script can log how many rows were touched.
SELECT
  (SELECT COUNT(*) FROM pulse_signals WHERE source_type = 'auto')   AS auto_rows,
  (SELECT COUNT(*) FROM pulse_signals WHERE source_type = 'manual') AS manual_rows,
  (SELECT COUNT(*) FROM pulse_signals)                              AS total_rows;
