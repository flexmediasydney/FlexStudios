-- Wave 7 P1-6 (W7.7): dynamic package/tier/engine_settings architecture.
--
-- Replaces the legacy hardcoded {Gold:24, Day-to-Dusk:31, Premium:38} ceilings
-- and per-package magic-number scoring with:
--   1. shortlisting_tiers — first-class engine tier table (S/P/A score anchors)
--   2. package_engine_tier_mapping — (package_id, tier_choice) → engine_tier
--      intersection. Joseph confirmed Gold→S/P + Flex→A/A; rest seeded as
--      best-guess editable in Settings → Packages → Tier Mapping.
--   3. shortlisting_rounds.engine_tier_id — pre-resolved at ingest, no
--      re-derivation per inference. Plus expected_count_target/min/max which
--      are computed dynamically from project products at ingest, not hardcoded.
--   4. engine_settings — universal config rows (initially: hard reject
--      thresholds). Master_admin editable via Settings → Engine Settings.
--   5. project_types.shortlisting_supported — manual-mode plumbing for W7.13.
--   6. DROP shortlisting_slot_definitions.package_types — replaced by
--      eligible_when_engine_roles (W7.8 backfill is complete).
--
-- See docs/design-specs/W7-7-package-shortlist-configs.md for the full design.

-- 1. shortlisting_tiers ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shortlisting_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_code TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  score_anchor NUMERIC NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  display_order INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE shortlisting_tiers IS
  'Wave 7 P1-6 (W7.7): first-class engine tier table. Backfilled from existing '
  'shortlisting_stream_b_anchors (Tier S=5, Tier P=8, Tier A=9.5). Wave 8 will '
  'add a versioned tier_configs FK''d to this; admin UI for tiers themselves '
  'is W8 scope.';

INSERT INTO shortlisting_tiers (tier_code, display_name, score_anchor, description, display_order)
VALUES
  ('S', 'Standard', 5,    'Tier S — entry-level quality bar (Stream B anchor 5).',     1),
  ('P', 'Premium',  8,    'Tier P — premium quality bar (Stream B anchor 8).',          2),
  ('A', 'A-Grade',  9.5,  'Tier A — top-shelf quality bar (Stream B anchor 9.5+).',     3)
ON CONFLICT (tier_code) DO NOTHING;

-- 2. package_engine_tier_mapping ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS package_engine_tier_mapping (
  package_id UUID NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  tier_choice TEXT NOT NULL CHECK (tier_choice IN ('standard', 'premium')),
  engine_tier_id UUID NOT NULL REFERENCES shortlisting_tiers(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (package_id, tier_choice)
);

COMMENT ON TABLE package_engine_tier_mapping IS
  'Wave 7 P1-6 (W7.7): (package_id, tier_choice) → engine_tier intersection. '
  'Joseph-confirmed: Gold→S/P, Flex→A/A. Best-guess seeds for Silver, AI, '
  'Day Video, Dusk Video; editable via Settings → Packages → Tier Mapping.';

-- Seed mapping (Joseph confirmed Gold + Flex; rest are best guesses).
WITH tier_ids AS (
  SELECT tier_code, id FROM shortlisting_tiers
)
INSERT INTO package_engine_tier_mapping (package_id, tier_choice, engine_tier_id, notes)
SELECT p.id, tc.tier_choice, t.id,
  CASE WHEN p.name IN ('Gold Package', 'Flex Package') THEN 'Joseph confirmed 2026-04-27' ELSE 'Best-guess seed; editable' END
FROM packages p
CROSS JOIN (VALUES ('standard'), ('premium')) AS tc(tier_choice)
JOIN tier_ids t ON t.tier_code = CASE
  -- Gold: S / P (Joseph explicit)
  WHEN p.name = 'Gold Package'    AND tc.tier_choice = 'standard' THEN 'S'
  WHEN p.name = 'Gold Package'    AND tc.tier_choice = 'premium'  THEN 'P'
  -- Flex: A / A (Joseph explicit)
  WHEN p.name = 'Flex Package'                                    THEN 'A'
  -- Silver: S / P (best guess)
  WHEN p.name = 'Silver Package'  AND tc.tier_choice = 'standard' THEN 'S'
  WHEN p.name = 'Silver Package'  AND tc.tier_choice = 'premium'  THEN 'P'
  -- AI: S / S (best guess — cheap path)
  WHEN p.name = 'AI Package'                                      THEN 'S'
  -- Day Video: S / P (best guess)
  WHEN p.name = 'Day Video Package' AND tc.tier_choice = 'standard' THEN 'S'
  WHEN p.name = 'Day Video Package' AND tc.tier_choice = 'premium'  THEN 'P'
  -- Dusk Video: P / A (best guess — Dusk is high-end)
  WHEN p.name = 'Dusk Video Package' AND tc.tier_choice = 'standard' THEN 'P'
  WHEN p.name = 'Dusk Video Package' AND tc.tier_choice = 'premium'  THEN 'A'
  -- Anything new defaults to S
  ELSE 'S'
END
WHERE p.is_active = true
ON CONFLICT DO NOTHING;

-- 3. shortlisting_rounds — engine_tier_id, expected_count_target/min/max,
--    manual-mode trigger reason. The legacy package_ceiling column is left in
--    place for now (back-compat with rounds already written) but new code paths
--    must NOT read it — read expected_count_target instead.
ALTER TABLE shortlisting_rounds
  ADD COLUMN IF NOT EXISTS engine_tier_id UUID REFERENCES shortlisting_tiers(id);

COMMENT ON COLUMN shortlisting_rounds.engine_tier_id IS
  'Wave 7 P1-6 (W7.7): pre-resolved engine tier (S/P/A) at ingest. NULL on '
  'legacy rounds; new rounds set this from package_engine_tier_mapping (bundled '
  'path) or projects.pricing_tier (à la carte path).';

ALTER TABLE shortlisting_rounds
  ADD COLUMN IF NOT EXISTS expected_count_target INT;
ALTER TABLE shortlisting_rounds
  ADD COLUMN IF NOT EXISTS expected_count_min INT;
ALTER TABLE shortlisting_rounds
  ADD COLUMN IF NOT EXISTS expected_count_max INT;

COMMENT ON COLUMN shortlisting_rounds.expected_count_target IS
  'Wave 7 P1-6 (W7.7): target shortlist photo count, computed at ingest from '
  'sum(project products with photo engine roles) — NOT hardcoded. min = max(0, '
  'target-3); max = target+3.';

ALTER TABLE shortlisting_rounds
  ADD COLUMN IF NOT EXISTS manual_mode_reason TEXT;

COMMENT ON COLUMN shortlisting_rounds.manual_mode_reason IS
  'Wave 7 P1-6 (W7.7): when status=''manual'', captures why the engine was '
  'skipped: ''project_type_unsupported'' (project_types.shortlisting_supported '
  '= false) or ''no_photo_products'' (computed target=0). NULL otherwise.';

-- 4. Drop legacy package_types (Joseph: hard clean now, no production data) ───
ALTER TABLE shortlisting_slot_definitions
  DROP COLUMN IF EXISTS package_types;

-- 5. engine_settings ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS engine_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES auth.users(id)
);

COMMENT ON TABLE engine_settings IS
  'Wave 7 P1-6 (W7.7): universal engine config rows. Master_admin editable via '
  'Settings → Engine Settings. Read-cached in edge functions on each invocation.';

INSERT INTO engine_settings (key, value, description) VALUES
  ('hard_reject_thresholds',
   '{"technical": 4.0, "lighting": 4.0}'::jsonb,
   'Universal floors below which Pass 2 rejects automatically. Master_admin editable via Settings → Engine Settings.')
ON CONFLICT (key) DO NOTHING;

-- 6. project_types.shortlisting_supported (manual-mode plumbing for W7.13) ────
ALTER TABLE project_types
  ADD COLUMN IF NOT EXISTS shortlisting_supported BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN project_types.shortlisting_supported IS
  'Wave 7 P1-6 (W7.7): when false, the project shortlisting subtab runs in '
  'manual mode (no AI passes; operator drags Dropbox files into approved; '
  'lock-triggers-move). When true (default), full Pass 0/1/2/3 engine runs.';

NOTIFY pgrst, 'reload schema';

-- ── Rollback (manual; only if migration breaks production) ──────────────────
--
-- ALTER TABLE project_types DROP COLUMN IF EXISTS shortlisting_supported;
-- DROP TABLE IF EXISTS engine_settings;
-- ALTER TABLE shortlisting_slot_definitions ADD COLUMN IF NOT EXISTS package_types TEXT[];
-- ALTER TABLE shortlisting_rounds DROP COLUMN IF EXISTS manual_mode_reason;
-- ALTER TABLE shortlisting_rounds DROP COLUMN IF EXISTS expected_count_max;
-- ALTER TABLE shortlisting_rounds DROP COLUMN IF EXISTS expected_count_min;
-- ALTER TABLE shortlisting_rounds DROP COLUMN IF EXISTS expected_count_target;
-- ALTER TABLE shortlisting_rounds DROP COLUMN IF EXISTS engine_tier_id;
-- DROP TABLE IF EXISTS package_engine_tier_mapping;
-- DROP TABLE IF EXISTS shortlisting_tiers;
--
-- Restoring package_types is OK because W7.8 left eligible_when_engine_roles
-- populated on every active slot — a follow-up backfill of package_types from
-- the engine_role array would be needed to fully restore the legacy fallback,
-- but the engine doesn't depend on that legacy path anymore.
