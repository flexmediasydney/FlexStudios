# W14 — 50-Project Structured Calibration Session — Design Spec

**Status:** ⚙️ Ready to dispatch (pending Joseph sign-off on Q1-Q3 below).
**Backlog ref:** P2-5.
**Wave plan ref:** Wave 14 — establish the permanent benchmark set + name override patterns. Subsumes W14.1-W14.5 from `docs/WAVE_PLAN.md`.
**Dependencies:**
- **W7.7 ✅ shipped** — round-level `engine_tier_id`, `expected_count_target`, `package_engine_tier_mapping` are read by the calibration UI to render package + tier context per project.
- **W8 must land first** — `tier_config_version` on rounds + `engine_version` provenance lets a calibration session capture "AI ran under config v3 of Tier P", which is the right granularity for downstream re-extraction. Without W8, calibration disagreements have no run-time pin and are harder to reproduce.
- **W11 should land first (not strictly blocking)** — universal vision response gives per-signal scores. Calibration disagreements are richer when the editor can see "AI scored vertical_line_convergence at 6.2 here", but pre-W11 we ship with the 4-dim aggregates and the analysis paragraph (which is enough for the session's primary output: ranked editor decisions vs ranked AI decisions).
- **W12 must land first** — W14.5 (the suggestion-engine validation step) cross-references editor disagreements against `pass2_slot_suggestion` events + `object_registry.market_frequency`. Pre-W12 the validation step degrades to "spot-check the disagreement reasons" which is fine for v1 but loses the institutional-memory feedback loop.

**Unblocks:**
- **Tier 8 weight tuning closure** — the calibration session produces the data Joseph needs to confidently set per-tier dimension weights via the W8 admin UI (replacing the v1 default uniform weights with empirically-derived ones).
- **Wave 11 prompt few-shot library** — disagreements with strong editor reasoning become canonical training_examples that future Pass 1/2 prompts inject as ground-truth examples.
- **Wave 16+ active learning** — the disagreement corpus is the supervised signal for any future auto-tuning of weights from editor feedback.

---

## Problem

Today the engine has two ways to learn:

1. **`shortlisting_overrides`** captures per-composition disagreements when an editor swaps a shot in/out of the shortlist via the UI. These are atomic, but they're noisy: an override might be a small correction ("AI picked the kitchen with the dirty tea towel; I picked the next kitchen") OR a fundamental disagreement about quality bar ("AI picked a Tier S quality kitchen; this is a Tier P shoot, the model's anchor is wrong"). The override row carries `primary_signal_overridden` but no broader narrative.

2. **`shortlisting_benchmark_results`** runs Pass 2 in blind mode against the holdout set's `confirmed_shortlist_group_ids` and reports a match rate. It tells us "the engine matches the human shortlist 88% of the time across 50 holdout rounds" but it doesn't tell us **why** it disagrees the other 12% of the time. The match rate is a leading indicator without diagnostic power.

The gap: there is no structured surface for an editor to **declare** ground truth alongside the AI's choices, with the side-by-side framing that exposes the *reason* for each disagreement. Without that data, Joseph can't tune Wave 8's tier_config weights with confidence — he's guessing at the right `aesthetic` weight for Tier P based on intuition rather than measured editor preference.

The Wave 14 calibration session closes this. The flow:

1. Engine selects 50 stratified projects (a balanced mix across package × tier × geography cells).
2. The editor opens the calibration UI and, **without seeing the AI's output**, manually declares "I would shortlist these stems for this project". (Blind editor input.)
3. Engine runs the benchmark-runner over the same 50 projects in parallel.
4. UI renders side-by-side per project: editor's set, AI's set, overlap, disagreements.
5. For every disagreement (slot the editor picked differently from the AI), the editor types a one-sentence reason: which signal matters here, what the AI missed.
6. Each disagreement row lands in `calibration_decisions` with editor reasoning + AI score + AI's reasoning + the resolved primary_signal_diff.

The output is a corpus of ~250-500 rows of structured editor-vs-AI disagreement (50 projects × ~5-10 disagreements each). This is the calibration set that:
- Tunes Wave 8's tier_config weights (admin sees "for Tier P kitchens, editors consistently prefer compositions with higher aesthetic scores; tune dimension_weights.aesthetic from 0.20 to 0.30")
- Validates Wave 12's AI suggestion engine (W14.5: do editor disagreements correlate with `pass2_slot_suggestion` events?)
- Becomes few-shot examples for future Pass 1/2 prompt versions

**This is a one-time, high-investment session** (~25 hours of editor labour per Q1) that produces the foundational measurement set the engine has been working toward.

---

## Architecture

### Section 1 — Stratification: 50 projects across (package × tier × geography) cells

The 50-project sample is the most consequential design decision in the wave. A bad stratification (all Mosman Gold-Premium, say) produces a calibration set that's tuned for one cell and useless for the others. The engine self-resolves on the cell distribution per Q2 below; admin reviews at session-start.

**Cell matrix (recommended distribution):**

| Cell | Count | Notes |
|---|---|---|
| Gold Standard (Tier S) | 15 | The bulk of FlexMedia's volume; primary tuning target |
| Gold Premium (Tier P) | 10 | High-touch tier; calibration here drives most of Wave 8's tier_config tuning |
| Silver Standard (Tier S) | 5 | Smaller tier; needs representation |
| Silver Premium (Tier P) | 3 | Edge cell; small sample but needed |
| Flex (Tier A) | 5 | Top tier; rare projects, but high-value calibration targets |
| AI Package (Tier S) | 5 | Cheap-path tier; should the engine apply different floor? Calibration tells |
| Day Video Standard (Tier S) | 3 | Mixed-deliverable; photo extraction calibration only |
| Dusk Video Premium (Tier A) | 2 | Edge cell + Dusk-specific calibration |
| Total | **48** | + 2 wildcard slots Joseph picks |

**Wildcard slots** let Joseph hand-pick 2 projects he specifically wants in the set (e.g. a Mosman waterfront with unusual architecture; a recent customer who left detailed feedback worth calibrating against). Reserved for Joseph's judgement; the engine's stratification covers the rest.

**Geographic distribution within cells:** within each cell, the engine picks projects spanning at least 3 distinct suburb postcodes when available, weighted toward higher-volume areas (Mosman, North Shore, Eastern Suburbs). This prevents the calibration set from being all-Mosman by accident.

**Selection method:** the engine's stratification edge fn (per §5) does:
```
For each cell:
  SELECT projects WHERE
    package_id = ? AND
    pricing_tier = ? AND
    has_completed_round AND               -- so we have ground-truth data to compare
    NOT used_in_calibration_session_before
  ORDER BY suburb_postcode_diversity_score DESC, completed_at DESC
  LIMIT cell.count;
```

Already-used projects (from a prior calibration session) are excluded so the calibration set rotates over time. Joseph can override per-project via the admin UI (e.g. "drop project X, add project Y").

**Status pin:** selected projects get a `calibration_session_id` stamp on a new association row (per §3 schema) so they're tracked across sessions. Re-running calibration in 12 months draws from the un-stamped pool.

### Section 2 — Blind editor input

The calibration UI's first phase is **blind editor declaration**: the editor sees the project's RAW folder contents (Dropbox previews via the existing media proxy infrastructure) and declares "this is my shortlist for this project". Crucially, the AI's output is hidden during this phase to prevent anchoring bias.

UI shape:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Calibration Session 2026-04 — Project 12 of 50: 14 Smith St, Mosman    │
│ Package: Gold Premium · Tier P · 32 photos delivered                   │
│                                                                        │
│  [Hidden: AI's shortlist — locked until you submit yours]              │
│                                                                        │
│  Composition Groups in this round:                                     │
│  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐                     │
│  │ thumb│  │ thumb│  │ thumb│  │ thumb│  │ thumb│                     │
│  │  001 │  │  002 │  │  003 │  │  004 │  │  005 │                     │
│  │ kitchen│ │facade│  │living│  │bed1 │  │ bath │                     │
│  └──────┘  └──────┘  └──────┘  └──────┘  └──────┘                     │
│   [add]    [add]     [add]     [add]     [add]                        │
│   ... 200+ more thumbnails, paginated/scrolled ...                    │
│                                                                        │
│  Your shortlist (drag here, click [add] above, or paste stem list):   │
│  ┌──────┐  ┌──────┐  ┌──────┐                                          │
│  │  001 │  │  003 │  │  012 │  ...                                    │
│  │ kitch│  │living│  │bed_2 │                                          │
│  └──────┘  └──────┘  └──────┘                                          │
│                                                                        │
│  Photo count target: 32 (per package). You picked: 28.                 │
│                                                                        │
│  [Submit my shortlist]   [Skip this project]                           │
└─────────────────────────────────────────────────────────────────────────┘
```

**Editor workflow:**
1. Browse compositions (paginated grid of dropbox preview thumbnails).
2. Click [add] on each composition to add to the editor's shortlist (right panel updates).
3. Optional: leave a per-composition note ("only kitchen with the bench cleared") — captured but not shown to the AI side.
4. Click "Submit my shortlist". The UI flips to phase 2 (side-by-side diff).

**Why blind:** the calibration's value depends on the editor's choices being independent of the AI's. If the AI's output is visible during selection, the editor's brain quietly anchors to it ("the AI picked this kitchen — yeah, that one's fine"). Blind selection forces a fresh decision and produces real ground truth.

**Persistence:** the editor's shortlist is saved to a new `calibration_editor_shortlists` table (§3) immediately on submit; the session can be resumed across days. The UI stamps phase=`editor_submitted` so re-opening doesn't reset.

### Section 3 — Side-by-side diff + per-disagreement reason capture

After the editor submits, the UI fetches the AI's parallel run output (Pass 2 in benchmark mode against the same project, per §6) and renders the comparison:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Project: 14 Smith St, Mosman — Calibration diff                        │
│                                                                        │
│  Editor picked 28 stems · AI picked 30 stems · Overlap: 23             │
│  Editor-only: 5 · AI-only: 7                                           │
│                                                                        │
│  ┌──────────────────────┬─────────────────────────┬──────────────────┐ │
│  │ Slot                  │ Editor                  │ AI                │ │
│  ├──────────────────────┼─────────────────────────┼──────────────────┤ │
│  │ exterior_front_hero   │ ✓ stem_002_facade       │ ✓ stem_002_facade │ │ ← match
│  │ kitchen_main          │ ✗ stem_017_kitchen_clean │ ✓ stem_018_kitchen_overall│ ← DISAGREE
│  │   ↳ Editor reason:    │ "stem_018 has the dirty tea towel; stem_017 is the same shoot, AEB same group, cleaner" │
│  │   ↳ AI score:         │ stem_018 combined 8.4 (technical 8.5, lighting 8.7, composition 8.2, aesthetic 8.0) │
│  │   ↳ AI analysis:      │ "Strong frontal kitchen showing the island; clean composition; lighting balanced;..." │
│  │   ↳ Primary signal:   │ [Aesthetic ▼]   ← Editor selects the dimension the AI under-weighted │
│  │   ↳ Save reason       │                                            │
│  ├──────────────────────┼─────────────────────────┼──────────────────┤ │
│  │ master_bedroom_hero   │ ✓ stem_034              │ ✓ stem_034        │ │ ← match
│  │ ...                                                                  │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│  [Submit all reasons]   [Save progress]                                │
└─────────────────────────────────────────────────────────────────────────┘
```

**Per-disagreement reason capture** is the calibration's primary output. For every disagreement row:

- **Editor reasoning (free text, required):** one-sentence narrative explaining why the editor's pick is correct vs the AI's. Mandatory — without the reason, the disagreement is just noise.
- **Primary signal (dropdown, required):** which dimension/signal the AI under-weighted or got wrong. Dropdown enumerates the 4 dimensions (technical/lighting/composition/aesthetic) plus the 22 signal_keys when W11 is live (pre-W11, just the 4 dims).
- **Optional reasoning category** (multi-select chips):
  - `clutter` — AI didn't penalise visible clutter
  - `mood` — AI missed the lifestyle / aesthetic mood
  - `composition_specific` — AI scored composition higher but the angle is wrong for the slot
  - `tier_mismatch` — AI's quality bar is wrong for this tier
  - `agent_preference` — known agent preference the AI doesn't have context for
  - `other`
- **Editor's score override (optional):** if the editor would have scored the AI's pick differently, capture the score they'd have given (a learning signal for tier-config tuning).

The submit button writes one `calibration_decisions` row per disagreement.

**Match rows** (editor and AI agree on the same stem for the same slot) also persist — they're rows where `editor_decision = ai_decision`, useful for the validation analytics (you want to know what % of slots had perfect agreement, not just count disagreements).

### Section 4 — Schema (mig 346)

Three new tables: the session container, the editor's shortlist, the per-decision diff.

```sql
-- Wave 14 P2-5 (W14): structured calibration session for editor-vs-AI ground truth.

-- 1. calibration_sessions ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS calibration_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_name TEXT NOT NULL,                         -- e.g. '2026-Q2 calibration'
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'editor_phase', 'diff_phase', 'completed', 'abandoned')),
  stratification_config JSONB NOT NULL,                -- { cells: [{package_id, pricing_tier, count}, ...] }
  selected_project_ids UUID[] NOT NULL DEFAULT '{}',
  engine_version TEXT,                                 -- pinned at session start (W8.4)
  tier_config_versions JSONB,                          -- { tier_id: version } pinned at session start
  editor_user_id UUID REFERENCES auth.users(id),       -- the editor doing the calibration
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  editor_phase_completed_at TIMESTAMPTZ,
  diff_phase_completed_at TIMESTAMPTZ,
  notes TEXT,                                          -- session-level rationale / context
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE calibration_sessions IS
  'Wave 14 (W14): per-session container for the 50-project structured calibration. Status lifecycle: open → editor_phase → diff_phase → completed.';

CREATE INDEX IF NOT EXISTS idx_calibration_sessions_editor
  ON calibration_sessions(editor_user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_calibration_sessions_status
  ON calibration_sessions(status) WHERE status != 'completed';

-- 2. calibration_editor_shortlists ────────────────────────────────────────
-- One row per (session, project) capturing the editor's blind shortlist.
CREATE TABLE IF NOT EXISTS calibration_editor_shortlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  calibration_session_id UUID NOT NULL REFERENCES calibration_sessions(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  round_id UUID REFERENCES shortlisting_rounds(id),    -- the round the AI ran against in benchmark mode
  editor_picked_stems TEXT[] NOT NULL DEFAULT '{}',    -- list of delivery_reference_stems the editor selected
  editor_per_stem_notes JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {stem: "free text note"}
  status TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'submitted', 'skipped')),
  skipped_reason TEXT,                                  -- if status='skipped'
  submitted_at TIMESTAMPTZ,
  ai_run_completed_at TIMESTAMPTZ,                      -- when the parallel AI benchmark finished
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (calibration_session_id, project_id)
);

COMMENT ON TABLE calibration_editor_shortlists IS
  'Wave 14 (W14): editor''s blind shortlist per (session, project). Submitted before the editor sees the AI''s output. Pairs with calibration_decisions for the diff capture.';

CREATE INDEX IF NOT EXISTS idx_calibration_editor_shortlists_session
  ON calibration_editor_shortlists(calibration_session_id);
CREATE INDEX IF NOT EXISTS idx_calibration_editor_shortlists_project
  ON calibration_editor_shortlists(project_id);

-- 3. calibration_decisions ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS calibration_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  calibration_session_id UUID NOT NULL REFERENCES calibration_sessions(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  round_id UUID REFERENCES shortlisting_rounds(id),
  slot_id TEXT NOT NULL,                                -- e.g. 'kitchen_main'
  stem TEXT,                                            -- the stem this decision is about (NULL when slot empty in both)
  ai_decision TEXT NOT NULL
    CHECK (ai_decision IN ('shortlisted', 'rejected', 'unranked', 'no_eligible')),
  editor_decision TEXT NOT NULL
    CHECK (editor_decision IN ('shortlisted', 'rejected', 'unranked', 'no_eligible')),
  agreement TEXT NOT NULL
    CHECK (agreement IN ('match', 'disagree')),         -- denormalised; 'match' when ai==editor for this stem
  -- Decision context:
  ai_score NUMERIC(5,2),                                -- composition's combined_score per AI's run
  ai_per_dim_scores JSONB,                              -- {technical, lighting, composition, aesthetic} for the stem
  ai_analysis_excerpt TEXT,                             -- truncated Pass 1 analysis paragraph
  -- Editor-supplied reasoning (mandatory on disagree, optional on match):
  editor_reasoning TEXT,                                -- one-sentence narrative
  primary_signal_diff TEXT,                             -- which dimension/signal the editor cites (e.g. 'aesthetic', 'window_blowout_area')
  reasoning_categories TEXT[],                          -- multi-select chips: ['clutter', 'mood', 'tier_mismatch', ...]
  editor_score_override NUMERIC(5,2),                   -- if editor would have scored the stem differently
  -- Provenance (W8.4):
  engine_version TEXT,
  tier_config_version INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE calibration_decisions IS
  'Wave 14 (W14): per-decision diff capture. One row per (session, project, slot). agreement=match or disagree. Disagree rows carry editor reasoning + primary_signal_diff for tier-config tuning + W11 prompt few-shot extraction.';

CREATE INDEX IF NOT EXISTS idx_calibration_decisions_session
  ON calibration_decisions(calibration_session_id);
CREATE INDEX IF NOT EXISTS idx_calibration_decisions_project
  ON calibration_decisions(project_id);
CREATE INDEX IF NOT EXISTS idx_calibration_decisions_disagree
  ON calibration_decisions(primary_signal_diff)
  WHERE agreement = 'disagree';
CREATE INDEX IF NOT EXISTS idx_calibration_decisions_slot_disagree
  ON calibration_decisions(slot_id) WHERE agreement = 'disagree';

-- 4. RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE calibration_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE calibration_editor_shortlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE calibration_decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY cal_sessions_select ON calibration_sessions FOR SELECT TO authenticated
  USING (get_user_role() IN ('master_admin','admin','manager'));
CREATE POLICY cal_sessions_write ON calibration_sessions FOR ALL TO authenticated
  USING (get_user_role() IN ('master_admin','admin'))
  WITH CHECK (get_user_role() IN ('master_admin','admin'));

CREATE POLICY cal_editor_shortlists_select ON calibration_editor_shortlists FOR SELECT TO authenticated
  USING (get_user_role() IN ('master_admin','admin','manager'));
CREATE POLICY cal_editor_shortlists_write ON calibration_editor_shortlists FOR ALL TO authenticated
  USING (get_user_role() IN ('master_admin','admin'))
  WITH CHECK (get_user_role() IN ('master_admin','admin'));

CREATE POLICY cal_decisions_select ON calibration_decisions FOR SELECT TO authenticated
  USING (get_user_role() IN ('master_admin','admin','manager'));
CREATE POLICY cal_decisions_write ON calibration_decisions FOR ALL TO authenticated
  USING (get_user_role() IN ('master_admin','admin'))
  WITH CHECK (get_user_role() IN ('master_admin','admin'));

NOTIFY pgrst, 'reload schema';

-- ── Rollback (manual) ─────────────────────────────────────────────────────
--
-- DROP TABLE IF EXISTS calibration_decisions;
-- DROP TABLE IF EXISTS calibration_editor_shortlists;
-- DROP TABLE IF EXISTS calibration_sessions;
```

### Section 5 — Edge functions

#### `calibration-session-create`

POST `{ session_name, stratification_config?, manual_project_ids?, editor_user_id }`.

- If `stratification_config` provided: use the cell counts as-is. Else use the recommended defaults per §1.
- If `manual_project_ids` provided: include them as the wildcard slots (capped at 5; per §1 reserved for Joseph's hand-picks).
- Run the cell-by-cell SELECT (§1) to fill the rest.
- INSERT one `calibration_sessions` row + 50 `calibration_editor_shortlists` rows (one per project, status=`in_progress`).
- Pin `engine_version` from `_shared/engineVersion.ts` + per-tier `tier_config_versions` map at session start.
- Return the session id + project list.

Auth: master_admin only.

#### `calibration-run-ai-batch`

POST `{ calibration_session_id, project_ids? }` (default: all projects in session).

- For each project in the session:
  - Resolve the round's id (most recent locked round for the project; or trigger a fresh round if none exist — out of scope for v1, just require `confirmed_shortlist_group_ids` already present).
  - Call the existing `shortlisting-benchmark-runner` edge fn with `{ trigger: 'calibration', round_ids: [...] }` to run Pass 2 in blind mode.
  - Upon completion, write `ai_run_completed_at` on the corresponding `calibration_editor_shortlists` row.
- Returns the list of completed projects + cost estimate.

This runs in parallel with the editor's blind selection — the AI's output is written to the DB but **not surfaced in the UI** until the editor submits their own shortlist for that project.

Auth: master_admin only.

#### `calibration-submit-editor-shortlist`

POST `{ calibration_session_id, project_id, picked_stems: string[], per_stem_notes?: object }`.

- UPSERT the `calibration_editor_shortlists` row with `editor_picked_stems = picked_stems`, `status='submitted'`, `submitted_at=NOW()`.
- Returns the AI's parallel result if `ai_run_completed_at IS NOT NULL` (so the UI can flip immediately to the diff phase). Else returns `pending_ai=true` and the UI shows "Waiting for AI run...".

Auth: master_admin OR admin (the editor).

#### `calibration-submit-decisions`

POST `{ calibration_session_id, project_id, decisions: CalibrationDecision[] }`.

- BULK INSERT (or UPSERT on `(session, project, slot)`) the `calibration_decisions` rows.
- Validate: every disagreement row must have non-empty `editor_reasoning` + `primary_signal_diff`. Match rows can have empty reasoning.
- Returns the inserted count + any validation errors.

Auth: master_admin OR admin.

#### `calibration-session-complete`

POST `{ calibration_session_id }`.

- Validates: every `calibration_editor_shortlists` row in `status='submitted'` has corresponding `calibration_decisions` rows for every slot where editor and AI both made a pick.
- Flips session `status='completed'`, sets `diff_phase_completed_at=NOW()`.
- Emits a summary `shortlisting_events` row with aggregate metrics: total disagreements, top primary_signal_diff values, per-cell match rates.

Auth: master_admin only.

### Section 6 — Parallel AI benchmark run

The AI side reuses the existing `shortlisting-benchmark-runner` edge fn (mig 295 + the runner in `supabase/functions/shortlisting-benchmark-runner/`). The runner already:

- Takes a `limit` parameter
- Runs Pass 2 in blind mode (no access to confirmed_shortlist_group_ids)
- Writes per-round results

Wave 14 extends the runner with an optional `calibration_session_id` parameter:

```typescript
// shortlisting-benchmark-runner extension:
interface RequestBody {
  trigger?: 'manual' | 'quarterly_cron' | 'calibration';
  limit?: number;
  calibration_session_id?: string;          // NEW: when present, scope the run to this session's projects
  round_ids?: string[];                      // NEW: explicit round list for calibration mode
}
```

When `trigger='calibration'`, the runner:
- SELECTs rounds via `round_ids` (the calibration-run-ai-batch edge fn supplies them).
- Runs Pass 2 in blind mode per existing logic.
- Writes results to `shortlisting_benchmark_results` AS USUAL (the calibration session's data is denormalised into `calibration_decisions`; the benchmark_results row is supplementary, gives the same per-slot match-rate breakdown the existing Calibration page surfaces).
- Stamps the benchmark_results row with `trigger='calibration'` and `notes` referencing the session id.

**Cost:** existing benchmark runner is ~$0.03/round → 50 rounds ≈ $1.50 per session. Negligible.

### Section 7 — Wave 12 validation hook (W14.5)

The wave plan calls out W14.5 as "stress-test Wave 12's AI suggestion engine — do editor disagreements correlate with model's proposed slots/room_types?". The validation:

1. After calibration session completes, run a query joining `calibration_decisions` (where `agreement='disagree'`) against `shortlisting_events` (where `event_type='pass2_slot_suggestion'`) for the same `round_id`.
2. For each disagreement, check: did Pass 2 emit a `proposed_slot_id` for the round that aligns with what the editor preferred?
3. Output: per-disagreement match — "AI proposed `balcony_terrace_hero` for round X; editor disagreed with the AI's `terrace_secondary` pick at slot `terrace_main`; the suggestion DID predict the editor's preference".
4. Aggregate: % of editor disagreements that the AI's suggestion engine flagged as a taxonomy gap. High % = suggestion engine is well-calibrated. Low % = the engine is missing important patterns.

**Implementation:** new admin page section under `Settings → Engine → AI Suggestions` titled "Calibration validation" — runs the join query, renders per-row results.

This is a once-per-calibration-session activity. No new edge fn; the join lives in the page's query. Pre-W12 it's a no-op; post-W12 it's the closing-the-loop step.

### Section 8 — Output utilisation

The calibration session produces three downstream artefacts:

1. **Wave 8 tier_config tuning data:** the disagreements grouped by tier × primary_signal_diff produce a per-tier signal-priority profile. Admin reads these from the calibration UI's "Aggregate" tab → applies tuning via `Settings → Engine → Tier Configs` (W8 admin UI). e.g. if Tier P kitchens have 8 disagreements all citing `aesthetic`, admin bumps Tier P's `dimension_weights.aesthetic` from 0.20 → 0.30.

2. **Wave 11 prompt few-shot examples:** disagreements with strong reasoning become Pass 1/2 few-shot examples. The W11 prompt builder reads `SELECT calibration_decisions WHERE agreement='disagree' AND editor_reasoning IS NOT NULL AND primary_signal_diff = ?` to inject relevant examples per-tier. The training_examples extractor (mig 287) is extended to also pull from `calibration_decisions` rows.

3. **Holdout set extension:** the 50 calibration projects are auto-marked as `is_benchmark=TRUE` on their rounds (per mig 295's `shortlisting_rounds.is_benchmark` flag) so they enter the quarterly benchmark holdout. Future quarterly runs measure improvement against this calibrated baseline.

---

## Migration `346_calibration_session.sql`

(Full SQL drafted in §4. Migration number 346 — chained after W7.7=339, W10.1=340, W10.3=341, W13a=342, W13b=343, W8=344, W12=345.)

---

## Engine integration

1. **`calibration-session-create`** (new edge fn) — stratification + session bootstrap.
2. **`calibration-run-ai-batch`** (new edge fn) — invokes existing benchmark-runner per-project.
3. **`calibration-submit-editor-shortlist`** (new edge fn) — persists blind editor input.
4. **`calibration-submit-decisions`** (new edge fn) — persists per-disagreement diff.
5. **`calibration-session-complete`** (new edge fn) — finalises session.
6. **`shortlisting-benchmark-runner`** (extension) — accepts `trigger='calibration'` and `round_ids` parameter.
7. **`shortlisting-training-extractor`** (extension) — when calibration_session completes, extract disagreement rows into `shortlisting_training_examples` with `source='calibration_session'` (a new value in the source enum from W13a's mig 342 — chains cleanly).

---

## Frontend impact

1. **`Settings → Engine → Calibration`** (new page, distinct from the existing `pages/ShortlistingCalibration.jsx` which handles the quarterly benchmark) — three tabs:
   - **Sessions:** list of past + active sessions, click to drill in.
   - **Run new session:** stratification config form, project picker for wildcards, "Start session" button.
   - **Active session:** the editor's blind-selection UI + diff-capture UI per §2 + §3.

   The orchestrator self-resolves: place this UI in `flexmedia-src/src/pages/SettingsCalibrationSession.jsx` to disambiguate from the existing benchmark page (`ShortlistingCalibration.jsx`). Navigation: rename the existing page to "Quarterly Benchmark"; new page is "Calibration Sessions".

2. **`Settings → Engine → AI Suggestions` extension** — add the "Calibration validation" panel per §7.

3. **Editor onboarding modal** — first-time calibration UI users see a one-page modal explaining the blind→diff flow + emphasising that reasoning quality matters (the data drives tier-config tuning + future prompts).

4. **Session resumption** — UI persists progress; closing the tab and reopening lands on the next un-submitted project. No "you'll lose progress" warnings — saves are eager.

---

## Tests

- **Migration test:** mig 346 idempotent; all three tables + indexes + RLS exist.
- **`calibration-session-create` integration test:** seed 100 candidate projects across cells; create session; verify 50 projects selected matching stratification config; wildcards included if provided.
- **`calibration-run-ai-batch` integration test:** session with 5 projects; verify benchmark-runner called per round; results land in benchmark_results with `trigger='calibration'`; `ai_run_completed_at` set on each `calibration_editor_shortlists` row.
- **`calibration-submit-editor-shortlist` integration test:** UPSERT semantics work; submitting twice updates the row; status flips to `submitted`.
- **`calibration-submit-decisions` validation test:** disagreement rows missing `editor_reasoning` rejected with 400; match rows accepted without reasoning.
- **`calibration-session-complete` integration test:** all decisions submitted → flips to `completed`; missing decisions for submitted shortlists → 409 with detail.
- **Benchmark-runner extension test:** new `trigger='calibration'` parameter routes correctly; `round_ids` filter respected.
- **UI snapshot test:** blind-selection phase hides AI output; diff-phase reveals it post-submit.

---

## Open questions for sign-off

**Q1.** Editor labour budget — 50 projects × ~30min review = 25 hours. Confirm.
**Recommendation:** **25 hours total** (split across 1-2 weeks; the editor doesn't need to do this in one sitting — sessions resume per §2). Per-project breakdown: ~10min for blind selection + ~15min for diff reasoning + ~5min context-switch overhead per project. The investment pays off across the calibration set's lifetime: every Wave 8 tier_config tuning decision, every Wave 11 prompt few-shot injection, every quarterly benchmark validation reads back to this corpus. Joseph picks if the timeline is too aggressive — can stretch to 4 weeks at part-time pace.

**Q2.** Stratification cells — recommended distribution per §1?
**Recommendation:** **48 stratified + 2 wildcard** as drafted. Heaviest weighting on Gold Standard (15) because it's the bulk volume. Smallest cells (Silver Premium 3, Dusk Video Premium 2) ensure edge-cell representation without over-investing. Joseph confirms the per-cell counts; the wildcard slots are his to fill. Out-of-the-box: the engine selects all 50 if Joseph provides no wildcards; he can swap any 2 for hand-picks before the session starts.

**Q3.** Repeat cadence — calibrate quarterly, half-yearly, annually?
**Recommendation:** **Annually for the v1 wave**, with the option to run a follow-up calibration mid-year if the engine ships major changes (Wave 11 universal vision response definitely qualifies). Quarterly is too frequent: the 25-hour editor commitment + 50-project rotation requires a healthy backlog of un-calibrated projects (the engine excludes already-used ones). FlexMedia's annual project volume gives ~500-1000 candidates → annual rotation pulls fresh data. Spec a re-run trigger (`engine_version` major-version bump or admin-initiated) rather than a fixed cron.

---

## Resolutions self-resolved by orchestrator

**R1 — Three tables, not one consolidated.**
The session container, the editor's blind shortlist, and the per-decision diff are three different lifecycle entities. A consolidated single table would force NULLable columns for "is this a session row, or a shortlist row, or a decision row?" — fragile. Three tables keep RLS, indexes, and queries clean.

**R2 — Blind editor input phase is mandatory, not skippable.**
Skipping the blind phase ("just show me the AI's output and I'll mark agreement/disagreement on each") seems faster but produces anchored data. The whole point of the calibration is independent ground truth. Joseph's editors can speed-run the blind phase (large grid + click [add]) but they can't bypass it. UI enforces.

**R3 — Per-disagreement reason capture is mandatory, not aspirational.**
A disagreement row without `editor_reasoning` is useless data. The submit handler validates and rejects empty reasoning on disagrees. Match rows are different — reasoning optional there because the agreement IS the data point.

**R4 — Reuse `shortlisting-benchmark-runner`, don't fork.**
The benchmark-runner already does Pass 2 in blind mode against locked rounds. Forking it for calibration would duplicate ~500 lines of edge-fn code. The trigger parameter extension (`'calibration'`) is the surgical addition.

**R5 — Editor resumes via session id, not via cookie/local storage.**
Auth + DB-persisted state survive tab close, browser restart, multi-device. The calibration UI fetches `calibration_editor_shortlists WHERE calibration_session_id = ? AND editor_user_id = ?` on load; renders the next un-submitted project automatically. No local state.

**R6 — Stratification is config-driven, not hardcoded.**
The `stratification_config JSONB` on `calibration_sessions` lets future sessions tune the cell distribution without a code deploy. v1 default per §1; admin can change cell counts per session (e.g. "this session, more Flex Tier A — we just signed three new luxury agencies").

**R7 — Disagreement → training_example extraction is automatic on session_complete.**
The training-extractor edge fn (mig 287) is already the canonical path for "high-quality disagreement → training corpus". Wave 14's session_complete handler enqueues an extraction job that pulls `calibration_decisions WHERE agreement='disagree'` and emits training rows with `source='calibration_session'`. No manual step.

**R8 — Wildcard slots capped at 5, not unlimited.**
Joseph's hand-picks are valuable but they shouldn't dominate the session. Capping at 5 (10% of the set) preserves stratification properties while letting Joseph inject specific cases worth calibrating. If Joseph wants 10 hand-picks, he runs a separate "ad-hoc calibration" session — not the structured 50-project one.

**R9 — Per-stem notes are captured but NOT shown to the AI side.**
The editor's per-stem notes during blind selection ("only kitchen with the bench cleared") are valuable for future analysis but if surfaced to the AI side they'd contaminate the blind premise. Stored in `calibration_editor_shortlists.editor_per_stem_notes`; revealed only after diff submit (via a "view editor's blind notes" toggle).

**R10 — `primary_signal_diff` enumeration matches W11 + 4-dim fallback.**
Pre-W11: enum is the 4 dimensions only. Post-W11: enum extends to include the 22 signal_keys. The dropdown's source is `engine_settings.calibration_primary_signal_options` JSON, defaulting to the 4 dims; admin updates to extend the list when W11 ships.

**R11 — `calibration_decisions.agreement` is denormalised but indexed.**
Computed at insert time from `ai_decision === editor_decision`. Denormalising it (vs computing on-the-fly) lets the index `idx_calibration_decisions_disagree WHERE agreement='disagree'` be a partial index on the hot-path query ("show me all disagreements for this session"). Worth the column.

**R12 — Edge fns are master_admin-gated for create/complete; admin-allowed for in-session writes.**
Editors are typically `admin` role; only Joseph (master_admin) creates and finalises sessions. Inside the session, the editor's writes (submit shortlist, submit decisions) are admin-allowed. Prevents accidental session_complete by an editor mid-session.

---

## Effort estimate

- Migration (3 tables + indexes + RLS): half-day
- `calibration-session-create` edge fn (stratification + bootstrap): 1 day
- `calibration-run-ai-batch` edge fn (orchestrates benchmark-runner per project): half-day
- `calibration-submit-editor-shortlist` + `calibration-submit-decisions` edge fns: 1 day
- `calibration-session-complete` edge fn (validation + training extraction trigger): half-day
- benchmark-runner extension (trigger='calibration' + round_ids parameter): 2 hours
- Calibration UI page (Sessions tab + Run new tab + Active session phase 1 blind + phase 2 diff): 4-5 days
  - Largest variance: the diff-capture UI's per-row reasoning form needs careful UX so editors don't speed-run with empty reasons
- AI Suggestions page extension (Calibration validation panel): 2 hours
- Editor onboarding modal: 2 hours
- Session resumption + state management: 1 day
- Tests + smoke + e2e: 1 day

**Total: ~9-10 engineering days** + 25 editor hours (separate budget).

---

## Out of scope (handled in other waves)

- **Quarterly benchmark replacement** — the existing `pages/ShortlistingCalibration.jsx` continues to handle the quarterly benchmark; it's renamed in the IA but its function is unchanged.
- **Auto-tuning of tier configs from disagreements** — Wave 16+ if/when prioritised. v1 ships the data + admin UI; Joseph reads + tunes manually.
- **Multi-editor sessions** — v1 is single-editor (whoever Joseph designates). Cross-editor agreement / disagreement tracking is a future extension.
- **Multilingual reasoning** — editor_reasoning is free text in English. Translation/normalisation is out of scope.
- **Session-level cost cap** — benchmark runner's 50-round cost is ~$1.50, well below any reasonable cap; no budget guard needed at v1.
- **Public API to read session data** — admin UI only; no external consumers.

---

## Pre-execution checklist

- [ ] W7.7 ✅ shipped (engine_tier_id, expected_count_target, package_engine_tier_mapping)
- [ ] W8 must have shipped (engine_version + tier_config_version on rounds)
- [ ] W11 should have shipped — pre-W11 the spec ships with 4-dim primary_signal_diff enumeration; post-W11 the enum extends. Document the pre-W11 limitation if Joseph runs the calibration before W11 lands
- [ ] W12 must have shipped — for the W14.5 suggestion-engine validation step. Pre-W12 the validation step is no-op (still safe to run the calibration; just no W12 hook)
- [ ] Joseph signs off on Q1 (25-hour editor budget), Q2 (stratification cells), Q3 (annual cadence)
- [ ] Migration number reserved at integration time (recommend 346 — chained after W7.7=339, W10.1=340, W10.3=341, W13a=342, W13b=343, W8=344, W12=345)
- [ ] Editor identified — typically the master photographer/editor whose shortlists are the ground-truth training target; Joseph may be that person himself
- [ ] First session's project pool reviewed: confirm there are ≥50 candidate projects across the stratification cells with completed locked rounds and `confirmed_shortlist_group_ids` populated
- [ ] Existing `pages/ShortlistingCalibration.jsx` renamed to "Quarterly Benchmark" in the navigation IA; new page lands at `Settings → Engine → Calibration Sessions`
- [ ] Editor onboarding modal copy reviewed by Joseph — emphasise blind-phase importance + reasoning quality
- [ ] One end-to-end smoke run on a 5-project mini-session before launching the real 50-project session — catch any UX gaps cheaply
