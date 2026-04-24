-- Migration 218: retire the tonomo-drift-detector cron + its backing function.
--
-- Background: detect_tonomo_drift() was written when the webhook pipeline
-- respected per-line lock columns (manually_locked_product_ids /
-- manually_locked_package_ids) on the projects table. The function's purpose
-- was to flag projects where Tonomo had set service tiers but a manual lock
-- blocked product/package reconciliation.
--
-- Migration 209 (2026-04-20) executed the "Tonomo wins" policy shift:
--   • Dropped manually_locked_product_ids + manually_locked_package_ids
--   • Stripped 'products'/'packages' from manually_overridden_fields
--   • reconcileProductsPackagesAgainstLock became an identity pass-through
--
-- The drift detector never had its columns removed, so every cron tick
-- (schedule '17 1,7,13,19 * * *' — 4× daily) has been erroring with:
--   "column p.manually_locked_product_ids does not exist"
-- cron.job_run_details shows 4 consecutive failures in the last 24h and
-- zero successes.
--
-- Correct fix: retire. The lock it detected no longer exists, and any future
-- product/package drift is now surfaced by:
--   • tonomo_pending_delta stash flow in utils.ts
--   • backfillTonomoDrift edge function (on-demand sweep)
--
-- No replacement detector needed.

BEGIN;

-- Unschedule the cron (idempotent — silently skips if already removed)
SELECT cron.unschedule('tonomo-drift-detector')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tonomo-drift-detector');

-- Drop the function
DROP FUNCTION IF EXISTS public.detect_tonomo_drift();

COMMIT;
