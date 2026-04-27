# W12 — Object Registry + AI Suggestion Engine — Trigger Thresholds

**Status:** Decision doc. ~half-day execution after sign-off.

Wave 12 builds the object/attribute registry + AI suggestion engine for new room_types and slots. The schema is well-specified in spec section 11 + 21. The remaining open questions are **trigger thresholds**: when does the engine raise a "suggested new room_type" or "suggested new slot" for admin review?

This doc proposes defaults. Admin should be able to tune them via Settings.

## Object/attribute normalisation thresholds (per spec section 21)

| Cosine similarity | Action |
|---|---|
| ≥ 0.92 | Auto-normalise — write directly as canonical |
| 0.75 – 0.92 | Human review queue — editor confirms or rejects |
| < 0.75 | Potential new canonical value — flagged for approval |

**Recommendation:** ship as spec defaults (above). Allow admin override per `attribute_key` in `attribute_values` if a particular attribute (e.g. `surround_material`) needs tighter or looser normalisation.

## AI suggestion thresholds (new — not in spec)

### Room type suggestions

When does the engine suggest "add a new room_type" for admin review?

**Trigger sources** (any one of these can drive a suggestion):

1. **Forced fallback in Pass 1** — model classifies as `special_feature`, `detail_material`, or `detail_lighting` AND analysis paragraph contains vocabulary not in current taxonomy. Indicates the model wanted a label we don't have.
2. **Repeat key_elements clusters** — same combination of `key_elements` appears across N+ shoots in W days, no current room_type fits.
3. **Override pattern signal** — editor consistently swaps compositions of a specific key_element pattern INTO the shortlist over the AI's choice.

**Proposed defaults:**

```
Trigger source 1 (forced fallback):
  threshold: 5 occurrences of the same vocabulary cluster in 90 days
  confidence floor: 0.7 (model's room_type_confidence in the fallback)

Trigger source 2 (key_elements clusters):
  threshold: 8 distinct shoots in 120 days share ≥75% key_element overlap
  must NOT match an existing room_type with confidence > 0.7

Trigger source 3 (override patterns):
  threshold: 5 confirmed-with-review overrides in 90 days where the human
             pick has a key_element pattern not represented in any
             existing slot's eligible_room_types
```

These produce ranked candidates (most-evident first) for admin review. Editor approves → row added to `shortlisting_room_types`; takes effect on next round.

**Why these numbers?** Empirical guess based on the volume FlexMedia is likely to do (~500 rounds/year ≈ 40/month). 5 occurrences in 90 days = ~10% of rounds — strong enough signal to surface. 8 shoots in 120 days = ~5% — high-confidence cluster. 5 confirmed overrides = compelling editor-driven gap.

Lower thresholds (e.g. 2 occurrences) = false positives, admin spam. Higher (e.g. 20 occurrences) = misses real gaps. 5-8 feels right.

### Slot suggestions

When does the engine suggest "add a new slot definition" for admin review?

**Trigger source** (the explicit one we designed in W7 P1-1):

The `proposed_slots` field on Pass 2 output. When Pass 2 emits `proposed_slot_id: 'X'` for at least N compositions across M rounds, surface for review.

**Proposed defaults:**

```
threshold: 5 distinct rounds in 90 days propose the same slot_id
  (with reasoning that sums to a coherent argument — admin reads samples)
confidence: derived from how many compositions per round were proposed
            for this slot (1 = weak, 3+ = strong)
```

Same justification as room_types.

### Storage

```sql
CREATE TABLE shortlisting_room_type_suggestions (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposed_key                TEXT NOT NULL,           -- model's slug attempt
  proposed_display_name       TEXT,
  trigger_source              TEXT NOT NULL,            -- 'forced_fallback' | 'key_elements_cluster' | 'override_pattern'
  evidence_count              INTEGER NOT NULL,
  first_observed_at           TIMESTAMPTZ NOT NULL,
  last_observed_at            TIMESTAMPTZ NOT NULL,
  sample_composition_ids      UUID[],
  sample_analysis_excerpts    TEXT[],
  proposed_eligible_slots     TEXT[],                   -- model's hint at what slots this might fill
  status                      TEXT DEFAULT 'pending',   -- 'pending' | 'approved' | 'rejected' | 'merged'
  reviewed_by                 UUID,
  reviewed_at                 TIMESTAMPTZ,
  reviewer_notes              TEXT,
  approved_room_type_id       UUID REFERENCES shortlisting_room_types(id),  -- when status='approved'
  merged_into_room_type_id    UUID REFERENCES shortlisting_room_types(id),  -- when status='merged'
  created_at                  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE shortlisting_slot_suggestions (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposed_slot_id            TEXT NOT NULL,
  proposed_display_name       TEXT,
  proposed_phase              INTEGER,
  evidence_round_count        INTEGER NOT NULL,
  first_observed_at           TIMESTAMPTZ NOT NULL,
  last_observed_at            TIMESTAMPTZ NOT NULL,
  sample_round_ids            UUID[],
  sample_reasoning            TEXT[],
  status                      TEXT DEFAULT 'pending',
  reviewed_by                 UUID,
  reviewed_at                 TIMESTAMPTZ,
  reviewer_notes              TEXT,
  approved_slot_id            TEXT,
  created_at                  TIMESTAMPTZ DEFAULT NOW()
);
```

### Suggestion-engine batch job

A weekly pg_cron job calls a new edge function `shortlisting-suggestion-engine` that:

1. Queries `shortlisting_events` for `pass2_slot_suggestion` events in the last 90 days
2. Aggregates by `proposed_slot_id`, counts distinct rounds
3. Filters per the threshold (5 rounds in 90 days)
4. Upserts to `shortlisting_slot_suggestions` (with new evidence) or merges into existing pending suggestion
5. Same pattern for room_type suggestions from `composition_classifications` + `key_elements` clusters + `shortlisting_overrides`

### Admin UI

`SettingsShortlistingSuggestions.jsx` — new page with two tabs:
- "Room types" — pending suggestions ranked by evidence_count
- "Slots" — pending suggestions ranked by evidence_round_count

Each suggestion shows:
- Sample compositions with their analysis paragraphs
- Frequency stats
- Proposed canonical key + display name
- "Approve" / "Reject" / "Merge into existing room_type/slot" actions

Approve → creates row in `shortlisting_room_types` or `shortlisting_slot_definitions`; suggestion archived.

## Open questions for sign-off

1. **Are the 5/90 + 8/120 thresholds reasonable for FlexMedia's volume?** Joseph's call. I picked them based on rough volume estimates.
2. **Should admin be able to lower thresholds for specific patterns?** E.g. "I always want to know about wine-cellar-adjacent observations no matter how rare." Recommendation: ship default thresholds; add per-pattern overrides if demand surfaces.
3. **Auto-promote highly-confident suggestions?** E.g. if 20+ rounds in 90 days propose the same slot, auto-create it without admin review. Recommendation: NEVER auto-promote — engine producing taxonomy without human sign-off has bad failure modes.

## Effort estimate

- Half-day to write defaults + decisions
- Wave 12 execution includes the suggestion engine implementation (~1 week within Wave 12's 4-6 week total)

## Pre-execution checklist

- [ ] Joseph signs off on the threshold defaults
- [ ] Wave 11 (universal vision response) has landed (provides `observed_objects` source for clustering)
