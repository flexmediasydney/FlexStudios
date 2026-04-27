# W8 — Tier Configs (versioned dimension/signal weights + admin UI + Pass-side integration + re-simulation safeguard + round metadata) — Design Spec

**Status:** ⚙️ Ready to dispatch (pending Joseph sign-off on Q1-Q4 below).
**Backlog ref:** P1-7 + P1-15 + P1-17.
**Wave plan ref:** Wave 8 (subsumes W8.1, W8.2, W8.3, W8.4 from `docs/WAVE_PLAN.md`).
**Dependencies:**
- **W7.7 ✅ shipped** — `shortlisting_tiers` table (S/P/A rows), `package_engine_tier_mapping`, `engine_settings`, `shortlisting_rounds.engine_tier_id` + `expected_count_target/_min/_max` + `manual_mode_reason` columns all live.
- **W7.6 ✅ shipped** — composable vision prompt blocks, `composition_classifications.prompt_block_versions JSONB` for downstream re-simulation provenance.
- **W7.8 ✅ shipped** — `products.engine_role` + `shortlisting_slot_definitions.eligible_when_engine_roles`.
- **No W11 dependency** — Wave 8 operates on today's 4-dim aggregate scoring schema (`technical/lighting/composition/aesthetic`) and on the 22 signals already enumerated in `shortlisting_signal_weights` (mig 286). W11 (universal vision response) is forward-compat: when it lands, the per-signal scores it emits land in the same `signal_weights` JSON map, no rework.

**Unblocks:**
- **W11 design closure** — Wave 11's "tier-weighted dimension rollup using DB-driven weights" item (W11.5 in `WAVE_PLAN.md`) reads the same `dimension_weights` rolled out here.
- **W13a** — historical FlexMedia training rows need `tier_used` + `tier_config_version` for reproducible re-extraction (per `W13a-historical-flexmedia-goldmine.md` §6).
- **W14** — calibration session diffs need round-time tier_config_version to compare like-for-like.
- **Future engine introspection** — admin can answer "why did this round score Tier P kitchen at 7.2?" by joining round → tier_config_version → weight breakdown.

---

## Problem

Today the engine has three interacting concepts but they're scattered across schema and code:

1. **Tier as score anchor** — `shortlisting_tiers` (W7.7) anchors Pass 2's quality bar at 5/8/9.5 per S/P/A, injected into the prompt via `streamBInjector.ts`.

2. **Combined-score formula** — `composition_classifications.combined_score` is computed in `shortlisting-pass1` as a uniform mean of the four dimension scores. The `shortlisting_signal_weights` table (mig 286) exists with per-signal weight rows but the engine **does not read it for the combined-score rollup** — the column is provisional infrastructure waiting for Wave 8 to wire it up.

3. **Hard reject thresholds** — `engine_settings.hard_reject_thresholds = {"technical": 4.0, "lighting": 4.0}` (W7.7) is a single global JSON, the same for all tiers. Joseph's instinct (per the W7.7 punt to W8) is that A-Grade rounds should run a tighter floor than Tier S rounds — a Tier S kitchen with technical=4.5 might be acceptable, the same shot in a Tier A round would be a defect.

The downstream gap: when an admin wants to **tune the engine** ("aesthetic should weigh more than technical for premium properties because the agent's job is selling the lifestyle, not auditing camera technique"), there is no surface. The values are constants in code or single-row globals in a generic settings table, not a tier-specific knob.

The further gap: when an admin **does change a weight**, there is no safety net. Today's flow would be: edit a weight, deploy, the next round runs under the new weight, the editor notices weird shortlists three days later, no easy way to roll back or to predict what would have happened. Wave 8 closes this with a re-simulation step: replay the last 30 locked rounds under the proposed new weights, show the diff, gate activation on admin confirmation.

The provenance gap: today's `shortlisting_rounds` row records `engine_tier_id` (W7.7) but does **not** record which version of the tier config was active when Pass 1 wrote the scores or when Pass 2 made its decisions. Re-extracting training rows from a historical round (W13a / W13b backfill) needs that version pin to be reproducible.

**The fix:** ship `shortlisting_tier_configs` (versioned), wire Pass 1 + Pass 2 to read it, build the admin UI with re-simulation gate, and pin `engine_version` + `tier_config_version` on every round at ingest.

---

## Architecture

### Section 1 — `shortlisting_tier_configs` versioned table

Per-tier weight bundle. Versioned monotonically. Exactly one row per tier with `is_active=TRUE` at any moment, enforced by a partial unique index. Activation is atomic (transaction): old row flips to `is_active=FALSE` + `deactivated_at=NOW()`, new row flips to `is_active=TRUE` + `activated_at=NOW()`. No row is ever deleted — historical configs stay queryable so rounds that ran under them retain reproducible provenance.

```sql
CREATE TABLE shortlisting_tier_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_id UUID NOT NULL REFERENCES shortlisting_tiers(id),
  version INT NOT NULL,                              -- monotonic per tier (1, 2, 3, ...)
  dimension_weights JSONB NOT NULL,                   -- {"technical":0.25,"lighting":0.30,"composition":0.25,"aesthetic":0.20}
  signal_weights JSONB NOT NULL,                      -- {"vertical_line_convergence":1.0,"window_blowout_area":0.8,...}
  hard_reject_thresholds JSONB,                       -- per-tier override of engine_settings global; NULL = use global
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  activated_at TIMESTAMPTZ,
  deactivated_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tier_id, version)
);

-- Exactly one active row per tier:
CREATE UNIQUE INDEX idx_tier_configs_one_active_per_tier
  ON shortlisting_tier_configs(tier_id) WHERE is_active = TRUE;

-- Hot-path fetch: "give me the active config for Tier P":
CREATE INDEX idx_tier_configs_active
  ON shortlisting_tier_configs(tier_id, is_active) WHERE is_active = TRUE;

-- Historical lookup by version (for tier_config_version round pin):
CREATE INDEX idx_tier_configs_tier_version
  ON shortlisting_tier_configs(tier_id, version);
```

**`dimension_weights` shape:** four required keys, sum to 1.0 (validated by a CHECK or by the admin-UI/edge-fn save handler — see §5). Today's combined-score formula reads each composition's four dimension scores; the weighted rollup reads `dimension_weights` keyed by dimension name.

**`signal_weights` shape:** map of `signal_key` → weight. Bootstrap covers the 22 signals that mig 291 seeded into `shortlisting_signal_weights`. Forward-compat: when W11 introduces new signals, they're added by inserting the new key into a fresh tier_config version. Old versions retain their snapshot; they don't auto-acquire the new signals, which is correct — historical rounds replay against historical signal sets.

**`hard_reject_thresholds`:** when NULL, the engine reads `engine_settings.hard_reject_thresholds` (the global). When populated, this overrides the global for this tier only. Shape matches the global: `{"technical": 4.5, "lighting": 4.5}` etc. Per-tier override gives Tier A its tighter floor without forcing Tier S to inherit it.

**`activated_at` / `deactivated_at`:** set by the activation transaction in `update-tier-config` edge fn (§5). Read by future analytics ("which tier_config was active on date X?") and by the round bootstrap (it pins the `tier_config_version` of whichever row had `is_active=TRUE` at round ingest time — see §3).

**`notes`:** admin-typed rationale ("aesthetic +0.05 to bias toward lifestyle shots after the Mosman calibration session"). Surfaced in the UI history panel for institutional memory.

**Why versioned in-table rather than via a separate `tier_config_history` table:** keeping all versions in the live table means SELECT-by-(tier_id, version) is a primary-index hit. Activation's atomicity is enforced by the partial unique index — there cannot be two `is_active=TRUE` rows for the same tier, even under concurrent writes (the second writer gets a constraint violation, which the UI catches). A separate history table would split the source of truth and require manual snapshot logic on every save.

### Section 2 — Backfill at v1

The migration writes one row per tier with `is_active=TRUE, version=1`:

```sql
INSERT INTO shortlisting_tier_configs (tier_id, version, dimension_weights, signal_weights, hard_reject_thresholds, is_active, activated_at, notes)
SELECT
  t.id,
  1,
  -- Default: balanced bias toward lighting (largest weight) per L9 lesson
  -- (lighting drives perceived quality more than any other dim).
  '{"technical":0.25,"lighting":0.30,"composition":0.25,"aesthetic":0.20}'::jsonb,
  -- Uniform 1.0 across all 22 signals at v1; Wave 14 calibration tunes per-signal.
  COALESCE(
    (SELECT jsonb_object_agg(signal_key, 1.0)
       FROM shortlisting_signal_weights
       WHERE is_active = TRUE),
    '{}'::jsonb
  ),
  NULL,                          -- v1: no per-tier override; everyone uses engine_settings global
  TRUE,
  NOW(),
  'v1 seed — uniform signal weights, lighting-biased dimensions. Tune via Settings → Engine → Tier Configs.'
FROM shortlisting_tiers t
WHERE t.is_active = TRUE
ON CONFLICT (tier_id, version) DO NOTHING;
```

Three rows seeded (Tier S/P/A at v1). The `hard_reject_thresholds` stays NULL at v1 — every tier inherits the W7.7 global (`technical=4.0, lighting=4.0`). Joseph tunes Tier A to a tighter floor (e.g. 4.5) once he's seen real Wave 14 calibration data.

### Section 3 — Round metadata columns (W8.4)

Every round needs to record which engine code + which tier_config it ran under, so historical replay is reproducible:

```sql
ALTER TABLE shortlisting_rounds
  ADD COLUMN IF NOT EXISTS engine_version TEXT,         -- e.g. 'wave-8-p1' or 'v2.3.1'
  ADD COLUMN IF NOT EXISTS tier_config_version INT;     -- which version of the active tier config
```

`engine_tier_id` (W7.7) already exists and serves as the FK to `shortlisting_tiers.id`; W8.4 does NOT add a denormalised `tier_used` column — `engine_tier_id` is the canonical reference, and the join to `shortlisting_tiers.tier_code` is one hop. The orchestrator confirmed (R3 below) the W7.7 column is sufficient; adding `tier_used TEXT` would denormalise unnecessarily and risk drift.

`engine_version` is a free-form string captured at ingest. The orchestrator self-resolves: pull it from a hardcoded constant in `_shared/engineVersion.ts` that's bumped on each Wave-completion commit (e.g. Wave 8 lands with `'wave-8-p1'`, mid-Wave-8 hotfixes bump to `'wave-8-p2'`). NOT pulled from `process.env.GIT_SHA` — Vercel deploys vs Supabase edge-fn deploys have different git SHAs and would create false noise. A wave-stamped string is what the analytics need: "rounds run under the Wave 8 engine".

`tier_config_version` is read at round bootstrap from the tier-config row that was active when ingest happened:

```typescript
// Inside shortlisting-ingest after engine_tier_id is resolved per W7.7's resolveEngineTier:
const { data: activeConfig } = await admin
  .from('shortlisting_tier_configs')
  .select('version')
  .eq('tier_id', engineTierId)
  .eq('is_active', true)
  .single();

await admin.from('shortlisting_rounds').update({
  engine_version: ENGINE_VERSION,           // from _shared/engineVersion.ts
  tier_config_version: activeConfig?.version ?? null,
}).eq('id', roundId);
```

If for some reason no active row exists for the tier (data corruption), the round writes `tier_config_version=NULL` and falls back to engine default behaviour — the engine doesn't crash. Pass 1 detects this case and emits a warning event so admin notices.

The columns are also surfaced on the round status UI as a small footer ("Engine: wave-8-p1 · Tier P v3"), giving operators provenance at a glance.

### Section 4 — Pass 1 + Pass 2 integration

#### Pass 1: weighted combined_score rollup

Today, `shortlisting-pass1` writes `composition_classifications.combined_score` via the formula:

```typescript
combined_score = (technical_score + lighting_score + composition_score + aesthetic_score) / 4
```

(Per the comment on `composition_classifications.combined_score`: "Weighted blend ... per current shortlisting_signal_weights config" — but the code has been computing a uniform mean since mig 287; W8 closes that gap.)

Wave 8 replaces the formula with a tier-aware weighted rollup:

```typescript
// New helper at _shared/scoreRollup.ts:
import { getActiveTierConfig } from './tierConfig.ts';

export interface DimensionScores {
  technical: number;
  lighting: number;
  composition: number;
  aesthetic: number;
}

export function computeCombinedScore(
  scores: DimensionScores,
  dimensionWeights: Record<string, number>,
): number {
  const w = dimensionWeights;
  return (
    scores.technical * (w.technical ?? 0.25) +
    scores.lighting * (w.lighting ?? 0.30) +
    scores.composition * (w.composition ?? 0.25) +
    scores.aesthetic * (w.aesthetic ?? 0.20)
  );
}
```

Pass 1 reads the active tier config once per round (cached for the duration of the round's classifications), computes `combined_score` per row using `tierConfig.dimension_weights`, and writes the result. The `signal_weights` JSON is also pinned into the round's audit JSON (W7.4 mirror) so the combined score is reproducible from row data alone.

When `signal_weights` becomes meaningful (W11 lands per-signal scores), the formula extends:

```typescript
// Forward-compat shape (post-W11):
combined_score = sum(
  per_signal_scores[signal_key] * signal_weights[signal_key]
) / sum(signal_weights values)
```

For W8 (pre-W11), the signal weights are stored but not yet read by the rollup — they ride along in the config as forward-compat scaffolding. The pre-W11 rollup uses dimension_weights only.

#### Pass 2: tier_config informs the prompt

Pass 2's Stream B anchor still comes from `shortlisting_tiers.score_anchor` (W7.7 unchanged). Wave 8 adds: the tier_config's `dimension_weights` are injected into the Pass 2 prompt as context. The model should know "this tier weights aesthetic at 0.35 vs 0.20 on Tier S" because it informs how the model phrases its acceptance/rejection reasoning when scores are close to the anchor.

Concretely, the Pass 2 prompt block (per W7.6 composable blocks) gains a new opt-in line:

```
TIER WEIGHTING CONTEXT
This round runs under Tier {tier_code} version {tier_config_version}.
The dimension priorities for this tier are:
  technical:    {technical_weight}
  lighting:     {lighting_weight}
  composition:  {composition_weight}
  aesthetic:    {aesthetic_weight}
When two compositions are scored close to the Tier {tier_code} anchor of
{score_anchor}, prefer the one whose strengths align with the higher-weighted
dimensions for this tier.
```

The orchestrator self-resolves: this context block is **opt-in** (gated by an `engine_settings` flag `pass2_tier_weighting_context_enabled`, default `true`). If A/B testing reveals the context confuses the model, admin flips it off without a code deploy. The block lives in `supabase/functions/_shared/visionPrompts/blocks/tierWeightingContext.ts` per W7.6's pattern.

#### Block-version interaction

Bumping a tier_config dimension/signal weight is **NOT** a prompt-block-text change — it's a runtime config consumed by post-processing (Pass 1 rollup) and as numerical context in Pass 2 (no new sentences in the prompt body). So `composition_classifications.prompt_block_versions` (W7.6) does NOT change when a tier_config version bumps.

This is correct: prompt blocks version bumps when their text changes (re-extraction needs to know the model saw different prompt wording). Tier-config version bumps when their numbers change (re-extraction needs to know the rollup used different weights). They're orthogonal axes; the round captures both: `prompt_block_versions JSONB` (W7.6) + `tier_config_version INT` (W8.4).

Re-simulation §5 below uses both pins: it replays a round's Pass 2 against a draft tier_config while keeping the prompt_block_versions fixed at whatever the original round used.

### Section 5 — Re-simulation safeguard (W8.3)

The flow:

1. Admin opens `Settings → Engine → Tier Configs`, picks a tier, clicks "Edit draft".
2. Modal opens with current weights pre-loaded as form values. Admin edits sliders / numeric inputs. Note field captures rationale.
3. Admin clicks **"Save draft"** — POSTs to `update-tier-config` edge fn, which inserts a new row with `is_active=FALSE`, the next `version` value, the draft weights, the rationale. Returns the draft row.
4. Admin clicks **"Preview impact"** — POSTs to `simulate-tier-config` edge fn with the draft row id. The simulator:
   - SELECTs the last 30 rounds of `status='locked' AND engine_tier_id = <draft tier>`, ORDER BY `locked_at DESC`.
   - For each round, joins to its `composition_classifications` rows (which carry the per-row `technical/lighting/composition/aesthetic` scores from Pass 1).
   - Recomputes each row's `combined_score` under the **draft** dimension_weights.
   - Re-runs the slot-assignment logic (the same logic Pass 2 uses, ported to a pure function in `_shared/slotAssignment.ts` so it's testable headless without the LLM round-trip): for each slot, pick the highest-scoring eligible composition. Hard reject thresholds applied per-row using the draft `hard_reject_thresholds` (or the global if NULL).
   - Compares the new slot assignments against the round's locked `confirmed_shortlist_group_ids`.
5. Simulator returns a per-round diff:
   ```typescript
   interface SimulationDiff {
     round_id: string;
     project_address: string | null;
     locked_at: string;
     diffs: Array<{
       slot_id: string;
       winner_old_group_id: string | null;        // what was actually shortlisted
       winner_new_group_id: string | null;        // what the draft would shortlist
       winner_old_combined_score: number | null;
       winner_new_combined_score: number | null;
       changed: boolean;                          // true when winner_old !== winner_new
     }>;
     unchanged_count: number;
     changed_count: number;
   }
   ```
6. Admin reviews the diff in a side-by-side UI. Each changed slot shows old-vs-new thumbnails (via dropbox proxy URLs from `composition_groups.dropbox_preview_path`) + the score deltas. Admin can:
   - **Confirm activation** → POSTs to `update-tier-config` with `{action: 'activate', draft_id: ...}`. The edge fn opens a transaction: flip the current active row to `is_active=FALSE, deactivated_at=NOW()`; flip the draft to `is_active=TRUE, activated_at=NOW()`. Commit.
   - **Discard draft** → DELETE the draft row.
   - **Edit further** → reopen modal, save another draft (which inserts another row at the next version; old draft can be discarded explicitly or left in place — `is_active=FALSE` rows are safe to keep around for audit).

**Why 30 rounds?** Recommended in Q3 below. Enough signal to reveal systematic behaviour shifts; few enough to fit in a single edge-fn timeout (rough cost: 30 rounds × ~10 compositions × pure-function rollup = sub-second; the slot-assignment loop dominates and is still well under 5s on a warm DB).

**Why pure-function slot-assignment in `_shared/`?** Re-simulation must be fast and deterministic — no LLM round-trip, no Pass 2 re-call. The slot-assignment logic Pass 2 uses (eligibility check → score-rank → top-k selection per slot) is structurally pure; pulling it into `_shared/slotAssignment.ts` lets re-simulation reuse the exact code path without involving Sonnet. Pass 2 itself continues to call the LLM for decision narration; the slot-assignment math is pure side-effect-free TypeScript and is testable independently.

**Cost guard:** simulation reads existing data (no LLM calls) → no API spend. The only cost is edge-fn compute time, capped by the 30-round limit.

**Concurrency safety:** if two admins click "Save draft" concurrently, both inserts succeed (different version numbers via `MAX(version) + 1` computed in the edge fn under a `FOR UPDATE` lock on the active row, which serialises). If two admins click "Confirm activation" concurrently, the partial unique index `idx_tier_configs_one_active_per_tier` enforces atomicity: the second transaction fails with a unique-violation, the UI catches the error and shows "Another admin just activated; refresh to see latest". See R7 below for the orchestrator's resolution.

### Section 6 — Admin UI (`Settings → Engine → Tier Configs`)

Master_admin only (PermissionGuard). Page layout:

```
┌────────────────────────────────────────────────────────────────────────┐
│ Tier Configs                                                           │
│                                                                        │
│ ┌──────────────────────────────────────────────────────────────────┐   │
│ │ Tier S — Standard (anchor 5)              Active version: 1     │   │
│ │                                                                  │   │
│ │ Dimension weights:                                              │   │
│ │   Technical:    0.25   ──●──────────                            │   │
│ │   Lighting:     0.30   ────●────────                            │   │
│ │   Composition:  0.25   ──●──────────                            │   │
│ │   Aesthetic:    0.20   ●────────────                            │   │
│ │                                                                  │   │
│ │ Signal weights (22 signals × table):                            │   │
│ │   vertical_line_convergence:  1.0   [────●────]                 │   │
│ │   window_blowout_area:        1.0   [────●────]                 │   │
│ │   ... 20 more rows ...                                          │   │
│ │                                                                  │   │
│ │ Hard reject thresholds:  using global (technical:4.0, lighting:4.0) │
│ │ [Override per-tier]                                             │   │
│ │                                                                  │   │
│ │ [Edit draft]   [View history]                                   │   │
│ └──────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│ ... Tier P card ...                                                    │
│ ... Tier A card ...                                                    │
└────────────────────────────────────────────────────────────────────────┘
```

**"Edit draft"** opens a modal:
- Pre-fills with current active values
- Sliders/numeric inputs for the four dimensions (with a live "sum" indicator that turns red if not 1.0)
- Numeric input grid for the 22 signals (rows = signal_key, columns = weight)
- Optional override for hard_reject_thresholds (toggle "Use global" ↔ "Override")
- Notes textarea (required — must explain the change)
- Buttons: **[Save draft]** **[Cancel]**

**"View history"** opens a sidebar:
- Lists all versions for the tier in DESC order
- Each row: version, activated_at, deactivated_at, created_by name, notes (truncated), [Diff vs current] action
- Click a version → modal showing the full weight breakdown + diff vs current

**After "Save draft":** the page renders an inline draft preview box under the tier card:
```
Draft v2 (created 12 minutes ago by Joseph)
  Dimension weights: technical 0.20 (-0.05), aesthetic 0.30 (+0.10) ...
  Notes: "Mosman calibration: lifestyle shots underperformed."
  [Preview impact]   [Activate]   [Discard]
```

**[Preview impact]** triggers the `simulate-tier-config` call (§5). On completion, opens a full-page diff view:
```
Re-simulation diff — Tier S draft v2 vs active v1
Rounds replayed: 30 (from 2026-04-01 to 2026-04-25)
Total slots: 287
Unchanged: 261 (91%)   Changed: 26 (9%)

[Filter: Changed only ▼]   [Sort: Slot ↓ ▼]

┌─────────────────────────────────────────────────────────────────────┐
│ Round: 12 Smith St Mosman (locked 2026-04-15)                       │
│ Slot kitchen_main:                                                  │
│   ▶ Old winner: kitchen_overall_03.cr3 (combined 7.4)               │
│   ▶ New winner: kitchen_island_02.cr3 (combined 7.6)  Δ +0.2        │
│   [thumb old]  [thumb new]                                          │
└─────────────────────────────────────────────────────────────────────┘
... 25 more changed slots ...

[Activate this draft]   [Discard]   [Edit further]
```

**[Activate this draft]** triggers the activation transaction (§5 step 6). On success: page refreshes, new version is now active, banner "Tier S v2 activated 2 seconds ago".

**Permission gating:** only `master_admin` can activate; `admin` can save drafts and run simulations but the activate button is hidden for them. This protects against well-meaning admins shipping live changes without master sign-off.

### Section 7 — Edge functions

Three new edge fns:

#### `update-tier-config`

POST `{ action: 'save_draft' | 'activate' | 'discard', tier_id, draft?, draft_id? }`.

- `save_draft`: validates dimension_weights sum to 1.0 (within 0.001 tolerance), validates signal_weights keys match active `shortlisting_signal_weights`, validates `hard_reject_thresholds` shape (when provided), resolves next `version` via `SELECT MAX(version)+1 FROM shortlisting_tier_configs WHERE tier_id = $1`, INSERTs new row with `is_active=FALSE`, returns row.
- `activate`: opens transaction, validates the draft exists + `is_active=FALSE`, UPDATE `is_active=FALSE, deactivated_at=NOW()` on currently-active row, UPDATE `is_active=TRUE, activated_at=NOW()` on draft, COMMITs. Returns updated row. Catches unique-violation from concurrent activation: returns 409 with detail "Another admin activated; refresh".
- `discard`: DELETEs the draft (only allowed when `is_active=FALSE`).

Auth: master_admin for `activate`; master_admin OR admin for `save_draft` / `discard`.

#### `simulate-tier-config`

POST `{ draft_id }`.

- SELECTs last 30 locked rounds for the draft's tier (per §5).
- For each round, runs the pure-function slot-assignment with the draft's weights.
- Returns the diff structure (§5 step 5).
- No DB writes (pure read-only).
- Cost: zero (no LLM); compute capped by edge-fn timeout. 30-round limit fits inside 30s timeout comfortably.

Auth: master_admin OR admin.

#### `pin-engine-version-and-tier-config` (helper, called by `shortlisting-ingest`)

Internal helper — not directly called by the UI. Wrapped into the existing `shortlisting-ingest` flow per §3. Reads `_shared/engineVersion.ts` for `engine_version`, reads the active tier_config row for `tier_config_version`, writes both to `shortlisting_rounds`. Emits a `shortlisting_events` warning if no active tier_config row exists for the round's tier.

### Section 8 — Backwards compatibility

Existing locked rounds (pre-W8) have:
- `engine_version = NULL`
- `tier_config_version = NULL`
- Pass 1 rolled up `combined_score` as a uniform mean

These rows stay valid; the columns being NULL is correct (the round predates the column). Re-simulation (§5) excludes rounds with NULL `tier_config_version` — they can't be replayed because there's no recorded weight set to compare against. The orchestrator self-resolves: the simulator's SELECT filter is `WHERE engine_tier_id = $1 AND tier_config_version IS NOT NULL`. Old rounds are excluded silently.

For the analytics ("which engine version produced this benchmark match rate?"), the join is left-join: rounds with NULL `engine_version` show as "pre-W8 engine" in the UI.

### Section 9 — Audit JSON (W7.4 mirror)

The audit JSON written to `Photos/_AUDIT/round_N_locked_<ts>.json` (W7.4) gains two new top-level keys:

```jsonc
{
  "round_id": "...",
  "engine_version": "wave-8-p1",                  // NEW
  "tier_config": {                                 // NEW
    "tier_code": "P",
    "version": 3,
    "dimension_weights": {"technical":0.20, "lighting":0.30, "composition":0.25, "aesthetic":0.25},
    "signal_weights": {...},
    "hard_reject_thresholds": null
  },
  // ... rest of W7.4 audit JSON unchanged
}
```

Read by external auditors + future ML re-extraction without DB access.

---

## Migration `344_shortlisting_tier_configs.sql`

Migration sequence (after W7.7=339, W10.1=340, W10.3=341, W13a=342, W13b=343):

```sql
-- Wave 8 P1-7+P1-15+P1-17 (W8): tier-config versioning, round-level provenance,
-- per-tier weights + hard-reject overrides.

-- 1. shortlisting_tier_configs ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shortlisting_tier_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_id UUID NOT NULL REFERENCES shortlisting_tiers(id),
  version INT NOT NULL,
  dimension_weights JSONB NOT NULL,
  signal_weights JSONB NOT NULL,
  hard_reject_thresholds JSONB,
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
  'Wave 8 (P1-7): per-tier versioned weight bundle. Exactly one row per tier_id has is_active=TRUE at any time (enforced by partial unique index). Activation flips old=FALSE + new=TRUE atomically. Old versions retained for replay/audit.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_tier_configs_one_active_per_tier
  ON shortlisting_tier_configs(tier_id) WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_tier_configs_active
  ON shortlisting_tier_configs(tier_id, is_active) WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_tier_configs_tier_version
  ON shortlisting_tier_configs(tier_id, version);

-- 2. v1 seed: one row per active tier ──────────────────────────────────────
INSERT INTO shortlisting_tier_configs (tier_id, version, dimension_weights, signal_weights, hard_reject_thresholds, is_active, activated_at, notes)
SELECT
  t.id,
  1,
  '{"technical":0.25,"lighting":0.30,"composition":0.25,"aesthetic":0.20}'::jsonb,
  COALESCE(
    (SELECT jsonb_object_agg(signal_key, 1.0)
       FROM shortlisting_signal_weights
       WHERE is_active = TRUE),
    '{}'::jsonb
  ),
  NULL,
  TRUE,
  NOW(),
  'v1 seed — uniform signal weights, lighting-biased dimensions. Tune via Settings → Engine → Tier Configs after Wave 14 calibration.'
FROM shortlisting_tiers t
WHERE t.is_active = TRUE
ON CONFLICT (tier_id, version) DO NOTHING;

-- 3. shortlisting_rounds — engine_version + tier_config_version ────────────
ALTER TABLE shortlisting_rounds
  ADD COLUMN IF NOT EXISTS engine_version TEXT,
  ADD COLUMN IF NOT EXISTS tier_config_version INT;

COMMENT ON COLUMN shortlisting_rounds.engine_version IS
  'Wave 8 (W8.4): engine code version stamp at ingest. e.g. wave-8-p1. Bumped per wave-completion commit. Rounds run pre-W8 leave NULL.';
COMMENT ON COLUMN shortlisting_rounds.tier_config_version IS
  'Wave 8 (W8.4): which version of shortlisting_tier_configs was active for the round''s engine_tier_id at ingest. NULL on rounds run pre-W8 or when no active config existed (engine fallback).';

CREATE INDEX IF NOT EXISTS idx_rounds_tier_config_version
  ON shortlisting_rounds(engine_tier_id, tier_config_version)
  WHERE tier_config_version IS NOT NULL;

-- 4. RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE shortlisting_tier_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY tier_configs_select_all ON shortlisting_tier_configs
  FOR SELECT TO authenticated USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
  );

CREATE POLICY tier_configs_insert_admin ON shortlisting_tier_configs
  FOR INSERT TO authenticated WITH CHECK (
    get_user_role() IN ('master_admin','admin')
  );

CREATE POLICY tier_configs_update_admin ON shortlisting_tier_configs
  FOR UPDATE TO authenticated USING (
    get_user_role() IN ('master_admin','admin')
  );

CREATE POLICY tier_configs_delete_master ON shortlisting_tier_configs
  FOR DELETE TO authenticated USING (
    get_user_role() = 'master_admin'
  );

NOTIFY pgrst, 'reload schema';

-- ── Rollback (manual; only if migration breaks production) ────────────────
--
-- ALTER TABLE shortlisting_rounds DROP COLUMN IF EXISTS tier_config_version;
-- ALTER TABLE shortlisting_rounds DROP COLUMN IF EXISTS engine_version;
-- DROP TABLE IF EXISTS shortlisting_tier_configs;
--
-- The combined_score formula reverts to the uniform mean automatically once
-- the tier-config read is removed from Pass 1 (revert the _shared/scoreRollup.ts
-- changes; combined_score recomputes per-row from the 4 dim scores).
```

---

## Engine integration

1. **`shortlisting-ingest`** — reads active tier_config + `_shared/engineVersion.ts`, writes `engine_version` + `tier_config_version` to the round (per §3).

2. **`shortlisting-pass1`** — reads `tier_config.dimension_weights` once per round (cached), passes to `computeCombinedScore` for each composition row's combined_score.

3. **`shortlisting-pass2`** — reads `tier_config` for the round's tier, injects the dimension_weights summary into the prompt as the new `tierWeightingContext` block (W7.6 composable). Block-version pinned per W7.6's existing mechanism.

4. **`update-tier-config`** (new) — admin endpoint for save_draft / activate / discard.

5. **`simulate-tier-config`** (new) — admin endpoint for dry-run replay over last 30 locked rounds.

6. **`shortlisting-benchmark-runner`** — already records `engine_version` in `shortlisting_benchmark_results` (mig 295); now extends to also capture `tier_config_version` per benchmarked round in the per-round payload. Existing column is a single TEXT; the new value-per-round is added to the JSONB `model_versions` field as `{tier_config_versions: {round_id: version}}`. No schema change.

7. **`_shared/scoreRollup.ts`** (new) — pure function `computeCombinedScore`.

8. **`_shared/slotAssignment.ts`** (new) — pure function for slot-assignment math, lifted out of Pass 2 so re-simulation can call it without an LLM.

9. **`_shared/tierConfig.ts`** (new) — `getActiveTierConfig(tierId)` helper with a per-invocation cache.

10. **`_shared/engineVersion.ts`** (new) — single export `ENGINE_VERSION = 'wave-8-p1'` (bumped per wave). Imported by ingest + benchmark-runner.

---

## Frontend impact

1. **`Settings → Engine → Tier Configs`** (new) — master_admin/admin page per §6. New file `flexmedia-src/src/pages/SettingsEngineTierConfigs.jsx` with sub-components `TierCard`, `EditDraftModal`, `ImpactDiffPanel`, `HistorySidebar`.

2. **Round status footer** — extend the existing `ShortlistingRoundStatus` component (find via grep) to render the new `engine_version` + `tier_config_version` provenance footer.

3. **Calibration page** (`pages/ShortlistingCalibration.jsx`) — extend to surface per-result `tier_config_version` in the per-package breakdown table (forward-compat with `engine_version` already shown).

4. **Permission policy** — `master_admin` can save draft + activate + discard; `admin` can save draft + simulate but the activate button is hidden client-side and rejected server-side.

---

## Tests

- `_shared/scoreRollup.test.ts` — pure-function tests for the weighted rollup. Cover: balanced weights → matches uniform mean; lopsided weights → matches manual calculation; missing dim key → falls back to default weight.
- `_shared/slotAssignment.test.ts` — pure-function tests for slot-assignment math. Cover: top-k selection respects eligibility; hard-reject filters out below-threshold rows; tie-breaking by group_index when scores are equal.
- `_shared/tierConfig.test.ts` — `getActiveTierConfig` cache hit/miss + fallback when no active row.
- `update-tier-config` integration test — save_draft → activate → verify only one is_active row remains; concurrent activate triggers unique-violation.
- `simulate-tier-config` integration test — diff structure shape matches contract; rounds without tier_config_version excluded; cost is zero (no LLM mock invocations).
- Pass 1 snapshot test — combined_score under v1 default weights matches the pre-W8 uniform mean (regression guard for backfill rows).
- Pass 2 snapshot test — `tierWeightingContext` block renders correctly when enabled, omitted when disabled.
- Migration test — v1 seed creates 3 rows (S/P/A) all `is_active=TRUE`; partial unique index rejects a second `is_active=TRUE` row for the same tier.

---

## Open questions for sign-off

**Q1.** Default dimension weights at v1?
**Recommendation:** `0.25 / 0.30 / 0.25 / 0.20` (technical / lighting / composition / aesthetic) — lighting-biased per L9 lesson ("lighting drives perceived quality more than any other dimension"). Identical for all three tiers at v1; tier-specific tuning happens via the admin UI after first benchmark / Wave 14 calibration. Joseph's call on whether to bias differently — e.g. Tier A could lean more aesthetic.

**Q2.** Default signal weights at v1?
**Recommendation:** `1.0` uniform across all 22 signals seeded by mig 291. Wave 14's calibration session refines per-signal post-launch. Uniform v1 means combined_score under v1 dimension_weights equals the pre-W8 uniform mean (regression-safe).

**Q3.** Re-simulation count — last 30 rounds?
**Recommendation:** 30. Reasonable signal (any systematic shift surfaces in 9% changed slots — 26 rows in the example diff), fits inside a single edge-fn timeout (sub-5s on warm DB), and matches the order of magnitude of FlexMedia's monthly volume so admin sees recent context. 50 would cost ~70% more compute for marginal additional signal; 10 misses systematic patterns. Joseph picks if 30 doesn't feel right.

**Q4.** Activation race protection — when two admins click activate concurrently, which wins?
**Recommendation:** optimistic concurrency via the `idx_tier_configs_one_active_per_tier` partial unique index. Whichever transaction commits first wins; the other gets a unique-violation, which the `update-tier-config` edge fn catches and returns 409 with body `{error: 'concurrent_activation', detail: 'Another admin just activated; refresh to see the latest config'}`. The UI catches the 409, surfaces a toast, refetches the active config. No explicit row-level lock needed — the index does the work. See R7 below for trade-off vs alternatives.

---

## Resolutions self-resolved by orchestrator

**R1 — versioning lives in-table, not in a separate history table.**
The partial unique index enforces "exactly one active row per tier" at the database level — no application logic risks two-active drift. Querying historical configs is `SELECT * WHERE tier_id = $1 AND version = $2`, a primary-index hit. A separate `_history` table would split the source of truth and require manual snapshot logic on every save (more places for bugs). Single-table versioning is the standard pattern for config-with-audit (mig 286's existing `shortlisting_signal_weights.is_active + version` columns follow the same shape).

**R2 — `dimension_weights` JSONB validated at save-time, not via DB CHECK.**
A CHECK constraint enforcing "values sum to 1.0" is fragile: floating-point arithmetic in Postgres + JSONB extraction is awkward. The save handler in `update-tier-config` validates with a 0.001 tolerance and returns 400 with detail before INSERT. Same pattern as `shortlisting_signal_weights` (mig 286 doesn't enforce sum either; admin UI checks).

**R3 — `engine_tier_id` is sufficient, no `tier_used` denormalisation.**
The original spec called for a `tier_used UUID REFERENCES shortlisting_tiers(id)` column. W7.7 already added `engine_tier_id UUID REFERENCES shortlisting_tiers(id)`. Adding a second column with the same data risks drift (which one is canonical when they disagree?). The W7.7 column is canonical; analytics queries needing the tier_code join one hop to `shortlisting_tiers`. No new column needed.

**R4 — `engine_version` is wave-stamped, not git-SHA-pulled.**
Vercel + Supabase deploy on different commits at different times; pulling git SHA produces inconsistent stamps that don't map to coherent engine behaviour. A wave-stamped string ("wave-8-p1") matches what the analytics need ("rounds run under the Wave 8 engine") and is a single point of truth in `_shared/engineVersion.ts`. Bumped manually per wave-completion commit (one-line edit).

**R5 — Pass 1 rollup, not Pass 2 rollup.**
The combined_score is written by Pass 1 to `composition_classifications.combined_score`. Pass 2 reads that value. So the weight rollup happens at Pass 1 time, not Pass 2. This means a tier-config change does NOT retroactively re-score historical compositions — old rounds keep the score that was current when they ran. Correct: re-extracting historical rounds under new weights is what re-simulation (§5) is for; live data stays pinned to its run-time config.

**R6 — Re-simulation is pure-function, no LLM in the replay loop.**
Pulling slot-assignment into `_shared/slotAssignment.ts` (a pure function) means re-simulation costs zero in API spend and runs fast enough to fit in one edge-fn invocation. Pass 2's LLM role is to generate the decision narrative ("why this slot picked this composition") — that's not what re-simulation needs. Re-simulation needs the math: which composition would have won the slot under the new weights. Pure function, fast, deterministic, no Sonnet bill.

**R7 — Activation race uses optimistic concurrency, not row-level lock.**
A pessimistic lock (`SELECT ... FOR UPDATE` on the active row before the activation transaction) would serialise activations cleanly but pays a cost: long-held locks block reads on the active config (Pass 1 / Pass 2 both read it). The partial unique index `idx_tier_configs_one_active_per_tier` enforces correctness without holding locks — concurrent winners get a clean unique-violation. The UI catches the 409 and shows a refresh message; admins rarely activate concurrently anyway (it's a rare action), so the lossy retry path is fine.

**R8 — `signal_weights` shipped at v1 even though Pass 1 doesn't read them yet.**
Forward-compat scaffolding. When W11 lands per-signal scoring, the rollup formula extends to include signal_weights. Storing them at v1 means W11's rollout doesn't need a schema change; the engine just starts reading what's already there. Until W11 lands they're dead-weight-but-cheap (a JSONB blob of 22 keys × number).

**R9 — `prompt_block_versions` (W7.6) and `tier_config_version` (W8.4) are orthogonal.**
Bumping a prompt block bumps `prompt_block_versions` (W7.6) — the model saw different prompt text. Bumping a tier_config bumps `tier_config_version` (W8.4) — the rollup used different numbers. They're independent axes. A round captures both pins so any historical re-extraction can fully reproduce what the engine saw + computed.

**R10 — Tier-weighting context block in Pass 2 prompt is opt-in via `engine_settings`.**
Adding text to the Pass 2 prompt risks confusing the model. Gating the new `tierWeightingContext` block behind an `engine_settings.pass2_tier_weighting_context_enabled` boolean means admin can A/B-test it: turn off for a week, observe match rate, turn on, compare. Default `true` (we believe context helps); admin can flip off without a deploy if it doesn't.

**R11 — Backfill rounds (W13a) inherit `engine_version='wave-13a-backfill'`.**
W13a synthetic rounds are created post-W8; they read the active tier_config + write `tier_config_version` like live rounds do. But their `engine_version` is stamped `'wave-13a-backfill'` (per the orchestrator's wave-stamp policy from R4) so analytics can distinguish synthetic from live runs without joining additional columns. Live Wave 8 rounds stamp `'wave-8-p1'`.

---

## Effort estimate

- Migration + v1 seed + RLS: 1 hour
- `_shared/tierConfig.ts` + `_shared/scoreRollup.ts` + `_shared/slotAssignment.ts` (pure functions + tests): half-day
- Pass 1 integration (read tier_config, weighted rollup): 2 hours
- Pass 2 integration (tierWeightingContext block, gated by engine_settings flag): 2 hours
- `update-tier-config` edge fn (save / activate / discard): 1 day
- `simulate-tier-config` edge fn (read 30 rounds, run pure-function replay, return diff): 1 day
- Admin UI page (TierCard + EditDraftModal + ImpactDiffPanel + HistorySidebar): 2 days
- Audit JSON extension (W7.4 mirror gains tier_config block): 1 hour
- Round status footer + Calibration page integration: 2 hours
- Engine-version constant + ingest pin: 1 hour
- Snapshot test updates + new pure-function tests: half-day
- End-to-end smoke test on a real round (small holdout): half-day

**Total: ~6-7 engineering days.** Largest uncertainty is the admin UI's diff view — if Joseph wants thumbnail comparisons inline (not just IDs) that's another half-day for the dropbox-proxy lookup pattern. Recommend ship without thumbnails on v1; add them in a follow-up burst if admins ask.

---

## Out of scope (handled in other waves)

- Per-signal scoring rollout (replaces dimension_weights with full signal_weights formula) — W11.5.
- Tier-A-only signal weights ("only Tier A cares about `wine_cellar_present`") — emergent from Wave 14 calibration, applied via the W8 admin UI when the data calls for it. No new schema needed.
- Auto-tuning of weights from training-example deltas (active learning) — Wave 16+ if/when it's prioritised; W8 ships the manual surface only.
- Cross-tier comparative analytics ("which tier_config produced the best benchmark match rate?") — extension of the Calibration page; out of scope for W8 execution but the data model supports it.
- Tier-config draft expiration ("auto-discard drafts older than 14 days") — defer to admin behaviour observation; if drafts pile up, add a cron later.

---

## Pre-execution checklist

- [ ] W7.7 ✅ shipped (`shortlisting_tiers`, `package_engine_tier_mapping`, `engine_settings`, `engine_tier_id` on rounds)
- [ ] W7.6 ✅ shipped (composable prompt blocks; new `tierWeightingContext` block follows the pattern)
- [ ] Joseph signs off on Q1 (default dimension weights), Q2 (uniform v1 signal weights), Q3 (30-round re-simulation), Q4 (optimistic concurrency)
- [ ] Migration number reserved at integration time (recommend 344 — chained after W7.7=339, W10.1=340, W10.3=341, W13a=342, W13b=343)
- [ ] `_shared/engineVersion.ts` constant scaffolding committed before the migration so the ingest write doesn't fail on first run
- [ ] Pass 1 snapshot test updated to capture the rollup-uses-weights regression guard (combined_score under v1 weights MUST equal pre-W8 uniform mean for backfill safety)
- [ ] Pass 2 snapshot test updated for the new context block (gated; both with and without flag)
- [ ] Admin UI access path: `Settings → Engine → Tier Configs` — confirm with Joseph this is the right IA (alternative: parallel to `Settings → Engine → Tier Mapping` from W7.7 admin)
- [ ] Activation 409 handling smoke-tested with two browser sessions saving + activating concurrently
- [ ] One end-to-end run on a holdout round confirms `engine_version` + `tier_config_version` written; combined_score values match expected weighted rollup
