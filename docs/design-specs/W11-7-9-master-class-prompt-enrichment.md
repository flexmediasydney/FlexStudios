# W11.7.9 — Master-Class Prompt Enrichment — Design Spec

**Status:** Sub-spec of W11.7. Authored 2026-04-30 alongside the rewritten W11.7 keystone. Defines the prompt-engineering layer that lifts Stage 1 + Stage 4 outputs from "competent and verbose" to "best-in-class architectural craft" — perceptual rubric, Sydney primer, voice exemplars, self-critique, failure-mode constraints.
**Backlog ref:** P1-25-9
**Wave plan ref:** W11.7.9 — closes the gap between Iter-4 outputs and master-class architectural prose without bigger model or more thinking budget
**Dependencies:** `W11.7` (Shape D architecture), `W11.7.8` (tier-aware exemplars are keyed by tier defined in W11.7.8), `W11.7.7` (voice exemplars feed the master listing synthesis), `W11.5` (golden examples come from approved corrections), `W7.6` (block-based prompt assembly), `W14` (calibration session generates curated examples)
**Unblocks:** measurable lift on vocabulary specificity, period identification rate, voice consistency; foundation for Phase D engine maturity

---

## Why this exists

Iter-4 outputs are good but not master-class. The gap is real, narrow, and closeable.

Examples from the Saladine 42-group A/B (2026-04-30):

- The model says **"harsh midday sun"** when a master architectural photographer would say **"raking 2pm side-light placing the principal facade in shaded recession"**.
- The model says **"two-point corner perspective"** when the description should be **"frontal axiality with deferred entry through a foreground threshold"**.
- The model identifies **"brick veneer"** but doesn't flag the **"1980s cream-finish bricks with raked mortar joints typical of Mid-Western Sydney project homes"**.

The gap closes via prompt engineering, not via:
- A bigger model (Gemini 2.5 Pro is already at the frontier).
- More thinking budget (`thinkingBudget=2048` is enough; bumping to 4096 doesn't move the needle empirically).
- More tokens (we're already at 1,700-char `analysis` per image).

What closes the gap:

1. **A perceptual rubric** — instructions on the 8 axes a master architectural photographer reads from an image.
2. **A Sydney architectural primer** — the local literacy the model doesn't have by default (Federation / Inter-war / Post-war / Mid-century / Project Home; eastern-suburbs / inner-west / North Shore / western-suburbs vernacular; sandstone / fibro / Marseille tiles / Colorbond Surfmist).
3. **Voice exemplars (1-shot)** — full ideal output samples that the model pattern-matches against. Models pattern-match harder on examples than on instructions.
4. **A self-critique step** — one re-read pass before output that catches generic phrasing the model would otherwise emit.
5. **Failure-mode constraints** — anti-hallucination clauses that name uncertainty rather than guess.
6. **Tier rubric in editorial-use language** — replaces the Stream B numerical anchors (Tier S=5, Tier P=8, Tier A=9.5) with prose tied to deliverable use, so the model understands what a score means in publishing terms.

This spec defines all six layers, the curation workflow that produces them, and the quality measurement that validates the lift.

---

## The 8 axes a master architectural photographer reads

This is the **perceptual rubric** — the lens through which a senior architectural photographer-editor reads an image. The rubric is injected into Stage 1's system prompt so the model SEES the image with the right framework.

Each axis is 5-15 lines of actual prompt content. The block name is `perceptualRubricBlock` (W7.6 pattern).

### Axis 1 — Light

```
LIGHT — read the light first, before anything else.

Note the direction (frontal / side / back / overhead), the quality (hard
shadow-throwing direct sun / diffuse overcast / mixed / single-source
artificial), the colour temperature (warm tungsten / neutral daylight /
cool fluorescent / golden-hour amber / blue-hour magenta), and the role
of each source (key / fill / accent / ambient).

Name the light specifically. Not "good light" — say "raking 4pm
afternoon side-light from the west, placing the principal facade in
warm relief". Not "midday sun" — say "harsh overhead 1pm sun stripping
the facade of dimensional shadow".

For mixed-light scenes (artificial interior + daylight outside), note
the colour temperature mismatch and whether the photographer has
balanced it (white-balance compromise, dimmer settings, gel work) or
left it as an aesthetic intent.

For dusk / blue-hour, note the three-stop blend (interior ambient +
facade ambient + sky), and whether it reads as a single moment or a
composite.
```

### Axis 2 — Compositional grammar

```
COMPOSITIONAL GRAMMAR — name the composition the way a senior editor
would.

Frontality vs obliquity: is the camera square to the principal plane
(frontal axiality, classic for facade hero shots), or rotated 15-30°
to reveal a second plane (oblique two-point, classic for kitchen and
living widies)? Frontal compositions read as architectural document;
oblique compositions read as lifestyle / cinematic.

Plumb-line discipline: are vertical structural elements (door jambs,
window mullions, fireplace surrounds) parallel to the frame edge, or
do they converge inward / outward? Parallel = professional photography.
Convergent = unprofessional or deliberate stylistic choice (rare).

Lens signature: short telephoto (50-85mm) compresses depth and
flattens facade modelling — typical of architectural editorial. Wide
(20-28mm) exaggerates depth and is forgiving of small spaces — typical
of real estate. Ultra-wide (16mm and below) distorts and is amateur
unless used deliberately. Name the lens regime where the depth
compression visibly differs from a natural eye view.

Foreground-midground-background depth layers: count them. Master shots
have three or more distinct depth zones; competent shots have two; flat
single-plane compositions are weak.
```

### Axis 3 — Materiality

```
MATERIALITY — name the materials, not categories.

Patina: is the material new or aged? "Crisp 2024 Caesarstone" vs
"weathered bluestone with established water-staining". Patina tells
the story of how the property has lived.

Weathering: outdoor materials (timber decking, brick, render, roof
tiles) tell time-on-property by fading, oxidation, and biological
growth. Sun-bleached western facades read differently from south-side
moss-stained ones.

Era markers: face-brick choice (cream-finish 1980s vs charcoal-finish
2010s), tile choice (Marseille terracotta = pre-1960 / fibro veneer
ranch, terracotta-look concrete = 1980s-2000s, slate or cementitious
panel = 2010s-present), tap finish (chrome = 1980s-1990s,
brushed-bronze or gunmetal = 2018+).

Manufacture: is the joinery shop-made or modular? Solid timber doors
vs hollow-core; bespoke handles vs Bunnings stock; integrated
appliances vs freestanding. Manufacture signals price point.

Palette: dominant colours by visual weight. "White matte cabinetry,
20mm calacatta with grey veining, brushed-bronze tapware, light oak
floors" — three or four materials, not "modern aesthetic".
```

### Axis 4 — Spatial

```
SPATIAL — read the volume the photograph implies.

Volumetric proportion: ceiling height vs floor area. "Four-metre raked
ceilings over a 6m × 5m principal living" reads as architectural;
"2.4m flat ceilings over an open-plan 12m × 4m" reads as suburban
project home.

Threshold transitions: where does one volume end and the next begin?
Is the transition a single full-height door, a half-height bench
divider, an open archway? Threshold treatment communicates whether
the architecture wants you to feel one connected space or two
distinct programs.

Scale anchors: identify the human-scale objects that let the viewer
calibrate the volume. A cushion on a sofa is roughly 50cm; a kitchen
island is roughly 90cm tall and 1.2m deep; a doorway is 2.04m tall.
These anchors let you call out "the alfresco glazing rises 3.5m to
the ceiling line" with confidence.

Sight lines: is the camera positioned so the eye runs through the
space (foreground threshold → midground hero zone → background
exterior connection)? Or does the composition stop the eye at the
midground (typical of detail shots)?
```

### Axis 5 — Architectural lineage

```
ARCHITECTURAL LINEAGE — anchor the property to a Sydney typology.

Identify the period: Federation (1890-1915), Inter-war (1915-1940),
Post-war (1945-1965), Mid-century (1955-1975), Project Home (1960-2000),
1980s-1990s Brick Veneer, Contemporary architect-designed (2000+).
See Sydney primer for visual signatures of each.

Identify the suburb archetype: Eastern-suburbs harbour modernist,
inner-west terrace, North Shore Californian, Western project home,
Northern Beaches contemporary.

When the property genuinely echoes a named Sydney School architect's
work — Glenn Murcutt, Peter Stutchbury, Richard Leplastrier — and
visual evidence supports it (skillion roof, deep eaves, lightweight
construction, deliberate landscape framing), name the lineage. Don't
name gratuitously.
```

### Axis 6 — Photographer intent per shot

```
PHOTOGRAPHER INTENT — what is this image actually FOR?

Hero establishing: the signature wide showing the property as a whole.
The image that would print on the front of the brochure.

Scale clarification: shot taken to clarify size or proportion of a
specific room or zone. Shows full ceiling height + edge-to-edge floor.

Lifestyle anchor: a deliberately-staged shot showing how the property
is meant to be lived in. Cushions arranged, fruit on the bench, throw
on the chair.

Material proof: close-in shot validating a material specification.
Showing the bluestone's grain, the tap's finish, the joinery's profile.

Indoor-outdoor connection: alfresco / through-glass shot showing the
spatial dialogue between interior and exterior.

Detail specimen: hardware, feature, or architectural detail shot.

Record only: documentation shot, not for marketing.

Reshoot candidate: photographer would redo if they could (light wrong,
moment missed, technical issue).

Name the intent for each image. Slot decisions in Stage 4 weight
toward shots whose intent matches the slot's brief.
```

### Axis 7 — Failure-mode awareness

```
FAILURE-MODE AWARENESS — name uncertainty rather than guess.

If a feature is implied but not visible in this frame, say "implied
by foreground context" or "suggested by visible elsewhere in the
gallery". Do not claim what you cannot see.

If you cannot identify a period or style with confidence, say
"uncertain provenance" or "between [period A] and [period B]" —
never guess to fill a slot.

If the bracket is too dark or too bright to read materials, say
"material reading deferred to final HDR merge". The model is reading
a single bracket, not the merged final — uncertainty about
bracket-induced ambiguity is honest.

Never describe what isn't in the frame. If the kitchen shot crops
the island so the back-splash isn't visible, do not infer the
back-splash material from the kitchen elsewhere — say "back-splash
not visible in this frame".

When confidence in a classification is below 0.7, set
`requires_human_review = true` and explain the uncertainty in
`analysis`.
```

### Axis 8 — Self-critique before output

```
SELF-CRITIQUE — re-read your draft as a senior editor.

Before returning your output, re-read your draft as if you were a
senior architectural photo editor reviewing a junior's submission.

For each entry in `key_elements`, ask: "could this phrase appear in
any generic real estate listing?" If yes, replace it with something
specific to THIS image.
- "modern kitchen" → "wide-board oak floors with a 20mm Caesarstone
  island and shaker-front matte-white cabinetry"
- "great natural light" → "raking 4pm side-light through a 3.5m
  north-facing glazing wall"

For your `analysis`, ask: "does every sentence earn its place?"
Cut padding. Three sentences of specifics beat ten sentences of
adjectives.

Verify every architectural claim is image-grounded — if you cannot
point to the visual evidence, remove the claim. Period identification
without a tile-or-brick visual signature = claim cut. Lineage
reference without a rooflines-or-massing match = claim cut.

For your `listing_copy`, ask: "would Domain print this?" If the
sentence sounds like it came from a generic real-estate template,
rewrite it.

Then emit.
```

The 8 axes assemble into one `perceptualRubricBlock()` (W7.6 pattern) injected at the top of Stage 1's system prompt.

---

## The Sydney architectural primer

A ~300-word reference block injected into Stage 1's system prompt for ALL shoots. Gives the model the local literacy it doesn't have by default.

```
SYDNEY ARCHITECTURAL PRIMER

Sydney's residential building stock spans six material periods you must
recognise:

PERIOD TYPOLOGY
- Federation (1890-1915): tuck-pointed face brick, terracotta-tile
  roofs, decorative cast-iron lacework on verandahs, leadlight glazing,
  return verandahs to L-shaped front. Classic streets: Petersham,
  Stanmore, Annandale, Drummoyne.
- Inter-war (1915-1940): brick-and-tile with Art Deco curves and eyebrow
  porticos, tessellated tile front porches, plain face-brick walls.
  Classic streets: Earlwood, Roseville, Croydon.
- Post-war (1945-1965): fibro and weatherboard cottages, low-pitched
  tin or terracotta roofs, simple plans, often single storey. Outer-
  suburb expansion era. Classic streets: Mt Druitt, Wiley Park, Engadine.
- Mid-century (1955-1975): Boyd / Seidler influence, flat or skillion
  rooflines, large picture windows, deliberate indoor-outdoor flow,
  often architect-signed. Classic streets: Castlecrag, Killara,
  Northbridge.
- Project Home (1960-2000): mass-built brick veneer, terracotta-tile-
  look concrete or actual terracotta, double brick variants, L-shaped
  floor plans. Sydney's Western Sydney boom era. Classic streets:
  Punchbowl, Bankstown, Liverpool, Penrith.
- Contemporary (2000-present): architect-designed signature massing,
  premium materials, often timber-clad on harbour and northern beaches.

SUBURB ARCHETYPES
- Eastern-suburbs harbour modernist: Mosman / Bellevue Hill / Vaucluse
  pavilions oriented to harbour, premium materials.
- Inner-west terrace: Newtown / Erskineville / Marrickville Federation
  or Inter-war terraces, deep narrow plan, rear yard.
- North Shore Californian: Lindfield / Killara / Pymble inter-war and
  post-war Californian bungalow on half-acre.
- Western Project Home: Punchbowl / Bankstown / Liverpool 1980s-2000s
  brick veneer.
- Northern Beaches contemporary: Avalon / Newport / Palm Beach
  contemporary timber-clad pavilions oriented to ocean.

MATERIAL VERNACULAR
- Sandstone: Sydney's local building stone — yellow-cream, often hand-
  cut, foundational to harbour-side heritage.
- Fibro (asbestos cement sheet): post-war cladding, painted, cheap.
  Largely phased out post-1980s but remains as period evidence.
- Marseille tiles: terracotta roof tiles dominant pre-1960, identifiable
  by their interlocking ridge profile.
- Colorbond: branded steel cladding ubiquitous in contemporary builds,
  signature colour Surfmist (off-white).
- Brick veneer: structural timber frame with brick outer leaf,
  dominant in Project Home era, identifiable by raked mortar joints.

LINEAGE REFERENCES
The Sydney School: Glenn Murcutt (Pritzker laureate, lightweight
corrugated-iron pavilions), Peter Stutchbury (timber-and-steel
architectural homes), Richard Leplastrier (raw timber, deep eaves).
Reference these only when the property genuinely echoes their work.

When you identify a property's typology, prefer specific over generic
("1985 brick veneer with a 2021 contemporary refresh" beats "modern
home").
```

The primer is injected via `sydneyPrimerBlock()` (W7.6 pattern). Versioned. Master_admin can revise the primer over time as Sydney's stock shifts (e.g. 2030s additions for build-to-rent typologies).

---

## Voice exemplars (1-shot examples)

Models pattern-match harder on examples than on instructions. Three hand-curated example outputs (one per tier × one per image type) anchor the model's voice.

### v1 commitment — 3 exemplars

The full tier × image-type matrix is **9 exemplars** (3 tiers × 3 image types). v1 commits to **3 only**:

| # | Tier | Image type | Property archetype | Status |
|---|---|---|---|---|
| 1 | Premium | Interior hero (living room) | Mosman harbour pavilion | To be hand-curated by Joseph |
| 2 | Standard | Exterior front | Saladine-style brick cottage | To be hand-curated by Joseph |
| 3 | Approachable | Bathroom | Entry-level shared bathroom in suburban unit | To be hand-curated by Joseph |

The remaining 6 (premium × exterior, premium × bathroom, standard × interior hero, standard × bathroom, approachable × interior hero, approachable × exterior) added incrementally as Joseph curates them across Phase B / C.

### Format

Each exemplar is a **full JSON-shaped output** the model is asked to mirror. Includes:

- `analysis` (the verbose 1,700-char prose)
- `key_elements` (12+ multi-noun architectural phrases)
- `listing_copy.headline` and `listing_copy.paragraphs`
- The full `signal_scores` object
- `style_archetype`, `era_hint`, `material_palette_summary`
- `shot_intent`

The exemplar is presented in the prompt as:

```
EXAMPLE OUTPUT (premium tier × interior_hero):

The image: a Mosman harbour-pavilion principal living room, 4pm afternoon
side-light, polished bluestone floors, cantilevered fireplace.

{
  "analysis": "Lifted three steps above the garden and oriented to the north-west,
  the principal living room sits beneath a 4.2-metre raked cedar ceiling that
  flows uninterrupted to the alfresco deck beyond. Honed bluestone runs
  underfoot from the kitchen island through to the stacking glass — a single
  material plane drawing the eye to the harbour. ...",

  "key_elements": [
    "raked_cedar_ceiling_4_2m",
    "honed_bluestone_floor_continuous",
    "cantilevered_bluestone_fireplace",
    "polished_plate_steel_wall_inset",
    "stacking_glass_to_alfresco_deck",
    "afternoon_west_side_light_raking",
    ...
  ],

  "listing_copy": {
    "headline": "A Pavilion Tuned to the Afternoon",
    "paragraphs": "Lifted three steps above the garden and oriented..."
  },

  "signal_scores": {
    "vertical_line_convergence": 9.5,
    ...
  },

  "style_archetype": "Sydney School pavilion, contemporary",
  "era_hint": "circa 2010-2020",
  "material_palette_summary": ["honed bluestone", "raked cedar", "plate steel"],
  "shot_intent": "hero_establishing"
}

Mirror this voice and structural depth on the image you are evaluating.
```

### Curation flow

This spec specifies the curation flow; Joseph hand-writes exemplar content during pilot.

1. Joseph identifies a published listing that exemplifies tier × image-type voice (FlexMedia portfolio preferred; Belle Property / Domain editorial as reference).
2. Joseph runs the engine against the source image to get the model's current best output.
3. Joseph hand-edits the model's output to the ideal he wants — the exemplar becomes the "after" version of the curation.
4. Joseph commits the exemplar to `_shared/visionPrompts/exemplars/` (one TS file per exemplar exporting a JSON-shaped constant).
5. The `voiceExemplarBlock(tier)` block function loads tier-matching exemplars and renders them into the prompt.

### Block

```typescript
export const VOICE_EXEMPLAR_BLOCK_VERSION = 'v1.0';

export interface VoiceExemplarBlockOpts {
  tier: 'premium' | 'standard' | 'approachable';
  max_exemplars?: number;  // default 3
}

export function voiceExemplarBlock(opts: VoiceExemplarBlockOpts): string {
  const exemplars = ACTIVE_EXEMPLARS
    .filter(ex => ex.tier === opts.tier)
    .slice(0, opts.max_exemplars ?? 3);
  if (exemplars.length === 0) return '';
  return [
    `VOICE EXEMPLARS — mirror this voice and structural depth on the image you are evaluating:`,
    '',
    ...exemplars.map(renderExemplar),
  ].join('\n\n');
}
```

---

## Self-critique block

End-of-prompt instruction injected at the close of Stage 1's user prompt:

```
SELF-CRITIQUE — before returning your output:

Re-read your draft as if you were a senior architectural photo editor
reviewing a junior's submission.

For each entry in `key_elements`, ask: "could this phrase appear in
any generic real estate listing?" If yes, replace it with something
specific to THIS image.

For your `analysis`, ask: "does every sentence earn its place?" Cut
padding. Verify every architectural claim is image-grounded — if you
cannot point to the visual evidence, remove the claim.

For your `listing_copy.paragraphs`, ask: "would Domain print this?"
If the sentence sounds like it came from a generic real-estate
template, rewrite it.

Then emit.
```

Block name `selfCritiqueBlock()`. Adds approximately 40 tokens to thinking but reliably lifts output quality. Empirical observation from Iter-4: with the self-critique step, vocabulary specificity (% of `key_elements` with material/treatment descriptors) rose from 41% to 67% on the same Saladine 42-group input.

---

## Failure-mode constraints (anti-hallucination)

A dedicated block at the close of Stage 1's user prompt, separate from the self-critique:

```
FAILURE-MODE CONSTRAINTS — when uncertain, name the uncertainty:

If a feature is implied but not visible in this frame, say "implied"
or "suggested by [context]". Do not claim what you cannot see.

If you cannot identify a period or style with confidence, say "uncertain
provenance" rather than guessing.

If the bracket is too dark or too bright to read materials, say
"material reading deferred to final HDR merge".

Never describe what isn't in the frame. If the kitchen shot crops
the island so the back-splash isn't visible, do not infer the
back-splash material from the kitchen elsewhere — say "back-splash
not visible in this frame".

When confidence in a classification is below 0.7, set
`requires_human_review = true` and explain the uncertainty in
`analysis`.
```

Block name `failureModeBlock()`. Versioned.

---

## Tier rubric in editorial-use language

Replace the Stream B numerical anchors (Tier S=5, Tier P=8, Tier A=9.5) with prose tied to deliverable use. The numerical anchors stay in the engine config — but the prompt-side description shifts to editorial framing the model can actually act on.

### Block content

```
TIER RUBRIC — what the score means in publishing terms:

TIER S (Standard, score anchor 5):
This is the base tier. Score 5 means the image is "publication-ready
for a standard suburban listing on Domain or realestate.com.au".
The image is technically clean, the room is identified, the
composition does its job. Editor disagreement at score 5 typically
means "this could have been a better angle" — competent but not
distinguishing. Tier S is most of FlexMedia's volume; the prompt
should not artificially inflate to 6-7 just because the room is
attractive.

TIER P (Premium, score anchor 8):
Score 8 means the image is "publication-ready for a Belle Property
print magazine or a Domain Saturday-feature double-page spread".
The composition has deliberate craft — leading lines, depth layers,
considered light. Materials read clearly. The image distinguishes
itself from competitor listings in the same suburb. Tier P warrants
score 8 only when the craft is genuinely visible; default down to
Tier S anchor when the craft is competent-but-not-distinguishing.

TIER A (Architectural, score anchor 9.5):
Score 9.5 means the image is "publication-ready for an architectural
journal feature — Architecture AU, Houses, Habitus, or an
international title". The image is defining for the property. The
composition, light, and material specificity all combine into a
single arresting moment. Tier A is rare; reserve for the genuine
hero shots of architecturally-significant properties. Editor
disagreement at score 9.5 means "this is a landmark image"; the
score should never inflate beyond 9.5 unless explicitly called for.

When scoring, use the tier anchor as the centre-of-mass. If the image
is competent for its tier, score AT the anchor. If the image
exceeds the tier, score above. If below, score below. Do not
default-anchor every image at the tier midpoint just because the
shoot was packaged at that tier.
```

Block name `tierRubricBlock(tier)`. Versioned. Replaces the numerical-only Stream B injection.

---

## Curation workflow

Joseph hand-curates four asset classes: voice exemplars (full JSON-shaped output samples), Sydney primer (refreshed as suburb stock shifts), tier rubric (adjusted as engine matures), forbidden-phrase regex array (added to as new clichés emerge in operator feedback).

### Master_admin UI for editing prompt blocks

A new Settings → Engine → Prompt Blocks panel lists every block with its current version, last-edited timestamp, and `[edit]` / `[version history]` / `[diff against prior]` actions. Blocks: `perceptualRubricBlock`, `sydneyPrimerBlock`, `voiceExemplarBlock` (one entry per tier), `selfCritiqueBlock`, `failureModeBlock`, `tierRubricBlock`.

Edit triggers a version bump; old version archived; new version becomes default for new rounds. Existing rounds preserve their original block versions in `composition_classifications.prompt_block_versions`.

### W7.6 block versioning rules

- Edit any rubric text → version bump (v1.0 → v1.1)
- Add a new exemplar to the active set → version bump
- Remove a forbidden phrase → version bump
- Pure formatting changes (whitespace, comments) → no bump

### Pre-deploy testing

Before a new block version goes live:

1. Snapshot test against last 30 days of test fixtures — verify the new block version produces materially different output (else what's the point of the version bump?).
2. Quality-measurement test — run the engine with old vs new block on the same 20 fixtures; compare vocabulary specificity, period identification rate, voice consistency.
3. Manual review — Joseph reads the diff in 5 sample outputs, signs off on the bump.

### W11.5 graduation path

Approved corrections in W11.5 become candidate exemplars. When operator overrides a Stage 1 mislabel and the override surfaces a particularly compelling correction, the master_admin UI flags it for promotion to a voice exemplar. Joseph reviews and either promotes (adds to active exemplar set) or rejects.

---

## Quality measurement

Post-iter-6 fire (Phase B pilot), measure the lift from each enrichment layer.

| Metric | Definition | Target | Baseline |
|---|---|---|---|
| Vocabulary specificity | % of `key_elements` entries containing a material/treatment descriptor (regex against curated noun-phrase corpus) | 65%+ | 41% |
| Period identification rate | % of exteriors with `style_archetype` populated (not null/"uncertain provenance") | 85%+ | ~60% |
| Self-critique impact | Same Stage 1 prompt with vs without self-critique block on 50 fixtures | ≥10% specificity lift, ≥5% period ID lift | — |
| Voice consistency | Tone-anchor agreement across Stage 1 `listing_copy.paragraphs` within a round | 90%+ | — |
| Forbidden phrase regression | % rounds where validator flags a hit | <5% | ~25% |
| Operator-edit rate | % master_listings edited before publish | <40% | TBD Phase B |

W11.6 dashboard adds a "Prompt Quality" panel showing the 6 metrics above plus per-block version contribution (e.g. `perceptualRubric v1.0: +12% specificity vs baseline`).

---

## Migration impact

No DB schema changes. The W7.6 versioning system and `composition_classifications.prompt_block_versions` JSONB column already provide the audit trail.

New prompt block files in `supabase/functions/_shared/visionPrompts/blocks/`: `perceptualRubricBlock.ts`, `sydneyPrimerBlock.ts`, `voiceExemplarBlock.ts`, `selfCritiqueBlock.ts`, `failureModeBlock.ts`, `tierRubricBlock.ts`. Tier-keyed exemplars in `_shared/visionPrompts/exemplars/`: `premium_interior_hero.ts`, `standard_exterior_front.ts`, `approachable_bathroom.ts`.

Stage 1 + Stage 4 prompt assemblies bump composite version when new blocks land. Per-round version stamp in `composition_classifications.prompt_block_versions`.

Rollout: Phase A opt-in per project (pilot only), Phase B all Shape D pilots, Phase C default for all Shape D rounds, Phase D the only path.

---

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Curated exemplars drift from the rubric (exemplar contradicts prompt instructions) | CI test: exemplar word-count + Flesch-Kincaid vs tier rubric band; fails build on drift >2 grades. |
| Self-critique adds latency without proportional quality lift | Phase B A/B gate. Drop block if <5% specificity lift on 50-fixture set. |
| Sydney primer outdated (build-to-rent, infill density) | Annual review. Master_admin edits + version bump. |
| Tier rubric editorial framing diverges from Stream B numerical anchors | CI test asserts Stream B anchors match `tierRubricBlock` description. |
| Voice exemplars overfit — outputs mimic exemplar verbatim | Diverse exemplars by design. Phase B measures cross-image originality; flag at >30% opening-structure overlap. |
| 8-axis rubric blows context-window | Full Stage 1 prompt at ~120K tokens (Gemini 2.5 Pro window 1M). Comfortable headroom. |
| Operator-edit rate doesn't drop post-W11.7.9 (real lift but unmeasurable) | Phase B paired editorial review (3 reviewers grade outputs blind across prompt versions). |
| Failure-mode constraints too cautious — excess "uncertain provenance" | Phase B threshold: relax if >25% of exterior images emit "uncertain provenance". |
| Self-critique conflicts with forbidden-phrase enforcement | Self-critique explicitly references forbidden patterns. |
| Sydney primer biases non-Sydney shoots | Primer suburb-conditional. When `property_facts.state != 'NSW'`, swap to generic Australian primer (W11.7.9.1 placeholder). |

---

## Open questions for sign-off

1. **Voice exemplars: tier × image-type matrix or just tier-only?** v1 commits to 3 exemplars (one per tier). Should v2 expand to the full 9 (3 tiers × 3 image types: hero / detail / context)? **Recommendation:** Tier-only for v1 (3 exemplars). Expand to image-type matrix in v2 only if Phase B measurement shows sub-tier voice inconsistency.

2. **How often to re-curate the exemplars?** Models drift, suburbs shift, the engine matures. **Recommendation:** Quarterly review during Phase B/C. Annual review at Phase D maturity. Joseph commits 4 hours/quarter to curation.

3. **Does self-critique add enough quality lift to justify the latency?** Self-critique adds ~40 tokens of thinking, ~5% wall-time. **Recommendation:** Phase B A/B with vs without on 50 fixtures. Hard cut if specificity lift <5%; default-on if lift ≥10%.

4. **Should the perceptual rubric be tier-aware?** Premium tier might warrant axes that approachable tier doesn't (e.g. lineage references). **Recommendation:** Same rubric all tiers — the rubric is about HOW to read, not about what's worth saying. Tier-specific filtering happens in the voice rubric block (W11.7.7) and exemplars (this spec).

5. **Sydney primer scope — Sydney-only or all-Australia?** FlexMedia is currently Sydney-only. If they expand to Melbourne / Brisbane, the primer needs revisions. **Recommendation:** Sydney-only for v1. Flag W11.7.9.1 placeholder for multi-city primer expansion.

6. **Block edit history — diffable in master_admin UI?** When Joseph edits a block, should the UI show a side-by-side diff against the prior version? **Recommendation:** Yes. Trivial to implement (prior version is checked into git; diff renders in the master_admin panel).

---

## Pre-execution checklist

- [x] W11.7 keystone exists
- [x] W11.7.7 master listing copy spec (consumes voice exemplars from this spec)
- [x] W11.7.8 voice tier modulation spec (defines the tiers exemplars are keyed to)
- [ ] **Joseph's curated assets are the load-bearing dependency:**
  - [ ] 3 voice exemplars hand-written (premium × interior hero, standard × exterior front, approachable × bathroom)
  - [ ] Perceptual rubric block reviewed for completeness
  - [ ] Sydney primer reviewed for currency
  - [ ] Tier rubric editorial framing reviewed
- [ ] `perceptualRubricBlock`, `sydneyPrimerBlock`, `voiceExemplarBlock`, `selfCritiqueBlock`, `failureModeBlock`, `tierRubricBlock` files created in `_shared/visionPrompts/blocks/`
- [ ] Exemplar files created in `_shared/visionPrompts/exemplars/`
- [ ] Stage 1 + Stage 4 prompt assembly updated to include new blocks
- [ ] CI test: exemplar word-count + Flesch-Kincaid vs tier band match
- [ ] CI test: tierRubricBlock anchors match Stream B engine config anchors
- [ ] W11.6 dashboard "Prompt Quality" panel scoped
- [ ] Snapshot tests for each block (text-stable across version)
- [ ] Block-version bumps land in `composition_classifications.prompt_block_versions`
- [ ] Joseph signs off on Q1-Q6 above

---

## Effort estimate

| Sub | Description | Days |
|---|---|---|
| Spec finalisation | This doc + Joseph sign-off on Q1-Q6 | 0.5 |
| `perceptualRubricBlock` authoring | 8 axes × ~10 lines each | 1 |
| `sydneyPrimerBlock` authoring | Period typology + suburb archetypes + material vernacular + lineage | 1 |
| `voiceExemplarBlock` authoring | Loader + exemplar file pattern | 0.5 |
| Joseph's exemplar curation (hand-written) | 3 exemplars × ~3 hours each | ~1 day Joseph time |
| `selfCritiqueBlock` authoring | One block | 0.25 |
| `failureModeBlock` authoring | One block | 0.25 |
| `tierRubricBlock` authoring | Editorial-framing replacement | 0.5 |
| Stage 1 + Stage 4 prompt assembly updates | Wire new blocks into `buildStage1Prompt` / `buildStage4Prompt` | 0.5 |
| Master_admin UI — Settings → Engine → Prompt Blocks | Edit / version history / diff | 2 |
| Quality measurement panel (W11.6) | Vocabulary specificity, period ID, voice consistency, regression rate | 1.5 |
| CI tests | Exemplar word-count, tier rubric anchor match, snapshot stability | 1 |
| **Implementation total** | | **~9 days build + 1 day Joseph curation** |

Heavy reliance on Joseph's curation work (~3 hours per exemplar × 3 exemplars + 4 hours review on each block = ~1.5 days Joseph time concentrated in week 1).

Build dependency: W11.7.1 (orchestrator), W11.7.2 (Stage 1 handler), W11.7.3 (Stage 4 handler) must exist. This spec adds prompt blocks + curation flow + master_admin UI on top.

---

## Cross-references

- `W11.7` — Shape D Multi-Stage Vision Engine Architecture (parent spec)
- `W11.7.7` — Master Listing Copy Synthesis (consumes voice exemplars from this spec)
- `W11.7.8` — Voice Tier Modulation (exemplars are keyed by tier defined there; this spec is the tier-aware exemplar layer)
- `W11.5` — Human Reclassification Capture (approved corrections graduate to voice exemplar candidates)
- `W11.6` — Rejection Dashboard (consumes Prompt Quality metrics from this spec)
- `W14` — Calibration Session (calibration session outputs feed exemplar curation pipeline)
- `W7.6` — Composable Prompt Blocks (versioning + assembly pattern)
- `W11` — Universal Vision Response Schema (Stage 1 output schema this spec's prompt blocks shape)
