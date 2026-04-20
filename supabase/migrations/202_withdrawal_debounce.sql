-- 202_withdrawal_debounce.sql
-- Add debounce state for withdrawal detection. The old one-strike-out rule
-- ("URL absent from memo23 response = immediately mark withdrawn") produced
-- 6 false positives on 2026-04-19 from a single flaky memo23 batch (8/12
-- URLs returned — not withdrawals, just a bad scrape).
--
-- Fix is two-layered, in pulseDetailEnrich:
--   1. Batch-health guard — skip the withdrawal path entirely for any batch
--      where memo23 returned < 75% of requested URLs. A low-yield batch is
--      a bad sample; trust nothing from it.
--   2. 2-miss debounce — even when batch health is OK, require the URL to
--      be absent across 2 separate probe runs before we flip
--      listing_withdrawn_at. Reset the counter the moment the URL reappears.
--
-- Also allows a new audit action 'withdrawn_rollback' so manual corrections
-- (like the one that just cleared the 6 false positives) land in
-- pulse_entity_sync_history cleanly.

BEGIN;

ALTER TABLE pulse_listings
  ADD COLUMN IF NOT EXISTS withdrawal_miss_count     int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS withdrawal_first_miss_at  timestamptz;

COMMENT ON COLUMN pulse_listings.withdrawal_miss_count IS
  'Consecutive memo23 probe runs where this URL was absent from the response. Reset to 0 when the URL reappears. Triggers listing_withdrawn_at when it reaches 2 AND the batch that produced the miss had >= 75% response health — see pulseDetailEnrich.';
COMMENT ON COLUMN pulse_listings.withdrawal_first_miss_at IS
  'Timestamp of the first miss in the current streak. Null once the URL reappears. Lets the UI compute time-to-confirm.';

ALTER TABLE pulse_entity_sync_history DROP CONSTRAINT IF EXISTS pulse_entity_sync_history_action_check;
ALTER TABLE pulse_entity_sync_history ADD CONSTRAINT pulse_entity_sync_history_action_check
  CHECK (action = ANY (ARRAY[
    'created','updated','cross_enriched','reconciled','flagged',
    'detail_enriched','withdrawn_detected','alternate_value_added','primary_promoted',
    'withdrawn_rollback'
  ]));

COMMIT;
