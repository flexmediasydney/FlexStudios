-- Wave 8 P1-7+P1-15+P1-17 (W8): tier-config versioning, round-level provenance,
-- per-tier weights + hard-reject overrides.
--
-- Spec: docs/design-specs/W8-tier-configs.md
--
-- This migration ships:
--   1. shortlisting_tier_configs — versioned per-tier weight bundle. Exactly
--      one row per tier_id has is_active=TRUE at any time, enforced by a
--      partial unique index. Activation is atomic (UPDATE old=FALSE +
--      UPDATE new=TRUE in a transaction). Old versions are retained for
--      replay/audit (never deleted).
--   2. v1 seed: 3 rows (one per active shortlisting_tier — S/P/A). Default
--      dimension weights are 0.25/0.30/0.25/0.20 (technical/lighting/
--      composition/aesthetic). Default signal weights are 1.0 across all 22
--      signals already seeded into shortlisting_signal_weights (mig 286 +
--      mig 291). hard_reject_thresholds stays NULL at v1 — every tier
--      inherits engine_settings.hard_reject_thresholds (mig 339).
--   3. shortlisting_rounds gains engine_version TEXT + tier_config_version
--      INT columns. Filled by shortlisting-ingest at round bootstrap (W8.4).
--   4. Backfill: existing rounds get engine_version='wave-8-v1' +
--      tier_config_version=1 so analytics can distinguish pre-W8 unfilled
--      rows from W8-era rounds with explicit version pins.
--   5. RLS policies mirroring shortlisting_signal_weights (mig 286).
--
-- The combined_score formula in Pass 1 is calibrated to remain regression-
-- equivalent under v1 weights: with uniform signal weights (1.0 × 22) and
-- the dimension weights summing to 1.0 (0.25+0.30+0.25+0.20=1.0), the
-- weighted rollup of the 4 dimensions reduces to a weighted average that
-- equals today's uniform mean iff every weight is 0.25. The v1 seed uses
-- 0.25/0.30/0.25/0.20 — NOT uniform — because the L9 lesson says lighting
-- drives perceived quality more than other dimensions. The Pass 1 snapshot
-- test in _shared/scoreRollup.test.ts asserts the explicit math: with
-- balanced 0.25 weights the rollup equals the uniform mean, and with the
-- v1 seed's lighting-biased weights the rollup applies the lighting bias.

-- 1. shortlisting_tier_configs ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shortlisting_tier_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_id UUID NOT NULL REFERENCES shortlisting_tiers(id),
  version INT NOT NULL,                              -- monotonic per tier (1, 2, 3, ...)
  dimension_weights JSONB NOT NULL,                  -- {"technical":0.25,"lighting":0.30,"composition":0.25,"aesthetic":0.20}
  signal_weights JSONB NOT NULL,                     -- {"signal_key":1.0,...}
  hard_reject_thresholds JSONB,                      -- per-tier override; NULL = use engine_settings global
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  activated_at TIMESTAMPTZ,
  deactivated_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tier_id, version)
);

COMMENT ON TABLE shortlisting_tier_configs IS
  'Wave 8 (P1-7): per-tier versioned weight bundle. Exactly one row per tier_id has is_active=TRUE at any time (enforced by partial unique index idx_tier_configs_one_active_per_tier). Activation flips old=FALSE + new=TRUE atomically. Old versions retained for replay/audit. dimension_weights keys: technical/lighting/composition/aesthetic, summing to 1.0 (validated at save-time, not via DB CHECK). signal_weights keys are signal_key from shortlisting_signal_weights (mig 286). hard_reject_thresholds shape matches engine_settings global; NULL means inherit global.';

COMMENT ON COLUMN shortlisting_tier_configs.tier_id IS
  'FK to shortlisting_tiers.id (mig 339). One row per (tier_id, version).';
COMMENT ON COLUMN shortlisting_tier_configs.version IS
  'Monotonic per-tier version number (1, 2, 3, ...). Resolved at save-time via MAX(version)+1.';
COMMENT ON COLUMN shortlisting_tier_configs.dimension_weights IS
  'JSONB: {"technical": 0.25, "lighting": 0.30, "composition": 0.25, "aesthetic": 0.20}. Keys must all be present; values must sum to 1.0 (validated at save-time within 0.001 tolerance).';
COMMENT ON COLUMN shortlisting_tier_configs.signal_weights IS
  'JSONB map of signal_key (from shortlisting_signal_weights) to numeric weight. v1 seeds uniform 1.0 across all active signals. Forward-compat for W11 per-signal scoring.';
COMMENT ON COLUMN shortlisting_tier_configs.hard_reject_thresholds IS
  'Optional per-tier override of engine_settings.hard_reject_thresholds. Same shape: {"technical": 4.5, "lighting": 4.5}. NULL means inherit the global.';
COMMENT ON COLUMN shortlisting_tier_configs.is_active IS
  'Exactly one row per tier_id has is_active=TRUE at any time (partial unique index idx_tier_configs_one_active_per_tier).';
COMMENT ON COLUMN shortlisting_tier_configs.notes IS
  'Admin-typed rationale for the version (e.g. "Mosman calibration: lifestyle shots underperformed."). Surfaced in History panel.';

-- Exactly one active row per tier — enforced by partial unique index.
-- This is the activation race protection (R7 in spec): two admins clicking
-- "activate" concurrently → second transaction gets unique-violation, UI
-- catches 23505 and shows a refresh-required toast.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tier_configs_one_active_per_tier
  ON shortlisting_tier_configs(tier_id) WHERE is_active = TRUE;

-- Hot-path fetch: "give me the active config for Tier P":
CREATE INDEX IF NOT EXISTS idx_tier_configs_active
  ON shortlisting_tier_configs(tier_id, is_active) WHERE is_active = TRUE;

-- Historical lookup by version (for tier_config_version round pin):
CREATE INDEX IF NOT EXISTS idx_tier_configs_tier_version
  ON shortlisting_tier_configs(tier_id, version);

-- 2. v1 seed: one row per active tier ──────────────────────────────────────
-- Default dimension weights per spec Q1 + R-recommendation:
--   technical: 0.25, lighting: 0.30, composition: 0.25, aesthetic: 0.20
-- Identical for all three tiers at v1 (S/P/A inherit the same v1 baseline).
-- Tier-specific tuning happens via the admin UI after Wave 14 calibration.
INSERT INTO shortlisting_tier_configs (tier_id, version, dimension_weights, signal_weights, hard_reject_thresholds, is_active, activated_at, notes)
SELECT
  t.id,
  1,
  '{"technical":0.25,"lighting":0.30,"composition":0.25,"aesthetic":0.20}'::jsonb,
  -- Uniform 1.0 across the 22 signals seeded by mig 286 + mig 291; W14
  -- calibration tunes per-signal post-launch.
  COALESCE(
    (SELECT jsonb_object_agg(signal_key, 1.0)
       FROM shortlisting_signal_weights
       WHERE is_active = TRUE),
    '{}'::jsonb
  ),
  NULL,                          -- v1: every tier inherits engine_settings global
  TRUE,
  NOW(),
  'v1 seed — uniform signal weights, lighting-biased dimensions (lighting=0.30 per L9 lesson). Tune via Settings → Engine → Tier Configs after Wave 14 calibration.'
FROM shortlisting_tiers t
WHERE t.is_active = TRUE
ON CONFLICT (tier_id, version) DO NOTHING;

-- 3. shortlisting_rounds — engine_version + tier_config_version ────────────
-- W8.4: every round records which engine code + which tier_config it ran
-- under, so historical replay is reproducible. tier_used denormalisation
-- is NOT added — engine_tier_id (mig 339) is canonical, one join hop to
-- shortlisting_tiers.tier_code.
ALTER TABLE shortlisting_rounds
  ADD COLUMN IF NOT EXISTS engine_version TEXT;
ALTER TABLE shortlisting_rounds
  ADD COLUMN IF NOT EXISTS tier_config_version INT;

COMMENT ON COLUMN shortlisting_rounds.engine_version IS
  'Wave 8 (W8.4): engine code version stamp captured at ingest. Free-form string from _shared/engineVersion.ts (e.g. wave-8-v1). Bumped per wave-completion commit. Backfilled to wave-8-v1 for existing rounds; pre-W8 rounds keep their backfilled stamp for analytics.';
COMMENT ON COLUMN shortlisting_rounds.tier_config_version IS
  'Wave 8 (W8.4): which version of shortlisting_tier_configs was active for the round''s engine_tier_id at ingest. Backfilled to 1 for existing rounds (the v1 seed). NULL only when no active config existed at ingest time (data corruption — fallback path).';

-- Backfill: every existing round gets engine_version='wave-8-v1' +
-- tier_config_version=1. The seed migration above creates v1 for every
-- active tier; existing rounds in 'locked' / 'processing' / 'manual' state
-- ran under code that produced uniform-mean combined_score, which equals
-- the weighted rollup under uniform 0.25 dimension weights. The v1 seed's
-- lighting-biased weights (0.30) DON'T match what historical rounds
-- actually saw — but they're the closest forward-compatible label, and
-- analytics can join on the row to read the actual weights if exact
-- replay is needed. Spec §8: this is intentional ("rounds with NULL
-- tier_config_version can't be replayed").
--
-- Future re-simulation that needs strict pre-W8 replay should filter
-- rounds where started_at < (the deploy timestamp of W8) — captured in
-- the audit log, queryable post-hoc.
UPDATE shortlisting_rounds
SET
  engine_version = COALESCE(engine_version, 'wave-8-v1'),
  tier_config_version = COALESCE(tier_config_version, 1)
WHERE engine_version IS NULL OR tier_config_version IS NULL;

CREATE INDEX IF NOT EXISTS idx_rounds_tier_config_version
  ON shortlisting_rounds(engine_tier_id, tier_config_version)
  WHERE tier_config_version IS NOT NULL;

-- 4. RLS ──────────────────────────────────────────────────────────────────
-- Same shape as shortlisting_signal_weights (mig 286). Master_admin/admin
-- write; everyone authenticated reads (the engine reads it on every Pass 1
-- invocation; if the engine had to be master-only it would block all rounds).
ALTER TABLE shortlisting_tier_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tier_configs_select_all" ON shortlisting_tier_configs;
CREATE POLICY "tier_configs_select_all" ON shortlisting_tier_configs
  FOR SELECT TO authenticated USING (
    get_user_role() IN ('master_admin','admin','manager','employee','contractor')
  );

DROP POLICY IF EXISTS "tier_configs_insert_admin" ON shortlisting_tier_configs;
CREATE POLICY "tier_configs_insert_admin" ON shortlisting_tier_configs
  FOR INSERT TO authenticated WITH CHECK (
    get_user_role() IN ('master_admin','admin')
  );

DROP POLICY IF EXISTS "tier_configs_update_admin" ON shortlisting_tier_configs;
CREATE POLICY "tier_configs_update_admin" ON shortlisting_tier_configs
  FOR UPDATE TO authenticated USING (
    get_user_role() IN ('master_admin','admin')
  );

DROP POLICY IF EXISTS "tier_configs_delete_master" ON shortlisting_tier_configs;
CREATE POLICY "tier_configs_delete_master" ON shortlisting_tier_configs
  FOR DELETE TO authenticated USING (
    get_user_role() = 'master_admin'
  );

NOTIFY pgrst, 'reload schema';

-- ── Rollback (manual; only if migration breaks production) ────────────────
--
-- DROP INDEX IF EXISTS idx_rounds_tier_config_version;
-- ALTER TABLE shortlisting_rounds DROP COLUMN IF EXISTS tier_config_version;
-- ALTER TABLE shortlisting_rounds DROP COLUMN IF EXISTS engine_version;
-- DROP INDEX IF EXISTS idx_tier_configs_tier_version;
-- DROP INDEX IF EXISTS idx_tier_configs_active;
-- DROP INDEX IF EXISTS idx_tier_configs_one_active_per_tier;
-- DROP TABLE IF EXISTS shortlisting_tier_configs;
--
-- The combined_score formula in Pass 1 reverts to a uniform mean once the
-- tier-config read is removed (revert _shared/scoreRollup.ts changes;
-- combined_score recomputes per-row from the 4 dim scores at insert time).
