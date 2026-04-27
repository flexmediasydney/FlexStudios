# W7.7 — `package_shortlist_configs` Sidecar Table — Design Spec (Draft)

**Status:** ⚠️ Decision draft. Authored 2026-04-27 by orchestrator. Some open questions need Joseph's input on cross-engine impact before dispatch.
**Backlog ref:** P1-6
**Wave plan ref:** W7.7 — `package_shortlist_configs` sidecar + `tiers` first-class table + slot FK refactor
**Dependencies:** None upstream. **Unblocks** W7.9 (per-package file count range), W7.11 (frontend hardcoded array purge), W8 (tier configs).

---

## Problem

The shortlisting engine needs **per-package configuration** that's specific to shortlisting and shouldn't pollute the core `packages` table:

1. **Slot definitions** that today live in `shortlisting_slot_definitions.package_types TEXT[]` (denormalized; modifying a package name silently orphans slot rows).
2. **Expected file count range** (W7.9 / P1-13) — Gold gets 30-40 hero shots, Silver gets 20-25. Today this is hardcoded math in the orchestrator.
3. **Hard reject thresholds** — premium packages should reject anything below technical_score 4.5; Silver tolerates 3.5+. Today it's the same threshold for everyone.
4. **Tier weight overrides** — Wave 8 will add per-tier dimension weights, but a Gold package on a Tier S property might want different weights than a Gold package on a Tier P property. The active tier per package is the input to that resolution.

Cross-engine concern: the `packages` table is also referenced by drone (`pricingParityCheck`) and conceptually by billing flows. We should NOT expand the core `packages` schema with shortlisting-only fields — that creates coupling drone teams have to navigate.

## Architecture decision: sidecar over column expansion

Two patterns considered:

### Option A — Add columns to `packages`

```sql
ALTER TABLE packages ADD COLUMN expected_file_count_target INT;
ALTER TABLE packages ADD COLUMN hard_reject_thresholds JSONB;
ALTER TABLE packages ADD COLUMN active_tier_id UUID;
ALTER TABLE packages ADD COLUMN slot_overrides JSONB;
```

**Pros:** simpler queries (no JOIN). Smaller migration footprint.
**Cons:** every shortlisting concept gets a column on the cross-engine `packages` table. Drone team's eyes glaze over. RLS rules on packages get more complex. `packages` becomes the "kitchen sink" of every engine's per-package needs.

### Option B — Sidecar table (recommended)

```sql
CREATE TABLE package_shortlist_configs (
  package_id UUID PRIMARY KEY REFERENCES packages(id) ON DELETE CASCADE,
  expected_file_count_min INT NOT NULL DEFAULT 0,
  expected_file_count_target INT NOT NULL DEFAULT 0,
  expected_file_count_max INT NOT NULL DEFAULT 0,
  hard_reject_thresholds JSONB NOT NULL DEFAULT '{}'::jsonb,
  slot_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  active_tier_id UUID REFERENCES shortlisting_tiers(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_package_shortlist_configs_active_tier
  ON package_shortlist_configs(active_tier_id);
```

**Pros:**
- Shortlisting concerns isolated from core packages.
- Drone team's `packages` view is unaffected.
- RLS rules can be per-engine (master_admin/admin for shortlisting; whatever drone needs for theirs).
- Easy to add a parallel `package_drone_configs` later if drone needs per-package settings without contaminating shortlisting's table.

**Cons:**
- Every read path gains a JOIN. (~5 ms; negligible against the engine's tens-of-seconds runtime.)
- Two writes when admin updates per-package settings. (Trivial — single SQL transaction.)

**Recommendation: Option B.** The cross-engine isolation argument dominates the small JOIN cost.

## `shortlisting_tiers` first-class table

Today the `tier` concept floats around as strings (`"Tier S"`, `"Tier P"`, `"Tier A"`) anchored only by the `shortlisting_stream_b_anchors.tier` column. Wave 8 needs a real `tiers` table so `package_shortlist_configs.active_tier_id` can FK to it.

```sql
CREATE TABLE shortlisting_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_code TEXT UNIQUE NOT NULL,           -- 'S', 'P', 'A', 'AA' for future
  display_name TEXT NOT NULL,                -- 'Standard', 'Premium', 'A-Grade', 'AA-Grade'
  score_anchor NUMERIC NOT NULL,             -- 5, 8, 9.5, 10 (Wave 8 makes this versioned)
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  display_order INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Backfill from the existing `shortlisting_stream_b_anchors` rows. Wave 8 will add a `shortlisting_tier_configs` versioned-weights table that FKs to `shortlisting_tiers`.

## Slot FK refactor (third deliverable)

Today `shortlisting_slot_definitions.package_types TEXT[]` carries a denormalized array of package *names* (e.g. `["Gold Package", "Silver Package"]`). This breaks when a package is renamed.

Refactor to a join table:

```sql
CREATE TABLE shortlisting_slot_package_eligibility (
  slot_definition_id UUID NOT NULL REFERENCES shortlisting_slot_definitions(id) ON DELETE CASCADE,
  package_id UUID NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  PRIMARY KEY (slot_definition_id, package_id)
);
```

Backfill: for each existing slot row, look up the package by name (`packages.name = ANY(slot.package_types)`) and insert join rows. Once verified, drop the `package_types` column in a follow-up migration.

⚠️ **W7.8 interaction.** W7.8 (currently in flight) is adding `shortlisting_slot_definitions.eligible_when_engine_roles TEXT[]` as the *modern* slot eligibility mechanism. After both W7.7 and W7.8 land, the resolution order is:
1. If `eligible_when_engine_roles` is non-empty → use product-driven matching against package's products (W7.8 path).
2. Else if `slot_package_eligibility` join has rows for the package → use that (W7.7 path).
3. Else → fall back to legacy `package_types` array (transition window only).

Once all slots have engine_roles populated, both `slot_package_eligibility` and `package_types` can be retired. Plan that as a future cleanup burst (W7.13?).

## Migration plan

**Migration 339** (numbered after W7.5 takes 336, W7.8 takes 337, and W7.6 plans 338):

```sql
-- 339_package_shortlist_configs.sql

-- 1. shortlisting_tiers
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

-- Seed from existing stream_b_anchors
INSERT INTO shortlisting_tiers (tier_code, display_name, score_anchor, description, display_order)
SELECT
  CASE tier
    WHEN 'Tier S' THEN 'S'
    WHEN 'Tier P' THEN 'P'
    WHEN 'Tier A' THEN 'A'
    ELSE tier
  END,
  CASE tier
    WHEN 'Tier S' THEN 'Standard'
    WHEN 'Tier P' THEN 'Premium'
    WHEN 'Tier A' THEN 'A-Grade'
    ELSE tier
  END,
  score_anchor,
  descriptor,
  CASE tier
    WHEN 'Tier S' THEN 1
    WHEN 'Tier P' THEN 2
    WHEN 'Tier A' THEN 3
    ELSE 99
  END
FROM shortlisting_stream_b_anchors
WHERE is_active = true
ON CONFLICT (tier_code) DO NOTHING;

-- 2. package_shortlist_configs
CREATE TABLE IF NOT EXISTS package_shortlist_configs (
  package_id UUID PRIMARY KEY REFERENCES packages(id) ON DELETE CASCADE,
  expected_file_count_min INT NOT NULL DEFAULT 0,
  expected_file_count_target INT NOT NULL DEFAULT 0,
  expected_file_count_max INT NOT NULL DEFAULT 0,
  hard_reject_thresholds JSONB NOT NULL DEFAULT '{}'::jsonb,
  slot_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  active_tier_id UUID REFERENCES shortlisting_tiers(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_package_shortlist_configs_active_tier
  ON package_shortlist_configs(active_tier_id);

-- Backfill: insert one row per active package with sane defaults
INSERT INTO package_shortlist_configs (
  package_id, expected_file_count_min, expected_file_count_target, expected_file_count_max,
  hard_reject_thresholds, active_tier_id
)
SELECT
  p.id,
  CASE p.name
    WHEN 'Gold Package' THEN 30
    WHEN 'Silver Package' THEN 20
    WHEN 'AI Package' THEN 8
    WHEN 'Flex Package' THEN 25
    ELSE 15
  END,
  CASE p.name
    WHEN 'Gold Package' THEN 35
    WHEN 'Silver Package' THEN 25
    WHEN 'AI Package' THEN 10
    WHEN 'Flex Package' THEN 30
    ELSE 20
  END,
  CASE p.name
    WHEN 'Gold Package' THEN 40
    WHEN 'Silver Package' THEN 30
    WHEN 'AI Package' THEN 12
    WHEN 'Flex Package' THEN 35
    ELSE 25
  END,
  '{"technical": 4.0, "lighting": 4.0}'::jsonb,
  (SELECT id FROM shortlisting_tiers WHERE tier_code = 'P' LIMIT 1)  -- default to Premium
FROM packages p
WHERE p.is_active = true
ON CONFLICT (package_id) DO NOTHING;

-- 3. slot_package_eligibility join table
CREATE TABLE IF NOT EXISTS shortlisting_slot_package_eligibility (
  slot_definition_id UUID NOT NULL REFERENCES shortlisting_slot_definitions(id) ON DELETE CASCADE,
  package_id UUID NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  PRIMARY KEY (slot_definition_id, package_id)
);

-- Backfill from package_types array
INSERT INTO shortlisting_slot_package_eligibility (slot_definition_id, package_id)
SELECT s.id, p.id
FROM shortlisting_slot_definitions s
CROSS JOIN packages p
WHERE p.is_active = true
  AND p.name = ANY(s.package_types)
ON CONFLICT DO NOTHING;

-- Rollback (in case the migration breaks production):
--
-- DROP TABLE shortlisting_slot_package_eligibility;
-- DROP TABLE package_shortlist_configs;
-- DROP TABLE shortlisting_tiers;
--
-- After rollback: all queries fall back to package_types text array on
-- shortlisting_slot_definitions. Stream B anchors still resolve via the
-- existing shortlisting_stream_b_anchors table. No data loss.
```

## Engine integration

1. **Slot eligibility resolution** (extends W7.8's resolver):
   - Step 1 (W7.8): match products' engine_roles against `slot.eligible_when_engine_roles`.
   - Step 2 (W7.7): when engine_roles miss, fall back to `slot_package_eligibility` join.
   - Step 3 (legacy): when join misses, fall back to `package_types` array.

2. **Expected file count** (W7.9): `SELECT expected_file_count_target FROM package_shortlist_configs WHERE package_id = ?`. Falls back to a hardcoded constant if no row.

3. **Hard reject thresholds**: read at the start of Pass 2, applied during scoring.

4. **Active tier**: read at the start of Pass 1 + Pass 2. Drives the Stream B anchors query: `SELECT * FROM shortlisting_stream_b_anchors WHERE tier = (SELECT display_name FROM shortlisting_tiers WHERE id = pkg.active_tier_id)`.

## Frontend impact

- New admin section `Settings → Packages → Shortlist Configs`. One row per active package showing min/target/max file counts, hard reject thresholds, active tier dropdown, slot overrides JSON editor.
- Existing slot definitions admin (`SettingsShortlistingSlots.jsx`) gets an "Eligible packages" multiselect populated from `slot_package_eligibility` join (replaces the current `package_types` text input).

## Open questions for Joseph (genuine cross-engine items)

These need Joseph's input — not orchestrator-resolvable on technical merit alone:

1. **Should drone get a parallel `package_drone_configs` sidecar?** If yes, do we want consistent shape (same column conventions) or independent? Affects future maintenance burden.

2. **Are the file count defaults right?** I've drafted 30/35/40 for Gold, 20/25/30 for Silver, 8/10/12 for AI, 25/30/35 for Flex. These come from spec section §3 vibes; would benefit from real Round 1 / Round 2 data to validate. Joseph: are these in the right ballpark?

3. **Default active_tier per package?** Drafted as `Tier P (Premium)` for everything. Should AI Package default to Tier S? Should Gold default to Tier A? This shapes what scores the engine targets out of the box.

4. **Hard reject thresholds — universal or per-package?** Drafted universal (`technical: 4.0, lighting: 4.0`) for backfill, but the table supports per-package overrides. Joseph: should premium packages start with stricter thresholds (e.g. 5.0)?

5. **Slot package eligibility cleanup timing.** Once W7.7 + W7.8 are both live and slot eligibility flows through engine_roles, the `package_types` text array becomes legacy. Plan a follow-up burst to drop it after a 1-month observation window? Or keep indefinitely as belt-and-braces?

6. **`shortlisting_tiers` admin UI?** Today tiers are defined by the `shortlisting_stream_b_anchors` rows. After this migration the canonical tier table is `shortlisting_tiers`. Admin UI for adding/editing tiers — Wave 7.7 scope or punt to Wave 8 (tier configs work)?

## Resolutions self-resolved by orchestrator

- Sidecar over column expansion (cross-engine isolation wins)
- Migration 339 reserved (after W7.5 takes 336, W7.8 takes 337, W7.6 plans 338)
- Slot FK refactor included as part of this wave (otherwise W7.8's product-driven path will silently bury the package_types denormalization issue)
- Backfill on migration day with sane defaults; admin UI lets per-package fine-tuning happen incrementally

## Effort estimate

- 0.5 day Joseph review of 6 open questions above
- 0.5 day final spec amendments
- 2-3 days execution: migration + backfill + sidecar reads in engine + admin UI
- Total: ~3-4 days

## Pre-execution checklist

- [x] Architecture decision (sidecar over column expansion) self-resolved by orchestrator
- [x] Migration 339 reserved
- [x] Cross-engine impact mapped (only `pricingParityCheck` references packages directly today)
- [ ] Joseph signs off on 6 open questions above
- [ ] After sign-off: orchestrator dispatches subagent burst with 4 logical commits (migration, sidecar reads, slot join refactor, frontend admin)
