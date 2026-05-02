/**
 * Recipe Matrix — shared constants.
 *
 * Centralised so the Cell Editor, Position Editor, and AdvancedSlotTemplates
 * panel all describe the same constraint surface and engine-mode vocabulary.
 *
 * All constants are plain strings (no closed PG enums — Joseph dropped the
 * SPACE_TYPE / ZONE_FOCUS enums in mig 9325f46 / v2.4 schema). The dropdown
 * values that populate the constraint pickers come from
 * `taxonomy_b_axis_distribution(axis)` at runtime — these constants only
 * describe the *axes* themselves and the engine-mode / phase / selection
 * vocabularies.
 *
 * Package + price-tier sets are intentionally NOT hard-coded — they're loaded
 * from the live `packages` and `shortlisting_tiers` tables so adding a new
 * package or tier doesn't require a UI redeploy.
 */

// ── Constraint axes the matrix exposes ────────────────────────────────────
//
// `key` is the column name on `gallery_positions` and the axis param fed to
// `taxonomy_b_axis_distribution`. `pickerSource` says where to source the
// dropdown options:
//   'taxonomy_b'      — call taxonomy_b_axis_distribution(key)
//   'shot_scale'      — finite open-vocab (mig 442)
//   'compression'     — finite open-vocab (mig 442)
//   'lens_class'      — finite open-vocab
//
// Every constraint dropdown gets an "(any)" / null option prepended at
// runtime — picking it leaves the constraint unset (engine-picks).
export const CONSTRAINT_AXES = [
  {
    key: "room_type",
    label: "Room type",
    tooltip:
      "Pre-Wave-11 single-axis classification. New positions should usually leave this NULL and use space_type + zone_focus instead.",
    pickerSource: "taxonomy_b",
    legacy: true,
  },
  {
    key: "space_type",
    label: "Space type",
    tooltip:
      "What kind of space the photo shows (kitchen_dedicated, primary_bedroom, etc). Primary discriminator after image_type.",
    pickerSource: "taxonomy_b",
  },
  {
    key: "zone_focus",
    label: "Zone focus",
    tooltip:
      "Sub-region the shot focuses on (kitchen_island, bedroom_dressing_zone, etc). Use to force a specific framing.",
    pickerSource: "taxonomy_b",
  },
  {
    key: "image_type",
    label: "Image type",
    tooltip:
      "Whether this position should be filled by an interior, exterior, drone, twilight, etc. shot.",
    pickerSource: "taxonomy_b",
  },
  {
    key: "composition_type",
    label: "Composition type",
    tooltip:
      "Hero / supporting / detail framing — the editorial role of the shot.",
    pickerSource: "taxonomy_b",
  },
  {
    key: "shot_scale",
    label: "Shot scale",
    tooltip:
      "How much of the space is in frame: wide, medium, tight. Wide reads as 'establishing shot'.",
    pickerSource: "shot_scale",
  },
  {
    key: "perspective_compression",
    label: "Perspective compression",
    tooltip:
      "Compressed (telephoto) vs spacious (wide-angle) feel. Compressed often reads more editorial.",
    pickerSource: "compression",
  },
  {
    key: "lens_class",
    label: "Lens class",
    tooltip:
      "Approximate equivalent focal length bucket: ultrawide / wide / standard / telephoto.",
    pickerSource: "lens_class",
  },
];

// Shot scale axis values — gallery_positions CHECK constraint (mig 443
// extends the mig 442 vocab).
export const SHOT_SCALE_VALUES = [
  "wide",
  "medium",
  "tight",
  "detail",
  "vignette",
];

// Perspective compression axis values — gallery_positions CHECK constraint.
export const COMPRESSION_VALUES = ["expanded", "neutral", "compressed"];

// Orientation (mig 443 column) — landscape / portrait / square. Not
// surfaced as a constraint in the matrix MVP because sales is almost
// always landscape.
export const ORIENTATION_VALUES = ["landscape", "portrait", "square"];

// Lens class — coarse focal-length bucket. Open vocab (text column).
export const LENS_CLASS_VALUES = [
  "ultrawide",
  "wide",
  "standard",
  "telephoto",
];

// ── Engine modes (per-package / per-product / per-cell override) ──────────
export const ENGINE_MODES = [
  {
    key: "recipe_strict",
    label: "Recipe strict",
    blurb:
      "Engine follows the recipe exactly; never deviates. Empty positions stay empty.",
  },
  {
    key: "recipe_with_ai_backfill",
    label: "Recipe + AI backfill",
    blurb:
      "Engine follows the recipe; fills any empty positions with the next-best uncommitted shot.",
  },
  {
    key: "full_ai",
    label: "Full AI",
    blurb:
      "Engine ignores the recipe and picks freely up to package_count_target. Use sparingly.",
  },
];

export const ENGINE_MODE_KEYS = ENGINE_MODES.map((m) => m.key);

// ── Phase semantics ──────────────────────────────────────────────────────
export const PHASES = [
  {
    key: "mandatory",
    label: "Mandatory",
    blurb:
      "Engine MUST fill this position. If no eligible image, the slot stays empty (or is filled by AI backfill if enabled on the parent recipe).",
  },
  {
    key: "conditional",
    label: "Conditional",
    blurb:
      "Engine fills this position only when the constraints can be satisfied; otherwise it is silently skipped.",
  },
  {
    key: "optional",
    label: "Optional",
    blurb:
      "Free recommendation slot. Engine picks the best image not yet committed to a higher-phase position.",
  },
];

// ── Selection modes ──────────────────────────────────────────────────────
export const SELECTION_MODES = [
  {
    key: "ai_decides",
    label: "AI decides",
    blurb:
      "Engine picks the best image satisfying the constraints. Default for most positions.",
  },
  {
    key: "curated",
    label: "Curated",
    blurb:
      "Operator specifies a sub-position breakdown (advanced). Mostly used for editorial-heavy decks.",
  },
];

// ── Engine roles (rounds break across these — Sales / Drone / Floor Plans) ─
// Engine-role keys map 1:1 to round.engine_role / round.engine_role_input.
// Pulled from current production data — kept in sync with the
// shortlisting engine.
export const ENGINE_ROLES = [
  {
    key: "photo_day_shortlist",
    label: "Sales Images",
    blurb: "Daytime sales-image shortlist — the bulk of most packages.",
  },
  {
    key: "drone_shortlist",
    label: "Drone Shots",
    blurb: "Aerial / drone shortlist; usually 2–4 positions per package.",
  },
  {
    key: "floor_plans",
    label: "Floor Plans",
    blurb: "Floor-plan deliverables; not run through Stage 4 voice anchor.",
  },
  {
    key: "dusk_shortlist",
    label: "Dusk Images",
    blurb: "Dusk-only round; gated by package add-on.",
  },
  {
    key: "video_shortlist",
    label: "Video Frames",
    blurb: "Video-frame shortlist; positions feed the v-cut downstream.",
  },
];

// ── Color helpers for matrix cells ───────────────────────────────────────
export function cellHealthColor(positionCount, expectedTarget) {
  if (positionCount === 0) return "red";
  if (expectedTarget == null) return positionCount > 0 ? "green" : "amber";
  if (positionCount >= expectedTarget) return "green";
  return "amber";
}

// ── Shape of a constraint tuple (for snapshot equality + diffing) ────────
export const CONSTRAINT_KEYS = CONSTRAINT_AXES.map((a) => a.key);

/**
 * Pick the constraint tuple from a position row (tolerates both raw DB
 * shape and editor-draft shape). Returns the canonical constraint object
 * with EVERY axis present (NULL = wildcard / engine-picks).
 */
export function pickConstraints(row) {
  const out = {};
  for (const k of CONSTRAINT_KEYS) {
    const v = row?.[k];
    out[k] = v === undefined || v === "" ? null : v;
  }
  return out;
}

/**
 * Count how many constraints are non-null on a position row.
 * Used to render the "X constraints set" hint on the position list.
 */
export function constraintCount(row) {
  let n = 0;
  for (const k of CONSTRAINT_KEYS) {
    const v = row?.[k];
    if (v !== undefined && v !== null && v !== "") n += 1;
  }
  return n;
}
