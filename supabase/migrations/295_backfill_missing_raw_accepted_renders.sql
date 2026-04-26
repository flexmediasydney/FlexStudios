-- ═══════════════════════════════════════════════════════════════════════════
-- 295: Backfill 4 raw_accepted shots that have NO drone_renders rows.
-- ───────────────────────────────────────────────────────────────────────────
-- Pre-mig audit query:
--   SELECT s.id FROM drone_shots s
--   WHERE s.lifecycle_state='raw_accepted'
--     AND NOT EXISTS (SELECT 1 FROM drone_renders r WHERE r.shot_id = s.id);
-- → 4 rows (all in shoot 4cc062e1-7e49-45c4-93d6-25ed3db8fd7e, project
--   4fd7ffeb-86ca-4a07-99b2-ae38909d1cfe Everton).
--
-- These shots were accepted (lifecycle_state='raw_accepted') without ever
-- having a render produced — likely because the legacy raw_preview_render
-- chain skipped them (it filters to lifecycle_state='raw_proposed' only)
-- and no manual render was triggered before acceptance.
--
-- Approach: enqueue ONE kind='render' drone_jobs row per affected shoot.
-- drone-render reads every eligible shot in the shoot, skips ones with an
-- existing render row (active-per-variant index), and renders only the
-- missing shots. Result: the 4 missing shots get 'pool' raw renders;
-- existing renders untouched.
--
-- Idempotent: ON CONFLICT DO NOTHING via the mig 294 index covers a
-- repeated apply (only matters if a pending render already exists for the
-- same shoot/pipeline/payload-shot_id key).
-- ═══════════════════════════════════════════════════════════════════════════

-- One render job per shoot that has at least one raw_accepted shot
-- missing its render. SELECT DISTINCT shoot_id collapses the 4-row
-- result down to one row per shoot.
INSERT INTO drone_jobs (kind, shoot_id, project_id, pipeline, payload, status, scheduled_for, created_at)
SELECT DISTINCT
  'render',
  s.shoot_id,
  sh.project_id,
  'raw',
  jsonb_build_object(
    'shoot_id', s.shoot_id,
    'kind', 'poi_plus_boundary',
    'reason', 'mig295_backfill_missing_renders'
  ),
  'pending',
  NOW(),
  NOW()
FROM drone_shots s
JOIN drone_shoots sh ON sh.id = s.shoot_id
WHERE s.lifecycle_state = 'raw_accepted'
  AND NOT EXISTS (SELECT 1 FROM drone_renders r WHERE r.shot_id = s.id)
ON CONFLICT DO NOTHING;

-- Audit log: report enqueued count + the shot IDs targeted.
DO $$
DECLARE
  v_jobs int;
  v_shots int;
BEGIN
  SELECT COUNT(*) INTO v_jobs
    FROM drone_jobs
    WHERE payload->>'reason' = 'mig295_backfill_missing_renders';
  SELECT COUNT(*) INTO v_shots
    FROM drone_shots s
    WHERE s.lifecycle_state = 'raw_accepted'
      AND NOT EXISTS (SELECT 1 FROM drone_renders r WHERE r.shot_id = s.id);
  RAISE NOTICE 'mig295: enqueued % backfill render job(s); % raw_accepted shots remain without renders (will land via dispatcher)', v_jobs, v_shots;
END $$;
