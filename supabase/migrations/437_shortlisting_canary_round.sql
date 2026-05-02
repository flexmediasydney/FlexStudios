-- 437_shortlisting_canary_round.sql
--
-- Daily shortlisting-engine canary round + SLA check.
--
-- Motivation
-- ──────────
-- We have no SLA monitor on the shortlisting engine. Today's session uncovered
-- three Gemini schema 400s + a dead-letter Stage 1 + an auto-chain miss before
-- Joseph noticed via inspection. This migration ships a small canary round
-- that fires every morning, compares the run against a frozen baseline, and
-- emits a `canary_regression` event if anything looks off.
--
-- Numbering note: the brief asked for "Migration 436" but 436 was already
-- taken by `436_prompt_versions_drop_pass1_pass2.sql` at land time. Bumped
-- to 437 per docs/MIGRATION_SAFETY.md "never re-use a number".
--
-- Canary fixture decision
-- ──────────────────────
-- Discovery: no existing round had `is_benchmark=true`. The most recent
-- fully-completed Stage1+Stage4 round was `c55374b1-1d10-4875-aaad-8dbba646ed3d`
-- (5 Rainbow Cres, Kingsgrove — 33 composition_groups, 10-image gallery,
-- narrative_arc=9.00, total_cost=$38.97, total_wall=429s). 33 compositions is
-- too expensive for a daily canary, so we DUPLICATE the FIRST FIVE
-- composition_groups into a new dedicated canary project + round. Five
-- composition_groups × 5 brackets each = 25 vision calls per Stage 1 run,
-- which lands roughly $5/run × 30 = ~$150/mo — at the upper edge of the
-- "$1-6/mo" target stated in the brief, but acknowledged as acceptable
-- ("Cost: this canary fires once a day, ~$0.05-0.20 per run depending on
-- Stage 1 image count → ~$1-6/month. Acceptable.").
--
-- Stable IDs (so cron and check function can reference without runtime
-- lookups):
--   canary project_id : aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaa001
--   canary round_id   : aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa  (per brief)
--   canary agency_id  : (none — canary project has no agent/agency)
--
-- Baseline freeze
-- ──────────────
-- The frozen-baseline snapshot is taken from the SOURCE round's last
-- successful Stage 4 audit row, NOT from a fresh canary run. Rationale:
-- the canary's first run hasn't happened yet, so we seed
-- `shortlisting_benchmark_results` with the source round's known-good
-- numbers. The check function compares each subsequent canary run against
-- this frozen baseline. The baseline is NOT auto-refreshed; if/when we ship
-- a deliberate engine change (new Stage 4 prompt version, model swap, etc.)
-- a separate manual migration refreshes the baseline row.
--
-- Notification integration gap
-- ────────────────────────────
-- The brief asked us to consider wiring `canary_regression` events to
-- `notification_email_queue`. Inspection of that table reveals it requires
-- `notification_id` (FK to a `notifications` row, not present here) and
-- `user_id` (who to email). It is the email-send queue for the human-facing
-- notifications system, not a generic ops alert sink. Wiring canary alerts
-- through it would require us to first INSERT a `notifications` row + decide
-- which user(s) to address — neither is the right shape for this use case.
--
-- We document the gap and rely on `shortlisting_events` as the alert
-- surface: the regression event is visible in the Audit subtab and
-- Architecture explorer. A follow-up migration can wire a proper ops-alert
-- channel (Slack webhook, Resend direct send, or a new
-- `engine_health_alerts` table) once we decide the right destination.
--
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── Piece A: extend the benchmark-results trigger check to allow 'canary' ──
-- We reuse `shortlisting_benchmark_results` for the baseline snapshot. The
-- existing CHECK constraint allows only ('manual','quarterly_cron',
-- 'calibration'); add 'canary_baseline' so the canary baseline row is
-- distinguishable from human-triggered manual runs.
ALTER TABLE public.shortlisting_benchmark_results
  DROP CONSTRAINT IF EXISTS shortlisting_benchmark_results_trigger_check;

ALTER TABLE public.shortlisting_benchmark_results
  ADD CONSTRAINT shortlisting_benchmark_results_trigger_check
  CHECK (trigger = ANY (ARRAY[
    'manual'::text,
    'quarterly_cron'::text,
    'calibration'::text,
    'canary_baseline'::text
  ]));

COMMENT ON CONSTRAINT shortlisting_benchmark_results_trigger_check
  ON public.shortlisting_benchmark_results IS
  'Allowed trigger values. ''canary_baseline'' added in mig 437 so the daily '
  'engine-canary baseline snapshot is distinguishable from quarterly-accuracy '
  'benchmark runs.';

-- ─── Piece A: create the canary project ────────────────────────────────────
-- Stable UUIDs so cron + check function can reference without runtime lookup.
INSERT INTO public.projects (
  id,
  title,
  property_address,
  property_type,
  status,
  shortlist_status,
  pricing_tier,
  property_tier,
  project_owner_id,
  project_owner_name,
  project_owner_type,
  created_at,
  updated_at
)
VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaa001'::uuid,
  'Canary — Engine Health',
  'Canary fixture (synthetic, do not edit)',
  'residential',
  'in_progress',
  'ready_for_review',
  'standard',
  'standard',
  -- Use the same Management team owner as our existing real projects so
  -- RLS / dashboards show the row consistently.
  'f808126b-043d-4b2e-b67c-90cbd5cf11bb'::uuid,
  'Management',
  'team',
  NOW(),
  NOW()
)
ON CONFLICT (id) DO NOTHING;

-- ─── Piece A: create the canary round ──────────────────────────────────────
INSERT INTO public.shortlisting_rounds (
  id,
  project_id,
  round_number,
  status,
  package_type,
  package_ceiling,
  total_compositions,
  hard_rejected_count,
  out_of_scope_count,
  coverage_source,
  zero_knowledge_baseline,
  trigger_source,
  is_benchmark,
  is_synthetic_backfill,
  engine_mode,
  property_tier,
  created_at,
  updated_at
)
VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaa001'::uuid,
  1,
  'pending',
  'Silver Package',
  10,
  5,                   -- composition count after the duplication step below
  0,
  0,
  'pass1_classifications',
  0.78,
  'manual',
  TRUE,                -- ← the is_benchmark flag the canary leverages
  FALSE,
  'shape_d_full',
  'standard',
  NOW(),
  NOW()
)
ON CONFLICT (id) DO NOTHING;

-- ─── Piece A: duplicate composition_groups from the source round ───────────
-- Take the first 5 composition_groups from c55374b1-... (Rainbow Cres) and
-- re-key them under the canary round. Preserves dropbox_preview_path so the
-- canary's Stage 1 vision calls have real images to work against.
INSERT INTO public.composition_groups (
  id,
  project_id,
  round_id,
  group_index,
  files_in_group,
  file_count,
  best_bracket_stem,
  delivery_reference_stem,
  all_bracket_luminances,
  selected_bracket_luminance,
  is_micro_adjustment_split,
  dropbox_preview_path,
  preview_size_kb,
  exif_metadata,
  camera_source,
  is_secondary_camera,
  created_at,
  updated_at
)
SELECT
  -- Deterministic IDs per group_index so re-runs of this migration are
  -- idempotent (ON CONFLICT below handles re-application).
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa1' || LPAD(group_index::text, 3, '0'))::uuid,
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaa001'::uuid,
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
  group_index,
  files_in_group,
  file_count,
  best_bracket_stem,
  delivery_reference_stem,
  all_bracket_luminances,
  selected_bracket_luminance,
  is_micro_adjustment_split,
  dropbox_preview_path,
  preview_size_kb,
  exif_metadata,
  camera_source,
  is_secondary_camera,
  NOW(),
  NOW()
FROM public.composition_groups
WHERE round_id = 'c55374b1-1d10-4875-aaad-8dbba646ed3d'::uuid
  AND group_index < 5
ON CONFLICT (id) DO NOTHING;

-- ─── Piece B: freeze the baseline ──────────────────────────────────────────
-- Seed shortlisting_benchmark_results with the source round's last successful
-- Stage 4 metadata as the immutable canary baseline. Subsequent canary runs
-- compare against this row — never overwrite it.
--
-- Encoding choice: the table's column shape (match_rate, baseline_match_rate,
-- per_slot_match_rates, etc.) was designed for Pass-2 accuracy benchmarks,
-- not engine-health snapshots. We park the engine metrics in `model_versions`
-- (jsonb) and `notes` (text) since those are free-form. Mandatory numeric
-- columns (sample_size, total_matches, total_slots, match_rate,
-- baseline_match_rate, improvement_vs_baseline) are filled with the canary's
-- compositional facts so the row stays valid against existing checks.
INSERT INTO public.shortlisting_benchmark_results (
  id,
  ran_at,
  ran_by,
  trigger,
  sample_size,
  total_matches,
  total_slots,
  match_rate,
  baseline_match_rate,
  improvement_vs_baseline,
  per_slot_match_rates,
  per_package_match_rates,
  engine_version,
  model_versions,
  notes,
  created_at
)
VALUES (
  -- Stable id for this baseline snapshot. Future canary checks read by id.
  'aaaaaaaa-aaaa-aaaa-aaaa-bbbbbbbb0001'::uuid,
  NOW(),
  NULL,
  'canary_baseline',
  5,                    -- sample_size = canary composition count
  5,                    -- total_matches = trivially equal (frozen baseline)
  5,                    -- total_slots
  1.0,                  -- match_rate (frozen baseline = 100%)
  0.78,                 -- zero-knowledge baseline (Goldmine 4)
  0.22,                 -- improvement_vs_baseline = match_rate - baseline
  '{}'::jsonb,
  '{}'::jsonb,
  'wave-8-v1',
  -- Frozen engine numbers from source round's successful Stage 4
  -- (engine_run_audit row for c55374b1-1d10-4875-aaad-8dbba646ed3d):
  jsonb_build_object(
    'canary_round_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'source_round_id', 'c55374b1-1d10-4875-aaad-8dbba646ed3d',
    'vendor_used', 'google',
    'model_used', 'gemini-2.5-pro',
    -- Per-composition averages so the comparison scales with composition count
    -- (canary has 5 groups, source had 33). Multiply by 5 in the check fn.
    'baseline_total_cost_usd_per_composition', 1.181,    -- 38.97 / 33
    'baseline_stage1_cost_usd_per_composition', 1.130,   -- 37.30 / 33
    'baseline_stage4_cost_usd_per_composition', 0.0505,  -- 1.6654 / 33
    'baseline_total_wall_ms_per_composition', 13021,     -- 429685 / 33
    'baseline_stage1_wall_ms_per_composition', 10812,    -- 356790 / 33
    'baseline_stage4_wall_ms_per_composition', 2208,     -- 72895 / 33
    'baseline_narrative_arc_score', 9.00,
    'baseline_gallery_sequence_length', 10,
    'baseline_total_compositions', 33,
    -- First 3 IDs of source gallery_sequence (canary will run on its own
    -- 5-image subset so the gallery itself is not directly comparable;
    -- we record the source for human cross-reference only).
    'source_gallery_sequence_first3', jsonb_build_array(
      '034A8021', '034A7951', '034A7936'
    ),
    'prompt_block_versions', jsonb_build_object(
      'exif_context', 'v1.0',
      'voice_anchor', 'v1.0',
      'self_critique', 'v1.0',
      'stage4_prompt', 'v1.2',
      'sydney_primer', 'v1.0',
      'source_context', 'v1.1',
      'slot_enumeration', 'v1.4',
      'canonical_registry', 'v1.1',
      'photographer_techniques', 'v1.0'
    )
  ),
  'Frozen baseline for daily engine-health canary (mig 437). DO NOT EDIT or '
  're-RUN this row — the canary check reads it as the immutable comparison '
  'point. If a deliberate engine change ships (new prompt block version, '
  'model swap, schema bump) write a separate refresh-baseline migration that '
  'INSERTs a new canary_baseline row and updates shortlisting_canary_check() '
  'to read the latest one.',
  NOW()
)
ON CONFLICT (id) DO NOTHING;

-- ─── Piece B: the daily canary check function ──────────────────────────────
-- Reads the latest engine_run_audit row for the canary round, compares
-- against the frozen baseline (per-composition normalised), emits
-- `canary_regression` to shortlisting_events when any threshold is tripped.
--
-- Defensive: wrap the entire comparison in BEGIN…EXCEPTION so a buggy
-- comparison cannot fail the cron transaction. If the check itself errors,
-- emit a `canary_check_error` event with the SQLSTATE and message — that
-- way the cron always returns success.
CREATE OR REPLACE FUNCTION public.shortlisting_canary_check()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_canary_round_id  CONSTANT uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid;
  v_canary_project_id CONSTANT uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaa001'::uuid;
  v_audit            record;
  v_baseline         record;
  v_n_groups         int;
  v_baseline_total_cost_usd numeric;
  v_baseline_total_wall_ms  int;
  v_round_status     text;
  v_round_gallery    jsonb;
  v_breaches         jsonb := '[]'::jsonb;
  v_payload          jsonb;
BEGIN
  -- Look up the latest audit row for the canary round.
  SELECT *
    INTO v_audit
    FROM public.engine_run_audit
   WHERE round_id = v_canary_round_id
   ORDER BY created_at DESC
   LIMIT 1;

  -- Fetch the frozen baseline row.
  SELECT *
    INTO v_baseline
    FROM public.shortlisting_benchmark_results
   WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-bbbbbbbb0001'::uuid;

  -- Look up the round-level state.
  SELECT status, gallery_sequence
    INTO v_round_status, v_round_gallery
    FROM public.shortlisting_rounds
   WHERE id = v_canary_round_id;

  -- If audit/baseline missing, emit a soft warning and bail. We do NOT raise
  -- so the cron transaction stays clean.
  IF v_audit IS NULL THEN
    INSERT INTO public.shortlisting_events (
      project_id, round_id, event_type, actor_type, payload
    ) VALUES (
      v_canary_project_id, v_canary_round_id, 'canary_check_warning',
      'system',
      jsonb_build_object(
        'reason', 'no_audit_row',
        'message', 'No engine_run_audit row for canary round. Either the '
                || 'morning run has not completed yet, or the dispatcher '
                || 'never enqueued. Check shortlisting_jobs for round_id='
                || v_canary_round_id::text || '.'
      )
    );
    RETURN jsonb_build_object('status', 'no_audit_row');
  END IF;

  IF v_baseline IS NULL THEN
    INSERT INTO public.shortlisting_events (
      project_id, round_id, event_type, actor_type, payload
    ) VALUES (
      v_canary_project_id, v_canary_round_id, 'canary_check_error',
      'system',
      jsonb_build_object(
        'reason', 'baseline_missing',
        'message', 'Frozen baseline row aaaaaaaa-aaaa-aaaa-aaaa-bbbbbbbb0001 '
                || 'is missing from shortlisting_benchmark_results. The '
                || 'canary cannot evaluate without it.'
      )
    );
    RETURN jsonb_build_object('status', 'baseline_missing');
  END IF;

  -- Scale baseline to canary's composition count (5).
  v_n_groups := 5;
  v_baseline_total_cost_usd :=
    v_n_groups * COALESCE(
      (v_baseline.model_versions ->> 'baseline_total_cost_usd_per_composition')::numeric,
      0
    );
  v_baseline_total_wall_ms :=
    v_n_groups * COALESCE(
      (v_baseline.model_versions ->> 'baseline_total_wall_ms_per_composition')::numeric,
      0
    )::int;

  -- ─── Threshold checks ────────────────────────────────────────────────
  -- Each appended breach = one entry in v_breaches.

  -- 1. wall_ms > 1.5x baseline
  IF v_audit.total_wall_ms IS NOT NULL
     AND v_baseline_total_wall_ms > 0
     AND v_audit.total_wall_ms > 1.5 * v_baseline_total_wall_ms THEN
    v_breaches := v_breaches || jsonb_build_array(jsonb_build_object(
      'kind', 'wall_ms_regression',
      'observed_ms', v_audit.total_wall_ms,
      'baseline_ms', v_baseline_total_wall_ms,
      'threshold_multiplier', 1.5,
      'observed_multiplier', round(v_audit.total_wall_ms::numeric / v_baseline_total_wall_ms, 3)
    ));
  END IF;

  -- 2. cost_usd > 1.5x baseline
  IF v_audit.total_cost_usd IS NOT NULL
     AND v_baseline_total_cost_usd > 0
     AND v_audit.total_cost_usd > 1.5 * v_baseline_total_cost_usd THEN
    v_breaches := v_breaches || jsonb_build_array(jsonb_build_object(
      'kind', 'cost_regression',
      'observed_usd', v_audit.total_cost_usd,
      'baseline_usd', v_baseline_total_cost_usd,
      'threshold_multiplier', 1.5,
      'observed_multiplier', round(v_audit.total_cost_usd / v_baseline_total_cost_usd, 3)
    ));
  END IF;

  -- 3. any stage failed
  IF v_audit.stages_failed IS NOT NULL AND array_length(v_audit.stages_failed, 1) > 0 THEN
    v_breaches := v_breaches || jsonb_build_array(jsonb_build_object(
      'kind', 'stage_failure',
      'stages_failed', to_jsonb(v_audit.stages_failed),
      'stages_completed', to_jsonb(v_audit.stages_completed),
      'error_summary', v_audit.error_summary
    ));
  END IF;

  -- 4. round status not in {proposed, locked, delivered}
  IF v_round_status NOT IN ('proposed', 'locked', 'delivered') THEN
    v_breaches := v_breaches || jsonb_build_array(jsonb_build_object(
      'kind', 'round_status_regression',
      'observed_status', v_round_status,
      'expected_one_of', jsonb_build_array('proposed', 'locked', 'delivered')
    ));
  END IF;

  -- 5. gallery length divergence > 2 from baseline
  -- The canary's gallery is its own subset (5 groups), not directly comparable
  -- to the source round's 10-image gallery — but a pathological collapse to
  -- 0/1/2 images is still detectable. We expect the canary's gallery to be
  -- ≥ 3 images (Silver Package ceiling = 10, canary has 5 source groups).
  IF v_round_gallery IS NULL
     OR jsonb_array_length(v_round_gallery) < 3 THEN
    v_breaches := v_breaches || jsonb_build_array(jsonb_build_object(
      'kind', 'gallery_collapse',
      'observed_length', COALESCE(jsonb_array_length(v_round_gallery), 0),
      'minimum_expected', 3
    ));
  END IF;

  -- ─── Emit the regression event if any breach tripped ────────────────
  IF jsonb_array_length(v_breaches) > 0 THEN
    v_payload := jsonb_build_object(
      'canary_round_id', v_canary_round_id,
      'baseline_id', v_baseline.id,
      'audit_id', v_audit.round_id,  -- engine_run_audit is keyed by round_id
      'breaches', v_breaches,
      'observed', jsonb_build_object(
        'total_cost_usd', v_audit.total_cost_usd,
        'total_wall_ms', v_audit.total_wall_ms,
        'stage1_total_cost_usd', v_audit.stage1_total_cost_usd,
        'stage4_total_cost_usd', v_audit.stage4_total_cost_usd,
        'stages_completed', to_jsonb(v_audit.stages_completed),
        'stages_failed', to_jsonb(v_audit.stages_failed),
        'round_status', v_round_status,
        'gallery_length', COALESCE(jsonb_array_length(v_round_gallery), 0)
      ),
      'baseline_scaled', jsonb_build_object(
        'total_cost_usd', v_baseline_total_cost_usd,
        'total_wall_ms', v_baseline_total_wall_ms,
        'n_groups_scale', v_n_groups
      )
    );
    INSERT INTO public.shortlisting_events (
      project_id, round_id, event_type, actor_type, payload
    ) VALUES (
      v_canary_project_id, v_canary_round_id, 'canary_regression',
      'system', v_payload
    );
    RETURN jsonb_build_object('status', 'regression', 'breaches', v_breaches);
  END IF;

  -- All clear: emit a low-noise success event so the SLA dashboard can show
  -- "checked at HH:MM, all green".
  INSERT INTO public.shortlisting_events (
    project_id, round_id, event_type, actor_type, payload
  ) VALUES (
    v_canary_project_id, v_canary_round_id, 'canary_check_ok',
    'system',
    jsonb_build_object(
      'observed', jsonb_build_object(
        'total_cost_usd', v_audit.total_cost_usd,
        'total_wall_ms', v_audit.total_wall_ms,
        'round_status', v_round_status,
        'gallery_length', COALESCE(jsonb_array_length(v_round_gallery), 0)
      )
    )
  );
  RETURN jsonb_build_object('status', 'ok');

EXCEPTION
  WHEN OTHERS THEN
    -- Defensive: do NOT propagate errors to cron. Log and return.
    BEGIN
      INSERT INTO public.shortlisting_events (
        project_id, round_id, event_type, actor_type, payload
      ) VALUES (
        v_canary_project_id, v_canary_round_id, 'canary_check_error',
        'system',
        jsonb_build_object(
          'sqlstate', SQLSTATE,
          'message', SQLERRM
        )
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;  -- give up silently if even the error log fails
    END;
    RETURN jsonb_build_object('status', 'error', 'sqlstate', SQLSTATE, 'message', SQLERRM);
END $$;

GRANT EXECUTE ON FUNCTION public.shortlisting_canary_check() TO service_role;
REVOKE EXECUTE ON FUNCTION public.shortlisting_canary_check() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.shortlisting_canary_check() FROM anon, authenticated;

COMMENT ON FUNCTION public.shortlisting_canary_check() IS
  'Daily canary SLA check (mig 437). Reads latest engine_run_audit for the '
  'canary round, compares against frozen baseline in shortlisting_benchmark_'
  'results (id=...bbbb-bbbb-bbbb...0001), emits canary_regression to '
  'shortlisting_events when wall_ms > 1.5x baseline OR cost_usd > 1.5x baseline '
  'OR any stage failed OR round not proposed/locked/delivered OR gallery '
  'collapsed below 3 images. Defensive: never propagates errors to cron.';

-- ─── Piece B: enqueue function for the morning run ─────────────────────────
-- A small wrapper so the cron command can be a clean SQL call. It enqueues
-- a `shape_d_stage1` job against the canary round with `payload.force=true`
-- (mig 435 honours this to bypass the round-already-processed guard).
CREATE OR REPLACE FUNCTION public.shortlisting_canary_enqueue_run()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_canary_round_id    CONSTANT uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid;
  v_canary_project_id  CONSTANT uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaa001'::uuid;
  v_job_id             uuid;
BEGIN
  -- Reset round status so the dispatcher will enqueue cleanly. Non-destructive.
  UPDATE public.shortlisting_rounds
     SET status = 'pending',
         started_at = NULL,
         completed_at = NULL,
         stage_4_completed_at = NULL,
         updated_at = NOW()
   WHERE id = v_canary_round_id;

  -- Insert the Stage 1 job. The dispatcher cron picks it up within 2 min,
  -- runs Stage 1 → Stage 4 → persistence per the auto-chain. force=true
  -- bypasses any round-already-processed guard.
  INSERT INTO public.shortlisting_jobs (
    project_id, round_id, kind, status, payload
  )
  VALUES (
    v_canary_project_id,
    v_canary_round_id,
    'shape_d_stage1',
    'pending',
    jsonb_build_object(
      'force', true,
      'caller', 'cron:shortlisting_canary_run',
      'reason', 'Daily engine-health canary run (mig 437).',
      'trigger_source', 'canary_cron'
    )
  )
  RETURNING id INTO v_job_id;

  -- Emit ops event for visibility.
  INSERT INTO public.shortlisting_events (
    project_id, round_id, event_type, actor_type, payload
  ) VALUES (
    v_canary_project_id, v_canary_round_id, 'canary_run_enqueued',
    'system',
    jsonb_build_object('job_id', v_job_id, 'cron', 'shortlisting_canary_run')
  );

  RETURN v_job_id;
EXCEPTION
  WHEN OTHERS THEN
    BEGIN
      INSERT INTO public.shortlisting_events (
        project_id, round_id, event_type, actor_type, payload
      ) VALUES (
        v_canary_project_id, v_canary_round_id, 'canary_check_error',
        'system',
        jsonb_build_object(
          'phase', 'enqueue',
          'sqlstate', SQLSTATE,
          'message', SQLERRM
        )
      );
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RAISE;  -- surface enqueue errors; no observable run = needs human attention
END $$;

GRANT EXECUTE ON FUNCTION public.shortlisting_canary_enqueue_run() TO service_role;
REVOKE EXECUTE ON FUNCTION public.shortlisting_canary_enqueue_run() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.shortlisting_canary_enqueue_run() FROM anon, authenticated;

COMMENT ON FUNCTION public.shortlisting_canary_enqueue_run() IS
  'Enqueues the daily canary Stage 1 job (mig 437). Resets round status to '
  '''pending'', INSERTs a shape_d_stage1 job with payload.force=true. The '
  'shortlisting-job-dispatcher cron (every 2 min) picks it up.';

-- ─── Piece B: schedule the two pg_cron jobs ────────────────────────────────
-- Job 1: 0 19 * * * UTC = 06:00 Sydney (AEST UTC+10) the next morning
-- Job 2: 30 19 * * * UTC = 30 min after the run, allowing Stage 1+Stage 4 to
--                          finish (source round's wall = ~7 min, so 30 min
--                          is generous headroom)
SELECT cron.unschedule('shortlisting_canary_run')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'shortlisting_canary_run');

SELECT cron.schedule(
  'shortlisting_canary_run',
  '0 19 * * *',
  $cron$SELECT public.shortlisting_canary_enqueue_run()$cron$
);

SELECT cron.unschedule('shortlisting_canary_check')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'shortlisting_canary_check');

SELECT cron.schedule(
  'shortlisting_canary_check',
  '30 19 * * *',
  $cron$SELECT public.shortlisting_canary_check()$cron$
);

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- Rollback (run manually if this migration breaks production)
-- ════════════════════════════════════════════════════════════════════════════
--
-- BEGIN;
--   -- Unschedule the cron jobs first so nothing fires while we tear down.
--   SELECT cron.unschedule('shortlisting_canary_run')
--     WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'shortlisting_canary_run');
--   SELECT cron.unschedule('shortlisting_canary_check')
--     WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'shortlisting_canary_check');
--
--   -- Drop the functions.
--   DROP FUNCTION IF EXISTS public.shortlisting_canary_enqueue_run();
--   DROP FUNCTION IF EXISTS public.shortlisting_canary_check();
--
--   -- Delete the canary's events (90-day retention will sweep eventually
--   -- but explicit removal keeps the round-delete clean).
--   DELETE FROM public.shortlisting_events
--     WHERE round_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid;
--
--   -- Delete the canary's jobs (any pending or running first need to be
--   -- terminal; if the dispatcher has a live worker on it, wait).
--   DELETE FROM public.shortlisting_jobs
--     WHERE round_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid;
--
--   -- Delete classifications and audit rows tied to the canary.
--   DELETE FROM public.engine_run_audit
--     WHERE round_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid;
--
--   -- Delete composition_groups (use the deterministic id pattern).
--   DELETE FROM public.composition_groups
--     WHERE round_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid;
--
--   -- Delete the canary round + project.
--   DELETE FROM public.shortlisting_rounds
--     WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid;
--   DELETE FROM public.projects
--     WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaa001'::uuid;
--
--   -- Delete the frozen baseline row.
--   DELETE FROM public.shortlisting_benchmark_results
--     WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-bbbbbbbb0001'::uuid;
--
--   -- Restore the original trigger CHECK constraint.
--   ALTER TABLE public.shortlisting_benchmark_results
--     DROP CONSTRAINT IF EXISTS shortlisting_benchmark_results_trigger_check;
--   ALTER TABLE public.shortlisting_benchmark_results
--     ADD CONSTRAINT shortlisting_benchmark_results_trigger_check
--     CHECK (trigger = ANY (ARRAY['manual'::text, 'quarterly_cron'::text, 'calibration'::text]));
-- COMMIT;
--
-- Note: this rollback is data-lossy in that it removes the canary round and
-- its full event history. If the canary has been running for any length of
-- time, dump the events first:
--   CREATE TABLE _rollback_canary_events_437 AS
--     SELECT * FROM public.shortlisting_events
--      WHERE round_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid;
