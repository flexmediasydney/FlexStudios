# W11.5 — Human Reclassification Capture — Design Spec

**Status:** ⚙️ Future wave — depends on W11 (universal vision schema). Authored 2026-04-29 from Joseph's question on whether operators can override Pass 1's room_type / slot / score.
**Backlog ref:** P1-23 (new)
**Wave plan ref:** W11.5 — operator-driven correction of Pass 1 mislabels feeds the closed-loop learning system
**Dependencies:** W11 (per-signal scoring), W12 (object_registry — for the cross-project canonical-feature memory path)
**Unblocks:** materially better Pass 1 accuracy via empirically-grown few-shot library; project-scoped re-runs that respect operator corrections

---

## Problem (Joseph 2026-04-29)

Pass 1 sometimes mislabels images. The 13 Saladine review surfaced IMG_6195 — a clearly-rear shot (Hills Hoist clothesline, hot water system, both back-of-house signals) classified as `exterior_front`. Pass 2 trusted Pass 1's room_type label and never considered IMG_6195 for the `exterior_rear` slot, leaving the operator with no path to correct the routing without re-running the round (which produces the same mislabel).

**Today's operator capabilities:**
- Drag to approve/reject ✓
- Swap to alternative ✓
- Annotate signal reason after rejection ✓ (W10.3)
- **Reclassify a misidentified room_type** ❌
- **Override a composition_type / vantage_point** ❌
- **Manually adjust a score** ❌
- **Add a new slot eligibility for a composition** ❌

The fundamental engine ethos — *grow with each operator response* — is undercut when the operator can't correct what the model got demonstrably wrong.

---

## Architecture

### Section 1 — Project-scoped reclassification (`composition_classification_overrides`)

New table:

```sql
CREATE TABLE composition_classification_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES composition_groups(id) ON DELETE CASCADE,
  round_id UUID NOT NULL REFERENCES shortlisting_rounds(id) ON DELETE CASCADE,
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
  actor_user_id UUID NOT NULL REFERENCES auth.users(id),
  actor_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_id, round_id)        -- one override per group per round; subsequent edits update the row
);

CREATE INDEX idx_class_overrides_round ON composition_classification_overrides(round_id);
CREATE INDEX idx_class_overrides_actor ON composition_classification_overrides(actor_user_id);
CREATE INDEX idx_class_overrides_human_room_type ON composition_classification_overrides(human_room_type)
  WHERE human_room_type IS NOT NULL;
```

### Section 2 — Pass 2 reads the COALESCE'd values

`shortlisting-pass2/index.ts` modifies its data assembly:

```typescript
// Before W11.5
const room_type = composition_classification.room_type;

// After W11.5
const override = await fetchOverride(round_id, group_id);
const room_type = override?.human_room_type ?? composition_classification.room_type;
// Same pattern for composition_type, vantage_point, combined_score
```

**Effect:** when operator reclassifies IMG_6195 from `exterior_front` to `exterior_rear` in round N, round N+1 (next ingest of same project) routes IMG_6195 to the exterior_rear slot. Pass 1 still emits its original guess on round N+1, but the override row persists across rounds for the same group.

### Section 3 — Frontend (engine swimlane only)

New `ReclassifyMenu` component on `ShortlistingCard.jsx` (engine mode only — manual mode has no Pass 1 to reclassify against):

- Right-click or "..." menu on each card → "Reclassify"
- Modal opens with:
  - Current Pass 1 values (room_type, composition_type, vantage_point, combined_score) shown read-only
  - Override fields: dropdown for room_type (from `eligible_room_types` registry), composition_type (from taxonomy), vantage_point (3 values), score slider (0-10)
  - `eligible_slot_ids` multiselect (default = inferred from new room_type via slot_definitions)
  - `override_reason` free-text required field (≥ 20 chars)
  - "Save override" → POST to new edge fn `reclassify-composition`

Visual indication on cards with active overrides: amber border + "Reclassified" badge; clicking the badge opens read-only diff modal.

### Section 4 — Edge fn `reclassify-composition`

```typescript
// supabase/functions/reclassify-composition/index.ts (new)

interface ReclassifyRequest {
  group_id: string;
  round_id: string;
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
// 3. UPSERT composition_classification_overrides row
// 4. Emit shortlisting_events.event_type='human_reclassification' with the diff
// 5. Return the override row + a "next-round impact preview" (which slots would change)
```

The "next-round impact preview" runs the slot-resolver against the override + remaining ai-classifications and surfaces "If we re-ran Pass 2 now, IMG_6195 would route to exterior_rear and IMG_6210 would lose its winner status to a closer match." Operator sees the consequence before committing.

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

Wave 11's Pass 1 prompt block `objectsAndAttributes` then primes the model:

> "When the image contains any of these registry-canonical objects, weight room_type per the listed signal: hills_hoist → exterior_rear (90% confidence, 10 observations)."

**Net effect:** by the 11th project where IMG_6195-style mislabel could happen, Pass 1 has **empirically-grown evidence** that Hills Hoist is a back-yard signal, regardless of facade dominance in the frame. This is the closed-loop ethos working.

### Section 6 — Few-shot library for Pass 1 (Wave 14 hook)

W14 calibration session captures 50 stratified projects' editor decisions including reclassifications. The output feeds a `pass1_fewshot_examples` table:

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

Wave 11's Pass 1 prompt assembly conditionally injects the top-N most-frequent few-shot examples (Wave 14 admin curates which ones graduate from raw observation to active prompt material):

> "EMPIRICAL CORRECTION EXAMPLES: 8 cases where Pass 1 said `exterior_front` but operators corrected to `exterior_rear`. Common evidence: Hills Hoist clothesline, hot water system, garden tap. When you see these elements in the frame, prefer `exterior_rear` even if the facade is prominent."

This is what "engine grows with each project" actually means in concrete terms.

---

## Migration

Reserve **next-available** at integration time. Recommend `347_composition_classification_overrides.sql` (after W7.7=339, W10.1=340, W7.13=341, W10.3=342, W13b=343, W8=344, W12=345, W14=346).

---

## Effort estimate

- 0.5 day backend (table + edge fn + RLS)
- 1 day frontend (ReclassifyMenu component + impact-preview modal)
- 0.5 day Pass 2 plumbing (COALESCE override into the data assembly)
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
