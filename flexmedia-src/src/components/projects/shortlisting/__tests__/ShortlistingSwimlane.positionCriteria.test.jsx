/**
 * W11.6.22c — position_criteria wiring tests.
 *
 * Run: npx vitest run flexmedia-src/src/components/projects/shortlisting/__tests__/ShortlistingSwimlane.positionCriteria.test.jsx
 *
 * Covers the swimlane → lightbox wiring for the Position panel's
 * curated-criteria list (the W11.6.22b panel already renders the data — these
 * tests exercise the data-flow side of the contract).
 *
 *  1. extractSlotIdsForPositionPrefs collects every distinct slot_id from
 *     overrides — both ai_proposed_slot_id (PASS 1) and human_selected_slot_id
 *     (PASS 2 swap cases). Output is sorted + deduped so the TanStack Query
 *     key is stable.
 *  2. extractSlotIdsForPositionPrefs returns [] for empty / null input
 *     (graceful: a round with no overrides → no fetch).
 *  3. buildPositionCriteriaMap turns N rows into an N-entry Map keyed by
 *     `${slot_id}:${position_index}`. Returned objects exclude the row id
 *     and timestamps; preserve the operator-curated criteria fields.
 *  4. buildPositionCriteriaMap skips rows missing slot_id or position_index
 *     (defensive — partial rows shouldn't surface as broken keys).
 *  5. resolvePositionFields returns all-null when slot_id or position_index
 *     is missing — legacy ai_decides path. The lightbox Position panel hides
 *     itself in that case (data-position-index attribute is null).
 *  6. resolvePositionFields surfaces position_label from the criteria's
 *     display_label and strips display_label out of position_criteria so the
 *     label doesn't double-render in the panel's criteria list.
 *  7. resolvePositionFields gracefully handles a missing criteria match
 *     (slot has position_index but no curated row) — emits position_index +
 *     filled_via with criteria=null. Lightbox panel falls back to the bare
 *     position-only render.
 *  8. resolvePositionFields rejects unknown position_filled_via values (e.g.
 *     'legacy_random_pick') — only 'curated_match' / 'ai_backfill' pass
 *     through. The lightbox uses this to colour the badge — anything else
 *     would be a contract violation worth surfacing as null.
 */
import { describe, it, expect, vi } from "vitest";

// Mock the supabase client because importing from ShortlistingSwimlane.jsx
// transitively initialises the createSupabaseClient call at module top —
// without these envs in vitest the import fails with "supabaseUrl is
// required". The pure helpers under test don't touch the client.
vi.mock("@/api/supabaseClient", () => ({
  api: {
    entities: {
      ShortlistingOverride: { filter: vi.fn(async () => []) },
      CompositionGroup: { filter: vi.fn(async () => []) },
      ShortlistingSlotPositionPreference: { filter: vi.fn(async () => []) },
    },
  },
  supabase: {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
                then: (resolve) => resolve({ data: [], error: null }),
              };
            },
          };
        },
      };
    },
  },
}));

vi.mock("@/components/drone/DroneThumbnail", () => ({
  default: function DroneThumbnailStub({ alt }) {
    return <div data-testid="drone-thumb-stub">{alt}</div>;
  },
}));

import {
  extractSlotIdsForPositionPrefs,
  buildPositionCriteriaMap,
  resolvePositionFields,
} from "../ShortlistingSwimlane";

describe("W11.6.22c — extractSlotIdsForPositionPrefs", () => {
  it("collects every distinct slot_id from ai_proposed + human_selected, sorted + deduped", () => {
    const overrides = [
      { human_action: "ai_proposed", ai_proposed_slot_id: "kitchen_hero" },
      { human_action: "ai_proposed", ai_proposed_slot_id: "living_hero" },
      // duplicate slot — should appear once
      { human_action: "ai_proposed", ai_proposed_slot_id: "kitchen_hero" },
      // swap case — human_selected_slot_id contributes
      {
        human_action: "swapped",
        ai_proposed_slot_id: "kitchen_hero",
        human_selected_slot_id: "kitchen_alt",
      },
      // null slot — skipped
      { human_action: "removed", ai_proposed_slot_id: null, human_selected_slot_id: null },
    ];
    const out = extractSlotIdsForPositionPrefs(overrides);
    expect(out).toEqual(["kitchen_alt", "kitchen_hero", "living_hero"]);
  });

  it("returns [] for empty / null / undefined input (graceful — no fetch)", () => {
    expect(extractSlotIdsForPositionPrefs([])).toEqual([]);
    expect(extractSlotIdsForPositionPrefs(null)).toEqual([]);
    expect(extractSlotIdsForPositionPrefs(undefined)).toEqual([]);
  });
});

describe("W11.6.22c — buildPositionCriteriaMap", () => {
  it("turns N rows into an N-entry Map keyed by slot_id:position_index, preserving criteria", () => {
    const rows = [
      {
        id: "uuid-1",
        slot_id: "kitchen_hero",
        position_index: 1,
        display_label: "Primary Hero",
        preferred_composition_type: "hero_wide",
        preferred_zone_focus: "kitchen_island",
        preferred_space_type: null,
        preferred_lighting_state: "natural_bright",
        preferred_image_type: null,
        preferred_signal_emphasis: ["composition_strength", "natural_light"],
        is_required: true,
        ai_backfill_on_gap: true,
        created_at: "2026-04-01T00:00:00Z",
      },
      {
        id: "uuid-2",
        slot_id: "kitchen_hero",
        position_index: 2,
        display_label: "Detail Shot",
        preferred_composition_type: "macro_detail",
        preferred_zone_focus: null,
        preferred_space_type: null,
        preferred_lighting_state: null,
        preferred_image_type: null,
        preferred_signal_emphasis: [],
        is_required: false,
        ai_backfill_on_gap: false,
      },
    ];
    const m = buildPositionCriteriaMap(rows);
    expect(m.size).toBe(2);
    const k1 = m.get("kitchen_hero:1");
    expect(k1).toBeDefined();
    expect(k1.display_label).toBe("Primary Hero");
    expect(k1.preferred_composition_type).toBe("hero_wide");
    expect(k1.preferred_signal_emphasis).toEqual([
      "composition_strength",
      "natural_light",
    ]);
    expect(k1.is_required).toBe(true);
    // row metadata (id, created_at) NOT carried through — keeps the lightbox
    // panel free of plumbing it doesn't render.
    expect(k1.id).toBeUndefined();
    expect(k1.created_at).toBeUndefined();
    const k2 = m.get("kitchen_hero:2");
    expect(k2).toBeDefined();
    expect(k2.display_label).toBe("Detail Shot");
    expect(k2.ai_backfill_on_gap).toBe(false);
  });

  it("skips rows missing slot_id or position_index (defensive)", () => {
    const rows = [
      { slot_id: null, position_index: 1, display_label: "Bad row 1" },
      { slot_id: "kitchen_hero", position_index: null, display_label: "Bad row 2" },
      { slot_id: "kitchen_hero", position_index: 1, display_label: "Good row" },
    ];
    const m = buildPositionCriteriaMap(rows);
    expect(m.size).toBe(1);
    expect(m.get("kitchen_hero:1").display_label).toBe("Good row");
  });

  it("returns empty Map for null / [] / non-array input (graceful)", () => {
    expect(buildPositionCriteriaMap([]).size).toBe(0);
    expect(buildPositionCriteriaMap(null).size).toBe(0);
    expect(buildPositionCriteriaMap(undefined).size).toBe(0);
  });
});

describe("W11.6.22c — resolvePositionFields", () => {
  it("returns all-null when slot_id or position_index is missing (legacy ai_decides)", () => {
    const m = new Map();
    const out = resolvePositionFields(m, null, null, null);
    expect(out).toEqual({
      position_index: null,
      position_filled_via: null,
      position_label: null,
      position_criteria: null,
    });
    // partial inputs also fall through to null
    const out2 = resolvePositionFields(m, "kitchen_hero", null, "curated_match");
    expect(out2.position_index).toBeNull();
    expect(out2.position_criteria).toBeNull();
  });

  it("hoists display_label → position_label and strips it from position_criteria (no double-render)", () => {
    const m = buildPositionCriteriaMap([
      {
        slot_id: "kitchen_hero",
        position_index: 1,
        display_label: "Primary Hero",
        preferred_composition_type: "hero_wide",
        preferred_zone_focus: "kitchen_island",
        preferred_signal_emphasis: ["composition_strength"],
        is_required: true,
        ai_backfill_on_gap: true,
      },
    ]);
    const out = resolvePositionFields(m, "kitchen_hero", 1, "curated_match");
    expect(out.position_index).toBe(1);
    expect(out.position_filled_via).toBe("curated_match");
    expect(out.position_label).toBe("Primary Hero");
    // criteria payload exists but display_label is no longer in it (lightbox
    // already renders the heading "Position 1 — Primary Hero" elsewhere).
    expect(out.position_criteria).toBeDefined();
    expect(out.position_criteria.display_label).toBeUndefined();
    expect(out.position_criteria.preferred_composition_type).toBe("hero_wide");
    expect(out.position_criteria.preferred_zone_focus).toBe("kitchen_island");
  });

  it("returns position_index + filled_via with criteria=null when slot has position_index but no curated row (graceful)", () => {
    // ai_backfill case where Stage 4 wrote position_index but the operator
    // never curated a row for that slot+index pair (legacy round, partial
    // curation). The panel falls back to the bare position-only render.
    const m = new Map(); // empty map → no criteria lookup hit
    const out = resolvePositionFields(m, "kitchen_hero", 3, "ai_backfill");
    expect(out.position_index).toBe(3);
    expect(out.position_filled_via).toBe("ai_backfill");
    expect(out.position_label).toBeNull();
    expect(out.position_criteria).toBeNull();
  });

  it("rejects unknown position_filled_via values (only curated_match / ai_backfill pass)", () => {
    const m = buildPositionCriteriaMap([
      {
        slot_id: "kitchen_hero",
        position_index: 1,
        display_label: "Hero",
        preferred_signal_emphasis: [],
      },
    ]);
    const out = resolvePositionFields(m, "kitchen_hero", 1, "legacy_random_pick");
    expect(out.position_filled_via).toBeNull();
    // criteria still resolves — only the filled_via gate is strict.
    expect(out.position_criteria).toBeDefined();
  });
});
