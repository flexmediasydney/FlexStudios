# W11.7.8 — Voice Tier Modulation — Design Spec

**Status:** Sub-spec of W11.7. Authored 2026-04-30 alongside the rewritten W11.7 keystone. Defines the `property_tier` input + voice anchor injection mechanism that drives Stage 1 per-image `listing_copy` AND Stage 4 `master_listing` voice consistency.
**Backlog ref:** P1-25-8
**Wave plan ref:** W11.7.8 — tier-aware voice modulation prevents pretentious-on-suburban / condescending-on-luxury copy
**Dependencies:** `W11.7` (Shape D architecture), `W11` (universal schema — `property_tier` field), `W11.7.7` (master listing copy synthesis consumes the voice rubric), `W11.7.9` (voice exemplars are tier-keyed), `W7.6` (block-based prompt assembly), `W7.7` (`package_tier_choice` for default coercion)
**Unblocks:** consistent tonal calibration across Stage 1 + Stage 4; per-project voice override; auto-tier defaults from price guide

---

## Why this exists

Saladine is a $1M-ish project home in Punchbowl. It's a clean, sympathetic 2021 renovation on a 1980s brick veneer cottage. Apply Belle Property luxury voice to it and the copy reads pretentious — "Set behind a low brick fence, this gracious residence presents an elegantly considered renovation" — which misrepresents the home AND turns off the actual buyer (a first-home upgrader, not a downsizer from Mosman).

Conversely, a $7M Mosman waterfront pavilion deserves the architectural-magazine voice. Applying the approachable rubric — "Big lounge room, four bedrooms, ducted air-con throughout" — strips the property of its actual differentiator (architectural lineage, materials, position) and undersells it to the agent's database.

The engine needs **tier-aware voice modulation**: same architectural specificity, same forbidden-pattern discipline, different prose register. This spec defines:

1. The 3 tier presets (premium, standard, approachable) — buyer profile, voice characteristics, sample paragraphs, reading-grade targets.
2. Tier selection mechanism (operator picks at project setup; UI shows samples).
3. Voice-anchor override (free-text rubric for non-preset cases).
4. How the voice anchor reaches the prompt (W7.6 `voiceAnchorBlock(tier, override?)`).
5. Tier coercion at scale (price-guide-band → default tier).
6. Per-tier downstream defaults (word_count, reading_grade_level expectations).
7. Voice quality validation (post-emission check that tier matches actual output).
8. Migration impact (new `projects.property_tier` column).

---

## The 3 tier presets

The full voice rubric block text lives in W11.7.7. This spec captures the **calibration framework** — which property fits which tier, the voice characteristics, and the sample paragraphs operators see at project setup.

### Comparison table

| Dimension | Premium | Standard (Saladine) | Approachable |
|---|---|---|---|
| Property typology | $5M+ harbour pavilions, eastern-suburbs Federation, architect-designed, heritage with restoration | $1M-$3M family homes, 1980s-2000s project homes, inner-west semis, renovated cottages | sub-$1M units, investor 2-bed, student rentals, ex-HC cottages, Western Sydney project low-end |
| Buyer | Downsizer / luxury upgrade / international | Working professional / family | First-home / investor |
| Sentence length | 8-30 words; max 1 subordinate clause | 8-22 words; conversational | <15 words; active voice always |
| Vocab register | Period + lineage + specific materials | Specific but accessible (Caesarstone over calacatta) | Plain English; describe what's there |
| Reading-grade target | F-K 9-12 | F-K 8-10 | F-K 6-8 |
| Body word count | 700-1000 | 500-750 | 350-500 |
| Em-dash usage | One per paragraph | Sparingly | Avoid |
| Default for price band | $5M+ | $1M-$5M | sub-$1M |
| Allowed patterns | Period openings, material specificity ("honed Carrara"), lifestyle through architecture | Count + material ("20mm Caesarstone island"), concrete lifestyle, practical orientation | Concrete features, honest framing ("renovated 2019" not "refurbished") |
| Forbidden patterns | "boasts", "nestled", "prime", "stunning", "beautifully appointed"; exclamation marks | All premium-forbidden + realtor jargon ("expansive", "sprawling", "executive") | All standard-forbidden + false-elevation ("presented to perfection", "showpiece") |

### Sample paragraphs

**Premium — Mosman harbour pavilion living room (~80 words):**

> Lifted three steps above the garden and oriented to the north-west, the principal living room sits beneath a 4.2-metre raked cedar ceiling that flows uninterrupted to the alfresco deck beyond. Honed bluestone runs underfoot from the kitchen island through to the stacking glass — a single material plane drawing the eye to the harbour. The fireplace is a cantilevered slab of the same bluestone, set into a wall of polished plate steel. It is a room built around one moment of light a day, and it earns it.

**Standard — Saladine exterior front (~75 words):**

> Set behind a low brick fence and a single mature jacaranda, the cottage shows its 1980s veneer-brick bones in a way that speaks to durability rather than period charm. The rendered porch and Colorbond Surfmist trim mark the 2021 refresh — restrained, sympathetic, and ready to sit beside a working family without showing wear. The block is level all the way to the rear fence, and the front lawn has been cared for by a single owner since planting.

**Approachable — entry-level two-bedroom unit (~60 words):**

> Two bedrooms, one bathroom, in a quiet 12-pack on a leafy back street in Lakemba. The kitchen has been updated — laminate benches, ducted gas cooktop, room for a small table. The lounge runs off the kitchen with a north-facing balcony big enough for two chairs and a small herb planter. Six minutes to Lakemba station; secure parking for one car downstairs.

---

## Tier selection

### Operator UX at project setup

When the operator creates a new shoot project, the tier selector appears in the project settings panel:

```
┌─────────────────────────────────────────────────────────────────────┐
│  PROPERTY TIER (drives listing copy voice)                          │
│  ────────────────────────────────────────────                       │
│  ◉ Standard (default)                                               │
│      Domain editorial — confident, warm, specific but accessible    │
│      Sample: "Set behind a low brick fence and a single mature      │
│      jacaranda, the cottage shows its 1980s veneer-brick bones..."  │
│                                                                     │
│  ○ Premium                                                          │
│      Belle Property / luxury magazine — restrained, evocative       │
│      Sample: "Lifted three steps above the garden and oriented to   │
│      the north-west, the principal living room sits beneath..."     │
│                                                                     │
│  ○ Approachable                                                     │
│      Friendly plain-language without pretension                     │
│      Sample: "Two bedrooms, one bathroom, in a quiet 12-pack on a   │
│      leafy back street in Lakemba. The kitchen has been updated..." │
│                                                                     │
│  [Custom voice rubric (advanced) ▾]                                 │
│      [textarea for free-text override]                              │
└─────────────────────────────────────────────────────────────────────┘
```

Each radio button shows a 1-paragraph sample of the voice in action. Operator picks the closest fit.

### Default

`property_tier = 'standard'` if the operator doesn't pick. This is the safest default — pretentious copy on a suburban home is a worse outcome than competent copy on a luxury home.

### Storage

`property_tier` is stored on the project (covers all rounds for that property) AND copied onto each round at round-start (so historical rounds preserve their original tier even if the project's default changes later).

---

## Voice-anchor override

For properties that don't fit any of the 3 presets — or agencies that have their own house-voice rubric — the override path provides a free-text input that the prompt uses verbatim.

### When to use the override

- Property doesn't fit the 3 presets (e.g. a $4M architect-designed cottage with a quirky brief that needs idiosyncratic voice)
- Agency has its own house-voice rubric ("warm but agent-led, not editorial — McGrath inner-west voice")
- Specific campaign needs a different tone (Christmas-week boutique sale, off-market discrete listing)
- Tier presets feel wrong but the operator can't articulate why — fallback to free-text

### Schema

```typescript
property_voice_anchor_override: string | null;
// Optional. When set, replaces the tier rubric block in the prompt.
// 50-1000 chars typical. Hard cap 2000 chars.
```

### How the override reaches the prompt

When `property_voice_anchor_override` is set, the W7.6 block `voiceAnchorBlock(tier, override)` returns:

```
VOICE ANCHOR — CUSTOM OVERRIDE

The operator has supplied a voice rubric for this listing. Apply it
verbatim:

  {{property_voice_anchor_override}}

Forbidden patterns from the standard tier rubric still apply
(see W11.7.7 for full list). Reading-grade and word-count targets
default to the {{tier}} tier band unless the override specifies
otherwise.
```

The forbidden-pattern discipline survives the override (no operator can paste an override that approves "stunning" or exclamation marks — those are forbidden across all tiers). Reading-grade and word-count default to the tier band the operator selected even when overriding.

### Audit

Override text is stored on `shortlisting_rounds.property_voice_anchor_override` per round. W11.6 dashboard surfaces overrides as a per-shoot annotation ("Override applied: 'warm but agent-led, not editorial'") for cross-round consistency monitoring.

---

## How the voice anchor reaches the prompt

### W7.6 block pattern

A new prompt block file, `_shared/visionPrompts/blocks/voiceAnchorBlock.ts`:

```typescript
export const VOICE_ANCHOR_BLOCK_VERSION = 'v1.0';

export interface VoiceAnchorBlockOpts {
  tier: 'premium' | 'standard' | 'approachable';
  override?: string | null;
}

export function voiceAnchorBlock(opts: VoiceAnchorBlockOpts): string {
  if (opts.override) {
    return [
      'VOICE ANCHOR — CUSTOM OVERRIDE',
      '',
      'The operator has supplied a voice rubric for this listing.',
      'Apply it verbatim:',
      '',
      '  ' + opts.override,
      '',
      `Forbidden patterns from the standard tier rubric still apply.`,
      `Reading-grade and word-count targets default to the ${opts.tier} tier band`,
      `unless the override specifies otherwise.`,
    ].join('\n');
  }

  switch (opts.tier) {
    case 'premium':     return PREMIUM_RUBRIC_TEXT;
    case 'standard':    return STANDARD_RUBRIC_TEXT;
    case 'approachable': return APPROACHABLE_RUBRIC_TEXT;
  }
}
```

### Injection points

The voice anchor block is injected into TWO prompts:

1. **Stage 1 prompt** (per-image batch, drives `listing_copy.headline` + `listing_copy.paragraphs` per image)
2. **Stage 4 prompt** (drives `master_listing.*` body + derivatives)

Both stages inject the same voice anchor text — consistency is the point. Stage 1's per-image listing copy and Stage 4's master listing should sound like they were written by the same author with the same tier discipline.

### Composition with W11.7.9 voice exemplars

W11.7.9 provides tier-keyed voice exemplars (1-shot examples — full ideal output for premium × interior hero, standard × exterior front, approachable × bathroom). Those exemplars get injected via `voiceExemplarBlock(tier)` AFTER the rubric block:

```typescript
// Stage 1 prompt assembly
userBlocks: [
  ...,
  { name: 'voiceAnchor', version: VOICE_ANCHOR_BLOCK_VERSION,
    text: voiceAnchorBlock({ tier: round.property_tier, override: round.property_voice_anchor_override }) },
  { name: 'voiceExemplar', version: VOICE_EXEMPLAR_BLOCK_VERSION,
    text: voiceExemplarBlock({ tier: round.property_tier }) },
  ...
]
```

The rubric tells the model what to do; the exemplars show it in action. Models pattern-match harder on examples than on instructions — see W11.7.9.

---

## Tier coercion at scale

When CRM has `price_guide_band` populated but the operator hasn't explicitly picked a tier, the engine derives a default. The derivation table:

| `price_guide_band` | Default tier | Rationale |
|---|---|---|
| `sub_750k` | `approachable` | Entry-level price → entry-level buyer → plain language |
| `750k_1m` | `approachable` | Same, with bump available to `standard` if operator wants |
| `1m_1_5m` | `standard` | Suburban / inner-suburb mid-tier — Saladine band |
| `1_5m_3m` | `standard` | Most family-home upgrades; standard voice handles them |
| `3m_5m` | `standard` (with prompt to consider `premium`) | Often premium-warranted; UI suggests both |
| `5m_10m` | `premium` | Luxury territory; premium voice is the safe default |
| `10m_plus` | `premium` | Always premium |
| `null` | `standard` | Safest unknown default |

### When the operator opens the tier selector

If `price_guide_band` is set, the tier selector pre-selects the default per the table. The operator can override.

### When `price_guide_band = null`

Default to `standard`. Operator can pick.

### Override always wins

Even when the price band suggests premium, an explicit operator selection of `standard` or `approachable` overrides. Same in reverse — operator can elect `premium` on a $1M home if they have a reason.

---

## Per-tier downstream defaults

The tier selection cascades into multiple downstream components:

### Master listing word counts

| Tier | Body target word count | Allowed tolerance | Trigger condition |
|---|---|---|---|
| `premium` | 700-1000 | ±15% (595-1150) | Body sum (4 paragraphs minus closing nullable) |
| `standard` | 500-750 | ±15% (425-862) | Same |
| `approachable` | 350-500 | ±15% (297-575) | Same |

### Master listing reading-grade targets

| Tier | Flesch-Kincaid target | Allowed tolerance | Action on out-of-band |
|---|---|---|---|
| `premium` | 9-12 | ±1 grade (8-13) | Soft warning |
| `standard` | 8-10 | ±1 grade (7-11) | Soft warning |
| `approachable` | 6-8 | ±1 grade (5-9) | Soft warning |

### Stage 1 per-image `listing_copy` lengths

| Tier | Headline word count | Paragraphs word count |
|---|---|---|
| `premium` | 8-12 | 140-200 |
| `standard` | 6-10 | 120-180 |
| `approachable` | 5-8 | 80-140 |

### Derivative output lengths

`seo_meta_description`, `social_post_caption`, `print_brochure_summary`, `agent_one_liner`, `open_home_email_blurb` — same length targets across tiers (the publishing channel constrains them, not the tier). Voice register inside those constraints follows the tier rubric.

---

## Voice quality validation

After the master_listing emits, the W11.6 dashboard surfaces three voice-consistency signals per round:

### 1. Reading-grade band match

Recompute Flesch-Kincaid against actual body text. Flag if outside the tier's band ±1.

```typescript
const computedGrade = fleschKincaid(masterListing.scene_setting_paragraph + ...);
const band = TIER_READING_GRADE_BANDS[masterListing.tier_used];  // [low, high]
const inBand = computedGrade >= band[0] - 1 && computedGrade <= band[1] + 1;
if (!inBand) {
  flag('reading_grade_outside_band', { computed: computedGrade, band });
}
```

### 2. Forbidden pattern hits

Run forbidden-phrase regex array against full master_listing body + derivatives. Per-tier regex array is the union of (a) tier-specific forbiddens and (b) global forbiddens.

```typescript
const hits = FORBIDDEN_PATTERNS[masterListing.tier_used]
  .map(re => ({ pattern: re.source, matches: bodyText.match(re) ?? [] }))
  .filter(h => h.matches.length > 0);

if (hits.length > 0) {
  flag('forbidden_phrases_present', hits);
}
```

### 3. Tier-mismatch flag

When the model self-reported reading-grade level differs from the recomputed value by >2 grades, flag — likely indicates the model misjudged its own voice.

When the recomputed reading-grade falls 2+ grades outside the tier's band, flag as `tier_mismatch_suspected` and suggest the operator consider regenerating with a different tier.

```typescript
if (computedGrade < band[0] - 2 || computedGrade > band[1] + 2) {
  flag('tier_mismatch_suspected', { current_tier: masterListing.tier_used, suggested_tier: suggestTierFromGrade(computedGrade) });
}
```

### Dashboard surface

The W11.6 dashboard adds a "Voice Quality" panel:

```
┌─────────────────────────────────────────────────────────────────────┐
│  VOICE QUALITY (last 30 days, 142 rounds)                           │
│  ────────────────────────────────────────────                       │
│  Reading-grade in band:        87% (124 rounds)                     │
│  Forbidden phrases (any):       4% (6 rounds, all 1-hit warnings)   │
│  Tier mismatches suspected:     2% (3 rounds, all premium-on-       │
│                                       sub-$2M homes)                │
│                                                                     │
│  Per-tier breakdown:                                                │
│    Premium:       18 rounds, 1 mismatch (5.5%), 0 forbidden         │
│    Standard:      94 rounds, 2 mismatch (2.1%), 4 forbidden         │
│    Approachable:  30 rounds, 0 mismatch, 2 forbidden                │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Migration impact

### Schema additions

```sql
-- 349 (W11.7's primary migration) already adds property_tier + override on rounds.
-- W11.7.8 adds the project-level column (so the tier persists across rounds for
-- the same property) + backfill.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS property_tier TEXT DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS property_voice_anchor_override TEXT;

COMMENT ON COLUMN projects.property_tier IS
  'Wave 11.7.8: Voice tier for listing-copy synthesis. premium | standard | approachable. Default standard. Set per project, copied onto each round at round-start.';

-- Backfill existing projects to 'standard'
UPDATE projects
SET property_tier = 'standard'
WHERE property_tier IS NULL;

-- Round-level columns (already in W11.7's migration 349, repeated for clarity):
-- ALTER TABLE shortlisting_rounds
--   ADD COLUMN IF NOT EXISTS property_tier TEXT,
--   ADD COLUMN IF NOT EXISTS property_voice_anchor_override TEXT;
```

### Round-start trigger

When a new `shortlisting_round` is inserted, copy the tier from the project:

```sql
-- Trigger on shortlisting_rounds INSERT
CREATE OR REPLACE FUNCTION copy_property_tier_to_round()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.property_tier IS NULL THEN
    NEW.property_tier := (SELECT property_tier FROM projects WHERE id = NEW.project_id);
  END IF;
  IF NEW.property_voice_anchor_override IS NULL THEN
    NEW.property_voice_anchor_override := (SELECT property_voice_anchor_override FROM projects WHERE id = NEW.project_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER copy_property_tier_to_round_trigger
BEFORE INSERT ON shortlisting_rounds
FOR EACH ROW EXECUTE FUNCTION copy_property_tier_to_round();
```

### Backfill rounds

Existing rounds get backfilled to the project's tier (after the project tier is backfilled to 'standard'):

```sql
UPDATE shortlisting_rounds r
SET property_tier = p.property_tier
FROM projects p
WHERE r.project_id = p.id
  AND r.property_tier IS NULL;
```

---

## Risks + mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Operator picks wrong tier (selects approachable on a $4M home) | Medium | Tier-mismatch validator flags the mismatch in W11.6 with a one-click "regenerate as premium" action. |
| Override text is too short / too vague to drive consistent voice | Medium | UI shows live word-count on the override textarea; warns when <30 chars. Pilot phase reviews override-driven listings 100%. |
| Override text contains injection-like patterns (instructions to ignore the master prompt) | Low | Override is sanitised at injection — wrapped in `<override>...</override>` tags in the prompt; explicit "ignore prior instructions" patterns are stripped. |
| Tier presets diverge from agency house-voice over time | Medium | Tier presets versioned (W7.6 block versioning). Master_admin UI allows editing the rubric blocks per future revision. |
| Voice exemplars (W11.7.9) drift from rubric — exemplar contradicts the prompt instructions | Medium | W11.7.9 specifies that exemplars are curated to match the rubric. CI test compares exemplar word count + grade against tier band; fails if drift >2 grades. |
| Cross-tier benchmarking — comparing premium vs standard voice quality unfair | Medium | W11.6 dashboard segments quality metrics per tier; never compares cross-tier. Per-tier baseline is the operator-acceptance rate of generated listings. |
| Project-level tier doesn't propagate to round (trigger fails) | Low | Backfill SQL above handles existing rounds. Trigger has unit test asserting round.property_tier is set on INSERT when project.property_tier is set. |
| Operator forgets to set tier on a luxury project, defaults to standard | Medium | Tier coercion table defaults price_guide_band > $5M to premium automatically; project setup wizard pre-fills based on band. Operator must opt-out, not opt-in. |

---

## Open questions for sign-off

1. **Tier auto-derivation from `package_tier_choice`.** Today `package_tier_choice` (W7.7) is `'standard' | 'premium'` on the package level (drives engine config — Tier S vs P weights). Should `property_tier` auto-derive from `package_tier_choice` (premium package → premium tier voice) by default? **Recommendation:** No. `package_tier_choice` is about engine quality bar; `property_tier` is about listing voice. Different concerns. Defaults derive from `price_guide_band`, not package.

2. **Voice anchor configurability in master_admin UI.** Should the rubric blocks (premium / standard / approachable text) be editable in master_admin (CMS-style), or are they hardcoded TypeScript with version bumps via PR? **Recommendation:** Hardcoded TypeScript via W7.6 versioned blocks. Editing voice rubrics is a craft act that needs PR review (snapshot tests catch unintended drift). Master_admin UI surfaces the active version + sample, but editing is a code change.

3. **Per-suburb default tier overlay.** Should the engine know that "Mosman" defaults to premium and "Lakemba" defaults to approachable, regardless of price band? **Recommendation:** Out of scope for v1. `price_guide_band` is a cleaner signal. Suburb overlay is a Phase D enrichment if data shows suburb is a stronger predictor than band.

4. **Mid-tier hybrid voice.** Some properties sit between standard and premium ($2M-$3M renovated cottages). Should there be a `standard_plus` tier? **Recommendation:** No. The standard tier rubric handles them. Override path covers genuinely between-tier cases.

5. **Tier change after round emission.** When the operator decides post-emission that the tier was wrong, can they switch tier and trigger regeneration? **Recommendation:** Yes — the W11.7.7 `regenerate-master-listing` endpoint accepts `override_property_tier`. Cost: $1.20 per regen. Operator-initiated, infrequent.

---

## Pre-execution checklist

- [x] W11.7 keystone exists
- [x] W11.7.7 master listing copy spec (companion) ready
- [ ] W11.7.9 master-class prompt enrichment spec (companion) ready
- [ ] `voiceAnchorBlock(tier, override?)` block file created in `_shared/visionPrompts/blocks/`
- [ ] 3 tier rubric texts (premium, standard, approachable) drafted as TypeScript constants
- [ ] Tier coercion table from `price_guide_band` implemented
- [ ] Project setup UI updated with tier selector + samples
- [ ] Override textarea with sanitisation + word-count UI
- [ ] Migration 349 includes `projects.property_tier` + `projects.property_voice_anchor_override`
- [ ] Trigger `copy_property_tier_to_round` deployed
- [ ] W11.6 dashboard "Voice Quality" panel scoped
- [ ] Snapshot tests for each rubric block (text-stable across version)
- [ ] CI test: voice exemplars (W11.7.9) match tier rubric word-count + grade band
- [ ] Joseph signs off on Q1-Q5 above

---

## Effort estimate

| Sub | Description | Days |
|---|---|---|
| Spec finalisation | This doc + Joseph sign-off on Q1-Q5 | 0.5 |
| `voiceAnchorBlock` block authoring | Block file + 3 rubric texts + override path | 1 |
| Tier coercion logic | Price-band → default-tier table + project setup wizard pre-fill | 0.5 |
| UI — tier selector at project setup | Radio buttons + sample previews + advanced override textarea | 1.5 |
| Schema migration | `projects.property_tier`, `property_voice_anchor_override`, trigger | 0.5 |
| Backfill | Existing projects → 'standard'; existing rounds → project tier | 0.5 |
| Quality validators | Reading-grade computation, forbidden-pattern regex, tier-mismatch flag | 1 |
| W11.6 dashboard panel | Voice quality breakdown per tier | 1 |
| Tests | Block snapshot tests, validator unit tests, trigger integration test, end-to-end with override | 1.5 |
| **Implementation total** | | **~7.5 days** |

Build dependency: W11.7.1 + W11.7.2 + W11.7.7 must be in place. This spec adds the tier input + voice block + downstream validators.

---

## Cross-references

- `W11.7` — Shape D Multi-Stage Vision Engine Architecture (parent spec)
- `W11.7.7` — Master Listing Copy Synthesis (consumes the voice rubric defined here)
- `W11.7.9` — Master-Class Prompt Enrichment (voice exemplars are tier-keyed; this spec defines the tiers they key against)
- `W11` — Universal Vision Response Schema (`property_tier`, `property_voice_anchor_override` field definitions)
- `W11.6` — Rejection Dashboard (consumes voice quality flags)
- `W7.6` — Composable Prompt Blocks (assembly pattern)
- `W7.7` — Dynamic Packages + Tier Configs (`package_tier_choice` referenced for default coercion discussion)
