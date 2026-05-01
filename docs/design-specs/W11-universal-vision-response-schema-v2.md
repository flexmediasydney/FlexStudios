# W11 — Universal Vision Response Schema (v2)

**Status:** Design phase. Supersedes `W11-universal-vision-response-schema.md` (v1).
**Authored:** 2026-05-01.
**Authority:** v1 was correct on the universal-schema *idea* but was authored before the
2026-04-30/05-01 production cutover to Shape D (W11.7). v1 conflated "the schema" with "the
producer". v2 separates the two cleanly: this doc is **the schema contract only**. The
producer (Shape D Stage 1 / Stage 4) is documented in `W11-7-unified-shortlisting-architecture.md`.
**Effort:** 2-3 day execution burst once signed off (W11.7.17).
**Blocks:** W15a (internal finals scoring), W15b (external listings scoring), W15c
(cross-source competitor analysis), W11.5 mature reclassification capture, all goldmine waves
(W13a/b/c) that emit the universal shape.

---

## 1. Goal

Unify the vision response schema across the four source contexts the engine sees so a single
Stage 1 caller can be re-aimed at finals, external REA listings, and floorplan images by
flipping a `source_type` input — with no parallel forks of prompt logic, no per-source schema
column gymnastics, and no breaking change to the 4-axis dimension scores already in
production. This unblocks W15a/b/c and lets goldmine backfills (W13a/b/c) emit data that is
queryable in the same shape Stage 1 emits today.

---

## 2. Source-context dimorphism

The model receives the same JSON Schema regardless of source. **What changes is which fields
are populated, which are scored vs ignored, and which `*_specific` block applies.** The
caller passes a `source_type` input that drives prompt-side instruction; the schema itself is
fixed.

The four source contexts already have preamble blocks in
`supabase/functions/_shared/visionPrompts/blocks/sourceContextBlock.ts` (`SOURCE_CONTEXT_BLOCK_VERSION = 'v1.0'`).
Those blocks are good — v2 keeps them and adds matching schema-side dimorphism.

### Per-source field activity matrix

| Field group | `internal_raw` | `internal_finals` | `external_listing` | `floorplan_image` |
|---|---|---|---|---|
| `analysis` (prose) | required | required | required | required (OCR-style) |
| `image_type` enum | required | required | required | required (`is_floorplan` always) |
| `image_classification.*` | required | required | required | required (subject = `floorplan`) |
| `room_classification.*` | required when subject ∈ interior/exterior/drone/detail | same | same | **null** (floorplans don't have a single room) |
| `signal_scores.exposure_*` | **null** (RAW brackets — don't penalise) | **scored** (blowout = hard fail) | scored observationally | **null** |
| `signal_scores.composition_*` | scored | scored | scored | **null** (no aesthetic frame) |
| `signal_scores.aesthetic_*` | scored | scored | scored | **null** |
| `quality_flags.clutter_severity` | scored | scored | scored (observational only) | **null** |
| `quality_flags.flag_for_retouching` | scored | scored | **always false** (we never reject competitor work) | **null** |
| `observed_objects[]` | populated | populated | populated | populated (architectural symbols only — door swings, wall lines, sliding tracks) |
| `observed_attributes[]` | populated | populated | populated | populated (room-name labels, dimensions) |
| `raw_specific.*` | populated | n/a | n/a | n/a |
| `finals_specific.*` | n/a | populated | n/a | n/a |
| `external_specific.*` | n/a | n/a | populated | n/a |
| `floorplan_specific.*` | n/a | n/a | n/a | populated |
| `listing_copy.*` (per-image) | populated | populated | **null** (we don't write copy for competitor images) | **null** |
| `appeal_signals` / `concern_signals` | populated | populated | populated (observational) | **null** |
| `retouch_priority` / `retouch_estimate_minutes` | populated | populated | **`'none'` always** | **null** |
| `gallery_position_hint` | populated | populated | **`'archive_only'` always** | **null** |
| `style_archetype` / `era_hint` / `material_palette_summary` | populated | populated | populated | populated (from drawing legend) |
| `embedding_anchor_text` | populated | populated | populated | populated |
| `confidence_per_field` | populated | populated | populated | populated |

### Scoring rubric dimorphism — the high-impact deltas

| Behaviour | RAW | Finals |
|---|---|---|
| Window blowout | **null** (HDR bracket — expected) | **0-10 score, hard fail** (HDR merge should have resolved) |
| Crushed shadows | soft penalty | hard fail |
| Vertical line convergence | soft penalty (correctable) | hard threshold (should be corrected) |
| Color cast / mixed white balance | soft penalty | real flaw — penalise |
| Sky replacement halos | n/a | **populated in `finals_specific.sky_replaced`** with severity score |
| Digital furniture artefacts | n/a | **populated in `finals_specific.digital_furniture_present`** |
| Digital dusk over-saturation | n/a | **populated in `finals_specific.digital_dusk_applied`** |

### External listing — observe, don't reject

External listings have already cleared their agency's bar. We catalogue, we don't critique.

- `flag_for_retouching` is always `false`.
- `retouch_priority` is always `'none'`.
- `gallery_position_hint` is always `'archive_only'` (these aren't going into our gallery).
- All `signal_scores.*` are populated as observational data only.
- `external_specific.package_signals.*` becomes the primary output: detect what products the
  competing agency offered (dusk / drone / video / floorplan / agent watermark).
- `external_specific.price_class_estimate` infers from home archetype + finishes + suburb
  signals.

### Floorplan — OCR-style, not aesthetic

Floorplans are architectural drawings, not photographs. Photographic scoring is meaningless;
the value is in label extraction.

- `room_classification` is **null**.
- All `signal_scores.*` are **null**.
- `quality_flags.*` are **null** (other than `is_near_duplicate_candidate` which can apply).
- `floorplan_specific.*` becomes the primary output: rooms detected, dimensions, archetype,
  bedroom/bathroom counts, north arrow.
- `floorplan_specific.cross_check_flags[]` records mismatches against the CRM project's
  declared bedrooms/bathrooms (e.g. `"crm_says_4br_floorplan_shows_3"`). These flags feed
  W11.5 and W11.6.

---

## 3. Universal schema v2 — full field list

Schema is one fixed shape. Everything is nullable except a small required set so the model
can return `null` on N/A fields without violating the contract.

```typescript
interface UniversalVisionResponseV2 {
  schema_version: '2.0';

  // ─── Caller-provided source metadata (echoed back for provenance) ───────────
  source: {
    type: 'internal_raw' | 'internal_finals' | 'external_listing' | 'floorplan_image';
    media_kind: 'still_image' | 'video_frame' | 'drone_image' | 'floorplan_image';
    is_hdr_bracket?: boolean;       // RAW only
    is_post_edit?: boolean;         // finals only
    external_url?: string;          // external only
    listing_id?: string;            // external only — pulse_listings.id
    bracket_index?: number | null;  // RAW only
    bracket_count?: number | null;  // RAW only
    property_tier?: 'premium' | 'standard' | 'approachable';  // drives listing_copy voice
  };

  // ─── Reasoning prose (always required) ──────────────────────────────────────
  analysis: string;                  // 5-7 sentences min, ~250 words

  // ─── Image type enum (always required) ──────────────────────────────────────
  image_type:
    | 'is_day' | 'is_dusk' | 'is_drone' | 'is_agent_headshot'
    | 'is_test_shot' | 'is_bts' | 'is_floorplan' | 'is_video_frame'
    | 'is_detail_shot' | 'is_facade_hero' | 'is_other';

  // ─── Image-level classification (always required) ───────────────────────────
  image_classification: {
    is_relevant_property_content: boolean;
    subject:
      | 'interior' | 'exterior' | 'drone' | 'detail'
      | 'floorplan' | 'agent_headshot' | 'test_shot' | 'bts'
      | 'equipment' | 'video_thumbnail' | 'other';
    is_dusk: boolean;
    is_day: boolean;
    is_golden_hour: boolean;
    is_night: boolean;
    time_of_day_confidence: number;
    is_drone: boolean;
    drone_type: 'orbit_oblique' | 'nadir' | 'elevation_rise' | null;
    is_video_frame: boolean;
    quarantine_reason:
      | 'agent_headshot' | 'bts' | 'test_shot' | 'equipment'
      | 'corrupt_frame' | 'severe_underexposure' | null;
  };

  // ─── Room/composition classification (null when N/A) ────────────────────────
  room_classification: {
    room_type: string;
    room_type_confidence: number;
    composition_type: string;
    vantage_point:
      | 'interior_looking_out' | 'exterior_looking_in' | 'neutral'
      | 'low_angle' | 'high_angle' | 'eye_level_through_threshold'
      | 'aerial_oblique' | 'aerial_nadir';
    is_styled: boolean;
    indoor_outdoor_visible: boolean;
    eligible_for_exterior_rear: boolean;
  } | null;

  // ─── Observed objects (feeds object_registry, W12) ──────────────────────────
  observed_objects: Array<{
    raw_label: string;
    proposed_canonical_id: string | null;
    confidence: number;
    bounding_box: {
      x_pct: number; y_pct: number;
      w_pct: number; h_pct: number;
    } | null;
    attributes: Record<string, unknown>;
  }>;

  // ─── Observed attributes (feeds raw_attribute_observations, W12) ────────────
  observed_attributes: Array<{
    raw_label: string;
    canonical_attribute_id: string | null;
    canonical_value_id: string | null;
    confidence: number;
    object_anchor: string | null;
  }>;

  // ─── Per-signal scores — the 22 signals (always present, nullable values) ──
  signal_scores: {
    // Technical (6)
    exposure_balance: number | null;
    color_cast: number | null;
    sharpness_subject: number | null;
    sharpness_corners: number | null;
    plumb_verticals: number | null;
    perspective_distortion: number | null;
    // Compositional (8)
    depth_layering: number | null;
    composition_geometry: number | null;
    vantage_quality: number | null;
    framing_quality: number | null;
    leading_lines: number | null;
    negative_space: number | null;
    symmetry_quality: number | null;
    foreground_anchor: number | null;
    // Aesthetic / styling (4)
    material_specificity: number | null;
    period_reading: number | null;
    styling_quality: number | null;
    distraction_freeness: number | null;
    // Workflow (4)
    retouch_debt: number | null;
    gallery_arc_position: number | null;
    social_crop_survival: number | null;
    brochure_print_survival: number | null;
  };

  // ─── Backwards-compat 4-axis aggregates (computed view, not source of truth) ─
  technical_score: number;
  lighting_score: number;
  composition_score: number;
  aesthetic_score: number;
  combined_score: number;

  // ─── Quality flags (always required) ────────────────────────────────────────
  quality_flags: {
    clutter_severity: 'none' | 'minor_photoshoppable' | 'moderate_retouch' | 'major_reject' | null;
    clutter_detail: string | null;
    flag_for_retouching: boolean;
    is_near_duplicate_candidate: boolean;
  };

  // ─── Free-form bridges (per-image, populated for non-floorplan sources) ─────
  key_elements: string[];
  zones_visible: string[];

  // ─── Per-image listing copy (populated for internal sources only) ───────────
  listing_copy: {
    headline: string;
    paragraphs: string;
  } | null;

  // ─── Marketing signals (populated for non-floorplan) ────────────────────────
  appeal_signals: string[];
  concern_signals: string[];
  buyer_persona_hints: string[];

  // ─── Workflow signals (populated for internal sources) ──────────────────────
  retouch_priority: 'urgent' | 'recommended' | 'none';
  retouch_estimate_minutes: number | null;
  gallery_position_hint: 'lead_image' | 'early_gallery' | 'late_gallery' | 'archive_only';
  social_first_friendly: boolean | null;

  // ─── Self-assessment ────────────────────────────────────────────────────────
  requires_human_review: boolean;
  confidence_per_field: {
    room_type: number;
    scoring: number;
    classification: number;
    [k: string]: number;
  };

  // ─── Architectural lineage ──────────────────────────────────────────────────
  style_archetype: string | null;
  era_hint: string | null;
  material_palette_summary: string[];

  // ─── Vector / search ────────────────────────────────────────────────────────
  embedding_anchor_text: string;
  searchable_keywords: string[];

  // ─── Photographer intent ────────────────────────────────────────────────────
  shot_intent:
    | 'hero_establishing' | 'scale_clarification' | 'lifestyle_anchor'
    | 'material_proof' | 'indoor_outdoor_connection' | 'detail_specimen'
    | 'record_only' | 'reshoot_candidate'
    | null;

  // ─── Source-specific blocks (only one of the four populates per emission) ──
  raw_specific: {
    luminance_class: 'underexposed' | 'balanced' | 'overexposed';
    is_aeb_zero: boolean;
    bracket_recoverable: boolean;
  } | null;

  finals_specific: {
    looks_post_processed: boolean;
    vertical_lines_corrected: boolean;
    color_grade_consistent_with_set: boolean | null;
    sky_replaced: boolean;
    sky_replacement_halo_severity: number | null;
    digital_furniture_present: boolean;
    digital_furniture_artefact_severity: number | null;
    digital_dusk_applied: boolean;
    digital_dusk_oversaturation_severity: number | null;
    window_blowout_severity: number | null;
    shadow_recovery_score: number | null;
    color_cast_score: number | null;
    hdr_halo_severity: number | null;
    retouch_artefact_severity: number | null;
  } | null;

  external_specific: {
    estimated_price_class: 'sub_1M' | '1M_to_3M' | '3M_to_10M' | '10M_plus' | 'unknown';
    // W11.7.17 Q4 binding: DROPPED letter-grade delivery_quality_grade.
    // External listings get combined_score numeric only.
    competitor_branding: {
      watermark_visible: boolean;
      agency_logo: string | null;
      photographer_credit: string | null;
    };
    package_signals: {
      dusk_quality: boolean;
      drone_perspective: boolean;
      video_thumbnail: boolean;
      floorplan_present: boolean;
      twilight_hdr: boolean;
      photo_count_in_listing: number | null;
    };
  } | null;

  floorplan_specific: {
    rooms_detected: Array<{
      room_label: string;
      canonical_room_type: string | null;
      area_sqm: number | null;
      dimensions_text: string | null;
    }>;
    total_internal_sqm: number | null;
    bedrooms_count: number | null;
    bathrooms_count: number | null;
    car_spaces: number | null;
    home_archetype: string | null;
    north_arrow_orientation: 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW' | null;
    levels_count: number | null;
    cross_check_flags: Array<{
      flag: string;
      crm_value: string | number;
      floorplan_value: string | number;
    }>;
  } | null;

  // ─── Provenance ────────────────────────────────────────────────────────────
  prompt_block_versions: Record<string, string>;
  vendor: 'gemini' | 'anthropic';
  model_version: string;
}
```

### Required field set

The schema enforces a small required set so the model returns a parseable object even on
exotic inputs:

```
schema_version, source, analysis, image_type, image_classification,
signal_scores (object always present, values may be null),
technical_score, lighting_score, composition_score, aesthetic_score, combined_score,
quality_flags, key_elements, zones_visible,
appeal_signals, concern_signals, retouch_priority, gallery_position_hint,
requires_human_review, confidence_per_field,
style_archetype, era_hint, material_palette_summary, embedding_anchor_text,
shot_intent, observed_objects, observed_attributes,
prompt_block_versions, vendor, model_version
```

The `*_specific` blocks and `room_classification` / `listing_copy` are nullable. The model
sets them to `null` when the source doesn't activate them.

---

## 4. Stage 1 prompt rewrite plan

Today's Stage 1 prompt assembly takes ordered `BlockEntry[]` lists for system + user messages.
v2 changes:

1. **Replace `pass1OutputSchema` block with `universalVisionResponseSchemaV2` block.** Same
   block-architecture pattern. Versioned via `UNIVERSAL_VISION_RESPONSE_SCHEMA_VERSION = 'v2.0'`.

2. **Add a new system block: `signalMeasurementBlock(source_type)`.** Renders the 22
   measurement prompts (§9 below) with source-aware activation/null hints. Versioned via
   `SIGNAL_MEASUREMENT_BLOCK_VERSION`.

3. **Extend `sourceContextBlock` minimally.** Bump to `v1.1` — append a field-list paragraph
   per source: "Populate `finals_specific.{sky_replaced, ...}`. Leave `raw_specific`,
   `external_specific`, `floorplan_specific` set to `null`."

4. **Caller passes `source_type` as input.** The Shape D orchestrator has the source on hand
   because the caller knows what it's feeding. v2 makes it an explicit input parameter.

The result: the schema is **one universal definition**; the model is told via prompt context
which source-specific subset to populate.

---

## 5. Migration path

v2 ships incrementally on the existing `composition_classifications` table.

### Migration 392 — additive columns

```sql
ALTER TABLE composition_classifications
  ADD COLUMN IF NOT EXISTS source_type TEXT
    CHECK (source_type IS NULL OR source_type IN
      ('internal_raw','internal_finals','external_listing','floorplan_image')),
  ADD COLUMN IF NOT EXISTS image_type TEXT,
  ADD COLUMN IF NOT EXISTS signal_scores JSONB,
  ADD COLUMN IF NOT EXISTS finals_specific JSONB,
  ADD COLUMN IF NOT EXISTS external_specific JSONB,
  ADD COLUMN IF NOT EXISTS floorplan_specific JSONB,
  ADD COLUMN IF NOT EXISTS raw_specific JSONB,
  ADD COLUMN IF NOT EXISTS observed_objects JSONB,
  ADD COLUMN IF NOT EXISTS observed_attributes JSONB,
  ADD COLUMN IF NOT EXISTS schema_version TEXT DEFAULT 'v2.0';

UPDATE composition_classifications
   SET source_type = 'internal_raw',
       schema_version = 'v1.0'
 WHERE source_type IS NULL;

CREATE INDEX IF NOT EXISTS idx_classif_source_type
  ON composition_classifications(source_type) WHERE source_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_classif_image_type
  ON composition_classifications(image_type) WHERE image_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_classif_signal_scores_gin
  ON composition_classifications USING gin (signal_scores)
  WHERE signal_scores IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_classif_finals_sky_replaced
  ON composition_classifications((finals_specific->>'sky_replaced'))
  WHERE finals_specific IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_classif_external_price_class
  ON composition_classifications((external_specific->>'estimated_price_class'))
  WHERE external_specific IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_classif_floorplan_archetype
  ON composition_classifications((floorplan_specific->>'home_archetype'))
  WHERE floorplan_specific IS NOT NULL;
```

### Persist layer change

The Shape D persist function extends to write the four new JSONB columns when the
corresponding `*_specific` block is populated in the response. Existing column writes are
unchanged.

---

## 6. Backwards compatibility

The 4-axis aggregates `technical_score`, `lighting_score`, `composition_score`,
`aesthetic_score` STAY. v2 makes them computed views over `signal_scores`.

### Rollup formula (v2)

```
SIGNAL_TO_DIMENSION = {
  // technical
  exposure_balance: 'technical', color_cast: 'technical',
  sharpness_subject: 'technical', sharpness_corners: 'technical',
  plumb_verticals: 'technical', perspective_distortion: 'technical',
  // compositional
  depth_layering: 'composition', composition_geometry: 'composition',
  vantage_quality: 'composition', framing_quality: 'composition',
  leading_lines: 'composition', negative_space: 'composition',
  symmetry_quality: 'composition', foreground_anchor: 'composition',
  // aesthetic
  material_specificity: 'aesthetic', period_reading: 'aesthetic',
  styling_quality: 'aesthetic', distraction_freeness: 'aesthetic',
};

function computeDimensionScore(signal_scores, dimension, tier_config, signal_weights):
  let valid = signals where SIGNAL_TO_DIMENSION[key] === dimension AND value !== null;
  if valid.length === 0: return null;
  return weighted_mean(valid, signal_weights);

combined_score = Σ over 4 dimensions of dim_score × tier_config.dim_weight
```

This rollup runs in the `_shared/dimensionRollup.ts` helper (new in W11.7.17).

### "Emit both" transition window

Per `MIGRATION_SAFETY.md` the engine writes both shapes for one rolling 4-week window post
v2 cutover.

---

## 7. W11.2 `composition_signal_scores` table — drop in favour of JSONB

v1 specified a sidecar table. v2 **drops this table** in favour of a `signal_scores JSONB`
column on `composition_classifications`.

### Trade-offs

| Concern | Sidecar table | JSONB column on classifications |
|---|---|---|
| Per-signal index | native btree on `(signal_key, source_type)` | GIN on JSONB or expression index per signal of interest |
| Per-signal aggregate query | clean SQL | `AVG((signal_scores->>'exposure_balance')::numeric)` — slightly more verbose, equivalent perf with expression index |
| Multi-source scoring on same `group_id` | one row per `(signal_key, source_type)` — natural | requires sibling rows keyed by source_type |
| Storage | ~22× row multiplier | 1× rows |
| Read pattern: "give me all signals for this image" | JOIN | one row, parse JSONB |
| Schema evolution (add 23rd signal) | no DDL | no DDL |

**Decision: JSONB on classifications.** The dominant read pattern is "give me Stage 1 output
for this image" which is one row per group with one JSONB blob.

**W11.2 in `WAVE_PLAN.md` (line 156) updates from "create sidecar table" to "JSONB column +
rollup helper". No new table.**

---

## 8. W15 unblocking

Once v2 ships, W15a/b/c become incremental new callers of the same Stage 1 path.

### W15a — internal finals scoring

- New caller: `shortlisting-finals-qa` edge function.
- Source: `internal_finals`. Inputs: post-edited JPEGs.
- Schema: same v2 contract. Stage 1 populates `finals_specific.*`.
- Downstream: a finals QA dashboard reads `finals_specific.*` to surface
  reshoot/retouch-required deliverables.

### W15b — external REA listing scoring

- New caller: `pulse-listing-vision-extract` edge function.
- Source: `external_listing`. Inputs: scraped images from `pulse_listings.image_urls[]`.
- Schema: same v2 contract. Stage 1 populates `external_specific.*`.
- Downstream: missed-opportunity recalibration.

### W15c — cross-source competitor analysis

- Pure SQL/analytics over the unified schema.

Each of W15a/b/c is **a 2-3 day burst of caller wiring + storage routing — zero schema
change**. The schema work is all in W11.7.17.

---

## 9. The 26 signal measurement prompts

W11.7.17 Q2 binding: lighting now has 4 dedicated signals; total = 26 signals
(22 from v1 + 4 new lighting). Each signal gets 1-2 sentences as the model-
facing instruction. Block: `signalMeasurementBlock(source_type)`.

```
SIGNAL MEASUREMENT INSTRUCTIONS — score 0-10. NULL = signal does not apply
to this source type or subject.

— TECHNICAL —
exposure_balance:
  Are highlights and shadows both held without clipping? 10 = both ends preserved;
  5 = one end clips noticeably; 0 = both ends blow out. RAW brackets: NULL (HDR
  merge will resolve). Finals: scored — blowout is hard-fail. External: scored
  observationally only.

color_cast:
  Are colours consistent across the frame, or does a tint dominate?
  10 = neutral unified. 5 = mild cast acceptable. 0 = severe cast unfixable.

sharpness_subject:
  Edge contrast on the primary subject. 10 = razor-sharp. 5 = adequate.
  0 = significant softness or blur.

sharpness_corners:
  Edge contrast at frame corners. 10 = corners as sharp as centre.
  5 = mild corner softness expected at wide aperture. 0 = severe corner mush.

plumb_verticals:
  Are vertical structural elements parallel to the frame edge, or do they
  keystone? 10 = perfect verticals. 5 = mild keystone. 0 = severe keystone.

perspective_distortion:
  Do straight architectural lines bow at frame edges (lens barrel/pincushion)?
  10 = no bow. 5 = mild bow at edges. 0 = severe fisheye effect.

— LIGHTING (NEW — Q2 binding) —
light_quality:
  Overall lighting CHARACTER and quality. 10 = beautiful, evocative light
  (golden-hour warmth, soft north-facing daylight, evenly-modulated dusk);
  5 = adequate ambient; 0 = harsh fluorescent overheads, mixed colour
  temperature chaos, or flat featureless light. RAW: scored. Finals:
  scored. External: observational. Floorplan: NULL.

light_directionality:
  Direction of light and how it shapes the subject. 10 = clear, intentional
  direction that reveals form (raking side-light on textured walls, top-back
  rim on architectural detail); 5 = neutral frontal/ambient; 0 = lighting
  works against the subject. Floorplan: NULL.

color_temperature_appropriateness:
  White balance MATCHES the scene the photographer is selling. 10 = tonally
  consistent (warm interiors for period homes, neutral cool for contemporary,
  dusk-amber for twilight sets); 5 = slightly off but recoverable; 0 =
  jarring mixed white balance or wrong temperature for the era/style.
  Floorplan: NULL.

light_falloff_quality:
  Gradient and rolloff between bright and shadow zones. 10 = smooth,
  photographic falloff that creates depth (gentle window wash gradient onto
  a wall, soft shadow into ceiling line); 5 = hard edges between zones but
  not distracting; 0 = harsh sharp-edged shadows, banding, or flash-flat
  with no falloff. Floorplan: NULL.

— COMPOSITIONAL —
depth_layering:
  Distinct foreground / midground / background depth zones.
  10 = three-plus clear layers. 5 = two layers. 0 = flat single-plane.

composition_geometry:
  Does the actual composition style match a recognised pattern?
  10 = textbook example. 5 = recognisable but loose. 0 = composition style unclear.

vantage_quality:
  Camera-position alignment with what the slot needs.
  10 = vantage matches slot intent. 5 = neutral vantage. 0 = vantage works against the slot.

framing_quality:
  Crop and edge management. 10 = clean edges. 5 = adequate. 0 = cluttered edges
  or awkward cropping.

leading_lines:
  Do architectural lines draw the eye to the primary subject?
  10 = strong leading lines anchoring the composition. 5 = some directional cues.
  0 = no leading lines.

negative_space:
  Is breathing room around the subject deliberate (vs cramped or empty)?
  10 = ideal balance. 5 = adequate. 0 = subject crowded or floating in empty frame.

symmetry_quality:
  When the composition is symmetrical, is the symmetry axis aligned to frame centre?
  10 = perfect axial symmetry. 5 = adequate. 0 = symmetry attempted but off-axis.
  NULL when not a symmetrical composition.

foreground_anchor:
  Anchoring foreground element. 10 = strong anchor. 5 = some foreground but not
  anchoring. 0 = no foreground, frame floats.

— AESTHETIC / STYLING —
material_specificity:
  Are key textures (stone veining, timber grain, tile grout) visible and
  identifiable? 10 = textures crisp. 5 = adequate. 0 = textures lost.

period_reading:
  Does the image read its architectural era cleanly?
  10 = era reads unambiguously. 5 = mixed signals. 0 = era unclear.

styling_quality:
  Is the staging intentional and considered?
  10 = deliberate styling throughout. 5 = some staging. 0 = unstaged.

distraction_freeness:
  Power lines, neighbouring properties, owner in frame, etc.
  10 = no distractions. 5 = minor distractions, retouchable. 0 = major distractions.

— WORKFLOW —
retouch_debt:
  Total retouch effort the editor will need.
  10 = no retouch debt. 5 = standard retouch. 0 = major retouch.
  HIGHER score = LESS debt.

gallery_arc_position:
  Pre-Stage-4 hint at gallery placement value.
  10 = lead-image candidate. 5 = mid-gallery. 0 = archive-only.

social_crop_survival:
  Does the image survive a 1:1 Instagram crop without losing the hero feature?
  10 = centre square preserves the subject. 5 = mostly preserved. 0 = subject lost.

brochure_print_survival:
  Does the image hold up at print resolution and print colour?
  10 = print-ready. 5 = adequate for digital, marginal in print. 0 = artefacts.

reading_grade_match:
  Does the image's content match the implied reading grade of the listing copy?
  10 = tonally consistent. 5 = adequate. 0 = jarring tonal mismatch.
```

The block is conditionally rendered:
- For `internal_raw`, the lines flagged "RAW: ..." override the default activation.
- For `internal_finals`, the lines flagged "Finals: ..." apply.
- For `external_listing`, all signals are scored observationally; the prompt appends a final
  paragraph: "Your scoring is observational. Do NOT recommend retouching, do NOT flag for
  rejection."
- For `floorplan_image`, the entire block emits "All signal_scores set to NULL."

---

## 10. Joseph's binding decisions (signed off 2026-05-01)

1. **Q1 — `image_type` enum scope.** SHIP THE 11 OPTIONS as listed.

2. **Q2 — Lighting dimension mapping.** ADD 4 NEW LIGHTING SIGNALS instead
   of computing `lighting_score` from existing technical signals:
   `light_quality`, `light_directionality`,
   `color_temperature_appropriateness`, `light_falloff_quality`. Total
   schema = 26 signals (22 from v1 + 4 new lighting). `lighting_score`
   aggregate computes from these 4.

3. **Q3 — Bounding boxes on `observed_objects`.** DEFAULT ON. Stage 1 emits
   `bounding_box: {x_pct, y_pct, w_pct, h_pct}` on every observed_object
   by default. ~10-15% extra output tokens per call accepted.

4. **Q4 — `external_listing` `delivery_quality_grade` letter scale.** DROP
   the A-F letter grade. External listings get `combined_score` numeric only.

5. **Q5 — Per-image bracketing of `*_specific` blocks.** Keep four nullable
   blocks; enforce via prompt + persist-layer validation.

6. **Q6 — Schema version bump.** HARD CUTOVER to v2.0. NO 4-week dual-emit
   window. Existing v1 rows tagged `schema_version='v1.0'` and immutable;
   new emissions are v2 from day one.

7. **Q7 — Floorplan source type — keep separate or fold into external?**
   KEEP SEPARATE as its own source type (separate schema branch).

---

## 11. Execution plan

W11.7.17 = "Universal Vision Response Schema v2 cutover".

| # | Burst | Owner | Effort | Dependencies |
|---|---|---|---|---|
| 1 | Spec sign-off (this doc + Q1-Q7 answered) | Joseph | 30-60 min review | none |
| 2 | Migration 392 — additive columns + indexes | subagent | 0.5 day | spec sign-off |
| 3 | New block: `universalVisionResponseSchemaV2.ts` | subagent | 1 day | migration applied |
| 4 | New block: `signalMeasurementBlock.ts` | subagent | 0.5 day | block 3 |
| 5 | Bump `sourceContextBlock.ts` to v1.1 | subagent | 0.5 day | parallel with 4 |
| 6 | Update `shortlisting-shape-d/index.ts` Stage 1 prompt + persist | subagent | 1 day | 3, 4, 5 |
| 7 | Add `_shared/dimensionRollup.ts` helper + tests | subagent | 0.5 day | 6 |
| 8 | Snapshot tests covering all 4 source types | subagent | 0.5 day | parallel with 7 |
| 9 | Smoke run on Saladine round in shadow mode | subagent | 0.25 day | 7, 8 |
| 10 | Cutover: flip `engine_settings.universal_schema_version = 'v2.0'` | subagent | 0.25 day | 9 passes |
| 11 | After 4-week stability window: deprecate v1 emission path | subagent | 0.25 day | T+4 weeks |

**Total: ~5 days execution + 4-week stability window.**

---

## Appendix A — Comparison: v1 vs v2

| Concern | v1 (2026-04-27) | v2 (2026-05-01) |
|---|---|---|
| Schema version | `'1.0'` | `'2.0'` |
| Sidecar `composition_signal_scores` table | yes | **dropped — JSONB column instead** |
| `image_type` enum | not in schema | **required field** with 11 options |
| `signal_scores` shape | per-row sidecar | **JSONB column** |
| `*_specific` blocks | partial | **all four** including floorplan |
| Per-image listing copy | declared | precisely scoped per source |
| `observed_objects` bounding box | not specified | **optional, opt-in** |
| `observed_attributes` | not in schema | **separate array** |
| Backwards compat with 4-axis aggregates | dual-emit | **aggregates are computed views** |
| Stage 4 / master_listing | included | **moved to W11.7 spec** (W11 v2 is per-image only) |

## Appendix B — Files this spec governs

- `supabase/functions/_shared/visionPrompts/blocks/stage1ResponseSchema.ts` — replaced by
  v2 `universalVisionResponseSchemaV2.ts`
- `supabase/functions/_shared/visionPrompts/blocks/sourceContextBlock.ts` — bumped to v1.1
- `supabase/functions/shortlisting-shape-d/index.ts` — Stage 1 prompt assembly + persist
- `supabase/migrations/392_universal_vision_schema_v2.sql` (new)
- `supabase/functions/_shared/dimensionRollup.ts` (new)
- `supabase/functions/_shared/visionPrompts/blocks/signalMeasurementBlock.ts` (new)
