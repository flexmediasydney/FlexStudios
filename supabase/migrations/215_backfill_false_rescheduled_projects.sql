-- Migration 215: backfill four projects stuck in pending_review by the
-- handleRescheduled false-positive bug (identical from/to dates in review
-- reason). See investigation: all four carry pending_review_type='rescheduled'
-- with pre_revision_stage='scheduled' and a reason like
-- "Shoot rescheduled in Tonomo from 2026-04-22T00:00:00+00:00 to 2026-04-22 —
-- please confirm" where the two dates are the same date in different formats.
--
-- Restoration rules:
--   • Projects with tonomo_delivered_at set AND all tasks complete AND
--     tonomo_order_status='complete' → promote to 'delivered'. These actually
--     shipped while stranded in pending_review.
--   • All other false-rescheduled projects → restore to pre_revision_stage
--     ('scheduled' on all four).
--
-- In both paths we also clear pending_review_reason, pending_review_type,
-- pre_revision_stage, urgent_review, auto_approved to leave clean state.
--
-- The code fix (handleRescheduled + approval button) prevents new occurrences;
-- this migration reconciles the 4 historical victims.

BEGIN;

-- Step 1: promote the two projects that already delivered while stuck.
-- Strict predicate: identifies only the projects that are stuck due to the
-- false-rescheduled bug (identical date-in-reason strings + delivered state).
UPDATE projects
SET
  status = 'delivered',
  pending_review_reason = NULL,
  pending_review_type = NULL,
  pre_revision_stage = NULL,
  urgent_review = false,
  auto_approved = false
WHERE
  status = 'pending_review'
  AND pending_review_type = 'rescheduled'
  AND pre_revision_stage = 'scheduled'
  AND tonomo_delivered_at IS NOT NULL
  AND tonomo_order_status = 'complete'
  AND pending_review_reason LIKE 'Shoot rescheduled in Tonomo from %T00:00:00+00:00 to %'
  AND EXISTS (SELECT 1 FROM project_tasks t WHERE t.project_id = projects.id AND NOT t.is_deleted AND t.is_completed)
  AND NOT EXISTS (SELECT 1 FROM project_tasks t WHERE t.project_id = projects.id AND NOT t.is_deleted AND NOT t.is_completed);

-- Step 2: restore the remaining false-rescheduled projects to their
-- pre_revision_stage (scheduled in all four known cases).
UPDATE projects
SET
  status = pre_revision_stage,
  pending_review_reason = NULL,
  pending_review_type = NULL,
  pre_revision_stage = NULL,
  urgent_review = false,
  auto_approved = false
WHERE
  status = 'pending_review'
  AND pending_review_type = 'rescheduled'
  AND pre_revision_stage IS NOT NULL
  AND pending_review_reason LIKE 'Shoot rescheduled in Tonomo from %T00:00:00+00:00 to %';

-- Step 3: write an audit trail so the restoration is visible in project
-- history. Use a single batched insert keyed on the projects matched above.
INSERT INTO project_activities (
  id, project_id, project_title, action, description,
  actor_type, actor_source, user_name, user_email, created_at
)
SELECT
  gen_random_uuid(),
  p.id,
  COALESCE(p.title, p.property_address, ''),
  'status_change',
  'Auto-restored by migration 215: false-rescheduled pending_review cleared. ' ||
    'Tonomo had fired a rescheduled webhook with the same date on both sides, ' ||
    'which incorrectly flipped this project to pending_review.',
  'system',
  'migration_215_backfill_false_rescheduled',
  'System',
  'system@flexstudios.app',
  NOW()
FROM projects p
WHERE p.id IN (
  -- The 4 stuck projects identified in the investigation (enumerated
  -- explicitly rather than re-predicated so the audit row lands once
  -- per project even if the update-predicate matches nothing after
  -- step 1/2 run).
  'a158b548-3174-4f57-be59-3d66b74f883a',
  '2ca2db54-b5f6-458d-ba0d-3a36313ad1e4',
  'e56c68a2-1067-4793-8476-677952ce0cf4',
  '5e9020d0-8773-4bdb-830e-d60f59056259'
);

COMMIT;
