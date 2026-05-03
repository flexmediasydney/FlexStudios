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
 *
 * Mig 451 (S1 / W11.6.29 — 2026-05-02): dropped `room_type` and
 * `composition_type` columns from gallery_positions. The Position Editor no
 * longer authors against those columns. Operators see "Room" labels backed by
 * `space_type`, and the old `composition_type` axis is decomposed into
 * `vantage_position` (eye_level / corner / through_doorway / aerial / …) and
 * `composition_geometry` (1-point / leading_lines / symmetrical / …).
 */

// Engine roles that are IMAGE shortlist deliverables — these are the only
// roles the Recipe Matrix authors positions for. Video has its own shot-list
// concept (not yet implemented); floorplan_qa is a separate processing path;
// agent_portraits are headshots with different shortlist criteria. Filter
// applied at: (a) per-cell target derivation, (b) engine_role tabs in
// CellEditorDialog, (c) packageOffersTier image-class fallback.
export const IMAGE_SHORTLIST_ENGINE_ROLES = Object.freeze([
  "photo_day_shortlist",
  "photo_dusk_shortlist",
  "drone_shortlist",
]);

export function isImageShortlistEngineRole(role) {
  return IMAGE_SHORTLIST_ENGINE_ROLES.includes(role);
}

// ── Constraint axes the matrix exposes ────────────────────────────────────
//
// `key` is the column name on `gallery_positions` and the axis param fed to
// `taxonomy_b_axis_distribution`. `pickerSource` says where to source the
// dropdown options:
//   'taxonomy_b'      — call taxonomy_b_axis_distribution(key)
//   'shot_scale'      — finite open-vocab (mig 442)
//   'compression'     — finite open-vocab (mig 442)
//   'lens_class'      — finite open-vocab
//   'orientation'     — finite open-vocab
//   'vantage'         — finite open-vocab (mig 451)
//   'geometry'        — finite open-vocab (mig 451)
//   'image_type'      — finite open-vocab (is_day / is_dusk / is_drone / …)
//
// `group` says which of the two Position Editor sections the axis lives in:
//   'default'  — always visible when a position is expanded
//   'more'     — collapsed inside the "More constraints" expander
//
// Every constraint dropdown gets an "(any)" / null option prepended at
// runtime — picking it leaves the constraint unset (engine-picks).
//
// The order here drives the rendered order in the Position Editor; keep
// "default" axes ahead of "more" axes for cleaner diffs.
export const CONSTRAINT_AXES = [
  // ── Default-visible axes ───────────────────────────────────────────────
  {
    key: "space_type",
    label: "Room",
    tooltip:
      "Which room / space the photo shows. Friendly labels above; raw enum codes hidden. Backed by composition_classifications.space_type.",
    pickerSource: "taxonomy_b",
    group: "default",
  },
  {
    key: "zone_focus",
    label: "Zone focus",
    tooltip:
      "Sub-region the shot focuses on (kitchen_island, bedroom_dressing_zone, etc). Use to force a specific framing.",
    pickerSource: "taxonomy_b",
    group: "default",
  },
  {
    key: "shot_scale",
    label: "Shot scale",
    tooltip:
      "How much of the space is in frame: wide / medium / tight / detail / vignette. Wide reads as 'establishing shot'.",
    pickerSource: "shot_scale",
    group: "default",
  },
  {
    key: "perspective_compression",
    label: "Perspective compression",
    tooltip:
      "Expanded (spacious) vs neutral vs compressed (telephoto-feel). Compressed often reads more editorial.",
    pickerSource: "compression",
    group: "default",
  },

  // ── More-constraints axes (collapsed by default) ────────────────────────
  {
    key: "vantage_position",
    label: "Vantage position",
    tooltip:
      "Where the camera is positioned in the room — eye_level / corner / through_doorway / aerial_overhead / low_angle. Half of the decomposed composition_type axis (mig 451).",
    pickerSource: "vantage",
    group: "more",
  },
  {
    key: "composition_geometry",
    label: "Composition geometry",
    tooltip:
      "Geometric pattern the frame uses — 1-point perspective / leading_lines / symmetrical / rule_of_thirds. Other half of the decomposed composition_type axis (mig 451).",
    pickerSource: "geometry",
    group: "more",
  },
  {
    key: "image_type",
    label: "Image type",
    tooltip:
      "Whether this position should be filled by a day / dusk / drone / floorplan / etc. shot.",
    pickerSource: "image_type",
    group: "more",
  },
  {
    key: "lens_class",
    label: "Lens class",
    tooltip:
      "Approximate equivalent focal length bucket: ultrawide / wide / standard / telephoto.",
    pickerSource: "lens_class",
    group: "more",
  },
  {
    key: "orientation",
    label: "Orientation",
    tooltip:
      "Landscape / portrait / square. Sales is usually landscape; portrait is common for tall hero shots.",
    pickerSource: "orientation",
    group: "more",
  },

  // ── Space-instance targeting axes (W11.8 / mig 454) ─────────────────────
  //
  // The Stage 1 → Stage 2 pipeline clusters compositions of the same
  // `space_type` into "space instances" (a duplex with two kitchens has
  // two kitchen instances; a property with one master bedroom has one
  // master_bedroom instance). Each instance gets a stable per-property
  // index so operators can target the Nth detected room.
  //
  // These two fields differ from the other constraint axes — they're not
  // composition_classifications properties, they're scoped to gallery
  // positions only. The Position Editor renders them as bespoke controls
  // (a hardcoded select + a checkbox) instead of the ConstraintPicker
  // taxonomy_b distribution path, so we tag them with `kind: 'instance'`
  // and let PositionRow special-case the rendering.
  {
    key: "instance_index",
    label: "Instance",
    tooltip:
      "Target the Nth space_instance the engine detected for this room type. Useful for multi-dwelling properties (e.g. position 1 = main kitchen, position 2 = granny flat kitchen). Leave as 'Any' to let the engine pick the best-scoring shot across all instances.",
    pickerSource: "instance_index",
    kind: "instance",
    type: "select",
    group: "more",
    options: [
      { value: null, label: "Any" },
      { value: 1, label: "1st detected" },
      { value: 2, label: "2nd detected" },
      { value: 3, label: "3rd detected" },
      { value: 4, label: "4th detected" },
    ],
  },
  {
    key: "instance_unique_constraint",
    label: "Force unique instance",
    tooltip:
      "When checked, every position in this recipe with the same constraint tuple must come from a DIFFERENT physical room. Useful for repeated positions (e.g. 3 lounge positions on a 2-lounge property: only 2 will fill, the 3rd stays empty unless ai_backfill is on).",
    pickerSource: "instance_unique_constraint",
    kind: "instance",
    type: "checkbox",
    group: "more",
    default: false,
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

// Orientation values — landscape / portrait / square.
export const ORIENTATION_VALUES = ["landscape", "portrait", "square"];

// Lens class — coarse focal-length bucket. Open vocab (text column).
export const LENS_CLASS_VALUES = [
  "ultrawide",
  "wide",
  "standard",
  "telephoto",
];

// Image type — finite vocab on composition_classifications.image_type.
// Backed by the Hierarchy B axis distribution but cached here as a
// fallback so the Position Editor doesn't have to round-trip on every
// open. Keep aligned with composition_classifications.image_type values.
export const IMAGE_TYPE_VALUES = [
  "is_day",
  "is_dusk",
  "is_night",
  "is_drone",
  "is_floorplan",
  "is_video_frame",
  "is_styled",
  "is_amenity",
];

// ── Vantage position (mig 451) ────────────────────────────────────────────
//
// Decomposed half of the old composition_type axis — captures *where the
// camera is* in the room, independent of the geometric pattern of the frame.
//
// Friendly labels exposed via VANTAGE_POSITION_LABELS below for the dropdown.
export const VANTAGE_POSITION_VALUES = [
  "eye_level",
  "corner",
  "square_to_wall",
  "through_doorway",
  "down_corridor",
  "aerial_overhead",
  "aerial_oblique",
  "low_angle",
  "high_angle",
];

export const VANTAGE_POSITION_LABELS = Object.freeze({
  eye_level: "Eye level (default)",
  corner: "Corner",
  square_to_wall: "Square to wall",
  through_doorway: "Through doorway",
  down_corridor: "Down corridor",
  aerial_overhead: "Aerial — overhead",
  aerial_oblique: "Aerial — oblique",
  low_angle: "Low angle",
  high_angle: "High angle",
});

// ── Composition geometry (mig 451) ────────────────────────────────────────
//
// Other decomposed half — captures the geometric pattern the frame uses,
// independent of where the camera is. Operators set this when they want a
// specific compositional language (e.g. leading lines for a corridor).
export const COMPOSITION_GEOMETRY_VALUES = [
  "one_point_perspective",
  "two_point_perspective",
  "three_point_perspective",
  "leading_lines",
  "symmetrical",
  "centered",
  "rule_of_thirds",
  "asymmetric_balance",
];

export const COMPOSITION_GEOMETRY_LABELS = Object.freeze({
  one_point_perspective: "1-point perspective",
  two_point_perspective: "2-point perspective",
  three_point_perspective: "3-point perspective",
  leading_lines: "Leading lines",
  symmetrical: "Symmetrical",
  centered: "Centered",
  rule_of_thirds: "Rule of thirds",
  asymmetric_balance: "Asymmetric balance",
});

// ── Friendly Room labels (mig 451) ────────────────────────────────────────
//
// Operators think in plain language — "Kitchen", "Master bedroom", "Pool
// area" — not raw enum codes. The Position Editor's Room dropdown shows
// these labels and hides the underlying space_type code.
//
// The list mirrors the most common values returned by
// taxonomy_b_axis_distribution('space_type'). Anything not in the table
// falls through to friendlyLabelForSpaceType() which de-snake-cases and
// title-cases the raw value (e.g. `garage_internal` → "Garage internal").
//
// Kept in display order rather than alphabetical: the editor renders them
// in this order so the most common picks (Kitchen, bedrooms, bathrooms) are
// at the top.
export const SPACE_TYPE_FRIENDLY_LABELS = Object.freeze({
  // Indoor — primary living
  kitchen_dedicated: "Kitchen",
  kitchen_dining_combined: "Open-plan kitchen/dining",
  kitchen_dining_living_combined: "Open-plan kitchen/living",
  living_room_dedicated: "Living room",
  living_dining_combined: "Open-plan living/dining",
  dining_room_dedicated: "Dining room",
  family_room: "Family room",
  rumpus_room: "Rumpus room",
  // Indoor — sleeping
  master_bedroom: "Master bedroom",
  primary_bedroom: "Primary bedroom",
  bedroom_secondary: "Secondary bedroom",
  guest_bedroom: "Guest bedroom",
  // Indoor — wet zones
  bathroom: "Bathroom",
  ensuite: "Ensuite",
  powder_room: "Powder room",
  laundry: "Laundry",
  // Indoor — utility / circulation
  hallway: "Hallway",
  entry_foyer: "Entry / foyer",
  staircase: "Staircase",
  study: "Study",
  home_office: "Home office",
  walk_in_robe: "Walk-in robe",
  butlers_pantry: "Butler's pantry",
  // Indoor — extras
  cellar: "Wine cellar",
  cinema_room: "Cinema room",
  gym: "Home gym",
  garage_internal: "Garage (internal)",
  // Outdoor — facade
  exterior_facade: "Front exterior",
  exterior_rear: "Back exterior",
  // Outdoor — amenity
  pool_area: "Pool area",
  spa_area: "Spa area",
  garden: "Garden",
  outdoor_alfresco: "Alfresco / outdoor dining",
  outdoor_kitchen: "Outdoor kitchen",
  balcony: "Balcony",
  deck: "Deck",
  patio: "Patio",
  courtyard: "Courtyard",
  // Aerial / drone perspectives
  streetscape: "Streetscape",
  aerial_overview: "Aerial overview",
  // Other
  view: "View",
  detail: "Detail",
});

/**
 * Resolve a friendly Room label for a space_type enum value.
 *
 * 1. If the value is in SPACE_TYPE_FRIENDLY_LABELS → return that.
 * 2. Otherwise, de-snake-case + capitalize each word so a brand-new
 *    distribution value lands in the dropdown with a sane label rather
 *    than the raw `garage_internal_carpet`.
 * 3. NULL / undefined → returns the empty string.
 */
export function friendlyLabelForSpaceType(value) {
  if (value == null || value === "") return "";
  if (Object.prototype.hasOwnProperty.call(SPACE_TYPE_FRIENDLY_LABELS, value)) {
    return SPACE_TYPE_FRIENDLY_LABELS[value];
  }
  return friendlyLabelGeneric(value);
}

/**
 * Generic snake_case → "Title case" helper. Used as the fallback labeller
 * for any axis whose dropdown values arrive as snake_case strings (zone_focus,
 * image_type, etc).
 */
export function friendlyLabelGeneric(value) {
  if (value == null || value === "") return "";
  return String(value)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

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
//
// Authored / Target dual-number logic (W11.6.28b — Joseph's brief):
//   X = positionCount (authored)   — gallery_positions rows in the cell scope
//   Y = expectedTarget             — the package's contractual deliverable
//                                    count for this price tier (or sum of
//                                    products[] if the tier jsonb's
//                                    image_count is missing)
//
// Color rules:
//   slate  — X = 0   (nothing authored yet, no warning)
//   red    — Y = 0   (defensive — package has no count for this tier; the
//                     cell shouldn't exist but render safely if it does)
//   amber  — X > Y   (over-target — engine will drop lowest-priority
//                     positions; surfaces a warning to the operator)
//   green  — 0 < X ≤ Y (the recipe authors within the contractual budget)
//
// expectedTarget=null is treated as "no target known" → fall back to the
// pre-target heuristic (any X > 0 reads as green; X = 0 reads as slate).
export function cellHealthColor(positionCount, expectedTarget) {
  const x = positionCount || 0;
  const y = expectedTarget;
  if (y === 0) return "red";
  if (x === 0) return "slate";
  if (y == null) return "green";
  if (x > y) return "amber";
  return "green";
}

// ── Per-package target derivation (W11.6.28b) ────────────────────────────
//
// The recipe matrix shows X authored / Y target per cell. Y is the package's
// contractual image deliverable count for this price tier:
//
//   1. PRIMARY  → packages.standard_tier / .premium_tier jsonb's `image_count`
//                 (authoritative when present; matches contract docs).
//   2. FALLBACK → SUM(products[i].quantity) for products that can deliver
//                 images in that tier. Quantity comes from the package's
//                 own products[] jsonb array; the per-product image
//                 contribution is taken from the product's tier jsonb when
//                 present, otherwise from the per-product quantity field.
//   3. UNKNOWN  → null (cell renders without a target gauge).
//
// Note: there is NO top-level `packages.expected_count_target` column
// (that lives on `shortlisting_rounds` and is per-round). Earlier code
// referenced it as a hard fallback; that path was a phantom.
//
// The fallback breakdown is exposed to the UI as a tooltip explaining
// "Target: 5 (Sales) + 3 (Drone) + 1 (Floor Plans) = 9".
//
// `productLookup` is optional (Map<id, product>) — passed in by the matrix
// when rendering per-cell targets so we can read the product's own
// .standard_tier / .premium_tier jsonb. When absent we still try to
// resolve from the package's products[] entries themselves (each entry
// already carries `quantity` from PackageFormDialog).
//
// IMAGE-CLASS FILTER (W11.6.28c — Joseph: "Silver shows 11 target = 10
// Sales Images + 1 Floor and Site Plan, but Floor Plans aren't image
// shortlist deliverables"):
//
// The sum-of-products fallback is filtered to image-class engine_roles only
// (photo_day_shortlist / photo_dusk_shortlist / drone_shortlist). Video,
// floorplan_qa, and agent_portraits products run through separate engines
// and don't belong in the image shortlist target. Products with a NULL
// engine_role (surcharges, declutter, etc.) are also excluded — operators
// should set engine_role to an image-class value if they want a product to
// contribute to the recipe matrix target.
//
// The tier_image_count primary path stays as-is — it's an explicit
// authored number on the package's tier jsonb. Operators are expected to
// only use that number for image-class output; the matrix help banner
// makes that clear.
export function deriveCellTarget(pkg, tierCode, productLookup = null) {
  if (!pkg || !tierCode) return { value: null, source: "unknown", breakdown: [] };

  const tierKey = tierCode === "premium" ? "premium_tier" : "standard_tier";
  const tierJson = pkg[tierKey];

  // ── Primary: tier jsonb image_count ────────────────────────────────────
  // (operators should only set image_count on image-class products /
  // tiers — non-image deliverables have their own count semantics)
  if (tierJson && typeof tierJson === "object") {
    const ic =
      tierJson.image_count ?? tierJson.images ?? tierJson.deliverable_count;
    if (Number.isFinite(Number(ic)) && Number(ic) > 0) {
      return {
        value: Number(ic),
        source: "tier_image_count",
        breakdown: [
          {
            label: `${pkg.name || "Package"} ${tierCode}`,
            value: Number(ic),
          },
        ],
      };
    }
  }

  // ── Fallback: sum of IMAGE-CLASS products[] in this package ────────────
  const items = Array.isArray(pkg.products) ? pkg.products : [];
  if (items.length > 0) {
    const breakdown = [];
    let total = 0;
    for (const item of items) {
      const prod = productLookup?.get?.(item.product_id);
      // FILTER non-image-class deliverables. We only count toward the
      // image-shortlist target when the product's engine_role is one of
      // photo_day_shortlist / photo_dusk_shortlist / drone_shortlist.
      // Products with NULL engine_role (surcharges, declutter, etc.) or
      // non-image classes (video, floorplan_qa, agent_portraits) are
      // EXCLUDED — they don't belong in the image-shortlist sum.
      //
      // When we have no productLookup (defensive fallback), we cannot
      // verify the engine_role and the line item is excluded — better to
      // under-count the image budget than over-count by including video.
      if (!prod || !isImageShortlistEngineRole(prod.engine_role)) continue;

      // Prefer the product's tier-specific image_count if we have a lookup.
      let qty = null;
      if (prod && prod[tierKey] && typeof prod[tierKey] === "object") {
        const pIc =
          prod[tierKey].image_count ??
          prod[tierKey].images ??
          prod[tierKey].deliverable_count;
        if (Number.isFinite(Number(pIc)) && Number(pIc) > 0) qty = Number(pIc);
      }
      // Fallback to the line-item quantity already carried by the package.
      if (qty == null && Number.isFinite(Number(item.quantity))) {
        qty = Number(item.quantity);
      }
      if (qty == null || qty === 0) continue;
      breakdown.push({
        label: item.product_name || prod?.name || "Product",
        value: qty,
      });
      total += qty;
    }
    if (total > 0) {
      return {
        value: total,
        source: "sum_of_products",
        breakdown,
      };
    }
  }

  return { value: null, source: "unknown", breakdown: [] };
}

// Format a derived target's breakdown into the per-cell tooltip copy.
export function describeTargetBreakdown(target) {
  if (!target || target.value == null) {
    return "No target — package missing image_count and products quantities.";
  }
  if (target.source === "tier_image_count") {
    return `Target: ${target.value} images (from package tier image_count).`;
  }
  if (target.source === "sum_of_products") {
    const parts = target.breakdown
      .map((b) => `${b.value} (${b.label})`)
      .join(" + ");
    return `Target: ${target.value} images = ${parts}. (Sum-of-products fallback — tier jsonb has no image_count.)`;
  }
  return "";
}

// Whether a package OFFERS this price tier — used to disable cells that
// don't make sense for a package that doesn't sell in this tier (e.g. an
// AI package may only have a Standard tier). We treat the tier as "offered"
// when the tier jsonb has any pricing/image data, or when the package has
// products[] entries (default-true so the matrix doesn't accidentally hide
// cells the operator set up).
//
// IMAGE-CLASS FILTER (W11.6.28c): the products[] fallback is filtered to
// image-class engine_roles only. A package with ONLY video products (e.g.
// "Day Video Package") would otherwise render image-shortlist cells the
// engine has no use for. When productLookup is supplied we verify
// engine_role; when not, the products[] count is treated as a soft signal
// (back-compat — the older callsites pass no lookup and we don't want to
// regress their cells). The matrix grid always passes a lookup.
export function packageOffersTier(pkg, tierCode, productLookup = null) {
  if (!pkg) return false;
  const tierKey = tierCode === "premium" ? "premium_tier" : "standard_tier";
  const tierJson = pkg[tierKey];
  if (tierJson && typeof tierJson === "object") {
    const hasFields = Object.keys(tierJson).some((k) => {
      const v = tierJson[k];
      return v != null && v !== 0 && v !== "" && !Number.isNaN(v);
    });
    if (hasFields) return true;
  }
  // Last resort: a package with products[] is offering whichever tier the
  // operator set up. With a productLookup, only IMAGE-CLASS products count
  // (video / floorplan_qa / agent_portraits / null engine_role exclude).
  if (Array.isArray(pkg.products) && pkg.products.length > 0) {
    if (productLookup) {
      const hasImageProduct = pkg.products.some((item) => {
        const prod = productLookup.get?.(item.product_id);
        return prod && isImageShortlistEngineRole(prod.engine_role);
      });
      return hasImageProduct;
    }
    return true;
  }
  return false;
}

// ── Shape of a constraint tuple (for snapshot equality + diffing) ────────
export const CONSTRAINT_KEYS = CONSTRAINT_AXES.map((a) => a.key);

// Subset by group — used by the Position Editor to render the "default"
// section vs the collapsed "More constraints" expander.
export const CONSTRAINT_KEYS_DEFAULT = CONSTRAINT_AXES.filter(
  (a) => a.group === "default",
).map((a) => a.key);
export const CONSTRAINT_KEYS_MORE = CONSTRAINT_AXES.filter(
  (a) => a.group === "more",
).map((a) => a.key);

/**
 * Pick the constraint tuple from a position row (tolerates both raw DB
 * shape and editor-draft shape). Returns the canonical constraint object
 * with EVERY axis present (NULL = wildcard / engine-picks).
 *
 * Mig 451: the legacy `room_type` and `composition_type` columns are NO
 * LONGER columns on gallery_positions and are deliberately NOT picked
 * up here even if they happen to ride along on a stale draft object —
 * the upsert sanitiser would reject the DB write otherwise.
 */
export function pickConstraints(row) {
  const out = {};
  for (const k of CONSTRAINT_KEYS) {
    const v = row?.[k];
    // W11.8 / mig 454: the boolean `instance_unique_constraint` defaults to
    // FALSE rather than NULL — its DB column is NOT NULL with default false.
    // Coerce undefined / null inputs to false for that key only; leave
    // every other axis at null on absence (the existing wildcard semantics).
    if (k === "instance_unique_constraint") {
      out[k] = v === true ? true : false;
      continue;
    }
    out[k] = v === undefined || v === "" ? null : v;
  }
  return out;
}

/**
 * Count how many constraints are non-null on a position row.
 * Used to render the "X constraints set" hint on the position list.
 *
 * W11.8 / mig 454: the boolean `instance_unique_constraint` only counts as
 * "set" when TRUE — its default (false) is the no-op behaviour and
 * shouldn't bump the constraint counter.
 */
export function constraintCount(row) {
  let n = 0;
  for (const k of CONSTRAINT_KEYS) {
    const v = row?.[k];
    if (k === "instance_unique_constraint") {
      if (v === true) n += 1;
      continue;
    }
    if (v !== undefined && v !== null && v !== "") n += 1;
  }
  return n;
}
