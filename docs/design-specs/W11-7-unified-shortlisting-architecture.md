# W11.7 — Unified Single-Call Shortlisting Architecture — Design Spec

**Status:** ⚙️ Architectural keystone for the next-generation engine. Authored 2026-04-29 from Joseph's questioning of why Pass 1 + Pass 2 are separate.
**Backlog ref:** P1-25 (new)
**Wave plan ref:** W11.7 — collapse Pass 1 + Pass 2 into a single Opus 4.7 call with per-image async description backfill
**Dependencies:** **W11 must ship first** (provides the compact universal-vision-response schema that fits in a single 8k output token budget). Plus W7.6 (block-based prompts), W7.7 (dynamic packages + tier configs), W8 (tier-config weights), W7.5 (mutex), W7.13 (manual-mode), W10.1 (multi-camera partition), W10.3 (override metadata), **W11.8 (multi-vendor adapter — vendor selection becomes runtime config; A/B harness validates Gemini / GPT-4o parity before production rollout)**.
**Unblocks:** the closed-loop "engine grows per project" ethos. Every project's overrides + reclassifications + observed objects feed forward into Opus's prompt context for the next project.

---

## Why this exists

Joseph 2026-04-29: *"if pass 1 is dropped completely, and we purely just send all images to opus 4.7 vision API, can't it then create the same scoring and descriptive results (or even better) compared to current pass 1, AND within context of the whole project, AND do classifications and slot selections and also provide the deductive reasoning/why behind each image and all the objects and attributes and absolutely everything we need?"*

**Yes, it can.** Today's two-pass split (per-image Pass 1 → text-only Pass 2) was a reasonable first design when Sonnet was the strongest available model. With Opus 4.7 and W11's compact per-image schema, a single oracle that sees the full visual universe outperforms the two-pass chain on every measurable axis.

The two-pass design has three architectural costs the unified design eliminates:

1. **Mislabel cascade.** Pass 1 mislabeled IMG_6195 as `exterior_front` despite identifying Hills Hoist + hot water system in the image (both back-yard signals). Pass 2 trusted the label and never considered it for `exterior_rear`. The single oracle sees the contradictory evidence and the cohort simultaneously — no cascade.

2. **Score compression.** Pass 1 anchors per-image scores to the tier's anchor band without cross-image context to differentiate. The unified call sees the full distribution and assigns scores against absolute signal anchors, not tier centroids.

3. **Inert override data.** Round #2 of a project today never sees round #1's overrides. The unified call's prompt explicitly carries `composition_classification_overrides` from prior rounds as authoritative context.

---

## Architecture

### Section 1 — The unified call shape

`shortlisting-unified` (new edge function) replaces `shortlisting-pass1` + `shortlisting-pass2`.

Per round:
1. Round bootstrap reads `projects` (packages, products, pricing_tier) → resolves engine_tier_id + expected_count_target via existing W7.7 helpers
2. Pass 0 still runs first (Haiku hard-reject + bracket detection); produces composition_groups with best_bracket_stem
3. Unified call fires with all preview JPEGs + structured prompt context
4. Pass 3 still runs after (rule-based validator)

#### Inputs the unified call receives

```typescript
interface UnifiedCallInput {
  // Visual universe
  images: Array<{
    composition_group_id: string;
    stem: string;                          // best_bracket_stem from Pass 0
    preview_url: string;                   // 1024px-wide JPEG preview from Modal
    is_secondary_camera: boolean;          // W10.1
    capture_timestamp_ms: number;
    aeb_bracket_value: number | null;
  }>;

  // Round context
  round: {
    id: string;
    package_name: string;
    package_tier_choice: 'standard' | 'premium';
    engine_tier: { code: 'S' | 'P' | 'A'; score_anchor: number };
    expected_count_target: number;
    expected_count_min: number;
    expected_count_max: number;
    engine_role_set: string[];             // ['photo_day_shortlist', ...] from W7.7
  };

  // Slot definitions (from W7.7 product-driven slot eligibility)
  slot_definitions: Array<{
    slot_id: string;
    display_name: string;
    phase: 1 | 2 | 3;
    eligible_room_types: string[];
    max_images: number;
    min_images: number;
    notes: string | null;
  }>;

  // Project memory (W11.5)
  project_memory: {
    prior_overrides: Array<{
      stem: string;
      ai_room_type: string;
      human_room_type: string;
      evidence: string[];
      override_reason: string;
    }>;
    prior_locked_rounds_count: number;
  };

  // Cross-project canonical knowledge (W12)
  canonical_object_registry: Array<{
    canonical_label: string;               // e.g. 'hills_hoist'
    category: string;                      // 'fixture'
    room_type_signal: string | null;       // 'exterior_rear'
    signal_confidence: number;             // 0-1
    market_frequency: number;              // observation count
  }>;

  // Few-shot library (W14 + W11.5)
  active_fewshot_examples: Array<{
    example_kind: 'room_type_correction' | 'composition_correction' | 'reject_pattern';
    ai_value: string;
    human_value: string;
    evidence_keywords: string[];
    description: string;
  }>;

  // Tier-aware engine config (W8)
  active_tier_config: {
    dimension_weights: { technical: number; lighting: number; composition: number; aesthetic: number };
    signal_weights: Record<string, number>;
    hard_reject_thresholds: { technical: number; lighting: number };
  };

  // Engine settings (W7.7 universal)
  engine_settings: {
    pass2_visual_context_enabled: true;   // always true under unified
    fewshot_max_active: number;            // default 20
  };
}
```

#### Outputs the unified call produces

The unified output fits in **~6,000-7,500 tokens** for typical Gold rounds (≤50 composition_groups). Per-image rich descriptions are deferred to the async backfill (Section 3).

```typescript
interface UnifiedCallOutput {
  schema_version: '1.0';
  round_id: string;
  model_version: 'claude-opus-4-7';
  prompt_block_versions: Record<string, string>;  // W7.6 provenance
  
  // Per-image structured data (~80-100 tokens per image)
  compositions: Array<{
    composition_group_id: string;
    stem: string;
    
    // Classification (replaces Pass 1's room_type / composition / vantage)
    room_type: string;
    composition_type: string;
    vantage_point: 'interior_looking_out' | 'exterior_looking_in' | 'neutral';
    image_type: string[];                  // ['day', 'exterior'] etc — W11
    
    // Signal scores (W11 per-signal, 22 absolute 0-10 scores)
    signal_scores: Record<string, number | null>;
    
    // Dimension rollup (W8 weighted)
    dimension_scores: { technical: number; lighting: number; composition: number; aesthetic: number };
    combined_score: number;                 // weighted via active_tier_config
    
    // Evidence (compact — full descriptions go to async backfill)
    key_evidence: string[];                 // 3-5 noun-phrases per image: ['hills_hoist', 'brick_facade', ...]
    observed_objects: Array<{               // W12 substrate
      raw_label: string;
      attributes: Array<{ key: string; value: string }>;  // [{key:'material', value:'caesarstone'}]
      confidence: number;                   // 0-1
    }>;
    
    // Meta
    is_secondary_camera: boolean;
    is_relevant_property_content: boolean;  // W11 — false for headshots/test/BTS
    quarantine_reason: string | null;       // when is_relevant=false
    clutter_severity: 'none' | 'minor_photoshoppable' | 'moderate_retouch' | 'major_reject';
  }>;
  
  // Slot decisions (cross-image judgement)
  slot_decisions: Array<{
    slot_id: string;
    phase: 1 | 2 | 3;
    winner: { stem: string; rationale: string };
    alternatives: Array<{ stem: string; rationale: string }>;  // typically 2
    rejected_near_duplicates: Array<{ stem: string; near_dup_of: string }>;
  }>;
  
  // Slot proposals (W12 hook — model identified taxonomy gaps)
  proposed_slots: Array<{
    proposed_slot_id: string;
    candidate_stems: string[];
    reasoning: string;
  }>;
  
  // Round-level
  coverage_notes: string;
  quality_outliers: Array<{                 // tier-mismatch flags (Q3 from Joseph)
    stem: string;
    actual_score: number;
    expected_for_tier: number;
    direction: 'over_delivered' | 'under_delivered';
    suggestion: string;                     // "consider tier_p pricing for similar listings"
  }>;
}
```

### Section 2 — Multi-message scaling (Joseph's Option C, confirmed 2026-04-29)

For rounds where output would exceed 8k tokens (typically >60 composition_groups), the unified call uses Anthropic's multi-turn conversation pattern with **prompt caching** to keep costs bounded.

#### Scaling tiers

```typescript
function selectExecutionMode(group_count: number): ExecutionMode {
  if (group_count <= 50) return 'single_call';
  if (group_count <= 100) return 'multi_message_2_turn';
  return 'multi_message_3_turn';
}
```

#### Single-call mode (≤50 groups)

One Opus request. Receives all images + full prompt context. Emits the full UnifiedCallOutput in one response.
- Cost: ~$1.20-1.80
- Latency: ~30-60s

#### Multi-message 2-turn (51-100 groups)

```
Request 1:
  cache_control: { type: 'ephemeral', ttl: 300 }  // Anthropic 5-min prompt cache
  messages: [
    { role: 'user', content: [...all images, prompt, "Process compositions 1..N/2"] }
  ]
  → Opus emits compositions[] for the first half (~7k tokens)

Request 2:
  messages: [
    ...Request 1's messages,
    { role: 'assistant', content: <Request 1's response> },
    { role: 'user', content: "Now process compositions N/2+1..N AND emit slot_decisions across all N." }
  ]
  → Opus emits compositions[] for second half + slot_decisions[]
```

With prompt caching: ~$0.80-2.00/round (vs ~$3-5 without caching).
Latency: ~60-120s.

#### Multi-message 3-turn (>100 groups)

Three sequential Opus requests within one logical conversation:
1. Classifications for compositions 1..N/3
2. Classifications for N/3+1..2N/3
3. Classifications for 2N/3+1..N + cross-cohort slot_decisions

With prompt caching:
- Request 1: full price (~$2.50)
- Requests 2 + 3: cached input @ 10% + new output (~$0.80 each)
- Total: ~$4.10 for a 150-group round, ~$5.50 for 200 groups.

### Section 3 — Async description backfill (Sonnet 4.6)

Rich 3-sentence per-image descriptions are NOT in the unified call's output (would break the 8k budget). They're generated immediately after the round opens to the operator via a background job.

#### Trigger
Pass 3 completion → emits `shortlisting_jobs` row of kind `description_backfill` per round.

#### Worker
New edge fn `shortlisting-description-backfill`. For each composition_group in the round:
1. Loads the unified call's output for the round (slot decisions + classification context)
2. Loads the image preview (Modal Dropbox path)
3. Calls Sonnet 4.6 with: image + structured context (round meta, slot decision for this image, key_evidence, observed_objects, near-duplicates)
4. Sonnet emits a 150-word description paragraph
5. Persists to `composition_classifications.analysis` (same column today's Pass 1 writes)

#### Parallelism + cost
35 backfill calls in parallel via `Promise.all` batches. ~$0.015/call × 35 = **$0.53/round**. Latency: ~30-60s post-round.

#### Operator UX
- Round completes → operator sees swimlane with classifications + scores + slot decisions immediately
- "Why?" buttons on each card render skeleton "Generating description..." for ~30-60s, then show the rich text
- Backfill is best-effort — if one Sonnet call fails, that card shows a fallback "Description unavailable; click to retry"

### Section 4 — Project memory (W11.5 hook)

The unified call's prompt assembly (W7.6 block pattern) includes a new `projectMemoryBlock` that loads:

```sql
-- Prior overrides for this project
SELECT
  cg.delivery_reference_stem,
  cco.ai_room_type,
  cco.human_room_type,
  cco.override_reason
FROM composition_classification_overrides cco
JOIN composition_groups cg ON cg.id = cco.group_id
JOIN shortlisting_rounds sr ON sr.id = cco.round_id
WHERE sr.project_id = $current_project_id
  AND cco.human_room_type IS NOT NULL
ORDER BY cco.actor_at DESC
LIMIT 50;
```

Rendered into the prompt as:

```
PROJECT MEMORY (prior operator corrections on this property):
- IMG_6195: AI=exterior_front → operator corrected to exterior_rear.
  Reason: "Hills Hoist + hot water system visible — clearly back yard."
- IMG_6228: AI=living_room → operator corrected to living_secondary.
  Reason: "Upstairs lounge, visually distinct from ground-floor living."

Treat these prior corrections as authoritative for this property.
When images in the current set show similar evidence, apply the same
classification pattern.
```

Opus uses this in its judgement. Round #2 of the same property never re-mislabels IMG_6195.

### Section 5 — Canonical registry context (W12 hook)

Top-200 most-frequent canonical objects from `object_registry` are loaded into the prompt:

```
CANONICAL FEATURE REGISTRY (top 200 by frequency, for cross-project consistency):
- hills_hoist (rotary clothesline): exterior_rear signal, 92% confidence, 47 obs
- caesarstone (engineered stone benchtop): kitchen_main signal, 96%, 80 obs
- subway_tile_splashback: kitchen_main, 87%, 42 obs
- terracotta_tile_roof: exterior signal (any orientation), 99%, 211 obs
- ducted_air_vent: interior signal, 94%, 156 obs
- corrugated_iron_shed: exterior_rear signal, 81%, 28 obs
...
```

Opus uses these as evidence weights. When a previously-unseen project shows a Hills Hoist in a frame, Opus draws on the cross-project pattern even though it has zero direct experience with this property.

### Section 6 — Few-shot examples (W14 hook)

Active examples from `pass1_fewshot_examples` (renamed to `engine_fewshot_examples` post-W11.7) are loaded:

```
EMPIRICAL CORRECTION EXAMPLES (from operator overrides across recent projects):
1. AI labelled exterior_front → human corrected to exterior_rear (8 cases).
   Common evidence: hills_hoist, hot_water_system, garden_tap.
2. AI labelled living_room → human corrected to living_secondary (12 cases).
   Common evidence: vantage_above_main_floor, distinct staircase visible, secondary furniture style.
3. AI labelled bedroom_secondary → human corrected to master_bedroom (5 cases).
   Common evidence: ensuite_door_visible, larger_room_volume, premium_finishes.

Apply these patterns when current images match the evidence keywords.
```

Default cap: 20 examples in active prompt (configurable via `engine_settings.fewshot_max_active`). W14 admin curates which examples graduate to active.

### Section 7 — Scoring under unified architecture

Per-image scores are **absolute against per-signal anchors**, not tier-relative. Stream B anchors block (W7.6) is rewritten:

```
SCORING ANCHORS — USE THE FULL 0-10 RANGE.

5 = MINIMUM acceptable score for the lowest tier (Tier S).
8 = MINIMUM threshold to reach Tier P quality.
9.5 = MINIMUM threshold to reach Tier A.

The tier sets the customer's expectation for the FLOOR of acceptable
quality. It does NOT cap the upper range of scores. A Tier S shoot can
produce a 9.0 if the photographer over-delivered. A Tier A shoot can
produce a 5.0 if the work didn't meet the price-tier expectation.

Score against the absolute per-signal anchors. Do not anchor scores to
the tier's expected score; anchor them to the actual visual quality.

When you find compositions that score >1.5 above the tier's score_anchor,
flag them in `quality_outliers` with direction='over_delivered' and the
suggestion 'consider tier upgrade for similar listings'. Conversely flag
under-delivered shoots so operators can address quality issues with
photographers.
```

Combined score is computed via Wave 8's tier-config weighted rollup over the 4 dimension scores; dimension scores are themselves weighted rollups over the 22 W11 per-signal scores. All anchors absolute, no tier compression by construction.

### Section 8 — Migration from two-pass to unified

#### Phase A — coexistence
Both `shortlisting-pass1` + `shortlisting-pass2` AND `shortlisting-unified` deployed. Engine settings flag `engine_mode: 'two_pass' | 'unified'` toggles per-round. Default: `'two_pass'` for safety; admin flips to `'unified'` after smoke-test confidence.

#### Phase B — pilot
Selected projects (master_admin opt-in) run in `unified` mode. Side-by-side with rounds that ran in `two_pass`. Compare:
- Slot decision agreement rate (should be ≥85% on the same set)
- Override rate (should be ≤ two_pass)
- Operator review duration per card (should be ≤ two_pass since rationale is richer)

#### Phase C — default flip
After pilot succeeds, `engine_settings.engine_mode = 'unified'` becomes default. New rounds use unified by default; legacy rounds remain queryable in their original two-pass output shape (audit-trail integrity).

#### Phase D — deprecation
`shortlisting-pass1` + `shortlisting-pass2` deleted. Their dispatcher chain entries (`pass1`, `pass2` job kinds) marked legacy in the dispatcher. Job replays of historical rounds use a compatibility shim that re-runs unified mode against the historical inputs.

Estimated phase timeline: A=2 weeks, B=4 weeks (parallel runs), C=2 weeks, D=4 weeks. Total ~12 weeks. Coexistence shape lets us roll back at any point if quality regresses.

---

## Migration

Reserve mig **349** (after W7.7=339, W10.1=340, W7.13=341, W10.3=342, W13b=343, W8=344, W12=345, W14=346, W11.5=347, W11.6=348).

```sql
-- 349_unified_shortlisting_engine.sql
-- W11.7: schema additions to support unified architecture coexistence.

-- 1. Engine mode setting
INSERT INTO engine_settings (key, value, description) VALUES
  ('engine_mode',
   '"two_pass"'::jsonb,
   'Wave 11.7: which shortlisting architecture to use. "two_pass" = legacy Pass 1 + Pass 2; "unified" = single Opus call with async description backfill. Master_admin flips to "unified" after pilot validation.')
ON CONFLICT (key) DO NOTHING;

-- 2. Round-level execution-mode stamp (replay reproducibility)
ALTER TABLE shortlisting_rounds
  ADD COLUMN IF NOT EXISTS engine_mode TEXT;
COMMENT ON COLUMN shortlisting_rounds.engine_mode IS
  'Wave 11.7: "two_pass" or "unified". Captured at ingest from the active engine_settings.engine_mode value.';

-- 3. Backfill: existing rounds were two_pass
UPDATE shortlisting_rounds
SET engine_mode = 'two_pass'
WHERE engine_mode IS NULL;

-- 4. Few-shot library table
CREATE TABLE IF NOT EXISTS engine_fewshot_examples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  example_kind TEXT NOT NULL,
  ai_value TEXT,
  human_value TEXT,
  evidence_keywords TEXT[],
  description TEXT,
  in_active_prompt BOOLEAN NOT NULL DEFAULT FALSE,
  observation_count INT NOT NULL DEFAULT 1,
  source_session_id UUID,
  curated_by UUID REFERENCES auth.users(id),
  curated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_fewshot_active ON engine_fewshot_examples(in_active_prompt) WHERE in_active_prompt = TRUE;

NOTIFY pgrst, 'reload schema';
```

---

## Cost model summary

| Round size | Mode | Cost / round |
|---|---|---|
| Small (≤50 groups, typical Gold) | Single Opus call | ~$1.78-2.38 |
| Medium (51-100 groups, premium video) | Multi-message 2-turn + caching | ~$2.50-3.50 |
| Large (101-150 groups, half-day Flex) | Multi-message 3-turn + caching | ~$4.10-5.00 |
| Extra-large (151-200+ groups, multi-day shoots) | Multi-message 3-turn + caching, 2-turn fallback per group-cluster | ~$5.50-8.00 |

In all tiers, async Sonnet description backfill adds ~$0.50-1.00.

**Today's cost: $1.50-3.90/round** (depending on group count).
**Unified cost: $1.78-9.00/round** (linear scaling with size).

The premium-package end is more expensive but the quality lift on those rounds is the highest-leverage business outcome (Tier P/A pricing depends on shortlist quality).

---

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Opus 4.7 quality regresses or is deprecated | `engine_settings.unified_model = 'claude-opus-4-7'` is admin-editable; swap fast |
| Single-call failure mode (whole round fails) | Retry once; on second failure, fall back to legacy `engine_mode='two_pass'` for that one round |
| Output token edge cases on huge rounds | Multi-message scaling; runtime detection at pre-flight |
| Prompt caching invalidation | Anthropic's 5-min cache TTL is sufficient for sequential turns within one round |
| Operator confusion during Phase A coexistence | Settings → Engine Settings displays current `engine_mode` clearly; round metadata pages show which mode produced each historical round |
| W11 schema not yet shipped | This spec hard-blocks on W11. Cannot dispatch implementation until W11 lands |

---

## Open questions for sign-off

**Q1.** Coexistence period length?
**Recommendation:** 4-week pilot (Phase B) before flipping default. Long enough for ~120 unified rounds across operators; short enough to ship the value soon.

**Q2.** Pilot project selection?
**Recommendation:** master_admin opt-in per-project. Allows controlled comparison against fresh two-pass rounds on similar properties.

**Q3.** Description backfill failure UX?
**Recommendation:** show "Description unavailable — retry" link on the card. Operator click → fires single Sonnet call for that image. Reduces blast radius of partial failures.

**Q4.** Should the unified output's `quality_outliers` automatically generate revenue-intelligence notifications?
**Recommendation:** No automatic notification at v1; surface in W11.6 dashboard as a list. After 3 months of data we have a sense of false-positive rate; then decide.

**Q5.** Backwards-compat for legacy rounds?
**Recommendation:** `shortlisting_rounds.engine_mode` stamps per round. Audit JSON includes the stamp. Replay paths read the stamp and route to the right engine version. Simple.

---

## Pre-execution checklist

- [x] W11 universal schema spec exists (this wave depends on its compact per-image shape)
- [x] W7.6 prompt blocks composable (this wave assembles the unified prompt from existing blocks + new ones)
- [x] W7.7 dynamic packages + tier configs (this wave reads them in)
- [x] W8 tier configs versioned (this wave reads active tier_config in)
- [x] W11.5 reclassification spec exists (this wave consumes the override data as project_memory)
- [x] W11.6 rejection dashboard spec exists (this wave's outputs feed it)
- [ ] **W11 must ship before W11.7 implementation begins** (universal schema is the input shape)
- [ ] Joseph signs off on coexistence period (Q1) + pilot mechanism (Q2)
- [ ] Migration 349 reserved at integration time
- [ ] Cost-model agreement: Joseph confirms ~$1.78-9.00/round linear-scaling envelope is acceptable

---

## What this wave kills

- `shortlisting-pass1` edge fn (deleted Phase D)
- `shortlisting-pass2` edge fn (deleted Phase D)
- `pass1` and `pass2` job kinds in dispatcher (legacy-tagged Phase C, removed Phase D)
- Pass 1 → Pass 2 chain coordination logic
- The Pass 1 trust assumption that caused IMG_6195's mislabel

## What this wave preserves (unchanged)

- Pass 0 (Haiku hard-reject + bracket detection) — still runs first
- Pass 3 (rule-based validator) — still runs last
- All composition_groups + composition_classifications + shortlisting_overrides + shortlisting_rounds tables (additive only)
- The lock + audit JSON pipeline (W7.4 / W7.5)
- The dispatcher mutex (W7.5)
- Manual mode (W7.13)
- The frontend swimlane (rendering against `composition_classifications.analysis` and slot decisions same as today)
- W7.6 composable prompt blocks (reused; new blocks added)
- W7.7 dynamic packages
- W8 tier configs

## Effort estimate

- 1 day: spec finalisation + Joseph sign-off
- 2 days: `shortlisting-unified` edge fn (assembly, prompt construction, multi-message handler, prompt caching wiring)
- 2 days: `shortlisting-description-backfill` edge fn + Sonnet integration
- 2 days: dispatcher chain updates (collapse pass1+pass2 into unified job kind; add description_backfill job kind)
- 1 day: migration 349 + admin UI for engine_settings.engine_mode toggle
- 2 days: tests (unit for prompt assembly; integration for multi-message; smoke for backfill)
- 1 day: cost-monitoring dashboard (real-time per-round cost surfaced in W11.6)
- 1 day: docs (deployment runbook, replay paths, rollback procedure)
- **Total: ~12 days execution + 4-week pilot before default flip**

This is the largest single wave of work since W7.7 + W11. Justified by the architectural compounding it unlocks for every downstream wave.
