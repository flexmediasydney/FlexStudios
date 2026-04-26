-- ═══════════════════════════════════════════════════════════════════════════
-- 302: drone_jobs cascade orchestration — parent_job_id + children_summary + terminal_status
-- ───────────────────────────────────────────────────────────────────────────
-- Wave 10 fix for QC iter 4 W6-A2: cascade orchestration rows mark
-- status='succeeded' once dispatcher fans out, even when child per-shot
-- jobs subsequently fail. Telemetry lies — operator sees "succeeded"
-- while real work failed.
--
-- Design (architect Section A): keep status alphabet stable; add separate
-- terminal_status field that reflects child progress via cache.
-- Trigger refreshes parent's children_summary on child status change.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE drone_jobs
  ADD COLUMN IF NOT EXISTS parent_job_id UUID REFERENCES drone_jobs(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS children_summary JSONB,
  ADD COLUMN IF NOT EXISTS terminal_status TEXT;

CREATE INDEX IF NOT EXISTS idx_drone_jobs_parent ON drone_jobs(parent_job_id) WHERE parent_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_drone_jobs_orchestration_in_progress
  ON drone_jobs(id) WHERE terminal_status = 'in_progress';

-- Backfill terminal_status on legacy non-cascade rows so the new RPCs work
UPDATE drone_jobs SET terminal_status = status WHERE parent_job_id IS NULL AND terminal_status IS NULL;

-- Trigger: every UPDATE of a row that has parent_job_id refreshes parent's summary.
CREATE OR REPLACE FUNCTION drone_jobs_refresh_parent_summary()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_parent UUID := COALESCE(NEW.parent_job_id, OLD.parent_job_id);
BEGIN
  IF v_parent IS NULL THEN RETURN NEW; END IF;

  WITH agg AS (
    SELECT
      COUNT(*)                                    AS total,
      COUNT(*) FILTER (WHERE status='pending')    AS pending,
      COUNT(*) FILTER (WHERE status='running')    AS running,
      COUNT(*) FILTER (WHERE status='succeeded')  AS succeeded,
      COUNT(*) FILTER (WHERE status='failed')     AS failed,
      COUNT(*) FILTER (WHERE status='dead_letter') AS dead_letter,
      MAX(GREATEST(finished_at, created_at))      AS last_child_at
    FROM drone_jobs WHERE parent_job_id = v_parent
  )
  UPDATE drone_jobs p SET
    children_summary = jsonb_build_object(
      'total', agg.total, 'pending', agg.pending, 'running', agg.running,
      'succeeded', agg.succeeded, 'failed', agg.failed, 'dead_letter', agg.dead_letter,
      'last_updated_at', NOW(),
      'last_child_finished_at', agg.last_child_at
    ),
    terminal_status = CASE
      WHEN agg.pending+agg.running > 0              THEN 'in_progress'
      WHEN agg.dead_letter > 0 AND agg.succeeded = 0 THEN 'failed'
      WHEN agg.dead_letter > 0                      THEN 'partially_failed'
      WHEN agg.succeeded   = agg.total              THEN 'succeeded'
      ELSE 'partially_failed'
    END
  FROM agg WHERE p.id = v_parent;

  RETURN NEW;
END $$;

-- Split into INSERT and UPDATE triggers (Postgres disallows OLD references in INSERT WHEN clause)
DROP TRIGGER IF EXISTS trg_drone_jobs_refresh_parent ON drone_jobs;
DROP TRIGGER IF EXISTS trg_drone_jobs_refresh_parent_ins ON drone_jobs;
DROP TRIGGER IF EXISTS trg_drone_jobs_refresh_parent_upd ON drone_jobs;

CREATE TRIGGER trg_drone_jobs_refresh_parent_ins
  AFTER INSERT ON drone_jobs
  FOR EACH ROW
  WHEN (NEW.parent_job_id IS NOT NULL)
  EXECUTE FUNCTION drone_jobs_refresh_parent_summary();

CREATE TRIGGER trg_drone_jobs_refresh_parent_upd
  AFTER UPDATE OF status ON drone_jobs
  FOR EACH ROW
  WHEN (NEW.parent_job_id IS NOT NULL OR OLD.parent_job_id IS NOT NULL)
  EXECUTE FUNCTION drone_jobs_refresh_parent_summary();

NOTIFY pgrst, 'reload schema';
