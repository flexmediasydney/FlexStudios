-- 097_pulse_fire_batch_counter_trigger.sql
-- Fix: pulse_fire_batches.dispatched_count stays at 0 during a drain
--
-- ── The bug ──────────────────────────────────────────────────────────────
-- Observed during the full-run validation test: all 6 batch rows kept
-- `dispatched_count=0` even as the queue items moved from pending → running
-- → completed. The UI "X/Y dispatched" progress bar looked broken.
--
-- Root cause: nothing was updating the counter as items moved through the
-- queue. The original migration-093 design expected `pulse_fire_batches_reconcile`
-- to update the count — but only when marking the whole batch 'completed'
-- at the very end. In-flight progress was invisible on the pulse_fire_batches
-- row.
--
-- ── The fix ──────────────────────────────────────────────────────────────
-- A trigger on pulse_fire_queue that maintains the counter live. Whenever a
-- queue row transitions INTO a terminal state (completed / failed / cancelled)
-- from a non-terminal one, increment the batch's dispatched_count. Inverse
-- on the reverse transition (retry re-queues → pending).
--
-- Definition of "dispatched" for this counter: the row has reached a
-- terminal outcome. Retries (pending → running → pending) don't count until
-- they finally terminate.
--
-- ── Also ─────────────────────────────────────────────────────────────────
-- Backfill dispatched_count on all existing batches so the UI immediately
-- reflects correct progress on past runs.

BEGIN;

CREATE OR REPLACE FUNCTION pulse_fire_queue_sync_batch_counts()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_was_terminal BOOLEAN := FALSE;
  v_now_terminal BOOLEAN := FALSE;
  v_batch_id     UUID;
BEGIN
  -- ── DELETE path ──
  -- If we're deleting a terminal row from a batch, the counter should
  -- decrement. Rare in practice — queue items aren't hard-deleted today,
  -- only soft-deleted via status='cancelled'. But defensive.
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('completed', 'failed', 'cancelled') AND OLD.batch_id IS NOT NULL THEN
      UPDATE pulse_fire_batches
      SET dispatched_count = GREATEST(0, dispatched_count - 1)
      WHERE id = OLD.batch_id;
    END IF;
    RETURN OLD;
  END IF;

  -- ── INSERT / UPDATE paths ──
  IF TG_OP = 'UPDATE' THEN
    v_was_terminal := OLD.status IN ('completed', 'failed', 'cancelled');
  END IF;
  v_now_terminal := NEW.status IN ('completed', 'failed', 'cancelled');

  -- No-op if terminal state didn't change
  IF v_was_terminal = v_now_terminal THEN
    RETURN NEW;
  END IF;

  v_batch_id := NEW.batch_id;
  IF v_batch_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_now_terminal AND NOT v_was_terminal THEN
    UPDATE pulse_fire_batches
    SET dispatched_count = dispatched_count + 1
    WHERE id = v_batch_id;
  ELSIF v_was_terminal AND NOT v_now_terminal THEN
    -- Covers the reconciler's "running → pending" retry path. Without this,
    -- a retry would leave the counter 1 too high.
    UPDATE pulse_fire_batches
    SET dispatched_count = GREATEST(0, dispatched_count - 1)
    WHERE id = v_batch_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pulse_fire_queue_sync_batch_counts_trig ON pulse_fire_queue;
CREATE TRIGGER pulse_fire_queue_sync_batch_counts_trig
  AFTER INSERT OR UPDATE OF status OR DELETE ON pulse_fire_queue
  FOR EACH ROW EXECUTE FUNCTION pulse_fire_queue_sync_batch_counts();

COMMENT ON FUNCTION pulse_fire_queue_sync_batch_counts IS
  'Maintains pulse_fire_batches.dispatched_count as queue items move through '
  'their state machine. Increment when item enters terminal state '
  '(completed/failed/cancelled), decrement on re-queue (terminal → pending). '
  'Installed by migration 097.';

-- ── Backfill existing batches ──────────────────────────────────────────
-- Recompute dispatched_count from current queue state. Safe to run anytime;
-- idempotent.
UPDATE pulse_fire_batches b
SET dispatched_count = sub.cnt
FROM (
  SELECT batch_id, count(*)::INT AS cnt
  FROM pulse_fire_queue
  WHERE batch_id IS NOT NULL
    AND status IN ('completed', 'failed', 'cancelled')
  GROUP BY batch_id
) sub
WHERE b.id = sub.batch_id;

COMMIT;
