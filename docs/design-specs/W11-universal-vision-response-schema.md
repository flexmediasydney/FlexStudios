# W11 — Universal Vision Response Schema — Design Spec

**Status:** Design phase. The architectural keystone of the entire roadmap.
**Cannot be delegated to subagents** without Joseph's sign-off — schema decisions here propagate to Wave 12, Wave 13b, Wave 15a/b/c.
**Effort:** ~1 week design + 4-5 weeks execution.

---

## ⚡ Execution shape change (2026-04-30 / 2026-05-01) — read this first

**This spec was originally authored for the two-pass architecture (Pass 1 + Pass 2 separate).** It was then revised for a "single unified Opus 4.7 call + async Sonnet description backfill". After 4 iterations of A/B testing on a 42-group Saladine round (2026-04-29 → 2026-05-01), the production architecture is now **Shape D** — a 5-call multi-stage Gemini-anchored pipeline. See `W11-7-unified-shortlisting-architecture.md` for the full architecture rewrite.

What this means for W11:

- **The 22-signal scoring schema is unchanged.** Every field in the per-signal `signal_scores` and `image_classification` / `room_classification` shapes below remains correct.
- **The producer changes — now 5 calls, not 1.**
  - **Stage 1** (3-4 batches × 50 images each, parallel): each call returns a full `UniversalVisionResponse` per image (verbose `analysis`, full `signal_scores`, `key_elements`, `observed_objects`, `clutter`, plus the iter-5+ additions documented below). Anchor: Gemini 2.5 Pro `thinkingBudget=2048`, `maxOutputTokens=6000`. Cost ~$0.66/call.
  - **Stage 4** (single call, sees ALL ~200 images PLUS reads Stage 1 JSON as text context): emits `slot_decisions[]`, `master_listing{}`, `gallery_sequence[]`, `dedup_groups[]`, `stage_4_overrides[]`, plus the master-level fields documented below. Anchor: Gemini 2.5 Pro `thinkingBudget=16384`. Cost ~$1.20.
- **Total per 200-angle shoot: ~$3.84, 5 calls (4 Stage 1 + 1 Stage 4), ~5 min wall.**
- **Async Sonnet description backfill is GONE.** Stage 1 produces verbose ~1,700 char `analysis` strings inline per image. No separate post-round Sonnet pass.
- **Vendor primary is Gemini 2.5 Pro** (cheaper, higher output token cap, more accurate on exterior orientation). Anthropic Opus 4.7 stays via `W11.8` multi-vendor adapter as failover + continuous A/B audit.
- **New per-image fields** added in iter-5: per-image listing copy, appeal/concern signals, retouch priority, gallery-position hints, confidence_per_field, style/era lineage, embedding anchor text, shot intent, canonical object ID linkage. See "Per-image output additions (iter-5+)" below.
- **New project-level fields** added in Stage 4: full `master_listing` object (headline, paragraphs, key_features, SEO meta, social caption, brochure summary, agent one-liner, open-home email blurb), gallery_sequence, dedup_groups, missing_shot_recommendations, narrative_arc_score, property_archetype_consensus, overall_property_score, stage_4_overrides. See "Schema additions for multi-stage vision engine (W11.7)" below.
- **New caller-provided input:** `property_tier` ('premium' | 'standard' | 'approachable', default 'standard') drives voice anchor for listing copy. Optional `property_voice_anchor_override` for per-project manual override.
- **W11 ships first; W11.7 ships after.** Shape D depends on W11's universal schema being the substrate.

Read both specs together. W11 = the schema contract. W11.7 = how the engine produces it.

## Vision

Joseph's "living entity" architecture: ONE structured response shape produced by every vision API call, regardless of input source (internal RAW / internal finals / external REA listing / floorplan image). The schema unifies the engine's eyes — every downstream system speaks one language.

Three call sites today + tomorrow:
1. **Internal RAW** (today's Pass 1) — feeds shortlisting + signals + objects
2. **Internal finals** (Wave 15a) — feeds quality QA + post-edit signals + objects (validate against RAW)
3. **External REA listings** (Wave 15b) — feeds competitor analysis + objects + missed-opportunity recalibration

If we get the schema right once, future call sites are wiring + downstream sinks. Wrong schema = parallel forks of prompt logic forever. This is the single most consequential design decision in the roadmap.

## The contract

```typescript
interface UniversalVisionResponse {
  schema_version: '1.0';

  // ─── Source metadata (caller-provided to the model) ──────────────────────
  source: {
    type: 'internal_raw' | 'internal_finals' | 'external_listing' | 'floorplan_image';
    media_kind: 'still_image' | 'video_frame' | 'drone_image' | 'floorplan_image';
    is_hdr_bracket?: boolean;       // RAW only — true for Canon AEB brackets
    is_post_edit?: boolean;         // finals only — true for delivered JPEGs
    external_url?: string;          // external only — provenance
    listing_id?: string;            // external only — pulse_listings.id
    bracket_index?: number | null;  // RAW only — which AEB bracket (0=center)
    bracket_count?: number | null;  // RAW only — total brackets in group
  };

  // ─── Reasoning-first prose (always required) ─────────────────────────────
  analysis: string;  // Min 3 sentences. Spec L9.

  // ─── Image-level classification (always required) ────────────────────────
  image_classification: {
    is_relevant_property_content: boolean;  // false → quarantine (agent headshot, BTS, equipment, test pattern)
    subject: 'interior' | 'exterior' | 'drone' | 'detail' | 'floorplan' | 'agent_headshot' | 'test_shot' | 'bts' | 'equipment' | 'video_thumbnail' | 'other';
    is_dusk: boolean;
    is_day: boolean;
    is_golden_hour: boolean;
    is_night: boolean;
    time_of_day_confidence: number;  // 0-1
    is_drone: boolean;
    drone_type: 'orbit_oblique' | 'nadir' | 'elevation_rise' | null;
    is_video_frame: boolean;
    quarantine_reason: 'agent_headshot' | 'bts' | 'test_shot' | 'equipment' | 'corrupt_frame' | 'severe_underexposure' | null;  // populated when is_relevant_property_content=false
  };

  // ─── Room/composition classification (when subject ∈ interior|exterior|drone|detail) ──
  room_classification: {
    room_type: string;                // canonical room_type (see Pass 1 prompt taxonomy)
    room_type_confidence: number;     // 0-1
    composition_type: string;         // canonical composition_type
    vantage_point: 'interior_looking_out' | 'exterior_looking_in' | 'neutral';
    is_styled: boolean;
    indoor_outdoor_visible: boolean;
    eligible_for_exterior_rear: boolean;  // alfresco + exterior_looking_in
  } | null;  // null when subject doesn't have a room (e.g. floorplan, agent_headshot)

  // ─── Observed objects (canonical-keyed, feeds object_registry) ──────────
  observed_objects: Array<{
    raw_label: string;                // model's free-form descriptor: "marble fireplace"
    proposed_canonical_key: string | null;  // model's guess at canonical OBJECT_*; null on first observation
    confidence: number;
    attributes: Record<string, unknown>;  // free-form; normalised downstream by object_registry batch
  }>;

  // ─── Per-signal scores (feeds composition_signal_scores table) ──────────
  signal_scores: {
    // Technical dimension (6 signals)
    vertical_line_convergence: number | null;
    horizon_level: number | null;
    focus_plane_accuracy: number | null;
    sharpness_primary_subject: number | null;
    noise_level_shadows: number | null;
    geometric_distortion_barrel: number | null;

    // Lighting dimension (6 signals)
    window_blowout_area: number | null;       // null on RAW (don't penalise); active on finals
    shadow_crush_percentage: number | null;
    ambient_artificial_balance: number | null;
    dusk_three_light_balance: number | null;  // null when not dusk
    light_source_consistency: number | null;
    specular_hotspots: number | null;

    // Compositional dimension (8 signals)
    sight_line_depth_layers: number | null;
    primary_subject_placement: number | null;
    foreground_element_present: number | null;
    composition_type_match: number | null;
    three_wall_coverage: number | null;       // null when not kitchen
    living_zone_count: number | null;         // count, not 0-10
    indoor_outdoor_connection_quality: number | null;
    vantage_point_score: number | null;       // alignment with slot's required vantage

    // Aesthetic dimension (8 signals)
    styling_deliberateness: number | null;
    colour_palette_coherence: number | null;
    material_texture_visibility: number | null;
    natural_light_quality: number | null;
    feature_prominence: number | null;
    surface_cleaning_quality: number | null;
    power_lines_distraction: number | null;   // null when not exterior
    poi_count: number | null;                 // null when not drone
  };

  // ─── Quality flags (always required) ─────────────────────────────────────
  quality_flags: {
    clutter_severity: 'none' | 'minor_photoshoppable' | 'moderate_retouch' | 'major_reject';
    clutter_detail: string | null;
    flag_for_retouching: boolean;
    is_near_duplicate_candidate: boolean;
  };

  // ─── Free-form bridges (lighter than observed_objects; feed key_elements) ─
  key_elements: string[];     // ["marble_island", "pendant_lights", "bronze_tapware"]
  zones_visible: string[];    // ["kitchen", "dining"]

  // ─── Source-specific extras (only populated for matching source.type) ────
  raw_specific?: {
    luminance_class: 'underexposed' | 'balanced' | 'overexposed';
    is_aeb_zero: boolean;
    bracket_recoverable: boolean;
  };

  finals_specific?: {
    looks_post_processed: boolean;
    vertical_lines_corrected: boolean;
    color_grade_consistent_with_set: boolean | null;  // requires set context
    sky_replaced: boolean;
    digital_furniture_present: boolean;
    digital_dusk_applied: boolean;
  };

  external_specific?: {
    estimated_listing_price_class: 'sub_1M' | '1M_to_3M' | '3M_to_10M' | '10M_plus' | 'unknown';
    competitor_branding_visible: boolean;
    competitor_credit_text: string | null;     // e.g. "Photography by Continuous Creative"
    package_signals: {
      indicates_dusk_product: boolean;
      indicates_drone_product: boolean;
      indicates_video_product: boolean;
      indicates_floorplan_product: boolean;
      photo_count_in_listing: number | null;
    };
  };
}
```

## Per-image output additions (iter-5+)

Stage 1 (W11.7) emits the full `UniversalVisionResponse` above PLUS the following fields per image. These were added through iter-3/iter-4/iter-5 testing as either marketing-relevant signals (listing copy, appeal/concern), production-workflow signals (retouch priority, gallery position), or model-self-assessment signals (confidence_per_field, requires_human_review).

```typescript
interface PerImageIter5Additions {
  // ─── Listing copy (per-image, Sydney real estate voice, tier-aware) ──────
  listing_copy: {
    headline: string;                       // 6-10 word headline for THIS specific image
    paragraphs: string;                     // 2-3 paragraphs, ~120-180 words, tier-aware voice
  };

  // ─── Marketing / buyer signals ───────────────────────────────────────────
  appeal_signals: string[];
  // examples: ["indoor_outdoor_living", "natural_light", "established_landscaping",
  //           "period_features_intact", "entertaining_layout"]

  concern_signals: string[];
  // examples: ["dated_finishes", "power_lines_visible",
  //           "neighbouring_property_intrudes", "privacy_concerns"]

  buyer_persona_hints: string[];
  // examples: ["young_family_upgrader", "downsizer", "investor",
  //           "first_home_buyer", "renovator"]

  // ─── Production / workflow ───────────────────────────────────────────────
  retouch_priority: 'urgent' | 'recommended' | 'none';
  retouch_estimate_minutes: number | null;  // editor time estimate
  gallery_position_hint: 'lead_image' | 'early_gallery' | 'late_gallery' | 'archive_only';
  social_first_friendly: boolean;           // survives 1:1 Instagram crop?

  // ─── Quality control ─────────────────────────────────────────────────────
  requires_human_review: boolean;
  confidence_per_field: {
    room_type: number;                      // 0-1
    scoring: number;                        // confidence in the 22 signal scores collectively
    classification: number;                 // confidence in image_classification
    // additional per-field confidences may be added; consumers must tolerate unknown keys
  };

  // ─── Architecture lineage ────────────────────────────────────────────────
  style_archetype: string | null;
  // examples: "Federation cottage", "1980s brick veneer", "mid-century pavilion"

  era_hint: string | null;
  // examples: "circa 1955-1965", "post-war"

  material_palette_summary: string[];       // top 3 materials by visual weight
  // examples: ["face brick", "terracotta tile", "white timber"]

  // ─── Embedding for similarity search (W11.13 / pgvector) ─────────────────
  embedding_anchor_text: string;            // 50-word summary optimised for vector embedding

  // ─── Searchable enrichment ───────────────────────────────────────────────
  searchable_keywords: string[];

  // ─── Photographer intent ─────────────────────────────────────────────────
  shot_intent:
    | 'hero_establishing'                   // signature wide showing the property
    | 'scale_clarification'                 // shot to clarify size/proportion
    | 'lifestyle_anchor'                    // staged for emotional appeal
    | 'material_proof'                      // close-in to validate material spec
    | 'indoor_outdoor_connection'           // alfresco / through-glass connection
    | 'detail_specimen'                     // close-up on hardware or feature
    | 'record_only'                         // documentation, not marketing
    | 'reshoot_candidate';                  // photographer's own shot they would redo

  // ─── Canonical ID linkage (populated by W12 rollup pass; null on first emission) ─
  canonical_object_ids: string[] | null;
  // examples: ["obj_kitchen_shaker_white", "obj_tap_gooseneck_chrome", ...]
}
```

### Why these fields

| Field group | Purpose | Downstream consumer |
|---|---|---|
| `listing_copy` | Inline per-image copy means no async backfill. Drives swimlane "Why?" panel + image carousel captions. | Frontend swimlane, listing publisher |
| `appeal_signals` / `concern_signals` | Structured sentiment beyond a single score. Stage 4 aggregates these for `master_listing` body. | Stage 4 input, W11.6 dashboard |
| `buyer_persona_hints` | Stage 4 picks the dominant persona for `master_listing.target_buyer_summary`. | Stage 4 input |
| `retouch_priority` / `retouch_estimate_minutes` | Editor workflow planning — operator sees per-image retouch backlog at round close. | Operator UI, retouch jobboard |
| `gallery_position_hint` | Pre-Stage-4 preference signal for gallery sequencing. Stage 4 may override. | Stage 4 input |
| `social_first_friendly` | Stage 4 prefers these for `social_post_caption` selection. | Stage 4 input, social automation |
| `requires_human_review` / `confidence_per_field` | Surfaces low-confidence images for operator review without trusting a single combined score. | W11.6 dashboard, swimlane filters |
| `style_archetype` / `era_hint` / `material_palette_summary` | Voice calibration — Stage 4 anchors `master_listing` archetype + tone consistency. | Stage 4 input, voice tier modulation |
| `embedding_anchor_text` | Single string optimised for vector embedding. Avoids embedding the full 1,700-char `analysis` (noisy) or just `key_elements` (sparse). | W11.13 pgvector pipeline |
| `searchable_keywords` | SEO / search index tokens. | Listing publisher, search index |
| `shot_intent` | Photographer-mind-modelling — distinguishes a deliberate "scale clarification" shot from an accidental "record only". Drives `master_listing` paragraph selection. | Stage 4 input |
| `canonical_object_ids` | Free-text Gemini outputs map to canonical IDs via post-rollup pass (W12). `null` on first emission. | W12 rollup, cross-project search |

## Why this shape

1. **`source.type` dispatches reject criteria.** RAW: don't penalise window blowout (it's an HDR bracket); allow dark exposures. Finals: blowout is a hard fail; vertical lines must be corrected. External: minimal rejection; we're cataloguing competitor work.

2. **`image_classification.is_relevant_property_content`** is the universal "should this even be evaluated?" gate. False → quarantine bucket (subject + quarantine_reason explain why). True → proceed to room/signal scoring.

3. **`room_classification` is null for non-room images.** Agent headshots, equipment shots, floorplan images don't have a room_type. Forcing a coercion (today: model picks `special_feature` as fallback) corrupts downstream room_type analytics. Null is honest.

4. **`observed_objects.proposed_canonical_key` allows model creativity AND feeds the registry.** Model has seen `OBJECT_*` registry from prompt context (or prompt mentions "use OBJECT_FIREPLACE if confident"). On first observation of a novel object, model emits `proposed_canonical_key: null` — the registry's normalisation batch decides whether to canonicalise.

5. **`signal_scores` are nullable** for context-dependent signals. `three_wall_coverage` only meaningful for kitchen; null elsewhere. `power_lines_distraction` only meaningful for exterior; null elsewhere. The dimension rollup (W11.5) handles nulls by skipping them in the weighted average.

6. **`schema_version` is in the response** so downstream consumers can fork on schema migrations without SQL column gymnastics.

## Source-aware prompting strategy

The Pass 1 prompt builder receives `source` as caller input and assembles a prompt that:
- Explicitly tells the model the source type
- Includes the relevant `xxx_specific` field expectations
- Activates/suppresses the right reject criteria

Example for RAW:
```
You are evaluating a real estate photography image. The source is:
  type: internal_raw
  media_kind: still_image
  is_hdr_bracket: true
  bracket_index: 2 (centre / EV0)
  bracket_count: 5

This is a RAW HDR bracket exposure. It may appear dark or have blown highlights
in some areas. This is expected and correct for HDR capture. Do NOT penalise
darkness or blown windows in your `signal_scores.window_blowout_area` or
`signal_scores.shadow_crush_percentage` — set those to null on RAW input.

Set raw_specific.luminance_class to "underexposed" / "balanced" / "overexposed"
based on overall exposure feel.
```

Example for finals:
```
You are evaluating a delivered final image. The source is:
  type: internal_finals
  media_kind: still_image
  is_post_edit: true

This image has been post-processed. Vertical lines should be corrected.
Window blowout should NOT be present (HDR blend should have resolved it).
Set signal_scores.window_blowout_area to a real numeric score — anything
visible blowout penalises the score.

Populate finals_specific.* fields based on post-processing artefacts you can
identify.
```

Example for external listing:
```
You are evaluating a competitor's delivered image from an REA listing. The
source is:
  type: external_listing
  media_kind: still_image
  external_url: https://...
  listing_id: <uuid>

This is a competitor's finished work. Do NOT apply our internal quality
standards as rejection criteria — score it but don't quarantine.

Identify package signals: dusk-quality lighting (signals dusk product),
drone perspective (signals drone product), video thumbnail (signals video
product), floorplan visible (signals floorplan product). Populate
external_specific.package_signals accordingly.
```

## Schema additions for multi-stage vision engine (W11.7)

Stage 4 of Shape D (W11.7) emits cross-image and project-level fields that don't fit on the per-image `UniversalVisionResponse`. These are master-level outputs of the round.

### Caller-provided input additions

```typescript
interface RoundInputAdditions {
  property_tier: 'premium' | 'standard' | 'approachable';
  // default 'standard' — drives voice anchor for listing copy
  // 'premium' = Belle Property / luxury-domain magazine voice
  // 'standard' = Domain editorial — confident, warm, accessible
  // 'approachable' = friendly, plain-language, no pretension

  property_voice_anchor_override?: string;
  // optional manual override (free-text), e.g. "warm but agent-led, not editorial"
  // injected into voice block verbatim when set
}
```

### Per-shoot master listing object

Emitted once per round by Stage 4. The `master_listing` is a complete listing-publishing artifact — headline, body, derivative outputs, editorial metadata.

```typescript
interface MasterListing {
  // ─── Hook tier ───────────────────────────────────────────────────────────
  headline: string;                         // 8-15 words, tier-appropriate Sydney voice
  sub_headline: string;                     // 1 sentence elaboration

  // ─── Body — 3-4 paragraphs, ~600-900 words total, Domain/Belle voice based on tier ─
  scene_setting_paragraph: string;          // facade, character, first impression
  interior_paragraph: string;               // floor plan + key rooms
  lifestyle_paragraph: string;              // entertaining, family, indoor-outdoor
  closing_paragraph: string | null;         // optional 4th — material specificity

  // ─── Standalone ──────────────────────────────────────────────────────────
  key_features: string[];                   // 6-10 specific bullet points (no clichés)
  location_paragraph: string;               // suburb pocket, walking distances, character
  target_buyer_summary: string;             // 1 sentence — who this is for

  // ─── Derivative outputs (zero-touch publishing) ─────────────────────────
  seo_meta_description: string;             // ≤155 chars for listing page <meta>
  social_post_caption: string;              // Instagram-ready, 1-2 lines + 5-8 hashtags
  print_brochure_summary: string;           // 200-word distillation
  agent_one_liner: string;                  // 10-15 words for verbal pitch
  open_home_email_blurb: string;            // 3-4 line email teaser

  // ─── Editorial metadata ──────────────────────────────────────────────────
  word_count: number;
  reading_grade_level: number;              // Flesch-Kincaid (target 8-10)
  tone_anchor: string;                      // self-reported voice anchor used
}
```

### Cross-image (Stage 4 only)

```typescript
interface Stage4CrossImage {
  // Recommended ordered stems for marketing gallery
  gallery_sequence: string[];

  // Visually similar groups ("6 angles of the same kitchen")
  dedup_groups: Array<{
    group_label: string;
    image_stems: string[];
  }>;

  // Proactive callouts
  // examples: "no clean exterior_facade_hero captured",
  //           "missing 'walking up to front door' lifestyle anchor",
  //           "no master_bedroom shot from the bed-side"
  missing_shot_recommendations: string[];

  // Gallery walkthrough coherence (0-10) — how well the sequence narrates the property
  narrative_arc_score: number;

  // Master-level archetype anchored to actual property after seeing all images
  // examples: "1920s Federation cottage, sympathetically extended to a contemporary rear pavilion",
  //           "1980s brick veneer ranch, partially renovated 2020"
  property_archetype_consensus: string;

  // Single property-level Tier rating
  overall_property_score: number;
}
```

### Stage 4 audit trail

When Stage 4's visual cross-comparison finds Stage 1 made a mistake on a per-image field, it writes to `stage_4_overrides[]` rather than silently changing the answer. Pipeline applies the override AND surfaces the diff in W11.6 for operator review.

```typescript
interface Stage4Override {
  stem: string;
  field: string;                            // e.g. "room_type"
  stage_1_value: string;
  stage_4_value: string;
  reason: string;
  // example reason: "visual cross-comparison shows this is rear yard not side passage —
  //                  Hills Hoist + hot-water unit visible alongside facade-side IMG_6193"
}
```

These override rows feed `W14` as graduate-quality few-shot candidates ("AI labelled X → corrected by visual cross-reference"). They are first-class training data for the engine.

### Composite Stage 4 output shape (reference)

For convenience — the full Stage 4 emission shape is documented authoritatively in `W11.7`, reproduced here at field-list level:

```typescript
interface Stage4Output {
  schema_version: '1.0';
  round_id: string;
  vendor: 'gemini' | 'anthropic';
  model_version: string;
  thinking_budget: number;
  prompt_block_versions: Record<string, string>;

  slot_decisions: Array<{
    slot_id: string; phase: 1 | 2 | 3;
    winner: { stem: string; rationale: string };
    alternatives: Array<{ stem: string; rationale: string }>;
    rejected_near_duplicates: Array<{ stem: string; near_dup_of: string }>;
  }>;

  proposed_slots: Array<{
    proposed_slot_id: string;
    candidate_stems: string[];
    reasoning: string;
  }>;

  master_listing: MasterListing;

  gallery_sequence: string[];
  dedup_groups: Array<{ group_label: string; image_stems: string[] }>;
  missing_shot_recommendations: string[];
  narrative_arc_score: number;
  property_archetype_consensus: string;
  overall_property_score: number;

  stage_4_overrides: Stage4Override[];

  coverage_notes: string;
  quality_outliers: Array<{
    stem: string; actual_score: number;
    expected_for_tier: number;
    direction: 'over_delivered' | 'under_delivered';
    suggestion: string;
  }>;
}
```

## All 22 signal measurement prompts

Spec section 9 enumerates the signals but doesn't author measurement prompts. This wave has to write all of them. Below is the prompt block injected into Pass 1.

```
SIGNAL MEASUREMENT INSTRUCTIONS:

For each signal below, score 0-10 based on the criterion. Set to null when
the signal isn't applicable (e.g. three_wall_coverage on non-kitchen).
Use the chain-of-thought approach: state your observation in `analysis`,
then derive the score from that observation.

TECHNICAL DIMENSION:
  vertical_line_convergence:
    Are vertical structural elements (door frames, window edges, walls) parallel
    to the frame edge, or do they converge inward/outward (keystoning)?
    10 = perfectly straight verticals. 5 = mild keystone, easily fixed in post.
    0 = severe keystone, primary subject distorted.
    On RAW: soft penalty (correctable). On finals: hard threshold.

  horizon_level:
    Is true horizontal (bench tops, window sills, floor lines) parallel to
    frame edges? 10 = perfectly level. 5 = ±2° tilt (minor).
    0 = visibly tilted >5°.

  focus_plane_accuracy:
    Is the sharpest plane at the primary subject? 10 = primary subject is
    crisply in focus. 5 = focus slightly missed (e.g. background sharper
    than foreground subject). 0 = primary subject completely out of focus.

  sharpness_primary_subject:
    Edge contrast on the main subject. 10 = razor-sharp. 5 = adequate
    sharpness. 0 = significant softness/blur.

  noise_level_shadows:
    Pattern noise in the darkest 15% of the frame. 10 = clean.
    5 = visible but acceptable. 0 = heavy chroma noise unfixable.

  geometric_distortion_barrel:
    Do straight architectural lines bow at frame edges (lens barrel
    distortion)? 10 = no bow. 5 = mild bow at edges. 0 = severe fisheye effect.

LIGHTING DIMENSION:
  window_blowout_area:
    Percentage of window area at pure white (255). On RAW input, set to NULL
    (HDR brackets expected). On finals, score: 10 = no blowout.
    5 = small blown areas. 0 = large pure-white windows ruining shot.

  shadow_crush_percentage:
    Percentage of frame at pure black (0). On RAW, soft penalty.
    On finals, hard threshold. 10 = no crush. 5 = some crushed shadow detail.
    0 = large pure-black areas.

  ambient_artificial_balance:
    Is natural light vs artificial light deliberately balanced?
    10 = exceptional natural-artificial blend. 5 = adequate.
    0 = clearly mismatched (e.g. blown daylight + dark interior).

  dusk_three_light_balance:
    For dusk shots only: are interior + facade + sky balanced?
    10 = three-stop blend invisible. Set to NULL when image is not dusk.

  light_source_consistency:
    Are colour temperatures consistent across light sources?
    10 = unified colour temperature. 5 = mixed but acceptable.
    0 = severe mixed lighting (warm + cool clashing).

  specular_hotspots:
    Distracting reflections on glossy surfaces (mirrors, glass, polished stone).
    10 = no hot spots. 5 = minor reflections, retouchable.
    0 = major hot spots dominating composition.

COMPOSITIONAL DIMENSION:
  sight_line_depth_layers:
    Distinct foreground / midground / background depth zones.
    10 = three or more clear depth layers. 5 = two layers (foreground +
    background only). 0 = flat single-plane composition.

  primary_subject_placement:
    Does the primary subject sit on a rule-of-thirds grid line OR is centred
    with deliberate symmetry? 10 = strong placement. 5 = okay but not
    intentional-feeling. 0 = subject awkwardly placed.

  foreground_element_present:
    Anchoring foreground element (rug edge, kitchen island corner, doorway
    frame). 10 = strong anchor. 5 = some foreground but not anchoring.
    0 = no foreground element, frame floats.

  composition_type_match:
    Does the actual composition style match a recognised pattern (corner
    two-point, hero wide, detail closeup, etc)? 10 = textbook example of
    its type. 0 = composition style is unclear or amateur.

  three_wall_coverage:
    Kitchens only: are 3 wall planes (back splash + side walls) visible?
    Set to NULL when not kitchen. 10 = all three walls visible with
    perspective. 5 = two walls. 0 = single wall front-on.

  living_zone_count:
    Count of distinct living zones visible in a single open-plan frame
    (kitchen, dining, living, etc). Output the count itself (not 0-10).
    Set to null when not open-plan. 1 zone = adequate. 2-3 zones = strong.
    4+ zones = exceptional.

  indoor_outdoor_connection_quality:
    Is alfresco/outdoor space visible through doors/windows?
    10 = hero outdoor feature visible from interior. 5 = partial visibility.
    0 = no connection visible. Null when image has no relevance to indoor-outdoor connection.

  vantage_point_score:
    Camera-position alignment with what the slot needs.
    10 = vantage matches slot intent (e.g. exterior_looking_in for alfresco hero).
    5 = neutral vantage. 0 = vantage works against the slot.

AESTHETIC DIMENSION:
  styling_deliberateness:
    Is the staging intentional and considered (cushions arranged, fruit bowl
    placed, throws arranged)?
    10 = deliberate styling visible throughout. 5 = some staging, some not.
    0 = unstaged or chaotically staged.

  colour_palette_coherence:
    Hue variance across the frame.
    10 = unified palette (e.g. all warm neutrals). 5 = mixed but pleasant.
    0 = clashing colours.

  material_texture_visibility:
    Are key textures (stone veining, timber grain, tile grout) visible?
    10 = textures crisp and apparent. 5 = adequate but some softness.
    0 = textures lost to softness or wrong angle.

  natural_light_quality:
    Directional, soft, low-angle natural light (vs flat overcast or harsh midday).
    10 = beautiful directional natural light. 5 = adequate.
    0 = flat or harsh light.

  feature_prominence:
    Does the hero feature (fireplace, island, view) fill an appropriate
    portion of the frame? 10 = feature is the clear subject.
    5 = feature visible but not dominant. 0 = feature lost.

  surface_cleaning_quality:
    Glass, mirrors, benches, shower screens — are they spotless?
    10 = surgically clean. 5 = mostly clean, minor smudges.
    0 = visible dust/smudges/water-spots.

  power_lines_distraction:
    Exterior shots only: are poles or overhead lines crossing the frame?
    Null when not exterior. 10 = no power lines. 5 = lines visible but
    unobtrusive. 0 = lines crossing through subject.

  poi_count:
    Drone shots only: count of identifiable POIs visible alongside the
    property (church spire, park, main road, water, CBD skyline).
    Null when not drone. Output the count.
```

## Migration path from current Pass 1

Today's Pass 1 emits 4 dimension aggregates (technical_score, lighting_score, composition_score, aesthetic_score) + analysis + classifications. Wave 11 changes the SHAPE.

**Backwards-compat strategy** (per `MIGRATION_SAFETY.md`):

1. **Migration N**: Pass 1 emits BOTH old shape AND new universal response. New table `composition_signal_scores` populated alongside existing `composition_classifications` columns. Pass 2 reads existing columns (no change).
2. **Migration N+1**: Pass 2 prompt rewritten to consume per-signal scores from the new table. Pass 1 still emits both shapes during transition.
3. **Migration N+2**: Pass 1 stops emitting old shape. The 4 dimension aggregates on `composition_classifications` become computed columns (or are dropped after a stable window).

The interim "emit both" period ensures that any rollback can fall back to the old code path without data loss.

## Per-signal score storage

```sql
CREATE TABLE composition_signal_scores (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id      UUID NOT NULL REFERENCES composition_groups(id) ON DELETE CASCADE,
  round_id      UUID NOT NULL REFERENCES shortlisting_rounds(id) ON DELETE CASCADE,
  signal_key    TEXT NOT NULL,             -- e.g. 'vertical_line_convergence'
  raw_score     NUMERIC,                    -- 0-10, nullable
  source_type   TEXT NOT NULL,              -- 'internal_raw' | 'internal_finals' | etc
  prompt_version INT NOT NULL,
  model_version TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (group_id, signal_key, source_type)
);

CREATE INDEX idx_signal_scores_group ON composition_signal_scores(group_id);
CREATE INDEX idx_signal_scores_signal ON composition_signal_scores(signal_key);
```

Notes:
- Same composition can have signal scores from MULTIPLE source_types (RAW now, finals later) → unique key is `(group_id, signal_key, source_type)`
- `prompt_version` lets us replay historical scores under new prompts later
- `raw_score` nullable because some signals are context-dependent

## Dimension score rollup

Per Wave 8 + W11.5: dimension scores are computed by multiplying signal × tier_config_weight × signal_default_weight, summing, normalising.

```typescript
function computeDimensionScore(
  signals: SignalScore[],
  dimension: 'technical' | 'lighting' | 'compositional' | 'aesthetic',
  tierConfig: TierConfig,
  signalWeights: Record<string, number>,
): number {
  const dimSignals = signals.filter(s => SIGNAL_TO_DIMENSION[s.signal_key] === dimension);
  const valid = dimSignals.filter(s => s.raw_score !== null);
  if (valid.length === 0) return 0;
  let weighted = 0;
  let totalWeight = 0;
  for (const s of valid) {
    const w = signalWeights[s.signal_key] ?? 1.0;
    weighted += s.raw_score * w;
    totalWeight += w;
  }
  return weighted / totalWeight;
}

const combinedScore =
    computeDimensionScore(signals, 'technical',     tierConfig, weights) * tierConfig.technical_weight
  + computeDimensionScore(signals, 'lighting',      tierConfig, weights) * tierConfig.lighting_weight
  + computeDimensionScore(signals, 'compositional', tierConfig, weights) * tierConfig.compositional_weight
  + computeDimensionScore(signals, 'aesthetic',     tierConfig, weights) * tierConfig.aesthetic_weight;
```

Tier weights live in `shortlisting_tier_configs` (W8). Per-signal default weights live in `shortlisting_signal_weights` (already exists, populated but unused).

## Open questions

5 of 6 self-resolved by orchestrator on technical/architectural merit. **Only Q4 (cost) genuinely needs Joseph's business decision.**

### Self-resolved (orchestrator, 2026-04-27)

- **Q1 — Source enum scope.** ✅ **Separate `'floorplan_image'`.** Floorplan images have OCR-style prompts with no aesthetic scoring; folding into `'external_listing'` would force the prompt to branch on `media_kind` anyway, doubling the surface area. Cleaner as its own source.type.
- **Q2 — `observed_objects` confidence floor.** ✅ **Emit at ≥0.5; auto-canonicalize at ≥0.7.** Below 0.5 the observation is too noisy to be useful even as raw data; between 0.5-0.7 it goes into the discovery queue for human review (W12.6); ≥0.7 routes straight to `attribute_values` for cosine-similarity matching against existing canonicals. These thresholds match the pgvector similarity tiers (auto-norm >0.92, review 0.75-0.92) one level upstream.
- **Q3 — Schema versioning policy.** ✅ **SemVer-style.** Major (breaking field removal / type change / required field added) → bump major + transition window. Minor (new optional field, expanded enum) → bump minor without window. Patch (description text changes, no shape impact) → no version bump. Today's launch ships as 1.0.
- **Q5 — Backwards-compat window.** ✅ **4 weeks of stable production with the new shape before old shape is deprecated.** Rolling window: if a regression forces a rollback, the clock restarts. Pass 1 dual-emits during this window (writes both shapes to two columns); downstream consumers migrate one at a time.
- **Q6 — Quarantine routing.** ✅ **Single `shortlisting_quarantine` table, `quarantine_reason` enum differentiates.** Existing P0 (hard reject) reasons + new W11 reasons (`agent_headshot`, `test_shot`, `bts`, `equipment_only`, `out_of_scope_content`) all land in the same place. Swimlane UI displays a per-reason count at the top so operators see "8 shortlistable + 3 retouch + 2 OOS + 1 BTS" at a glance. One quarantine table, many reasons, never a separate sidecar table for any subset.

### Genuinely open (needs Joseph's decision)

- **Q4 — Cost.** Updated 2026-04-30/05-01 after iter-5 measurements on Shape D (W11.7).
  - Original two-pass baseline: ~$1.50-3.90/round.
  - Iter-2 single-Opus + Sonnet backfill: ~$3-5/round.
  - **Shape D (production target, Gemini-anchored): ~$3.84 per 200-angle shoot.**
    - 4 × Stage 1 batch calls (50 imgs each) @ ~$0.66 = $2.64
    - 1 × Stage 4 visual master synthesis @ ~$1.20
    - Pass 0 Haiku reject @ ~$0.04
  - Linear scaling table (50 / 100 / 150 / 200 / 300 / 400 angles): $1.94 / $2.60 / $3.26 / $3.84 / $5.16 / $6.48.
  - Anthropic failover (W11.8 routes through Opus 4.7) ~12× more expensive — budget ~$45/200-shoot worst case. Dashboard alerts on >5% Anthropic-routed rounds in any 24h window.
  - **Joseph: confirm $3.84/200-shoot envelope acceptable for the inline listing-copy + master_listing publishing artifact + cross-image dedup + narrative arc.** The cost is 50-100% above the iter-2 single-Opus baseline but produces dramatically more output (per-image listing copy, master_listing object, gallery sequence, dedup groups, stage_4_overrides) AND uses the cheaper vendor as anchor. Net cost-per-published-listing is lower than today's because the master_listing replaces a separate copywriter step.

### Sign-off items (separate from open questions)

- Sign-off on the `UniversalVisionResponse` TypeScript interface (the schema itself, ~200 lines)
- Sign-off on the 22 measurement prompts (verbatim text per signal)
- Sign-off on the dimension rollup formula (per-signal scores → 4-dim aggregates → tier-weighted combined)

## What this wave UNBLOCKS

- **Wave 12** (object_registry) — `observed_objects` array shape locks in here
- **Wave 13b** (description goldmine) — populates `raw_attribute_observations` using the same canonical-key shape Pass 1 produces
- **Wave 15a** (internal finals scoring) — uses same schema, different `source.type`
- **Wave 15b** (external REA listing scoring) — same schema, different reject criteria, populates `external_specific.package_signals` for missed-opportunity recalibration
- **Wave 15c** (cross-source competitor analysis) — queries unified schema across all sources

Without Wave 11 done right, every downstream wave forks its own schema → maintenance nightmare.

## Effort estimate

- 1 week design (this doc + sign-off + 22 measurement prompt iteration)
- 2-3 weeks Pass 1 prompt rewrite + new shape + DB schema
- 1 week Pass 2 prompt rewrite to consume per-signal context
- 1 week dimension rollup + tier weight integration
- 1 week migration + dual-emit + validation

Total: ~5-6 weeks. The largest single wave.

## Pre-execution checklist

### Self-resolved by orchestrator (2026-04-27)

- [x] Q1 — floorplan_image as separate source.type
- [x] Q2 — emit ≥0.5, auto-canonicalize ≥0.7
- [x] Q3 — SemVer schema versioning
- [x] Q5 — 4-week backwards-compat window
- [x] Q6 — single quarantine table with per-reason enum

### Needs Joseph's decision (3 items, ~30-60 min review)

- [ ] **Cost**: ~30-50% increase per Pass 1 round acceptable?
- [ ] **Schema**: sign off on `UniversalVisionResponse` TypeScript interface
- [ ] **22 measurement prompts**: sign off on the verbatim prompt text per signal

### Upstream wave dependencies

- [ ] Wave 8 (tier configs) has landed — needed for dimension rollup
- [ ] Vision prompt blocks (W7.6) have landed — gives the composition primitive that W11 plugs into

### Total review surface for Joseph

After self-resolutions: **3 decisions + 1 schema review + 22 prompts read.** That's a 30-60 min review session, not a full week.
