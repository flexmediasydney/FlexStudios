/**
 * swimlaneSlots — frontend mirror of the canonical slot vocabulary.
 *
 * The source of truth lives in
 *   `supabase/functions/_shared/visionPrompts/blocks/slotEnumeration.ts`
 * but that module is Deno-only and can't be imported from the Vite frontend.
 * This file mirrors the closed enum + phase mapping + display labels so the
 * swimlane toolbar can render slot dropdowns / counters without re-querying
 * the database.
 *
 * Drift policy: when slotEnumeration.ts changes, this file MUST be updated
 * in the same commit. The arrays are intentionally ordered the same way so
 * a side-by-side diff is trivial. The closed enum + alias map only changes
 * once or twice per quarter (it's a vocabulary stabiliser by design).
 *
 * The slot list here is identical to CANONICAL_SLOT_IDS in v1.2 of
 * slotEnumeration.ts. If you add a slot there, mirror it here in the same
 * commit and bump CANONICAL_SLOT_IDS_VERSION.
 */

export const CANONICAL_SLOT_IDS_VERSION = "v1.2";

export const CANONICAL_SLOT_IDS = [
  // Phase 1 — lead heroes
  "exterior_facade_hero",
  "kitchen_hero",
  "living_hero",
  "master_bedroom_hero",
  "alfresco_hero",

  // Phase 2 — supporting
  "exterior_rear",
  "kitchen_secondary",
  "dining_hero",
  "bedroom_secondary",
  "bathroom_main",
  "ensuite_hero",
  "entry_hero",
  "study_hero",
  "powder_room",
  "laundry_hero",
  "garage_hero",
  "pool_hero",
  "view_hero",

  // Phase 3 — detail / archive / specials
  "kitchen_detail",
  "bathroom_detail",
  "material_detail",
  "garden_detail",
  "balcony_terrace",
  "games_room",
  "media_room",

  // Phase 3 sentinel — Stage 4 free recommendations.
  "ai_recommended",
];

/** slot_id → 1 | 2 | 3 (phase). Unmapped slot_ids return undefined. */
export const PHASE_OF_SLOT = {
  // Phase 1
  exterior_facade_hero: 1,
  kitchen_hero: 1,
  living_hero: 1,
  master_bedroom_hero: 1,
  alfresco_hero: 1,

  // Phase 2
  exterior_rear: 2,
  kitchen_secondary: 2,
  dining_hero: 2,
  bedroom_secondary: 2,
  bathroom_main: 2,
  ensuite_hero: 2,
  entry_hero: 2,
  study_hero: 2,
  powder_room: 2,
  laundry_hero: 2,
  garage_hero: 2,
  pool_hero: 2,
  view_hero: 2,

  // Phase 3
  kitchen_detail: 3,
  bathroom_detail: 3,
  material_detail: 3,
  garden_detail: 3,
  balcony_terrace: 3,
  games_room: 3,
  media_room: 3,
  ai_recommended: 3,
};

/**
 * Human-readable display names mirrored from slot_definitions.display_name in
 * the DB. Where the DB hasn't yet been seeded, we fall back to a title-cased
 * version of the slot_id (handled at the call site).
 *
 * Keep these short — they appear in dropdown checkboxes and chip labels.
 */
export const SLOT_DISPLAY_NAMES = {
  exterior_facade_hero: "Exterior facade (hero)",
  kitchen_hero: "Kitchen (hero)",
  living_hero: "Living (hero)",
  master_bedroom_hero: "Master bedroom (hero)",
  alfresco_hero: "Alfresco (hero)",

  exterior_rear: "Exterior rear",
  kitchen_secondary: "Kitchen (secondary)",
  dining_hero: "Dining (hero)",
  bedroom_secondary: "Bedroom (secondary)",
  bathroom_main: "Bathroom (main)",
  ensuite_hero: "Ensuite (hero)",
  entry_hero: "Entry (hero)",
  study_hero: "Study (hero)",
  powder_room: "Powder room",
  laundry_hero: "Laundry (hero)",
  garage_hero: "Garage (hero)",
  pool_hero: "Pool (hero)",
  view_hero: "View (hero)",

  kitchen_detail: "Kitchen detail",
  bathroom_detail: "Bathroom detail",
  material_detail: "Material detail",
  garden_detail: "Garden detail",
  balcony_terrace: "Balcony / terrace",
  games_room: "Games room",
  media_room: "Media room",

  ai_recommended: "AI recommended",
};

/**
 * Importance ordering for the `slot_importance` sort. Returns a numeric key
 * such that lower = more important. Phase 1 lead heroes come first in their
 * canonical order, then Phase 2, then Phase 3. Cards with no slot get a
 * sentinel value at the end.
 */
const IMPORTANCE_INDEX = (() => {
  const m = new Map();
  CANONICAL_SLOT_IDS.forEach((slotId, i) => m.set(slotId, i));
  return m;
})();

export function slotImportanceKey(slotId) {
  if (!slotId) return Number.MAX_SAFE_INTEGER;
  const idx = IMPORTANCE_INDEX.get(slotId);
  return typeof idx === "number" ? idx : Number.MAX_SAFE_INTEGER - 1;
}
