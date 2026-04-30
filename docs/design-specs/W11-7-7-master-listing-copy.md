# W11.7.7 — Master Listing Copy Synthesis — Design Spec

**Status:** Sub-spec of W11.7. Authored 2026-04-30 alongside the rewritten W11.7 keystone. Locks the prompt, schema, voice rubrics, derivative outputs and quality gates that turn Stage 4's raw cross-image capability into a publication-ready listing-copy artifact.
**Backlog ref:** P1-25-7
**Wave plan ref:** W11.7.7 — master listing copy is the most consequential output of Stage 4 beyond slot decisions
**Dependencies:** `W11.7` (Shape D architecture), `W11` (universal schema — `master_listing` shape lives here), `W11.7.8` (voice tier modulation drives the synthesis voice), `W11.7.9` (master-class prompt enrichment seeds editorial calibre), `W7.6` (block-based prompt assembly)
**Unblocks:** turnkey listing publishing, separate copywriter step retired, `regenerate-master-listing` re-run path for alt-angle drafts

---

## Why this exists

Property listings are the highest-leverage content output of any shoot. Today they're hand-written by an external copywriter (per-job fee) or by the listing agent under time pressure (variable quality). Stage 4 of the Shape D engine already sees every approved image AND reads the merged Stage 1 per-image JSON, so it has more aggregate information about the property than any human writer typically has when drafting copy. The engine just needs the synthesis instruction set, the voice rubric, the editorial schema, and the quality gates.

This spec defines:

1. The full `master_listing` schema (every field, target length, voice characteristics, forbidden patterns, accepted patterns, example outputs).
2. The voice rubric blocks per `property_tier`, written as actual prompt text the synthesis call uses verbatim.
3. The 5 derivative outputs (SEO meta, social caption, brochure summary, agent one-liner, open-home email blurb) — each with its own micro-prompt instruction.
4. The editorial metadata derivation (word count, reading-grade, tone anchor) — what the model self-reports vs what's computed downstream.
5. Quality gates (forbidden patterns, reading-grade band, word-count tolerance, hand-review cadence by phase).
6. The independent re-generation flow (`regenerate-master-listing` endpoint).
7. Migration impact (`shortlisting_master_listings` table choice + rationale).

---

## Inputs the synthesis sees

The Stage 4 call receives the same input bundle as the slot-decision pass (W11.7) — the master listing synthesis is one of multiple emissions in the same call. No separate API hit for copy.

```typescript
interface MasterListingSynthesisInputs {
  // Visual context — ALL approved images (Stage 4 sees them in the same prompt)
  images: Array<{
    composition_group_id: string;
    stem: string;
    preview_url: string;
  }>;                                      // typically 100-200

  // Stage 1 merged per-image enrichment (text context)
  stage_1_merged: Stage1PerImageOutput[];

  // CRM property facts (caller-injected — never invented by the model)
  property_facts: {
    address_line: string | null;           // "12 Blackbutt Way" — null when off-market
    suburb: string;                        // "Punchbowl"
    state: string;                         // "NSW"
    bedrooms: number | null;
    bathrooms: number | null;
    car_spaces: number | null;
    land_size_sqm: number | null;
    internal_size_sqm: number | null;
    price_guide_band: 'sub_750k' | '750k_1m' | '1m_1_5m' | '1_5m_3m' | '3m_5m' | '5m_10m' | '10m_plus' | null;
    auction_or_private_treaty: 'auction' | 'private_treaty' | 'eoi' | null;
    inspection_times: string | null;
  };

  // Voice tier (W11.7.8)
  property_tier: 'premium' | 'standard' | 'approachable';
  property_voice_anchor_override: string | null;

  // Master-class enrichment (W11.7.9)
  active_voice_exemplars: VoiceExemplar[];   // ≤3 exemplars matching tier
  perceptual_rubric_block_text: string;
  sydney_primer_block_text: string;
}
```

The synthesis prompt assembles these into a single instruction. CRM facts go in as authoritative — the prompt explicitly forbids the model from inventing or interpolating any factual figure not present in `property_facts`.

---

## Output schema — full `master_listing` object

Every field, length target, and discipline. Tier-specific examples are Saladine — standard tier.

### Hook tier

| Field | Length | Voice / forbidden / accepted |
|---|---|---|
| `headline` | 8-15 words | Specific, image-grounded; no exclamation marks; no clichés. **Example:** `Brick Cottage on a Level Block in Punchbowl's Leafy West` |
| `sub_headline` | 12-25 words | Elaborates with one substantive specific (material + lifestyle frame). **Example:** `Three bedrooms, two bathrooms, a covered alfresco, and a north-facing rear lawn — a working family home, fully renovated 2021.` |

### Body — 3-4 paragraphs, ~600-900 words total

| Field | Length | Voice / forbidden / accepted |
|---|---|---|
| `scene_setting_paragraph` | 150-200 words | Facade + character + first-impression. Material-led opening, period reference. Forbid "welcome to", "nestled in", "boasting". **Excerpt:** "Set behind a low brick fence and a single mature jacaranda, the cottage shows its 1980s veneer-brick bones in a way that speaks to durability rather than period charm..." |
| `interior_paragraph` | 150-220 words | Floor plan + key rooms with specifics — bench material, flooring, window orientation. Forbid generic listing of room counts. **Excerpt:** "The plan opens centrally to a kitchen that runs along the southern wall, anchored by a 20mm Caesarstone island and shaker-front cabinetry in matte white..." |
| `lifestyle_paragraph` | 150-200 words | Entertaining, family, indoor-outdoor. Concrete lifestyle evidence. Forbid hypothetical scenarios divorced from images. **Excerpt:** "The covered alfresco flows from the family room through a single bifold, and the level back lawn — large enough for a trampoline and a clothesline both — is fenced on three sides..." |
| `closing_paragraph` | 100-150 words, optional | Material specificity / unique angle for the fourth beat. Null on most standard-tier suburban homes; populated on premium/character properties. |

### Standalone

| Field | Length | Voice / forbidden / accepted |
|---|---|---|
| `key_features` | 6-10 bullets | Specific noun-verb fragments. Material + count + context. **Example:** `["Caesarstone island bench, 20mm matte stone", "Federation-style ceiling roses preserved in front formal", "Covered alfresco with mains-gas BBQ outlet", "Level rear lawn, ~140sqm, fenced on 3 sides", ...]` |
| `location_paragraph` | 80-120 words | Suburb pocket, numeric walking distances. Forbid vague distance language. **Example:** `Punchbowl's leafy west pocket sits between Belmore Road and the rail corridor — a 6-minute walk to Punchbowl station, 8 minutes to the IGA, and a 12-minute drive to Bankstown Central...` |
| `target_buyer_summary` | 15-25 words | Direct ID of the buyer profile. **Example:** `A first-home upgrader or growing family looking for a cleanly renovated three-bedroom on a real backyard in catchment.` |

### Editorial metadata

| Field | Type | Source | Notes |
|---|---|---|---|
| `word_count` | int | Model self-report | Stage 4 prompt asks for "after writing the body, count the words across the four paragraphs and report it here". Validated downstream. |
| `reading_grade_level` | numeric | Model self-report (Flesch-Kincaid) | Model emits its best estimate. Downstream worker (`shortlisting-quality-checks` edge fn) recomputes Flesch-Kincaid against the actual text and writes `reading_grade_level_computed` alongside. |
| `tone_anchor` | string | Model self-report | Free-text label the model uses to describe the voice it adopted ("Domain editorial, warm-but-grounded"). Used in W11.6 dashboard for voice-consistency monitoring. |

---

## Voice rubrics per tier

These are the actual prompt block texts injected into the synthesis call based on `property_tier`. Each rubric is 50-100 lines and gets concatenated into the master prompt via the W7.6 block pattern (`voiceAnchorBlock(tier, override?)`).

### Premium tier — Belle Property / luxury magazine voice

```
VOICE ANCHOR — PREMIUM TIER

You are writing in the voice of a senior editor at Belle Property's print
magazine, with the discipline of a Domain editorial copywriter on a feature
listing. Your craft is restrained evocative prose, grounded in materials and
period — never in adjectives. The reader has seen ten luxury listings this
month already; the difference between this listing and the others is whether
the prose earns its place.

OPENING DISCIPLINE
- Never open with "Welcome to" or "Step inside".
- Never open with the address.
- Open with the property's defining gesture — the architectural move that
  makes this house this house. Materials, period, or the orientation of the
  principal room.

VOCABULARY REGISTER
- Specific materials over generic adjectives. "Brushed-bronze tapware" not
  "designer fittings". "1920s Federation oak floors" not "timber floors".
  "Calacatta marble waterfall" not "stone island".
- Period references where the architecture warrants. "Inter-war duplex",
  "post-war pavilion", "1960s Boyd-influenced living wing".
- Architectural lineage names where the property genuinely echoes them.
  Glenn Murcutt, Peter Stutchbury, Richard Leplastrier — the Sydney School.
  Don't name them gratuitously; only when the building actually shows that
  influence.

SENTENCE PACING
- Vary sentence length. Mix one short declarative every paragraph or two
  with longer evocative sentences.
- One subordinate clause per sentence is the ceiling. Never two.
- Comma-spliced run-ons are forbidden. Use the em-dash for the single
  parenthetical aside per paragraph.

FORBIDDEN PATTERNS (regex-enforced post-emission)
- /stunning/i
- /must inspect/i
- /don['']t miss/i
- /modern living at its (?:best|finest)/i
- /a rare opportunity/i
- /(?:beautifully|perfectly|exquisitely) (?:appointed|presented|finished)/i
- /\bprime\b/i (when used as adjective)
- /this property (?:offers|features|presents|boasts)/i
- "boasts" (any context)
- "nestled" (any context)
- exclamation marks (zero tolerance)

ENCOURAGED PATTERNS
- Period openings: "Built in 1928", "A 1958 post-war duplex", "The 1990
  rear pavilion sits above..."
- Material specificity: "honed Carrara", "tongue-and-groove cedar",
  "wide-board European oak"
- Lifestyle through architecture: "the principal living room is lifted
  half a level above the garden, which keeps morning sun on the floor
  through winter"
- Restrained closing: "It is the kind of house that does not shout."

READING-GRADE TARGET
- Flesch-Kincaid 9-12. Premium readers tolerate longer clauses and
  Latinate vocabulary, but never at the cost of clarity.

WORD-COUNT TARGET
- Body 700-1000 words across the 3-4 paragraphs.

EXAMPLE PROPERTY THIS VOICE FITS
- $5M+ harbour-side architectural piece, Mosman pavilion, eastern-suburbs
  Federation, North Shore Californian bungalow with a contemporary
  rear addition.
```

### Standard tier — Domain editorial voice (Saladine fits here)

```
VOICE ANCHOR — STANDARD TIER

You are writing in the voice of a Domain editorial copywriter on a Saturday
weekend feature — confident, warm, specific but accessible. The reader is a
working professional or a young family scrolling on their phone after dinner;
they want to know what the house is actually like, not what adjectives it
deserves.

OPENING DISCIPLINE
- Open with the property's character, suburb position, or defining feature.
  "Set behind a low brick fence...", "Three bedrooms on a level block...",
  "Built in 1985 and refreshed top-to-bottom in 2021..."
- Avoid generic openings ("Welcome to", "Step inside", "This stunning home").

VOCABULARY REGISTER
- Specific but accessible. "Caesarstone bench" not "calacatta marble".
  "Shaker cabinetry" not "bespoke joinery". "Covered alfresco" not
  "outdoor entertaining pavilion".
- Period references when relevant but plain-language. "1980s brick
  veneer", "post-war fibro cottage", "renovated 2021".
- No name-dropping of architects unless the property genuinely is by one.

SENTENCE PACING
- Conversational. Short to medium sentences. Vary length but not
  dramatically.
- Use the em-dash sparingly for a parenthetical. Don't comma-splice.
- Lead with subject-verb clarity. "The kitchen runs along the south wall"
  not "Running along the south wall is a kitchen".

FORBIDDEN PATTERNS (regex-enforced post-emission)
- /stunning/i
- /must inspect/i
- /don['']t miss/i
- /modern living at its (?:best|finest)/i
- /(?:beautifully|perfectly|exquisitely) (?:appointed|presented|finished)/i
- "boasts", "nestled", "prime location"
- exclamation marks (zero tolerance)
- realtor jargon: "expansive", "sprawling", "executive"

ENCOURAGED PATTERNS
- Specific count + material: "20mm Caesarstone island", "three north-
  facing windows in the main bedroom", "covered alfresco with a mains-gas BBQ
  outlet"
- Concrete lifestyle: "level back lawn fenced on three sides — room for
  a trampoline and a clothesline both"
- Practical orientation: "north-facing rear", "south-side bathroom",
  "morning sun on the kitchen bench"

READING-GRADE TARGET
- Flesch-Kincaid 8-10. The Domain reader is educated but tired; clarity
  trumps cleverness.

WORD-COUNT TARGET
- Body 500-750 words across the 3-4 paragraphs.

EXAMPLE PROPERTY THIS VOICE FITS
- Saladine ($1M-ish project home in Punchbowl), inner-west semi, suburban
  family home, three-bedroom unit in a 12-pack apartment block.
```

### Approachable tier — friendly plain-language voice

```
VOICE ANCHOR — APPROACHABLE TIER

You are writing for a first-home buyer, an investor, or a buyer who reads
listings on their phone in the kitchen with the kettle on. Plain, friendly,
concrete. No pretension. No condescension either — just plain prose that
respects the reader's time.

OPENING DISCIPLINE
- Lead with the practical headline: bed/bath count, location, the one
  feature that distinguishes this property from the next.
- "A two-bedroom unit in a quiet 12-pack, six minutes from the station..."
- "Three bedrooms, one bathroom, on a 480sqm block..."

VOCABULARY REGISTER
- Plain English. Avoid jargon — both architectural and real estate. Just
  describe what's there.
- "Big lounge room" not "expansive living domain".
- "Renovated bathroom" not "fully appointed wet area".
- Material specifics where they help (Caesarstone, ducted air-con,
  timber-look flooring) but never for show.

SENTENCE PACING
- Short. Most sentences under 15 words. Compound sentences only when the
  meaning is clearer that way.
- Active voice always.

FORBIDDEN PATTERNS (regex-enforced post-emission)
- /stunning/i
- /must inspect/i
- /don['']t miss/i
- /modern living/i
- "boasts", "nestled", "prime location", "executive"
- exclamation marks (zero tolerance)
- false elevation: "presented to perfection", "showpiece"

ENCOURAGED PATTERNS
- Concrete features: "ducted air-conditioning throughout", "secure
  parking for one car", "courtyard pavers, easy upkeep"
- Practical orientation: "north-facing balcony", "morning-sun kitchen"
- Honest framing: "renovated 2019" (not "recently refurbished"),
  "shared driveway" (not "private access")

READING-GRADE TARGET
- Flesch-Kincaid 6-8. Reads as comfortably as a well-written news brief.

WORD-COUNT TARGET
- Body 350-500 words across the 3-4 paragraphs.

EXAMPLE PROPERTY THIS VOICE FITS
- Entry-level unit, investor-grade two-bedroom, student rental, ex-Housing
  Commission cottage, suburban first-home stock.
```

### Override path

When `property_voice_anchor_override` is set, the entire tier rubric block above is replaced with:

```
VOICE ANCHOR — CUSTOM OVERRIDE

The operator has supplied a voice rubric for this listing. Apply it
verbatim:

  {{property_voice_anchor_override}}

Forbidden patterns from the standard tier rubric still apply
(see W11.7.7 for full list). Reading-grade and word-count targets
default to the standard tier band unless the override specifies
otherwise.
```

---

## Editorial metadata derivation

The model self-reports `word_count`, `reading_grade_level`, and `tone_anchor` inline. Downstream computation supplements:

| Metadata | Self-reported | Recomputed downstream | Source of truth |
|---|---|---|---|
| `word_count` | Yes (model counts) | Yes — `wordCount(headline + sub_headline + body + closing)` | Recomputed value (model self-report kept for audit) |
| `reading_grade_level` | Yes (Flesch-Kincaid estimate) | Yes — `flesch-kincaid` against actual text via `readability` npm package | Recomputed value (model self-report kept for audit) |
| `tone_anchor` | Yes (model labels its own voice) | No | Self-report — used as voice-consistency dashboard signal in W11.6 |

The recomputed values land on the `shortlisting_master_listings` row alongside `master_listing.word_count` (model) and `master_listing.reading_grade_level` (model). The W11.6 dashboard surfaces both.

---

## Derivative outputs (5 publishing-ready strings)

Each derivative is a per-field instruction within the same Stage 4 prompt. The model emits all 5 in one pass. Per-derivative instructions:

### `seo_meta_description` — ≤155 chars

Single sentence including: suburb name + property type (3-bed cottage / 2-bed unit / etc) + one distinguishing feature (renovated 2021 / north-facing rear) + one benefit (catchment / station distance). Declarative, no exclamation marks, no clichés. Writes for Google snippet display.

- ✓ `Renovated 3-bedroom brick cottage on a level block in Punchbowl's leafy west — 6-minute walk to the station.` (154 chars)
- ✗ `Stunning 3 bed home in Punchbowl, must inspect!` — clichés + exclamation

### `social_post_caption` — Instagram-ready, 1-2 lines + 5-8 hashtags

Caption leads with the most arresting visual or feature, ends with suburb. Hashtags: 3-4 location, 2-3 property-style, 1-2 seasonal/timing. No emoji. Sparing exclamation marks (or none).

- ✓ `Caesarstone bench, level lawn, 6 mins to the station — three bedrooms in Punchbowl's leafy west.\n#PunchbowlNSW #SydneySouthWest #FamilyHomeSydney #CottageRenovation #FirstHomeBuyer #SaturdayInspections`
- ✗ `Just listed 🔥 Don't miss this stunner! #realestate #home` — clichés, generic hashtags, emoji

### `print_brochure_summary` — ~200-word distillation

Structure: opening sentence (headline reframed) → middle (4-5 most compelling specifics from body) → closing sentence (buyer-fit / lifestyle frame). Print readability constraints: no em-dashes (don't render reliably in budget print), no quotation marks, short paragraphs (3-4 sentences max), no specialised vocabulary that needs context the print piece cannot provide. Joseph hand-curates a tier-keyed exemplar during pilot.

### `agent_one_liner` — 10-15 words for verbal pitch

Single sentence the listing agent can deliver without sounding like they're reading. Declarative, anchored in the most distinguishing feature + location frame.

- ✓ `Three-bedroom brick cottage on a level block in Punchbowl's leafy west, renovated 2021.` (15 words)
- ✓ `1928 Federation in inner-west Marrickville with a 2022 contemporary rear pavilion.` (12 words)

### `open_home_email_blurb` — 3-4 lines for buyer-database email

Structure: line 1 (headline reframe + open-home time anchor) → line 2-3 (2-3 distinguishing specifics) → line 4 optional (parking / RSVP).

- ✓ `Saturday 11:00am — three bedrooms, one with a north-facing rear yard. Caesarstone island, level lawn, six minutes to Punchbowl station. Renovated 2021. Off-street parking.`

---

## Quality gates

Quality is enforced at three layers: model self-discipline (prompt-level), automated post-emission validators (rule-based), and human review (phase-dependent).

### Layer 1 — prompt-level discipline

The voice rubric blocks above include forbidden patterns and encouraged patterns. The model is instructed to self-check before emitting. The W11.7.9 self-critique block (referenced in W11.7.9) adds a re-read step.

### Layer 2 — post-emission automated validators

| Gate | Rule | Action on fail |
|---|---|---|
| Forbidden phrase regex | Run forbidden-pattern regex array against `headline + sub_headline + body + closing + key_features.join + location + target_buyer_summary + derivatives`. | Flag `quality_flag.has_forbidden_phrases = true`. Operator review required pre-publish. |
| Exclamation mark count | Count `!` in body. | If > 0, flag `quality_flag.exclamation_count = N`. Required review. |
| Reading-grade band | Recompute Flesch-Kincaid against actual body text. | If outside tier band ±1 grade, flag `quality_flag.reading_grade_outside_band`. Soft warning. |
| Word-count tolerance | Recompute word count against actual body text. | If outside tier target ±15%, flag `quality_flag.word_count_outside_band`. Soft warning. |
| Repeated phrase check | Trigram analysis — if any 3-word phrase appears >2x in the master listing, flag. | Soft warning. |
| Cliché density | Run cliché phrase regex array against body. Threshold: 0 hits acceptable, 1 hit warns, 2+ hits fails. | Hard fail at 2+ hits. Operator must edit before publish. |

### Layer 3 — human review by phase

| Phase | Review cadence | Reviewer |
|---|---|---|
| Phase B pilot (W11.7.5) | 100% — every master_listing reviewed pre-publish | Joseph + 1 designated copy reviewer |
| Phase C default flip (W11.7.6) | 1-in-10 spot-check. Plus 100% review on any listing where Layer 2 flags fired. | Designated copy reviewer (rotating) |
| Phase D mature operation | Sentiment monitor — W11.6 dashboard tracks `master_listing` quality flags as a daily trend. Manual review only on flagged listings. | Self-service via dashboard |

---

## Master_admin re-generation flow

Listing copy is regeneratable independently of slot decisions. New endpoint:

```
POST /shortlisting/regenerate-master-listing
{
  round_id: UUID,
  override_property_tier?: 'premium' | 'standard' | 'approachable',
  override_voice_anchor_text?: string,
  reason_for_regeneration?: string  // operator-provided context
}

→ 200 OK
{
  master_listing: MasterListing,
  regeneration_count: number,
  prior_master_listing_archived_at: ISO8601
}
```

### Implementation

1. Reads stored Stage 4 artifacts (`shortlisting_master_listings.master_listing` + `shortlisting_rounds.master_listing_input_snapshot` if cached, else re-derives Stage 1 merged JSON from `composition_classifications`).
2. Re-runs the Stage 4 synthesis with the same images + Stage 1 JSON, but applies the override tier / voice anchor.
3. Archives the prior master_listing to `shortlisting_master_listings_history` (versioned by `regeneration_count`).
4. Writes the new master_listing back to `shortlisting_master_listings`.
5. Increments `regeneration_count`.

### Use cases

- Copywriter wants alternate voice angle ("can we try the approachable rubric on this one?").
- Listing agent rejects the standard-tier draft, requests premium voice on a $1.2M renovated cottage that punches above its tier.
- Original generation pre-dated a Sydney primer block update (W11.7.9) — agent wants the refreshed voice.

---

## Migration impact

### Storage choice — table vs JSONB column

Two options were considered:

| Option | Pros | Cons | Decision |
|---|---|---|---|
| (A) JSONB column on `shortlisting_rounds.master_listing` | Single-row read on round display. Schema-flexible. | History/regeneration awkward to query. JSON arrays for derivative regeneration_counts. Index on JSONB fields slow. | Rejected |
| (B) New `shortlisting_master_listings` table | Clean history via `shortlisting_master_listings_history`. Easy to index on `tier_used`, `created_at`, `regeneration_count`. Queryable for cross-round analytics ("what % of premium-tier listings hit the reading-grade band last 30 days?"). One row per round. | Extra JOIN on round display. | **Selected.** |

### Schema (additions to W11.7's migration 349)

W11.7 already creates the base `shortlisting_master_listings` table. This spec folds in the W11.7.7-specific additions:

```sql
-- Additions to migration 349:
ALTER TABLE shortlisting_master_listings
  ADD COLUMN IF NOT EXISTS regeneration_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quality_flags JSONB,
  ADD COLUMN IF NOT EXISTS reading_grade_level_computed NUMERIC,
  ADD COLUMN IF NOT EXISTS word_count_computed INT,
  ADD COLUMN IF NOT EXISTS forbidden_phrase_hits TEXT[],
  ADD COLUMN IF NOT EXISTS regenerated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS regenerated_by UUID REFERENCES auth.users(id);

CREATE INDEX idx_master_listings_tier ON shortlisting_master_listings(property_tier);
CREATE INDEX idx_master_listings_created ON shortlisting_master_listings(created_at);
CREATE INDEX idx_master_listings_regeneration ON shortlisting_master_listings(regeneration_count)
  WHERE regeneration_count > 0;

-- History table for regeneration audit trail (one row per archived version)
CREATE TABLE IF NOT EXISTS shortlisting_master_listings_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  master_listing_id UUID NOT NULL REFERENCES shortlisting_master_listings(id) ON DELETE CASCADE,
  round_id UUID NOT NULL,
  master_listing JSONB NOT NULL,
  property_tier TEXT NOT NULL,
  voice_anchor_used TEXT,
  regeneration_count INT NOT NULL,
  archived_at TIMESTAMPTZ DEFAULT NOW(),
  archived_by UUID REFERENCES auth.users(id),
  archive_reason TEXT
);
CREATE INDEX idx_master_listings_history_round ON shortlisting_master_listings_history(round_id);

-- Audit trail for human edits (per-field diff)
CREATE TABLE IF NOT EXISTS shortlisting_master_listings_human_edits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  master_listing_id UUID NOT NULL REFERENCES shortlisting_master_listings(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  prior_value TEXT,
  new_value TEXT,
  edited_by UUID NOT NULL REFERENCES auth.users(id),
  edited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edit_reason TEXT
);
CREATE INDEX idx_master_listings_human_edits_ml ON shortlisting_master_listings_human_edits(master_listing_id);
```

### Backfill

None required. New rounds populate from Phase A (W11.7.4) onward.

---

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Hallucinated facts (sqm, pool depth, year built, school catchment) | Prompt forbids inventing any numeric or factual claim not in `property_facts`. Post-emission validator scans for likely-hallucinated patterns ("circa 19XX", "approximately N sqm") and flags if not in facts. |
| Tier mismatch (premium voice on $800K home; approachable voice on $5M home) | Voice anchor selection gated by `property_tier` input. Default coercion (W11.7.8) from price_guide_band. Operator can override. |
| SEO title-tag duplication across same-suburb listings | `seo_meta_description` requires suburb + property type + 1 unique distinguishing feature. Post-emission cross-listing dup detection (Levenshtein >0.85, last 30 days same-suburb) flags duplicates. |
| Copy stale for re-shoots | Master listings versioned per `round_id`. New round → new master_listing. Regeneration endpoint for in-round re-draft. |
| Prompt injection via `property_facts` | HTML-escape and length-cap pre-prompt-assembly. address_line ≤100 chars; suburb ≤50. |
| Reading-grade self-report drift from recomputed | Both stored. Dashboard alerts when delta >2 grades. |
| Forbidden-phrase regex false positives | Tier-aware patterns. Premium permits "stunning" with architectural noun; standard/approachable reject all uses. |
| Regenerate cost burn ($1.20 per call) | Operator-initiated, infrequent. Cost accepted. |
| Master listing quality varies by tier × property type | Phase B 100% editorial review, first 100 rounds. Calibration loop. |

---

## Open questions for sign-off

1. **Tier-mismatch override flow.** When the operator selects `standard` tier on project setup but the property genuinely warrants `premium` voice (e.g. exceptional renovation on a typical-suburb home), should the regenerate-master-listing endpoint flag a "voice mismatch suggestion" via a model self-assessment? Or rely entirely on the operator to spot it? **Recommendation:** Phase D feature, Phase B/C operator-driven only.

2. **Copywriter human-edit storage.** When an operator edits the generated master_listing in-app pre-publish, do we store the diff to `shortlisting_master_listings_human_edits` (audit trail) AND offer it as graduate-quality training data for future tier rubric tuning? **Recommendation:** Yes to both. Edited fields feed the W14 calibration session as ground truth for tier rubric calibration.

3. **Derivative output mandatory vs optional.** All 5 derivatives (SEO meta, social caption, brochure summary, agent one-liner, open-home email blurb) emit by default. Should low-tier listings (`approachable`) skip print_brochure_summary (mailbox drop unlikely) by default? **Recommendation:** Emit all 5 always; UI surfaces them per use case. Operator hides what they don't need.

4. **Multi-language support.** Should the master_listing schema support per-locale variants (e.g. Mandarin for Chatswood, Cantonese for Hurstville)? **Recommendation:** Out of scope for v1. Add as W11.7.7.1 if downstream analytics show language-of-listing as a material conversion signal.

5. **CRM facts confidence.** When `property_facts.bedrooms = null` (CRM hasn't been populated), should the model attempt to infer from images? **Recommendation:** No — model emits "bedroom count not provided" in body or skips the count specific. Never guess; always defer to CRM.

6. **Pilot copy reviewer recruitment.** Who is the designated copy reviewer for Phase B (100% review)? **Recommendation:** Joseph + 1 freelance copywriter at a per-listing review fee. ~50 listings/week × 4 weeks = 200 reviews × ~$15/review = $3,000 pilot budget.

---

## Pre-execution checklist

- [x] W11.7 keystone exists
- [x] W11 universal schema defines `master_listing` shape
- [ ] W11.7.8 voice tier modulation spec (companion to this) ready
- [ ] W11.7.9 master-class prompt enrichment spec (companion to this) ready
- [ ] Voice rubric blocks (premium, standard, approachable) drafted in `_shared/visionPrompts/blocks/voiceAnchorBlock.ts`
- [ ] Forbidden phrase regex array curated and reviewed by Joseph
- [ ] Migration 349 reserved (additions folded in alongside W11.7's primary migration)
- [ ] Stage 4 prompt template includes master_listing synthesis instructions
- [ ] `regenerate-master-listing` edge fn scaffolded
- [ ] `shortlisting_master_listings_history` + `shortlisting_master_listings_human_edits` tables present in migration
- [ ] W11.6 dashboard panel for master_listing quality flags scoped
- [ ] Joseph signs off on Q1-Q6 above
- [ ] Pilot reviewer (Phase B) recruited

---

## Effort estimate

| Sub | Description | Days |
|---|---|---|
| Spec finalisation | This doc + Joseph sign-off on Q1-Q6 | 1 |
| Voice rubric block authoring | `voiceAnchorBlock(tier, override?)` + 3 tier preset texts + override path | 1.5 |
| Forbidden-phrase regex curation | Pattern list + tier-aware overrides + tests | 0.5 |
| Stage 4 prompt assembly | Synthesis instructions + derivative output prompts + integration with W7.6 block pattern | 2 |
| Post-emission validators | Forbidden-phrase, reading-grade, word-count, cliché density, repeated-phrase | 1 |
| `regenerate-master-listing` edge fn | New endpoint + history archival + tier override path | 1.5 |
| Schema migration | Add `regeneration_count`, `quality_flags`, history table, human edits table | 0.5 |
| Dashboard panel (W11.6) | Voice consistency, forbidden-phrase trends, regeneration counts | 1 |
| Tests | Snapshot tests for voice rubrics, integration test for regeneration, validator unit tests | 1.5 |
| Pilot reviewer onboarding | Reviewer guidelines, review UI for editing master_listing, edit-audit wiring | 1 |
| **Implementation total** | | **~11.5 days** |
| Phase B pilot review labour | Per-listing review × 200 listings | ~80 hours over 4 weeks (reviewer time, not engineering) |

Build dependency: W11.7.1 (orchestrator) + W11.7.3 (Stage 4 handler) must be in place. This spec adds prompt blocks + validators + regeneration endpoint + history table on top.

---

## Cross-references

- `W11.7` — Shape D Multi-Stage Vision Engine Architecture (parent spec)
- `W11.7.8` — Voice Tier Modulation (drives the tier-aware voice anchor consumed here)
- `W11.7.9` — Master-Class Prompt Enrichment (voice exemplars + Sydney primer feed the synthesis)
- `W11` — Universal Vision Response Schema (`master_listing` interface lives in the schema)
- `W11.5` — Human Reclassification Capture (human edits to master_listing feed back as training data)
- `W11.6` — Rejection Dashboard (consumes quality flags from this spec)
- `W7.6` — Composable Prompt Blocks (assembly pattern this spec uses)
- `W14` — Calibration Session (master_listing edits in calibration become ground-truth for tier rubric tuning)
