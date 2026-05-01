# W13a — Historical FlexMedia Delivery Goldmine — Design Spec

**Status:** Infrastructure ready 2026-05-01 — manual-trigger only, no autonomous backfills fired.

- Migration **382** (`382_w13a_backfill_metadata.sql`) applied: `shortlisting_rounds.is_synthetic_backfill`, `backfill_source_paths`, status enum extension to `backfilled`, `composition_groups.synthetic_finals_match_stem`, and the new `shortlisting_backfill_log` table with full RLS.
- Edge function `shortlisting-historical-backfill` deployed: master_admin-only POST endpoint that bootstraps the synthetic round + extract jobs, then leaves the existing dispatcher chain (extract → pass0 → shape_d_stage1 → stage4_synthesis) to do the actual processing. Cost cap enforced at three layers (caller-supplied `cost_cap_usd`, `engine_settings.cost_cap_per_round_usd`, runtime watchdog at 1.5× estimate).
- **No autonomous trigger.** No cron, no batch runner, no auto-queue. Joseph fires the endpoint per project, reviews, decides whether to fire again. The system never processes more than one project per human invocation.

### Invocation example

```bash
curl -X POST https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/shortlisting-historical-backfill \
  -H "Authorization: Bearer <master_admin_jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "<delivered-project-uuid>",
    "raws_dropbox_path": "/Flex Media Team Folder/.../Photos/Raws",
    "finals_dropbox_path": "/Flex Media Team Folder/.../Photos/Finals",
    "cost_cap_usd": 5
  }'
```

The endpoint returns immediately with `mode: 'background'` and the `round_id` + `log_id`. The dispatcher chain processes the synthetic round in the background; `shortlisting_backfill_log.status` walks `queued → running → succeeded|failed` over the next 5-30 minutes depending on project size. Final `cost_usd` populates from `engine_run_audit.total_cost_usd` once Stage 4 completes; the matched-finals enrichment fires post-Stage 4 to populate `composition_groups.synthetic_finals_match_stem` (the W14 calibration ground-truth signal).

A separate W13a follow-up task (out of scope for this infrastructure burst) extracts `shortlisting_training_examples` rows from the synthetic round.

---

## Original spec body (sign-off questions Q1-Q4 self-resolved per orchestrator + Joseph 2026-04-27)


**Backlog ref:** P2-4
**Wave plan ref:** W13a — synthetic-round creator + Pass 1 over RAW + finals + enriched `shortlisting_training_examples` per W13a.1/.2/.3
**Dependencies:**
- **W7.7 must land first** — synthetic rounds need `engine_tier_id` + `package_engine_tier_mapping` for tier provenance (`tier_used` per training row).
- **W8 must land first** — training rows need `tier_config_version` (W8.4) so future re-extractions can be reproduced under the right tier weights.
- **W11 strongly preferred but not blocking** — universal vision response gives richer per-row signal scores. v1 can ship under the legacy schema if W11 slips; the schema is forward-compat.
- **W11.7 (unified architecture) recommended** — backfill rounds will produce richer, more consistent training data when the unified call is the producer. If W11.7 ships before W13a launches, all backfill goes through the unified pipeline.

**Unblocks:** Wave 11+ benchmark runner gets a 50-100x larger calibration set; Wave 14's 50-project structured calibration becomes the *delta-validator* against the goldmine baseline.

---

## ⚡ Architectural alignment (2026-04-29)

W11.7's unified architecture **simplifies W13a backfill execution**:

- **Single Opus call per historical project** instead of separate Pass 1 + Pass 2 chain. Same architecture as live rounds → backfill outputs are directly comparable to live outputs (no reconciling-different-prompts at W14 calibration time).
- **Async description backfill** (Sonnet 4.6) generates the rich descriptions for historical training data, same way as live rounds. Cost stays predictable.
- **Quality outliers detected automatically**: under W11.7, the unified call emits `quality_outliers[]` per round. Historical Tier S rounds that over-delivered Tier P-quality work get flagged in the goldmine — useful for retroactive pricing analysis.
- **Engine-mode stamp on synthetic rounds**: backfill rounds inherit `shortlisting_rounds.engine_mode='unified'` (or `'two_pass'` if W13a runs before W11.7's default flip). W14 calibration filters by mode for like-for-like comparison.

---

## Problem

FlexMedia has years of completed projects sitting in Dropbox. Each completed project carries:

- A **RAW folder** (`Photos/Raws/Shortlist Proposed/` or legacy paths) with 100-300 CR3 files captured on shoot day.
- A **delivered finals folder** (`Photos/Finals/Sales Images/`, etc.) with 25-40 retouched JPEGs that the editor delivered to the agent.

Each completed project is therefore a **perfectly-supervised learning example**: given these 100+ RAWs, the editor (under business pressure, agent feedback, and learned taste) chose THESE 30 finals. The intersection of (RAW set, delivered finals set) is the ground truth for what makes a "shortlist-worthy" composition for this client / agent / package / tier combination.

Today's `shortlisting_training_examples` table (mig 287, mig 332) is populated **only** from human-confirmed rounds going forward — i.e. rounds where Pass 0/1/2/3 ran AND the editor locked a confirmed shortlist. We have ~zero training rows because the engine has barely shipped. Wave 8's tier-weight tuning starves; Wave 11's prompt few-shot injection has nothing to inject; the benchmark runner's 50-round target (mig 295) is months of natural runs away.

**The fix:** treat each historical project as a synthetic shortlisting round. Skip Pass 0 + Pass 2 + Pass 3 (no slot resolution because the editor already decided); run Pass 1 over BOTH the RAW set and the finals set in read-only "scoring" mode; emit one `shortlisting_training_examples` row per delivered final (`was_shortlisted=true`) with full provenance: package, engine tier, slot (resolved by filename pattern matching against the package's slot definitions), human-confirmed scores from Pass 1's vision pass, and the analysis paragraph.

This is "Goldmine 1 with full provenance" per Joseph's memory note — the institutional-memory bootstrap that the engine and the team have been working for.

---

## Architecture

### Section 1 — Synthetic-round creator

A new edge function `shortlisting-historical-backfill` creates a "synthetic round" tied to a real legacy project, marked `status='backfilled'`. The synthetic round shape:

```typescript
// supabase/functions/shortlisting-historical-backfill/index.ts (new)

interface BackfillRequest {
  project_id: string;                 // an existing FlexMedia project (legacy or current)
  raw_folder_path: string;            // Dropbox path to RAW folder (relative or full)
  finals_folder_path: string;         // Dropbox path to delivered finals folder
  tier_choice?: 'standard' | 'premium' | null;  // null → infer from project.pricing_tier
  package_id?: string | null;         // null → infer from project.packages[0].package_id
  notes?: string | null;
}

interface BackfillResponse {
  ok: boolean;
  round_id: string;
  raw_count: number;
  finals_count: number;
  enqueued_extract_jobs: number;
  enqueued_pass1_jobs: number;
  estimated_cost_usd: number;        // Pass 1 cost estimate at $0.013/RAW + $0.013/final
  warnings: string[];
}
```

Synthetic round persistence:

```typescript
// 1. Create shortlisting_rounds row
const { data: round } = await admin.from('shortlisting_rounds').insert({
  project_id: input.project_id,
  status: 'backfilled',                  // NEW status — see §2 migration
  is_benchmark: false,                    // Wave 14 calibration uses a separate set
  is_historical_backfill: true,           // NEW column — see §2 migration
  started_at: NOW(),
  package_type: resolvedPackageName,      // e.g. 'Gold Package'
  package_tier_choice: input.tier_choice ?? project.pricing_tier ?? 'standard',
  engine_tier_id: resolveEngineTier(...), // per W7.7 resolver
  expected_count_target: finalsCount,     // the editor delivered N finals — that IS the target
  expected_count_min: finalsCount,        //   - min/max collapse for backfilled rounds
  expected_count_max: finalsCount,
  raw_folder_path: input.raw_folder_path,
  finals_folder_path: input.finals_folder_path,
  // ...
}).select('id').single();
```

`status='backfilled'` is a new enum value; today's enum (per spec + mig audit) covers `pending|in_progress|locked|failed`. Section 2 migration adds the value. Backfilled rounds:

- Skip Pass 0 (no bracket detection — we trust the RAW filenames as-is).
- Run Pass 1 over RAW + finals as two separate batches.
- Skip Pass 2 (no slot assignment — the editor already chose).
- Skip Pass 3 (no QA pass — finals are by definition the QA outcome).
- Are excluded from the dispatcher's normal queue (`status NOT IN ('backfilled')` filter on the dispatcher's pending-rounds query).

### Section 2 — Schema additions

```sql
-- Wave 13a P2-4: shortlisting_rounds gains is_historical_backfill + adjusted
-- status enum to include 'backfilled' so dispatcher excludes them.

-- 'status' column today is unconstrained TEXT (no CHECK). Enforce with new
-- CHECK constraint that includes 'backfilled' as a first-class value.
ALTER TABLE shortlisting_rounds
  DROP CONSTRAINT IF EXISTS shortlisting_rounds_status_check;
ALTER TABLE shortlisting_rounds
  ADD CONSTRAINT shortlisting_rounds_status_check
  CHECK (status IN ('pending', 'in_progress', 'locked', 'failed', 'backfilled'));

ALTER TABLE shortlisting_rounds
  ADD COLUMN IF NOT EXISTS is_historical_backfill BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE shortlisting_rounds
  ADD COLUMN IF NOT EXISTS finals_folder_path TEXT;

COMMENT ON COLUMN shortlisting_rounds.is_historical_backfill IS
  'Wave 13a P2-4: TRUE for rounds created by shortlisting-historical-backfill — synthetic rounds tied to legacy projects, status=backfilled, no Pass 0/2/3.';
COMMENT ON COLUMN shortlisting_rounds.finals_folder_path IS
  'Wave 13a P2-4: Dropbox path to the delivered finals folder. Only set on backfilled rounds.';

-- shortlisting_training_examples gains:
--   - was_shortlisted (always TRUE for backfilled — every finals row is a confirmed positive)
--   - source ('live'|'historical_backfill'|'pulse_ground_truth')
--   - tier_used (W8.4 lands this for live rounds; backfill writes it directly from the round's engine_tier_id)
--   - tier_config_version (W8.4)
ALTER TABLE shortlisting_training_examples
  ADD COLUMN IF NOT EXISTS was_shortlisted BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'live'
    CHECK (source IN ('live', 'historical_backfill', 'pulse_ground_truth')),
  ADD COLUMN IF NOT EXISTS tier_used TEXT,
  ADD COLUMN IF NOT EXISTS tier_config_version INT,
  ADD COLUMN IF NOT EXISTS round_id UUID REFERENCES shortlisting_rounds(id) ON DELETE SET NULL;

COMMENT ON COLUMN shortlisting_training_examples.was_shortlisted IS
  'Wave 13a P2-4: TRUE for rows representing a final the editor delivered (confirmed positive). For live rounds this is also TRUE for every row (mig 287 only emitted on confirmation). The column makes the semantics explicit and forward-compat for negative-example sources.';
COMMENT ON COLUMN shortlisting_training_examples.source IS
  'Wave 13a P2-4: provenance of this training row. live = generated by Pass 0/1/2/3 confirmation flow; historical_backfill = generated by shortlisting-historical-backfill against legacy projects; pulse_ground_truth = future use (Wave 15c competitor analysis).';

CREATE INDEX IF NOT EXISTS idx_training_examples_source
  ON shortlisting_training_examples(source) WHERE excluded = FALSE;
CREATE INDEX IF NOT EXISTS idx_training_examples_round
  ON shortlisting_training_examples(round_id) WHERE excluded = FALSE;

NOTIFY pgrst, 'reload schema';

-- Rollback (manual):
--   ALTER TABLE shortlisting_training_examples DROP COLUMN IF EXISTS round_id, ...;
--   ALTER TABLE shortlisting_rounds DROP COLUMN IF EXISTS finals_folder_path;
--   ALTER TABLE shortlisting_rounds DROP COLUMN IF EXISTS is_historical_backfill;
--   ALTER TABLE shortlisting_rounds DROP CONSTRAINT shortlisting_rounds_status_check;
```

### Section 3 — Two-input UX

A new admin page `Settings → Engine → Historical Backfill` lists known legacy projects (paginated by `created_at DESC`), with two inputs per row:

```
┌────────────────────────────────────────────────────────────────────────┐
│ Project: 12 Smith St, Mosman — Gold Package — 2024-08-15               │
│ ┌──────────────────────────────────────────────────────────────────┐   │
│ │ RAW folder  : /Flex Media Team Folder/Mosman/Smith/Photos/Raws… │   │
│ └──────────────────────────────────────────────────────────────────┘   │
│ ┌──────────────────────────────────────────────────────────────────┐   │
│ │ Finals folder: /Flex Media Team Folder/Mosman/Smith/Photos/Final│   │
│ └──────────────────────────────────────────────────────────────────┘   │
│ Tier (override): [Standard ▼]  Package (override): [Auto-detected ▼]   │
│ Estimated cost: $1.42 (164 RAWs + 32 finals @ $0.013/img Sonnet)       │
│                                                                        │
│ [Validate paths]   [Backfill round]                                    │
└────────────────────────────────────────────────────────────────────────┘
```

`[Validate paths]` calls `listDropboxFiles` against both paths, returns counts + a sample of filenames so the operator can sanity-check ("yep that's the right folder before I burn $1.42").

`[Backfill round]` POSTs the request to `shortlisting-historical-backfill`. The endpoint:

1. Validates project exists.
2. Validates RAW + finals folders exist via Dropbox (fast `files/list_folder` pre-check).
3. Creates the synthetic round (§1).
4. Enqueues N `extract` jobs for the RAW set (just the EXIF + preview path — same as live rounds).
5. Enqueues 1 `pass1` job for the RAWs once extracts complete (chained by dispatcher).
6. Enqueues 1 `pass1` job for the finals set as a separate batch (no extract — finals are JPEGs, no CR3 conversion needed; we either fetch directly via Dropbox proxy or use a lighter Modal worker).
7. Returns the round_id + estimated cost.

The frontend polls the round's status (existing infrastructure) and renders progress.

### Section 4 — Pass 1 over finals (lighter pipeline)

For RAWs, today's `shortlisting-extract` → `shortlisting-pass0` → `shortlisting-pass1` chain works as-is.

For finals (JPEGs), Pass 0 is bypassed — there's no bracket detection. We need a lighter ingest:

```typescript
// Option A (preferred): new Modal worker `finals-extract`
// - Downloads JPEGs from Dropbox (no exiftool serial extraction needed —
//   though we still want capture date for ordering).
// - Resizes to 1024px wide (same target as RAW preview).
// - Uploads resized JPEGs to a per-round previews dir.
// - Returns a flat list of {fileName, previewPath, captureTs, luminance}.
//
// Pass 0 ingestion creates one composition_group per final (file_count=1,
// is_secondary_camera=false, source='finals'). The new column source
// distinguishes RAW-derived from finals-derived groups.
```

`composition_groups` gets one more column to track this:

```sql
-- Inside the same Wave 13a migration:
ALTER TABLE composition_groups
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'raw'
    CHECK (source IN ('raw', 'finals'));

COMMENT ON COLUMN composition_groups.source IS
  'Wave 13a P2-4: distinguishes Pass 0-derived RAW groups (default) from finals-extract-derived groups (only on backfilled rounds).';
```

Pass 1 already accepts a list of composition_groups and emits classifications + scores. The signal scores from a final JPEG vs a RAW preview differ (finals have window blowout already retouched, sharpness already corrected, etc.) — the universal vision response (W11) handles this via `source.is_post_edit=true`. Pre-W11, we accept the score asymmetry and document it in training extraction (the extractor knows whether each row came from RAW or finals via `composition_groups.source`).

### Section 5 — Slot resolution by filename pattern

Delivered finals follow a naming convention enforced by FlexMedia editors:

```
12_smith_st_mosman_01_facade.jpg              → slot 'sales_facade'
12_smith_st_mosman_02_kitchen_main.jpg        → slot 'sales_kitchen'
12_smith_st_mosman_03_kitchen_island.jpg      → slot 'sales_kitchen' (variant 2)
12_smith_st_mosman_04_living_room.jpg         → slot 'sales_living_main'
12_smith_st_mosman_05_master_bed.jpg          → slot 'sales_master_bedroom'
...
```

Pattern matching:

1. Lower-case the filename.
2. Strip the address prefix (everything before the first `_` after the index).
3. Strip the leading 2-3 digit index.
4. Match against a curated regex set keyed on slot_id from `shortlisting_slot_definitions`.

```typescript
// supabase/functions/_shared/finalsSlotResolver.ts (new)

export interface SlotPatternRule {
  slot_id: string;
  patterns: RegExp[];     // e.g. [/kitchen[-_ ]?(main|island|view)?/, /kitchen.*overall/]
  variant_index_extractor?: (fileName: string) => number;
}

// Bootstrap from existing slot definitions:
//   SELECT slot_id, slot_label FROM shortlisting_slot_definitions WHERE is_active
// Merged with a hand-curated synonym list (committed alongside the spec
// implementation; iterates as we see real filenames).
```

Variant detection: `kitchen_01.jpg` and `kitchen_02.jpg` both resolve to `sales_kitchen` with `variant_count=2` aggregated post-resolution. Editors who delivered 3 variants of the kitchen are signalling "this kitchen mattered" — `weight = 1.0 + 0.2 * (variant_count - 1)` per existing training corpus formula.

**Unmatched filenames** get logged as `slot_id=NULL` rows with `excluded=TRUE` and a warning. Editor can manually classify them later via a curator UI (Wave 13a follow-up; out of scope for v1).

### Section 6 — Training extraction (per-row provenance)

After Pass 1 over both batches finishes, a new edge function `shortlisting-historical-training-extractor` walks both sets and emits one row per final:

```typescript
// For each final (composition_group with source='finals', round_id=X):
//   1. Match by filename → resolve slot_id (§5)
//   2. Find the matching RAW (composition_group with source='raw' and
//      delivery_reference_stem matching the final's stem prefix). When
//      no match (rare; editor renamed mid-shoot), set raw_classification=NULL.
//   3. Insert shortlisting_training_examples row:

INSERT INTO shortlisting_training_examples (
  composition_group_id,          // the FINAL's composition_group_id (canonical)
  delivery_reference_stem,       // the final's filename stem
  variant_count,                 // count of finals with same slot_id
  slot_id,                       // resolved per §5
  package_type,                  // round.package_type
  project_tier,                  // round.package_tier_choice
  human_confirmed_score,         // Pass 1 score from the FINAL (post-edit)
  ai_proposed_score,             // Pass 1 score from the RAW (pre-edit) when matched
  was_override,                  // FALSE for backfilled rows (no AI ran live)
  was_shortlisted,               // TRUE — every backfill row is a confirmed positive
  source,                        // 'historical_backfill'
  tier_used,                     // round.engine_tier (resolved via package_engine_tier_mapping)
  tier_config_version,           // active config version at extraction time
  round_id,                      // the synthetic round
  analysis,                      // Pass 1 analysis paragraph (preferentially from final)
  key_elements,                  // from Pass 1 — finals enriched
  zones_visible,                 // from Pass 1
  composition_type,              // from Pass 1
  room_type,                     // from Pass 1
  weight,                        // 1.0 + 0.2 * (variant_count-1)  (no override bonus)
  training_grade,                // FALSE — curator promotes manually
  excluded,                      // FALSE for matched; TRUE for unmatched filenames
  created_at,
  updated_at
);
```

**Why use the final's score, not the RAW's?** Per Joseph's universal-vision-response design, finals scores measure what the editor actually delivered — a styled/retouched composition. RAW scores measure the as-shot frame. For training purposes, we want "what did the editor produce", not "what did the editor start from". The RAW score is preserved as `ai_proposed_score` so we can compute the delta (RAW → finals improvement) for separate analytics.

### Section 7 — Cost cap + invocation model (manual-trigger only)

**Joseph confirmed 2026-04-27**: this wave runs strictly on-demand, one project at a time. No batch runner, no overnight cron, no auto-scheduler. Joseph asks the orchestrator (or invokes the admin UI) when he wants to backfill a specific project; he picks which one. The runtime never decides on its own to process a queue.

**Per-project cost** (Sonnet over 1024px JPEGs at $0.013/call, per W11 cost model):

A typical Gold project: ~165 RAWs + ~32 finals = 197 Pass 1 calls = **~$2.56/project**. AI Package projects are smaller (~$0.50). Premium video packages can run higher (~$5).

**Edge function shape** (`shortlisting-historical-backfill`):

```typescript
interface BackfillRequest {
  project_id: string;                  // explicit; Joseph specifies which project
  raw_folder_path: string;             // Dropbox path to the RAW set
  finals_folder_path: string;          // Dropbox path to the delivered finals
  cost_cap_usd: number;                // required; pre-flight estimate must fit under this
  dry_run?: boolean;                   // if true, return the cost estimate + slot-resolver
                                       // preview without enqueueing any jobs
}
```

The edge fn:
1. Validates the project exists and the folders are reachable
2. Lists files in both Dropbox folders → estimated cost = (raw_count + finals_count) × $0.013
3. If estimate > cost_cap_usd → return 400 with detail; do NOT enqueue
4. If `dry_run=true` → return `{estimate, raw_count, finals_count, slot_match_preview}`; do NOT enqueue
5. Else: create the synthetic `shortlisting_rounds` row + enqueue Pass 1 jobs as before

**No cross-project batch endpoint.** No "process the next 25 projects" mode. Joseph invokes the edge fn once per project, reviews the result, decides whether to invoke again for the next project. The system never processes more than one project per human invocation.

**Admin UI** (lands as part of W13a execution): a `Settings → Engine → Historical Backfill` page where Joseph:
- Picks a project from a dropdown (excluding projects already backfilled)
- Pastes the RAW + finals folder paths (or uses a folder-picker that walks Dropbox)
- Sets `cost_cap_usd`
- Clicks "Estimate" → shows the dry-run preview (cost + slot-match preview)
- Clicks "Run backfill" → fires the actual call
- Recent runs table at the bottom: project, triggered_at, raw_count, finals_count, cost, status

Joseph alone decides which project gets processed and when. The system never batches across projects.

### Section 8 — Idempotency

Re-running a backfill against the same `(project_id, raw_folder_path, finals_folder_path)` triple should be safe:

- The synthetic round is keyed by `(project_id, status='backfilled', finals_folder_path)` — UNIQUE constraint prevents duplicate rows.
- The training extractor uses `(round_id, delivery_reference_stem)` as a natural key for upsert-on-conflict.

```sql
-- Inside the W13a migration:
CREATE UNIQUE INDEX IF NOT EXISTS uq_shortlisting_rounds_backfill_dedup
  ON shortlisting_rounds(project_id, finals_folder_path)
  WHERE is_historical_backfill = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_training_examples_backfill_dedup
  ON shortlisting_training_examples(round_id, delivery_reference_stem)
  WHERE source = 'historical_backfill';
```

---

## Migration

Reserve **next available** at integration time. Recommend `342_shortlisting_historical_backfill.sql` (chained after W7.7=339, W10.1=340, W10.3=341).

(SQL drafted across §2, §4, §8 — assemble into one migration file at execution time. Rollback comment block per existing pattern.)

---

## Engine integration

1. **`shortlisting-historical-backfill`** (new edge fn) — POST creates synthetic round, validates folders, enqueues extract + pass1 jobs.

2. **`finals-extract`** (new Modal worker) — lighter than `photos-extract`; downloads JPEGs, resizes, uploads previews. No exiftool needed; uses PIL EXIF reads for capture date.

3. **`shortlisting-extract`** edge fn — extends to dispatch to `finals-extract` when payload carries `is_finals: true`. Keep the routing inside the existing edge fn so the dispatcher chain stays unchanged.

4. **`shortlisting-pass1`** — no changes. Reads `composition_groups.source` to know it's processing RAWs vs finals; passes the hint into `buildPass1Prompt` if W11 has landed (else ignores).

5. **Dispatcher** — needs to filter `WHERE status NOT IN ('backfilled')` on its pending-rounds candidate query so backfill rounds don't double-run Pass 0/2/3. The dispatcher's `claim_shortlisting_jobs` RPC operates on `shortlisting_jobs` rows directly so this is one filter line in the round-bootstrap query, not the dispatcher's main loop.

6. **`shortlisting-historical-training-extractor`** (new edge fn) — runs after Pass 1 finals + Pass 1 RAWs both succeed; emits the training rows per §6.

7. **Slot resolver `_shared/finalsSlotResolver.ts`** — pure function with curated regex; tested independently.

---

## Frontend impact

1. **`Settings → Engine → Historical Backfill`** — new admin page (master_admin / admin only). Lists projects (paginated, filtered by `pricing_tier`, `package_type`, `created_at`). Per-row form with the two folder inputs, validate button, backfill button, estimated cost, and link to the synthetic round's status page.

2. **Reuse round status page** — backfilled rounds render the same status UI as live rounds, but with a banner "This is a historical backfill — Pass 0/2/3 skipped". Once Pass 1 finishes, banner shifts to "Training rows extracted: N rows for {package} {tier}".

3. **Curator UI for unmatched finals** — list of training_examples rows where `excluded=TRUE AND source='historical_backfill'`. Each row shows the filename + a slot dropdown for manual classification. Out of scope for v1 of W13a — punt to a follow-up burst.

---

## Open questions for sign-off

**Q1.** ~~How many historical projects to backfill in v1?~~ → resolved by Joseph 2026-04-27: **N/A — Joseph picks projects one at a time, on demand**. No batch policy. The system processes exactly the project Joseph names per invocation.

**Q2.** For projects where the editor's choice was overruled by client edits (rare client revisions where the agent demanded a different shot post-delivery), do we exclude or include with a flag?
**Recommendation:** include with a flag. Add `was_client_revised BOOLEAN` to the training row (defaults FALSE). Operator marks it TRUE on the backfill UI when they know the project went through revisions. Excluded by default from training prompts (`weight *= 0.5`); curator can promote later.

**Q3.** ~~Cost cap budget for 100 projects?~~ → resolved by Joseph 2026-04-27: **N/A — no upfront budget**. Joseph supplies a per-invocation `cost_cap_usd` for each project. The system never processes anything without an explicit human invocation + cost cap acceptance. Per-project cost is documented (~$2.56 for a typical Gold project) so Joseph can size the cap.

**Q4.** When a final filename doesn't match any slot pattern, do we skip silently (log only) or fail the round?
**Recommendation:** skip silently — emit `excluded=TRUE` row + a `shortlisting_events` warning. Failing the round on one bad filename would block 99% useful rounds for 1 file. The curator UI (Wave 13a follow-up) handles cleanup.

---

## Resolutions self-resolved by orchestrator

- **R1 (synthetic round vs separate table).** A separate `historical_training_rounds` table would duplicate plumbing (status tracking, job queue routing, Pass 1 invocation). Reusing `shortlisting_rounds` with `is_historical_backfill=TRUE + status='backfilled'` keeps the engine plumbing as-is — only the dispatcher's "should I run Pass 0/2/3 on this?" branch flips. Cleaner.

- **R2 (Pass 1 on finals = Pass 1 on RAWs).** Same prompt assembly, same scoring formula (until W11). Score asymmetry (finals look "better" per signal because they're retouched) is documented and feeds the training row's `human_confirmed_score`. Pre-W11 we accept the asymmetry; post-W11 the universal vision response carries `is_post_edit` and the prompt adjusts.

- **R3 (slot resolver lives in `_shared/`, not in pass1).** Pure-function regex matcher, no I/O, deterministic. Lives where future callers (W14 calibration) can also reuse it. Tests use historical filename samples committed alongside.

- **R4 (training row weight ignores override bonus for backfill).** The `+0.3 if was_override` weight bonus from spec §14 doesn't apply to backfill rows — no AI ran, no override happened. `weight = 1.0 + 0.2 * (variant_count - 1)` is the formula.

- **R5 (no Pass 0 over finals).** Bracket detection is meaningless on retouched JPEGs (no AEB tags, often single-shot). The `finals-extract` Modal worker creates `composition_groups` rows directly with `file_count=1, source='finals'`. Pass 0 entry point in the dispatcher checks `round.is_historical_backfill` and skips its bracket-detection logic for backfilled rounds.

- **R6 (variant_count derived post-resolution, not at insert).** The training extractor walks all finals for the round, groups by resolved slot_id, sets `variant_count = group_size`. UPDATE-after-INSERT pattern is fine; the count column stays denormalised because read-side queries (Wave 8 prompt construction) need it without a JOIN.

---

## Effort estimate

- Migration (schema + indexes + dedup uniques): 30 min
- `finals-extract` Modal worker: half-day (clone `photos-extract`, strip exiftool, simplify)
- `shortlisting-historical-backfill` edge fn: 1 day (validation, round creation, job enqueue, idempotency)
- `_shared/finalsSlotResolver.ts` + curated regex set + tests: half-day
- `shortlisting-historical-training-extractor` edge fn: half-day (matches RAW ↔ finals, emits training rows)
- Settings page UI: 1 day (project picker, two-input form, validate, progress link)
- Pilot run on 25 projects + slot-resolver QA: 1 day (real-world filename variance testing)

**Total: ~5 days.** The pilot round is critical — historical filename conventions vary by year; the slot-resolver regex set will need iteration after seeing real data.

---

## Out of scope (handled in other waves)

- Curator UI for manual classification of unmatched finals (deferred per Q4 + R6 — punt to Wave 13a follow-up)
- Re-extraction triggered by a tier-config update (Wave 8.3 re-simulation handles this for live rounds; backfill rounds re-extract via the curator UI)
- Negative-example training rows (rejected RAWs that the editor explicitly NOT-shortlisted) — out of scope; the Pass 1 RAW scoring DOES happen but those rows are NOT inserted into training_examples in v1. Wave 14 calibration handles negative examples explicitly.
- W13b (Pulse description goldmine) — sibling spec, separate dependencies (W12 not W7/W8)
- W13c (Floorplan OCR goldmine) — sibling spec, depends on W12

---

## Pre-execution checklist

- [ ] W7.7 shipped (`engine_tier_id` + `package_engine_tier_mapping` resolver available)
- [ ] W8 shipped (`tier_used` + `tier_config_version` columns on training rows; W8.4 specifically)
- [ ] Joseph signs off on Q1 (50-100 stratified), Q2 (revision flag), Q3 ($256 budget, 25-project pilot), Q4 (skip unmatched silently)
- [ ] Migration number reserved at integration time (recommend 342)
- [ ] Pilot project list selected (25 projects across all (package, tier) cells; orchestrator confirms list with Joseph)
- [ ] Slot-resolver regex set reviewed against ≥10 historical projects' real filenames (catch convention drift early)
- [ ] `finals-extract` Modal app deployed under `flexstudios-finals-extract` namespace
- [ ] Cost cap monitoring: a `shortlisting_events` event at "backfill_round_completed" payload includes actual_cost_usd; alert if any single round exceeds 1.5x estimated
