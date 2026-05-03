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
