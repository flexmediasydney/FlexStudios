# W11.5 — Human Reclassification Capture — Design Spec

**Status:** ⚙️ Future wave — depends on W11 (universal vision schema) + W11.7 (Shape D multi-stage architecture). Authored 2026-04-29 from Joseph's question on whether operators can override Stage 1's room_type / slot / score; terminology refreshed 2026-04-30 to align with the rewritten W11.7 (Gemini-anchored Shape D, 5-call multi-stage).
**Backlog ref:** P1-23 (new)
**Wave plan ref:** W11.5 — operator-driven correction of Shape D mislabels feeds the closed-loop learning system
**Dependencies:** W11 (per-signal scoring schema), W11.7 (Shape D multi-stage architecture — overrides feed `project_memory` consumed in Stage 1's prompt context), W12 (object_registry — for the cross-project canonical-feature memory path)
**Unblocks:** materially better Shape D engine accuracy via empirically-grown few-shot library; project-scoped re-runs that respect operator corrections

---

## ⚡ Architectural alignment (2026-04-30)

This spec was originally authored against the "single Opus call + Sonnet backfill" framing. Under the rewritten W11.7 (`docs/design-specs/W11-7-unified-shortlisting-architecture.md`), the engine is now a **Shape D multi-stage call**: 3-4 Stage 1 batch calls × 50 images each (full per-image enrichment), followed by 1 Stage 4 visual master synthesis call across all 200 images. This wave still becomes simpler AND higher-leverage:

- **Simpler:** instead of modifying multiple passes to respect overrides, only Stage 1's prompt assembly (W7.6 block pattern) needs the new `projectMemoryBlock` that loads `composition_classification_overrides` rows.
- **Higher-leverage:** the override data feeds Stage 1's prompt context as `project_memory`, so round #2 of the same project respects it directly — and after W12, the same data feeds cross-project canonical registry.
- **Two override classes:** v1 captures both (a) **Stage 1 overrides** — operator corrects a per-image classification (room_type / composition / vantage / score) — and (b) **Stage 4 overrides** — Stage 4's visual master synthesis already corrected a Stage 1 mistake (different image won the slot than Stage 1 alone would have predicted), and the operator confirms or further refines that correction. Both classes share the same table; `override_source` distinguishes which stage was being corrected.
- **Few-shot feedback loop:** W11.5 reclassifications populate the `pass1_fewshot_examples` library that Stage 1 reads on every subsequent batch call, so the engine learns from each operator correction without code changes.

Section references below to "Pass 1" / "Pass 2" should be read as **Stage 1** (per-image enrichment) and **Stage 4** (visual master synthesis) under the Shape D engine.

---

## Problem (Joseph 2026-04-29)

Stage 1 sometimes mislabels images. The 13 Saladine review surfaced IMG_6195 — a clearly-rear shot (Hills Hoist clothesline, hot water system, both back-of-house signals) classified as `exterior_front`. Stage 4 traditionally trusted Stage 1's room_type label and never considered IMG_6195 for the `exterior_rear` slot, leaving the operator with no path to correct the routing without re-running the round (which produces the same mislabel). Under Shape D's visual master synthesis, Stage 4 *can* override Stage 1's label across all 200 images — but operators still need a path to lock in corrections that survive future rounds.

**Today's operator capabilities:**
- Drag to approve/reject ✓
- Swap to alternative ✓
- Annotate signal reason after rejection ✓ (W10.3)
- **Reclassify a misidentified room_type** ❌
- **Override a composition_type / vantage_point** ❌
- **Manually adjust a score** ❌
- **Add a new slot eligibility for a composition** ❌
- **Confirm / refine a Stage 4 correction of a Stage 1 label** ❌

The fundamental engine ethos — *grow with each operator response* — is undercut when the operator can't correct what the model got demonstrably wrong, OR confirm when the model's own internal cross-stage correction was right.

---

## Architecture

### Section 1 — Project-scoped reclassification (`composition_classification_overrides`)

New table:

```sql
CREATE TABLE composition_classification_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES composition_groups(id) ON DELETE CASCADE,
  round_id UUID NOT NULL REFERENCES shortlisting_rounds(id) ON DELETE CASCADE,
  -- Which stage emitted the value the operator is correcting / confirming
  override_source TEXT NOT NULL DEFAULT 'stage1'
    CHECK (override_source IN ('stage1', 'stage4')),
  -- Original AI values (denormalised so we can replay the override decision)
  ai_room_type TEXT,
  ai_composition_type TEXT,
  ai_vantage_point TEXT,
  ai_combined_score NUMERIC(4, 2),
  -- Human overrides (only the fields the operator actually corrected; null = accept AI)
  human_room_type TEXT,
  human_composition_type TEXT,
  human_vantage_point TEXT,
  human_combined_score NUMERIC(4, 2),
  human_eligible_slot_ids TEXT[],   -- explicit slot eligibility override (e.g. add 'exterior_rear' to a slot list)
  override_reason TEXT,              -- free-text capture of WHY (consumed by W11.6 dashboard)
  override_notes TEXT,               -- internal notes
  -- actor_user_id: human author of the override.
  -- W11.7 cleanup (mig 379_2) relaxed this to NULLABLE specifically for
  -- override_source='stage4_visual_override' rows — those are authored by
  -- the W11.7 Stage 4 visual master synthesis engine, not a human. A CHECK
  -- constraint enforces NOT NULL when override_source IN ('stage1_correction',
  -- 'master_admin_correction'). The authoritative audit trail for stage4
  -- engine overrides lives in shortlisting_stage4_overrides.
  actor_user_id UUID REFERENCES auth.users(id),
  actor_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT actor_required_chk CHECK (
    (override_source IN ('stage1_correction', 'master_admin_correction')
       AND actor_user_id IS NOT NULL)
    OR (override_source = 'stage4_visual_override')
  ),
  UNIQUE (group_id, round_id, override_source)  -- one override per group per round per stage
);

CREATE INDEX idx_class_overrides_round ON composition_classification_overrides(round_id);
CREATE INDEX idx_class_overrides_actor ON composition_classification_overrides(actor_user_id);
CREATE INDEX idx_class_overrides_human_room_type ON composition_classification_overrides(human_room_type)
  WHERE human_room_type IS NOT NULL;
```

### Section 2 — Stage 4 reads the COALESCE'd values via project_memory

Under the Shape D engine, the `shortlisting-shape-d` orchestrator loads `composition_classification_overrides` rows for the current project at round-start and injects them into the Stage 1 prompt as `project_memory` (per W11.7's prompt-block contract). Stage 4's visual master synthesis then sees authoritative human-corrected values when computing slot decisions across all 200 images.

```typescript
// Round-start: orchestrator builds project_memory
const overrides = await fetchProjectOverrides(project_id);
const projectMemoryBlock = renderProjectMemoryBlock(overrides);

// Stage 1 batch call (per 50-image batch)
const stage1Prompt = assembleStage1Prompt({ projectMemoryBlock, /* ... */ });

// Stage 4 visual master synthesis reads COALESCE'd values
const room_type = override?.human_room_type ?? stage1.composition_classification.room_type;
// Same pattern for composition_type, vantage_point, combined_score
```

**Effect:** when operator reclassifies IMG_6195 from `exterior_front` to `exterior_rear` in round N, round N+1 (next ingest of same project) routes IMG_6195 to the exterior_rear slot via `project_memory`. Stage 1 may still emit its original guess on a fresh image, but the override row persists across rounds for the same group and is authoritative once Stage 4 sees it.

### Section 3 — Frontend (engine swimlane only)

New `ReclassifyMenu` component on `ShortlistingCard.jsx` (engine mode only — manual mode has no Stage 1 / Stage 4 to reclassify against):

- Right-click or "..." menu on each card → "Reclassify"
- Modal opens with:
  - Current Stage 1 values (room_type, composition_type, vantage_point, combined_score) shown read-only
  - Stage 4 corrected values (when `override_source='stage4'`) shown as "Engine corrected during synthesis" pill so the operator sees the cross-stage delta
  - Override fields: dropdown for room_type (from `eligible_room_types` registry), composition_type (from taxonomy), vantage_point (3 values), score slider (0-10)
  - `eligible_slot_ids` multiselect (default = inferred from new room_type via slot_definitions)
  - `override_reason` free-text required field (≥ 20 chars)
  - "Save override" → POST to new edge fn `reclassify-composition`

Visual indication on cards with active overrides: amber border + "Reclassified" badge; clicking the badge opens read-only diff modal. Cards where Stage 4 visually corrected Stage 1 (without operator action) display a separate "Engine self-corrected" badge — clicking it opens the Stage 1 → Stage 4 diff and offers a one-click "Confirm" button that writes a `stage4`-source override row.

### Section 4 — Edge fn `reclassify-composition`

```typescript
// supabase/functions/reclassify-composition/index.ts (new)

interface ReclassifyRequest {
  group_id: string;
  round_id: string;
  override_source: 'stage1' | 'stage4';  // which stage's value is being corrected/confirmed
  human_room_type?: string;
  human_composition_type?: string;
  human_vantage_point?: string;
  human_combined_score?: number;
  human_eligible_slot_ids?: string[];
  override_reason: string;          // required
  override_notes?: string;
}

// 1. Auth: master_admin / admin / manager (employees can suggest but not commit per RLS)
// 2. Validate: room_type must exist in shortlisting_room_types registry; combined_score in [0,10]
// 3. UPSERT composition_classification_overrides row (keyed on group_id + round_id + override_source)
// 4. Emit shortlisting_events.event_type='human_reclassification' with the diff
// 5. Return the override row + a "next-round impact preview" (which slots would change)
```

The "next-round impact preview" runs the slot-resolver against the override + remaining ai-classifications and surfaces "If we re-ran Stage 4 now, IMG_6195 would route to exterior_rear and IMG_6210 would lose its winner status to a closer match." Operator sees the consequence before committing.

### Section 5 — Cross-project canonical memory (W12 hook)

When an operator's reclassification cites specific evidence in `override_reason` (e.g. "Hills Hoist visible — clearly back yard"), Wave 12's `object_registry` extracts the noun-phrase (`Hills Hoist`) and records:

```sql
-- Inside object_registry (mig 345 from W12)
canonical_label: 'hills_hoist'
category: 'fixture'
market_frequency: NN  -- bumped on each new observation
room_type_signal: 'exterior_rear'  -- learned from N reclassifications citing it
room_type_signal_confidence: 0.9   -- N matches / N total observations
```

After ~10 reclassifications citing "Hills Hoist" as the disambiguator, Wave 12's normalisation pipeline writes a new row to `attribute_values`:

```
object_id: <hills_hoist's id>
attribute_key: 'room_type_signal'
value_text: 'exterior_rear'
confidence: 0.9
observation_count: 10
```

Wave 11's Stage 1 prompt block `objectsAndAttributes` then primes the model:

> "When the image contains any of these registry-canonical objects, weight room_type per the listed signal: hills_hoist → exterior_rear (90% confidence, 10 observations)."

**Net effect:** by the 11th project where IMG_6195-style mislabel could happen, Stage 1 has **empirically-grown evidence** that Hills Hoist is a back-yard signal, regardless of facade dominance in the frame. This is the closed-loop ethos working.

### Section 6 — Few-shot library for Stage 1 (Wave 14 hook)

Every W11.5 reclassification — whether sourced from a Stage 1 mislabel or a confirmed Stage 4 self-correction — populates the `pass1_fewshot_examples` library that Stage 1 reads on every batch call. W14 calibration session also captures 50 stratified projects' editor decisions including reclassifications. The combined output feeds a `pass1_fewshot_examples` table:

```sql
CREATE TABLE pass1_fewshot_examples (
  id UUID PRIMARY KEY,
  example_kind TEXT NOT NULL,        -- 'room_type_correction' | 'composition_type_correction' | ...
  ai_value TEXT,
  human_value TEXT,
  evidence_keywords TEXT[],          -- ['hills_hoist', 'rotary_clothesline']
  evidence_image_path TEXT,           -- Dropbox path to the actual image (not bundled in prompts; reference for review)
  in_active_prompt BOOLEAN DEFAULT TRUE,
  observation_count INT,
  source_session_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

Wave 11's Stage 1 prompt assembly conditionally injects the top-N most-frequent few-shot examples (Wave 14 admin curates which ones graduate from raw observation to active prompt material):

> "EMPIRICAL CORRECTION EXAMPLES: 8 cases where Stage 1 said `exterior_front` but operators corrected to `exterior_rear`. Common evidence: Hills Hoist clothesline, hot water system, garden tap. When you see these elements in the frame, prefer `exterior_rear` even if the facade is prominent."

This is what "engine grows with each project" actually means in concrete terms.

---

## Migration

Reserve **next-available** at integration time. Recommend `347_composition_classification_overrides.sql` (after W7.7=339, W10.1=340, W7.13=341, W10.3=342, W13b=343, W8=344, W12=345, W14=346).

---

## Effort estimate

- 0.5 day backend (table + edge fn + RLS)
- 1 day frontend (ReclassifyMenu component + impact-preview modal + Stage 4 self-correction "Confirm" badge)
- 0.5 day Stage 4 plumbing (COALESCE override into the visual master synthesis data assembly + Stage 1 `project_memory` block)
- 0.5 day tests + audit JSON extension
- Total: **~2.5 days**

---

## Open questions for sign-off

**Q1.** Override scope — project-only or global?
**Recommendation:** **Project-only at v1.** A reclassification on Saladine's IMG_6195 doesn't auto-fix every Hills Hoist mislabel everywhere — that's W12's job via canonical registry. Project-scoped overrides are conservative and let operators correct the immediate problem without unintended cross-project effects.

**Q2.** Score override authority — should it count for benchmark replay?
**Recommendation:** **Yes, but tag it.** Add `human_combined_score_authoritative BOOLEAN` so W14 calibration / W8 benchmarks can choose to weight overridden scores higher than AI-only (operator hand-grading is ground-truth-er than Sonnet output). Default TRUE for master_admin reclassifications, FALSE for manager-level edits.

**Q3.** Bulk reclassification UX?
**Recommendation:** **Defer to v2.** v1 ships per-card. After 6 weeks of usage, observe if "select 5 cards → set room_type=exterior_rear" is a real operator need. Easy to add later.

---

## Pre-execution checklist

- [x] W11 spec exists (universal vision response schema is the consumer of the few-shot library)
- [x] W12 spec exists (object_registry receives the cross-project canonical memory)
- [x] W14 spec exists (calibration session generates the few-shot bank)
- [ ] Joseph confirms project-scoped scope at v1
- [ ] Joseph confirms human_combined_score_authoritative=TRUE default for master_admin
- [ ] Migration number reserved at integration time
