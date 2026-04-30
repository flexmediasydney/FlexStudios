-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 350: Wave 11.8 — multi-vendor vision adapter + A/B comparison
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: docs/design-specs/W11-8-multi-vendor-vision-adapter.md (commit db511e9)
--
-- This migration ships the data substrate for the vendor-agnostic vision adapter
-- introduced in W11.8. It does NOT change current Pass 0/1/2 behaviour — those
-- continue to call Anthropic via the thin compatibility wrapper around the new
-- `_shared/visionAdapter` router.
--
-- What ships here:
--   1. `vendor_shadow_runs`        — per-call audit table for vendor responses,
--                                    populated by the retroactive comparison fn
--                                    and by future shadow-run wiring on the
--                                    unified call (W11.7 dep). One row per
--                                    (round_id, pass_kind, vendor, model)
--                                    invocation.
--   2. `vendor_comparison_results` — per-round pairwise comparison metrics
--                                    (slot agreement, score correlation,
--                                    object overlap, room-type agreement,
--                                    cost, latency, disagreement summary).
--   3. Nine new `engine_settings` rows for per-pass vendor + model selection +
--      shadow-run toggle. Master_admin edits via the existing
--      Settings → Shortlist · Engine Settings page.
--   4. RLS:
--        - SELECT: master_admin + admin (read for the comparison UI).
--        - UPDATE: master_admin (corrections only — primary writes are
--          service-role from the edge fns).
--        - INSERT: service_role only (the comparison + shadow harness).
--      No DELETE policy — historical comparison data is retained.
--
-- Note on numbering: the spec says "reserve 350" but the live tree has used
-- migration numbers up to 369; the orchestrator will renumber on cherry-pick
-- if a later free slot is needed. The filename matches the spec for clean
-- diffing during integration.
--
-- ─── 1. vendor_shadow_runs ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS vendor_shadow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID NOT NULL REFERENCES shortlisting_rounds(id) ON DELETE CASCADE,
  pass_kind TEXT NOT NULL,                     -- 'unified' | 'description_backfill' | 'pass0_hardreject'
  vendor TEXT NOT NULL,                        -- 'anthropic' | 'google'
  model TEXT NOT NULL,                         -- e.g. 'claude-opus-4-7' | 'gemini-2.0-pro'
  request_payload JSONB NOT NULL,              -- full VisionRequest (replayable)
  response_output JSONB,                       -- parsed structured output (null on failure)
  response_usage JSONB,                        -- usage metrics + cost
  vendor_meta JSONB,                           -- timing + finish_reason + request_id
  error_message TEXT,                          -- non-null when the vendor call failed
  ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- group_id is optional — populated when the shadow run is for a single
  -- composition (most common). Null when the call was a multi-image batch
  -- (e.g. unified call covering many compositions in one request).
  group_id UUID REFERENCES composition_groups(id) ON DELETE SET NULL,
  -- A label the harness assigns to a particular comparison config so multiple
  -- (vendor, model) variants of the same pass can be distinguished, e.g.
  -- 'anthropic-opus-baseline' or 'google-pro-test'.
  label TEXT
);

COMMENT ON TABLE vendor_shadow_runs IS
  'Wave 11.8: per-call vendor invocation audit. Populated by the retroactive '
  'comparison edge fn (vendor-retroactive-compare) and by future shadow-run '
  'wiring on the W11.7 unified call. One row per (round_id, pass_kind, vendor, '
  'model[, group_id]) call. Replayable via request_payload. error_message '
  'non-null on failure.';
COMMENT ON COLUMN vendor_shadow_runs.pass_kind IS
  'Logical pass identifier: unified | description_backfill | pass0_hardreject. '
  'Matches the engine_settings keys that route the call.';
COMMENT ON COLUMN vendor_shadow_runs.request_payload IS
  'Full VisionRequest JSON (vendor, model, prompt, images-as-paths, schema). '
  'Replayable — the harness can re-run this row through callVisionAdapter '
  'verbatim if a vendor response needs reproduction.';
COMMENT ON COLUMN vendor_shadow_runs.response_output IS
  'Parsed structured output matching the request schema. NULL when the call '
  'failed (see error_message).';
COMMENT ON COLUMN vendor_shadow_runs.response_usage IS
  'Usage metrics: input_tokens, output_tokens, cached_input_tokens, '
  'estimated_cost_usd. Used for the Cost column in vendor_comparison_results.';
COMMENT ON COLUMN vendor_shadow_runs.vendor_meta IS
  'Vendor metadata: vendor, model, request_id, finish_reason, elapsed_ms.';
COMMENT ON COLUMN vendor_shadow_runs.label IS
  'Human-readable label assigned by the comparison harness (e.g. '
  '"anthropic-opus-baseline"). Lets multiple (vendor, model) variants of the '
  'same pass be distinguished in the comparison report.';

CREATE INDEX IF NOT EXISTS idx_shadow_runs_round
  ON vendor_shadow_runs(round_id);
CREATE INDEX IF NOT EXISTS idx_shadow_runs_vendor_model
  ON vendor_shadow_runs(vendor, model);
CREATE INDEX IF NOT EXISTS idx_shadow_runs_round_pass
  ON vendor_shadow_runs(round_id, pass_kind);
CREATE INDEX IF NOT EXISTS idx_shadow_runs_group
  ON vendor_shadow_runs(group_id) WHERE group_id IS NOT NULL;

-- ─── 2. vendor_comparison_results ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS vendor_comparison_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID NOT NULL REFERENCES shortlisting_rounds(id) ON DELETE CASCADE,
  primary_vendor TEXT NOT NULL,
  primary_model TEXT NOT NULL,
  shadow_vendor TEXT NOT NULL,
  shadow_model TEXT NOT NULL,
  -- Optional labels matching the labels used in vendor_shadow_runs.
  primary_label TEXT,
  shadow_label TEXT,
  -- Decision-level metrics
  slot_decision_agreement_rate NUMERIC(4, 3),    -- 0-1; fraction of slots with same winner
  near_duplicate_agreement_rate NUMERIC(4, 3),   -- fraction of near-dup clusters that match
  classification_agreement_rate NUMERIC(4, 3),   -- fraction of compositions classified to same room_type
  -- Score-level metrics
  combined_score_mean_abs_delta NUMERIC(4, 2),   -- avg |primary_score - shadow_score|
  combined_score_correlation NUMERIC(4, 3),      -- Pearson correlation
  -- Object overlap (Jaccard on key_elements, since today's schema doesn't
  -- have observed_objects yet — W12 substrate. Same column kept for
  -- forward-compat, value reflects whatever overlap metric the harness
  -- emitted for v1).
  observed_objects_overlap_rate NUMERIC(4, 3),
  -- Cost
  primary_cost_usd NUMERIC(8, 6),
  shadow_cost_usd NUMERIC(8, 6),
  -- Latency
  primary_elapsed_ms INT,
  shadow_elapsed_ms INT,
  -- Disagreement narrative (auto-generated from diff)
  disagreement_summary TEXT,
  -- Pointer to the full markdown report uploaded to Dropbox
  -- (<dropbox_root_path>/Photos/_AUDIT/vendor_comparison_<round_id>.md).
  -- Optional: best-effort upload; the row is still useful without it.
  dropbox_report_path TEXT,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE vendor_comparison_results IS
  'Wave 11.8: per-round pairwise vendor comparison metrics. One row per '
  '(primary, shadow) vendor-model pair compared. disagreement_summary holds '
  'a truncated markdown narrative; full report mirrored to Dropbox at '
  'dropbox_report_path. Driving table for the Vendor Comparison admin page.';
COMMENT ON COLUMN vendor_comparison_results.slot_decision_agreement_rate IS
  'Fraction of shortlist slots where both vendors picked the same winner '
  '(0=zero agreement, 1=perfect agreement). NULL when slot decisions weren''t '
  'made by both vendors (e.g. unified call only).';
COMMENT ON COLUMN vendor_comparison_results.combined_score_correlation IS
  'Pearson correlation between primary and shadow combined_score across all '
  'compositions. >0.85 = strong agreement on relative ranking; <0.5 = '
  'fundamentally different scoring distributions.';
COMMENT ON COLUMN vendor_comparison_results.observed_objects_overlap_rate IS
  'Jaccard score on object/key-element sets (today: key_elements arrays from '
  'Pass 1 output; W12-onwards: observed_objects canonical keys).';
COMMENT ON COLUMN vendor_comparison_results.dropbox_report_path IS
  'Path to the full markdown comparison report at <root>/Photos/_AUDIT/'
  'vendor_comparison_<round_id>.md. Best-effort: NULL when upload failed.';

CREATE INDEX IF NOT EXISTS idx_comparison_round
  ON vendor_comparison_results(round_id);
CREATE INDEX IF NOT EXISTS idx_comparison_generated_at
  ON vendor_comparison_results(generated_at DESC);

-- ─── 3. engine_settings seed (9 rows) ────────────────────────────────────────
-- These rows configure which vendor + model is used for each logical pass and
-- the shadow-run toggle. Master_admin flips via Settings → Engine Settings.

INSERT INTO engine_settings (key, value, description) VALUES
  ('vision.unified_call.vendor',
   '"anthropic"'::jsonb,
   'Wave 11.8: vendor for the W11.7 unified Pass 1+2 call. Allowed: "anthropic" | "google".'),
  ('vision.unified_call.model',
   '"claude-opus-4-7"'::jsonb,
   'Wave 11.8: model id within the chosen vendor for the unified call.'),
  ('vision.description_backfill.vendor',
   '"anthropic"'::jsonb,
   'Wave 11.8: vendor for the async per-image description backfill. Allowed: "anthropic" | "google".'),
  ('vision.description_backfill.model',
   '"claude-sonnet-4-6"'::jsonb,
   'Wave 11.8: model id for description backfill.'),
  ('vision.pass0_hardreject.vendor',
   '"anthropic"'::jsonb,
   'Wave 11.8: vendor for Pass 0 hard-reject classification. Allowed: "anthropic" | "google".'),
  ('vision.pass0_hardreject.model',
   '"claude-haiku-4"'::jsonb,
   'Wave 11.8: model id for Pass 0.'),
  ('vision.shadow_run.enabled',
   'false'::jsonb,
   'Wave 11.8: when true, every unified call ALSO fires a parallel shadow run against vision.shadow_run.vendor for A/B comparison. Cost doubles when enabled.'),
  ('vision.shadow_run.vendor',
   '"google"'::jsonb,
   'Wave 11.8: shadow vendor when shadow_run.enabled=true.'),
  ('vision.shadow_run.model',
   '"gemini-2.0-pro"'::jsonb,
   'Wave 11.8: shadow model.')
ON CONFLICT (key) DO NOTHING;

-- ─── 4. RLS ──────────────────────────────────────────────────────────────────
-- Pattern mirrors shortlisting_signal_weights / shortlisting_tier_configs (mig 286/344):
-- master_admin+admin can SELECT/UPDATE; service_role inserts via edge fns.

ALTER TABLE vendor_shadow_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "vendor_shadow_runs_select_admin" ON vendor_shadow_runs;
CREATE POLICY "vendor_shadow_runs_select_admin" ON vendor_shadow_runs
  FOR SELECT TO authenticated USING (
    get_user_role() IN ('master_admin', 'admin')
  );

DROP POLICY IF EXISTS "vendor_shadow_runs_update_master" ON vendor_shadow_runs;
CREATE POLICY "vendor_shadow_runs_update_master" ON vendor_shadow_runs
  FOR UPDATE TO authenticated USING (
    get_user_role() = 'master_admin'
  );

-- INSERT is service-role only — no policy = denied for authenticated; the
-- edge fns use the service-role client (which bypasses RLS).

ALTER TABLE vendor_comparison_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "vendor_comparison_results_select_admin" ON vendor_comparison_results;
CREATE POLICY "vendor_comparison_results_select_admin" ON vendor_comparison_results
  FOR SELECT TO authenticated USING (
    get_user_role() IN ('master_admin', 'admin')
  );

DROP POLICY IF EXISTS "vendor_comparison_results_update_master" ON vendor_comparison_results;
CREATE POLICY "vendor_comparison_results_update_master" ON vendor_comparison_results
  FOR UPDATE TO authenticated USING (
    get_user_role() = 'master_admin'
  );

NOTIFY pgrst, 'reload schema';

-- ─── Rollback (manual; only if migration breaks production) ───────────────────
--
-- DELETE FROM engine_settings WHERE key IN (
--   'vision.unified_call.vendor', 'vision.unified_call.model',
--   'vision.description_backfill.vendor', 'vision.description_backfill.model',
--   'vision.pass0_hardreject.vendor', 'vision.pass0_hardreject.model',
--   'vision.shadow_run.enabled', 'vision.shadow_run.vendor', 'vision.shadow_run.model'
-- );
-- DROP TABLE IF EXISTS vendor_comparison_results;
-- DROP TABLE IF EXISTS vendor_shadow_runs;
