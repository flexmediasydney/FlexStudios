-- 355_heal_orphan_auto_completion_time_logs.sql
--
-- Auto-completion TaskTimeLog rows are created when a task is ticked off
-- (estimated_minutes > 0). Until 2026-04-28 they were never deleted when
-- the task was un-ticked, leaving phantom effort entries. The frontend
-- now cleans these up on un-tick (see TaskManagement.jsx); this migration
-- one-shot heals the existing orphans accumulated before the fix landed.
--
-- Scope: rows where log_source='auto_completion', is_manual=false, AND
-- the underlying task is currently NOT completed. Manually-logged time
-- (is_manual=true) and onsite logs (log_source='auto_onsite') are
-- preserved — they represent real work that's independent of this
-- task's tick state.
--
-- Pre-heal count: 25 orphan rows ≈ 9.5 hours of phantom effort.

DELETE FROM task_time_logs ttl
USING project_tasks pt
WHERE ttl.task_id = pt.id
  AND ttl.log_source = 'auto_completion'
  AND COALESCE(ttl.is_manual, false) = false
  AND pt.is_completed = false
  AND COALESCE(pt.is_deleted, false) = false;
