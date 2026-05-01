# W14 — Structured Calibration Suite (Shape D Engine Drift Detection)

**Status:** Shipped 2026-05-01 (runner + dashboard + 5-project smoke gated by Joseph sign-off).
**Wave plan ref:** Wave 14 — calibration measurement; subsumes the prior W14 editor-blind-labelling
spec at `docs/design-specs/W14-calibration-session.md` (now demoted to "v0 — superseded").
**Dependencies:**
- **Shape D engine live** — Stage 1 + Stage 4 deployed and smoke-validated against Rainbow Cres
  (round c55374b1) and Saladine (round 3ed54b53) on 2026-05-01.
- **Hygiene fixes shipped** — Stage 4 dedup, slot_id canonicalisation (mig 384), canonical-rollup
  auto-trigger. Calibration measures the engine in its post-hygiene state; pre-hygiene runs are
  excluded from comparisons.
- **W11.7.1 Wave 2A** — `engine_run_audit` provenance per round so we can compare apples-to-apples.

---

## Goal

Wave 14 measures Shape D engine consistency across a stratified historical sample so Joseph can
see at a glance where the engine drifts between regen runs. It surfaces three feedback loops —
score consistency, slot-decision agreement, regression escalation — through a single calibration
dashboard. The output is a closed loop: dashboard flags drift → operator drills into the round →
Stage 4 override or prompt-block tuning closes the gap before the next regen.

**Not in scope:** auto-tuning, prompt-block changes, and the full 50-project run. This wave ships
the measurement infrastructure and a 5-project smoke. Joseph signs off on the smoke before the full
run is dispatched (one-shot manual trigger from the dashboard).

---

## Sampling strategy

### Target (full run)

50 projects total, stratified to mirror FlexMedia's market mix:

| Tier         | Count | Rationale                                        |
| ------------ | ----- | ------------------------------------------------ |
| Premium      | 17    | High-touch tier; word_count band 700-1000        |
| Standard     | 25    | Bulk volume; word_count band 500-750             |
| Approachable | 8     | Cheap-path tier; word_count band 350-500         |
| **Total**    | **50** |                                                 |

Within each tier, the runner aims for a **50/50 well-photographed vs challenging split**:
- "Well-photographed" = round had ≤2 stage_4_overrides on prior run (clean shoot signal)
- "Challenging" = round had ≥4 stage_4_overrides on prior run, OR `clutter_severity` flagged
  on ≥10% of compositions, OR mixed light (`time_of_day` heterogeneity ≥2 distinct values)

The challenging split is the diagnostic signal — these are the rounds where drift hurts most.

### Selection method

Two modes:
1. **Operator-supplied:** `{ project_ids: [uuid, …] }` — Joseph hand-picks, runner accepts as-is.
2. **Auto-sample:** `{ auto_sample: true, n: 50, seed: <integer> }` — runner does:
   ```
   For each tier in [premium, standard, approachable]:
     SELECT project_id FROM (
       SELECT DISTINCT ON (p.id)
         p.id, sr.id AS round_id, era.engine_mode,
         (SELECT COUNT(*) FROM shortlisting_stage4_overrides
          WHERE round_id = sr.id) AS prior_override_count
       FROM projects p
       JOIN shortlisting_rounds sr ON sr.project_id = p.id
       JOIN engine_run_audit era ON era.round_id = sr.id
       WHERE p.property_tier = ?
         AND era.engine_mode LIKE 'shape_d%'
         AND sr.status IN ('proposed','locked','delivered')
       ORDER BY p.id, sr.created_at DESC
     ) candidates
     ORDER BY md5(id::text || ?::text) -- deterministic seed
     LIMIT ?
   ```
   Half the per-tier slice with `prior_override_count <= 2` (well), half with `>= 4`
   (challenging). The seed is cached on `engine_calibration_run_summaries.seed` so the same
   sample is reproducible — re-runs use the same projects, which is the basis for delta math.

### Reality vs target

As of 2026-05-01 the production system has **2 Shape D rounds total** (Rainbow Cres + Saladine).
The runner is built to work with whatever's there — `n` is interpreted as a ceiling. The 5-project
smoke runs against ALL available Shape D rounds (currently 2; will grow as backfills land).

---

## Metrics

### Score consistency

For each composition with a classification on both prior_run_id and current_run_id:
- Per-axis delta: `|technical_now - technical_prior|` (and same for lighting / composition / aesthetic)
- Per-image overall: `max` across the four axes
- Aggregates: `median`, `p95`, `max` across all compositions in the round

A "drift event" fires when `max > 0.5` on any axis. Drift event count per round is exposed in
the dashboard.

**Acceptance:** median per-axis delta `< 0.3`. >0.3 = engine is non-deterministic enough that
human consumers will notice.

### Slot agreement

For each slot_id present in BOTH prior and current run:
- `winning_stem_prior` = `shortlisting_overrides.ai_proposed_group_id` joined to
  `composition_groups.canonical_stem` for the most-recent prior `human_action='approved_as_proposed'`
  row (or fall back to `proposed_shortlist_group_ids[index]`).
- `winning_stem_now` = same path, post-current-run.
- `agreement = winning_stem_prior == winning_stem_now`

Slot-agreement % per round = matched slots / total slots present in both runs.

**Acceptance:** `slot_agreement_pct >= 0.80`. <80% means Stage 4's slot decisions are unstable
between regens — Joseph would have to re-pick on every run.

### Master listing word_count + reading_grade_level

Per-tier acceptance bands (from W11.7.7 spec):

| Tier         | word_count band | reading_grade_level band |
| ------------ | --------------- | ------------------------ |
| premium      | 700-1000        | 9-11                     |
| standard     | 500-750         | 8.5-10.5                 |
| approachable | 350-500         | 8-10                     |

`out_of_band = word_count_in_band ? 0 : 1` per round. Drift signal: out-of-band rate >10%.

### Override emission rate

`override_rate = stage_4_override_count / total_compositions` per round.

| Healthy band | Signal |
| ------------ | ------ |
| 0.02 - 0.08 | Stage 1 prompt is well-tuned; Stage 4 corrects edge cases only |
| < 0.02       | Stage 4 might be too conservative (false negative) |
| > 0.12       | Stage 1 prompt is unstable — too many corrections needed |

**Acceptance:** override_rate ∈ [0.02, 0.08].

### Regression count

A regression = a composition whose `clutter_severity` escalated between runs:
- `none → minor_photoshoppable` (NEW concern flagged)
- `minor_photoshoppable → moderate_retouch`
- `moderate_retouch → major_reject`

UNLESS the round has an operator-flagged change in `shortlisting_overrides` since the prior run
(meaning a human asked for a re-eval — the regression is intentional).

`regression_count_pct = regressions / total_compositions`.

**Acceptance:** `regression_count_pct < 0.02`. >2% = the engine is randomly hardening its judgement
across regens, which would surface as "AI getting more pessimistic" complaints from operators.

### Per-tier voice register self-report

`shortlisting_master_listings.master_listing -> 'tone_anchor'` is a free-text field where the model
self-reports the voice it was anchoring to (e.g. "Mosman premium — restrained, architectural").
The calibration computes per-tier tone-anchor stability:

```
For each tier, group rounds by tone_anchor (lower-cased, normalised).
Stability = (1 - distinct_anchors / total_rounds_in_tier).
```

>0.7 = consistent voice. <0.5 = the model is improvising voices per round → signal for prompt tuning.
Surfaced in the dashboard as a free-text panel below the per-project table.

---

## Acceptance criteria (overall pass/fail)

A calibration run is "passing" iff ALL of:

1. Median score delta `< 0.3` per axis (technical / lighting / composition / aesthetic)
2. Slot agreement `>= 0.80` (median across rounds)
3. Override rate ∈ [0.02, 0.08] (median across rounds)
4. Regression count `< 0.02` (median across rounds)
5. Master listing out-of-band rate `<= 0.10`

Any one of these failing → dashboard surfaces the failing axis with a red banner and a "Drill down"
link to the worst-offending project's shortlisting subtab.

---

## Cost model

| Component                | Per-project cost        |
| ------------------------ | ----------------------- |
| Stage 1 (Gemini 2.5 Pro) | ~$0.50 (avg 35 images, ~$0.014/image) |
| Stage 4 (Gemini 2.5 Pro) | ~$0.13 (single multi-image call) |
| Total                    | **~$0.63 / project**    |

50 projects × $0.63 = **$31.50 budget**, rounded up to **$32**.

Hard cap: per-round `cost_cap_per_round_usd` (engine_settings, default $10) still applies — the
runner respects the existing per-round guard, so a runaway round can't burn the calibration budget.

5-project smoke = ~$3.15.

---

## Architecture

### Edge function: `shortlisting-calibration-runner`

POST `{ project_ids: [uuid, …] }` OR `{ auto_sample: true, n: number, seed?: number }`.

Steps:
1. **Auth gate.** master_admin only.
2. **Reentrancy guard.** Refuse if a `calibration_started` event was emitted in the last 30 min
   without a paired `calibration_complete`. Same pattern as `shortlisting-benchmark-runner`.
3. **Sample resolution.** Either accept `project_ids` as-is, or run the deterministic-seed
   stratified sampler against `engine_run_audit` JOIN `shortlisting_rounds` JOIN `projects`.
   Cap at `n=50` regardless.
4. **Pre-run snapshot.** For each project's most-recent Shape D round:
   ```
   {
     round_id, project_id, project_tier,
     classifications: [{ group_id, stem, technical, lighting, composition, aesthetic, clutter_severity }],
     slot_decisions: [{ slot_id, winning_stem }],   -- from shortlisting_overrides
     overrides: [{ stem, field, stage_1_value, stage_4_value }],
     master_listing: { word_count, reading_grade_level, tone_anchor }
   }
   ```
5. **Round reset + enqueue.** Per round:
   - UPDATE `shortlisting_rounds SET status='processing'` (idempotent — keeps DB invariants happy
     for downstream consumers).
   - INSERT one `shortlisting_jobs` row of `kind='shape_d_stage1'` with `status='pending'`.
   - The dispatcher (cron-ticked, every minute) picks up + serializes naturally — we DON'T
     direct-invoke; serialization is the dispatcher's job.
6. **Insert `engine_calibration_runs` parent row** with status `'running'` and `started_at=NOW()`.
   Insert one `engine_calibration_runs` per project (status=`'pending'`).
7. **Wait + poll.** Poll `shortlisting_jobs WHERE round_id = ANY($)` every 30s for up to 60min.
   Round is "done" when:
   - Stage 1 job (`kind='shape_d_stage1'`) succeeds AND
   - Stage 4 job (`kind='stage4_synthesis'`) terminal status is `succeeded`/`failed`/`dead_letter`.
   The runner exits early if all rounds are done, else times out at 60min.
8. **Post-run capture + diff.** Same shape as pre-run; compute the metrics listed above.
9. **Persist.** UPDATE the per-project `engine_calibration_runs` row with the metrics + jsonb
   blobs. UPDATE the parent `engine_calibration_run_summaries` row with the aggregates +
   pass/fail.
10. **Emit `calibration_complete` event** on `shortlisting_events` with the run_id and
    overall pass/fail.
11. **Return JSON summary.** The dashboard renders this directly without a re-fetch.

**Wall-clock note:** edge functions on Supabase Pro have a ~400s wall-clock cap. Polling for
60min won't fit in one invocation. The runner uses `EdgeRuntime.waitUntil` to background-process
after returning the run_id immediately — the dashboard polls `engine_calibration_run_summaries`
to reflect status. This mirrors the Stage 1 fast-ack pattern Shape D already uses.

### Schema: migration 384a (next free)

`engine_calibration_run_summaries` (one row per calibration run):

| column                   | type        | notes                                  |
| ------------------------ | ----------- | -------------------------------------- |
| id                       | uuid        | PK                                     |
| run_id                   | text        | natural ID (timestamp + nonce)         |
| started_at               | timestamptz | NOW() at create                        |
| finished_at              | timestamptz | nullable until complete                |
| status                   | text        | 'running' / 'completed' / 'failed'     |
| seed                     | bigint      | sampling seed (NULL if operator-picked)|
| n_projects_requested     | int         | what the operator asked for           |
| n_projects_dispatched    | int         | actual dispatched count                |
| n_projects_completed     | int         | succeeded by deadline                  |
| total_cost_usd           | numeric(8,4)| sum across all projects                |
| median_score_delta       | numeric(4,2)| max-axis median across projects        |
| median_slot_agreement    | numeric(5,4)| % across projects                      |
| median_override_rate     | numeric(5,4)| % across projects                      |
| median_regression_pct    | numeric(5,4)| % across projects                      |
| master_listing_oob_rate  | numeric(5,4)| % out-of-band across projects          |
| voice_anchor_stability   | numeric(5,4)| 0..1 across rounds (per-tier weighted) |
| acceptance_pass          | boolean     | TRUE iff all 5 acceptance criteria met |
| failed_criteria          | text[]      | which criterion failed if !pass        |
| summary_jsonb            | jsonb       | full structured summary for dashboard  |

`engine_calibration_runs` (one row per project per calibration run):

| column                   | type        | notes                                  |
| ------------------------ | ----------- | -------------------------------------- |
| id                       | uuid        | PK                                     |
| run_id                   | text        | FK to summary                          |
| project_id               | uuid        | FK projects                            |
| round_id                 | uuid        | the round we re-ran                    |
| status                   | text        | 'pending' / 'running' / 'completed' / 'failed' |
| started_at               | timestamptz |                                        |
| finished_at              | timestamptz | nullable                               |
| score_consistency_jsonb  | jsonb       | { median, p95, max, drift_events: [] } |
| slot_agreement_pct       | numeric(5,4)|                                        |
| slot_diff_jsonb          | jsonb       | per-slot agreement detail              |
| override_rate            | numeric(5,4)|                                        |
| override_count           | int         |                                        |
| regression_count         | int         |                                        |
| regression_pct           | numeric(5,4)|                                        |
| master_listing_in_band   | boolean     | based on tier band                     |
| word_count_now           | int         |                                        |
| reading_grade_level_now  | numeric(4,2)|                                        |
| tone_anchor_now          | text        |                                        |
| cost_usd                 | numeric(8,4)| Stage 1 + Stage 4 cost for THIS run    |
| pre_run_snapshot         | jsonb       | full pre-state                         |
| post_run_snapshot        | jsonb       | full post-state                        |
| error_message            | text        | nullable, set on failure                |

RLS: master_admin / admin SELECT; service-role INSERT / UPDATE; master_admin DELETE only.

### Frontend: `CalibrationDashboard.jsx`

Route: `/CalibrationDashboard`, gated by `PermissionGuard require={['master_admin']}`.

Sections (top → bottom):
1. **Summary header card.** Latest run timestamp, total projects dispatched/completed, $ spent,
   pass/fail badge per acceptance criterion (5 chips colour-coded green/red).
2. **Re-run button + Download CSV button.** Re-run invokes the runner with the same seed.
   CSV exports per-project rows.
3. **Per-project table.** Columns: project name, tier, score-consistency (color-coded
   red/amber/green by median delta), slot agreement, override rate, regression count.
   Each row links to `/ProjectDetails?id=<uuid>&tab=shortlisting`.
4. **Drift table (top-10 worst).** Sorted by `MAX(score_delta_max, 1 - slot_agreement, override_rate - 0.08, regression_pct)`.
5. **Voice anchor stability panel.** Per-tier breakdown.

Style mirrors `DispatcherPanel.jsx` (compact, slate-tinted cards, tabular-nums for numeric cells).

---

## Tests

`supabase/functions/_shared/calibrationMath.test.ts` — pure-helper tests:
1. **Score-delta calc:** 4 dimensions, all-equal returns 0; one dim shifted by 1.0 returns 1.0
   on that dim and max=1.0.
2. **Slot agreement %:** 5 slots, 4 match → 0.8; 0 slots → returns null (not /0).
3. **Regression detection:** prior=`none`, now=`minor_photoshoppable` → regression.
   prior=`minor_photoshoppable`, now=`none` → NOT a regression (improvement).
4. **Master listing in-band:** premium/720 → true; premium/650 → false (below band).
5. **Stratified sampler determinism:** same seed → same output for same input.
6. **Acceptance pass/fail:** all green → `acceptance_pass=true`; single criterion failing →
   `acceptance_pass=false` with that criterion in `failed_criteria`.

---

## Smoke run (5-project gate)

Per Joseph's standing rule: smoke first, full run gated.

The 5-project smoke runs against the available Shape D rounds (as of 2026-05-01: Rainbow Cres +
Saladine). The dashboard renders results, Joseph reviews, and only then is the full 50-project
run dispatched.

Smoke acceptance: runner completes without timeouts, summary JSON renders correctly in the
dashboard, and the metrics sanity-check (no NaN, no nulls in required fields). The pass/fail
math is informational on the smoke — only the full 50-project run is binding.

---

## Out of scope

- Auto-tuning weights from drift events (Wave 16+).
- Prompt-block diff / version comparison (calibration measures the *current* engine; comparing to
  prior prompt versions requires the prompt-version snapshot which is a separate wave).
- Editor-supplied ground truth (the v0 W14 spec at `W14-calibration-session.md` covers that — it's
  a different wave shape).
- Cross-vendor compare (Anthropic vs Gemini). vendor_shadow_runs already covers this.

---

## Pre-execution checklist

- [x] Migration 384a applied
- [x] `shortlisting-calibration-runner` deployed
- [x] CalibrationDashboard route added
- [x] 6 calibrationMath tests pass
- [ ] 5-project smoke run dispatched + results reviewed by Joseph
- [ ] Joseph green-lights full 50-project run via dashboard "Run full" button (out of scope here —
      Joseph triggers manually post-smoke)
