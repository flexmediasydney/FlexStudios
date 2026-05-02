/**
 * shortlistingEnums.js — W11.6.22b mirror of canonical shortlisting taxonomies.
 *
 * MIRROR OF supabase/functions/_shared/visionPrompts/blocks/* — keep in sync.
 *
 * Why mirror instead of re-export:
 *   The Deno backend modules use `.ts` extensions and rely on the Vite alias
 *   path to resolve. While `@pricing` works for the pricing engine (which has
 *   relative imports with .ts extensions), pulling in the taxonomy modules
 *   requires the same plumbing. The taxonomy lists below are short and stable
 *   enough that a literal copy is the lowest-friction option AND keeps the
 *   curated-position editor's bundle small.
 *
 * Sources of truth (DO NOT diverge — these are referenced by Gemini's
 * responseSchema enums + Stage 1/4 prompts; drift creates ML-level bugs):
 *
 *   - IMAGE_TYPE_OPTIONS, LIGHTING_STATE_OPTIONS, UNIVERSAL_SIGNAL_KEYS:
 *       supabase/functions/_shared/visionPrompts/blocks/universalVisionResponseSchemaV2.ts
 *   - SPACE_TYPE_OPTIONS, ZONE_FOCUS_OPTIONS:
 *       supabase/functions/_shared/visionPrompts/blocks/spaceZoneTaxonomy.ts
 *   - COMPOSITION_TYPE_OPTIONS:
 *       supabase/functions/_shared/visionPrompts/blocks/compositionTypeTaxonomy.ts
 *
 * When you change a backend list, mirror the change here. The
 * SettingsShortlistingSlots curated-position editor + tests assert
 * length-equality against these arrays so a drift will fail CI loudly.
 */

// ─── universalVisionResponseSchemaV2.ts ─────────────────────────────────────

/**
 * 10 image_type options surfaced as preferred_image_type dropdown values.
 *
 * Mig 442 (2026-05-02, schema v2.5): `is_detail_shot` REMOVED — replaced by
 * the new `shot_scale` axis (wide | medium | tight | detail | vignette).
 * Detail shots are now classified via shot_scale="detail" / "tight".
 */
export const IMAGE_TYPE_OPTIONS = [
  "is_day",
  "is_dusk",
  "is_drone",
  "is_agent_headshot",
  "is_test_shot",
  "is_bts",
  "is_floorplan",
  "is_video_frame",
  "is_facade_hero",
  "is_other",
];

/** 5 shot_scale options (mig 442 / schema v2.5). */
export const SHOT_SCALE_OPTIONS = [
  "wide",
  "medium",
  "tight",
  "detail",
  "vignette",
];

/** 3 perspective_compression options (mig 442 / schema v2.5). */
export const PERSPECTIVE_COMPRESSION_OPTIONS = [
  "expanded",
  "neutral",
  "compressed",
];

/** 3 orientation options (mig 442 / schema v2.5; derived from EXIF at persist). */
export const ORIENTATION_OPTIONS = ["landscape", "portrait", "square"];

/** 4 lighting_state options for preferred_lighting_state dropdown. */
export const LIGHTING_STATE_OPTIONS = ["day", "dusk", "twilight", "night"];

/** 26 universal signal keys for preferred_signal_emphasis multi-select. */
export const UNIVERSAL_SIGNAL_KEYS = [
  // ─ Technical (6) ─
  "exposure_balance",
  "color_cast",
  "sharpness_subject",
  "sharpness_corners",
  "plumb_verticals",
  "perspective_distortion",
  // ─ Lighting (4) ─
  "light_quality",
  "light_directionality",
  "color_temperature_appropriateness",
  "light_falloff_quality",
  // ─ Compositional (8) ─
  "depth_layering",
  "composition_geometry",
  "vantage_quality",
  "framing_quality",
  "leading_lines",
  "negative_space",
  "symmetry_quality",
  "foreground_anchor",
  // ─ Aesthetic / styling (4) ─
  "material_specificity",
  "period_reading",
  "styling_quality",
  "distraction_freeness",
  // ─ Workflow (4) ─
  "retouch_debt",
  "gallery_arc_position",
  "social_crop_survival",
  "brochure_print_survival",
];

// ─── spaceZoneTaxonomy.ts ────────────────────────────────────────────────────

/** 32 space_type options (architectural enclosure). */
export const SPACE_TYPE_OPTIONS = [
  "master_bedroom",
  "bedroom_secondary",
  "bedroom_third",
  "living_dining_combined",
  "living_room_dedicated",
  "dining_room_dedicated",
  "kitchen_dining_living_combined",
  "kitchen_dedicated",
  "studio_open_plan",
  "bathroom",
  "ensuite",
  "powder_room",
  "entry_foyer",
  "hallway",
  "study",
  "media_room",
  "rumpus",
  "laundry",
  "mudroom",
  "garage",
  "alfresco_undercover",
  "alfresco_open",
  "balcony",
  "terrace",
  "exterior_facade",
  "exterior_rear",
  "exterior_side",
  "pool_area",
  "garden",
  "streetscape",
  "aerial_oblique",
  "aerial_nadir",
];

/** 29 zone_focus options (compositional subject). */
export const ZONE_FOCUS_OPTIONS = [
  "bed_focal",
  "wardrobe_built_in",
  "dining_table",
  "kitchen_island",
  "kitchen_appliance_wall",
  "kitchen_pantry",
  "lounge_seating",
  "fireplace_focal",
  "study_desk",
  "tv_media_wall",
  "bath_focal",
  "shower_focal",
  "vanity_detail",
  "toilet_visible",
  "window_view",
  "door_threshold",
  "stair_focal",
  "feature_wall",
  "ceiling_detail",
  "floor_detail",
  "material_proof",
  "landscape_overview",
  "full_facade",
  "pool_focal",
  "outdoor_dining",
  "outdoor_kitchen",
  "bbq_zone",
  "drying_zone",
  "parking_zone",
];

// ─── compositionTypeTaxonomy.ts ──────────────────────────────────────────────

/** 11 canonical composition_type values. */
export const COMPOSITION_TYPE_OPTIONS = [
  "hero_wide",
  "corner_two_point",
  "detail_closeup",
  "corridor_leading",
  "straight_on",
  "overhead",
  "upward_void",
  "threshold_transition",
  "drone_nadir",
  "drone_oblique_contextual",
  "architectural_abstract",
];
