/**
 * TaxonomyExplorerTab — vitest suite (W11.6.26 / mig 441 + 448 + 451
 * extensions).
 *
 * Coverage:
 *   1. Renders without throwing when fed mock RPC responses.
 *   2. Shows the tab heading, both mode triggers, and the H-A panel by default.
 *   3. Renders the H-B panel when the user switches mode + exposes legacy
 *      axes inside a collapsible (closed by default).
 *   4. (mig 441) Hierarchy A detail panel renders the source-attribution
 *      observation rows + filter chips when a node is selected.
 *   5. (mig 441) The legacy-axes collapsible opens on click and reveals the
 *      room_type axis card.
 *   6. (mig 448) All primary axes render alongside C1's 3 new axes
 *      (shot_scale, perspective_compression, orientation).
 *   7. (mig 451 — S1 / W11.6.29) PRIMARY axes count = 8: image_type,
 *      space_type, shot_scale, zone_focus, vantage_position,
 *      composition_geometry, perspective_compression, orientation. The
 *      legacy section now contains BOTH room_type AND composition_type
 *      (composition_type was decomposed into vantage_position +
 *      composition_geometry).
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const TREE_NODES = [
  {
    canonical_id: "obj_kitchen_island_stone",
    display_name: "Kitchen island (stone)",
    description: "Stone-topped kitchen island",
    level_0_class: "kitchen",
    level_1_functional: "island",
    level_2_material: "stone",
    level_3_specific: "waterfall",
    level_4_detail: null,
    aliases: ["island_waterfall_stone"],
    market_frequency: 12,
    signal_room_type: "kitchen_main",
    signal_confidence: 0.9,
    status: "active",
    last_observed_at: "2026-05-01T10:00:00Z",
  },
  {
    canonical_id: "obj_bed_four_poster_timber",
    display_name: "Four-poster timber bed",
    description: null,
    level_0_class: "bedroom",
    level_1_functional: "bed",
    level_2_material: "timber",
    level_3_specific: "four_poster",
    level_4_detail: null,
    aliases: [],
    market_frequency: 7,
    signal_room_type: "master_bedroom",
    signal_confidence: 0.92,
    status: "active",
    last_observed_at: "2026-05-01T10:00:00Z",
  },
];

const ATTRIBUTED_OBSERVATIONS = [
  {
    composition_classification_id: "cc-1",
    group_id: "g-1",
    round_id: "r-1",
    project_id: "p-aaa",
    project_name: "13 Saladine Ave, Punchbowl",
    project_url: "/ProjectDetails?id=p-aaa",
    image_filename: "IMG_6090",
    image_dropbox_path: "/path/preview.jpg",
    source_type: "internal_raw",
    attribution_source: "internal_raw",
    image_type: "is_day",
    pulse_listing_id: null,
    pulse_listing_url: null,
    pulse_listing_address: null,
    classified_at: "2026-05-01T10:00:00Z",
  },
  {
    composition_classification_id: "cc-2",
    group_id: null,
    round_id: null,
    project_id: null,
    project_name: null,
    project_url: null,
    image_filename: "https://cdn.example/external.jpg",
    image_dropbox_path: null,
    source_type: "external_listing",
    attribution_source: "pulse_listing",
    image_type: "is_day",
    pulse_listing_id: "pl-bbb",
    pulse_listing_url: "/PulseListingDetail?id=pl-bbb",
    pulse_listing_address: "1 Test St, Sydney",
    classified_at: "2026-04-30T10:00:00Z",
  },
];

const AXIS_DIST = {
  space_type: [
    { value: "master_bedroom", n_compositions: 248, pct: 31.4 },
    { value: "kitchen_dedicated", n_compositions: 184, pct: 23.3 },
  ],
  zone_focus: [
    { value: "bed_focal", n_compositions: 200, pct: 40.0 },
  ],
  image_type: [
    { value: "is_day", n_compositions: 1247, pct: 80.0 },
  ],
  room_type: [
    { value: "kitchen_main", n_compositions: 99, pct: 30.0 },
  ],
  composition_type: [
    { value: "wide_angle", n_compositions: 50, pct: 50.0 },
  ],
  // mig 448 — new axes from C1's mig 442. No production data yet, so the live
  // RPC returns empty arrays. We mirror that here.
  shot_scale: [],
  perspective_compression: [],
  orientation: [],
  // mig 451 — S1's decomposed composition axes. Empty by design at first,
  // gets populated by Stage 1 vision once the schema bumps to v2.6.
  vantage_position: [],
  composition_geometry: [],
};

vi.mock("@/api/supabaseClient", () => {
  return {
    api: {
      auth: { me: vi.fn(async () => ({ id: "u1", role: "master_admin" })) },
      rpc: vi.fn(async (name, params) => {
        if (name === "taxonomy_a_tree") {
          return { total_rows: TREE_NODES.length, nodes: TREE_NODES };
        }
        if (name === "taxonomy_a_node_detail") {
          return {
            found: true,
            node: TREE_NODES[0],
            observation_count: ATTRIBUTED_OBSERVATIONS.length,
            observations: ATTRIBUTED_OBSERVATIONS,
            eligible_slots: ["kitchen_hero"],
          };
        }
        if (name === "taxonomy_b_axis_distribution") {
          return AXIS_DIST[params?.p_axis] || [];
        }
        if (name === "taxonomy_b_value_detail") {
          return {
            axis: params?.p_axis,
            value: params?.p_value,
            n_compositions: 248,
            samples: ATTRIBUTED_OBSERVATIONS,
            eligible_slots: ["master_bedroom_hero"],
          };
        }
        if (name === "taxonomy_observation_filters") {
          return {
            source_types: [
              "internal_raw",
              "internal_finals",
              "external_listing",
              "pulse_listing",
              "floorplan_image",
            ],
            n_per_source_total: { internal_raw: 47, pulse_listing: 1247 },
          };
        }
        return null;
      }),
    },
    supabase: { from: () => ({ select: () => ({}) }) },
  };
});

import TaxonomyExplorerTab from "../TaxonomyExplorerTab";

function mount() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <TaxonomyExplorerTab />
    </QueryClientProvider>,
  );
}

describe("TaxonomyExplorerTab — W11.6.26 + mig 441", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mounts without throwing and renders the tab heading", async () => {
    expect(() => mount()).not.toThrow();
    await waitFor(() => {
      expect(screen.getByTestId("taxonomy-explorer-tab")).toBeTruthy();
    });
    expect(screen.getByText(/Taxonomy Explorer/i)).toBeTruthy();
  });

  it("shows both mode triggers and renders the H-A panel by default", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("taxonomy-mode-a")).toBeTruthy();
      expect(screen.getByTestId("taxonomy-mode-b")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByTestId("taxonomy-a-search")).toBeTruthy();
    });
  });

  it("exposes the Hierarchy B mode trigger so users can switch", async () => {
    mount();
    await waitFor(() => {
      const bTrigger = screen.getByTestId("taxonomy-mode-b");
      expect(bTrigger).toBeTruthy();
      expect(bTrigger.textContent).toContain("Hierarchy B");
    });
  });

  // ─── mig 441: source attribution + legacy collapsible ──────────────────────

  it("renders source-attributed observation rows when a Hierarchy A node is selected", async () => {
    mount();
    // Wait for the tree to render then click on the kitchen node leaf.
    await waitFor(() => {
      expect(screen.getByTestId("taxonomy-a-search")).toBeTruthy();
    });

    // The tree may or may not show a clickable item at top level depending on
    // the HierarchyATree implementation. Force-select by typing the canonical_id
    // into the search and then clicking — but a more direct way is to dispatch
    // a click on a leaf when present. We assert on the panel behaviour by
    // selecting via the search hit + click. If the leaf is not addressable,
    // we skip — the assertion below just verifies the panel exists once a
    // node is selected.
    //
    // Direct path: any node with canonical_id "obj_kitchen_island_stone" will
    // surface as a leaf row inside the tree once filtered.
    const searchInput = screen.getByTestId("taxonomy-a-search");
    fireEvent.change(searchInput, {
      target: { value: "kitchen_island_stone" },
    });

    // Find a leaf-row anchor — HierarchyATree renders leaf nodes as buttons or
    // div role=button with data-testid prefix. We look for the canonical_id
    // text and click its closest interactive ancestor.
    let leaf;
    await waitFor(() => {
      leaf = screen.queryByText(/obj_kitchen_island_stone/i);
      expect(leaf).toBeTruthy();
    });
    fireEvent.click(leaf);

    // Once a node is selected, the detail panel + ObservationsPanel should
    // render attribution chips and at least one row.
    await waitFor(() => {
      // Chip strip is rendered with data-testid="<id>-chips".
      expect(
        screen.getByTestId("taxonomy-a-observations-chips"),
      ).toBeTruthy();
    });

    // Expected chips: internal_raw + pulse_listing chips with counts.
    expect(
      screen.getByTestId("taxonomy-a-observations-chip-internal_raw"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("taxonomy-a-observations-chip-pulse_listing"),
    ).toBeTruthy();

    // Project link for the internal_raw row should be present.
    const projectLinks = screen.getAllByTestId("obs-row-project-link");
    expect(projectLinks.length).toBeGreaterThan(0);
    expect(projectLinks[0].getAttribute("href")).toContain(
      "/ProjectDetails?id=p-aaa",
    );

    // Pulse link for the external_listing+pulse_listing_id row.
    const pulseLinks = screen.getAllByTestId("obs-row-pulse-link");
    expect(pulseLinks.length).toBeGreaterThan(0);
    expect(pulseLinks[0].getAttribute("href")).toContain(
      "/PulseListingDetail?id=pl-bbb",
    );
  });

  it("Hierarchy B legacy axes section is closed by default and opens on click", async () => {
    mount();
    // Switch to Hierarchy B mode first via userEvent (radix Tabs requires
    // pointer-event-style interaction; fireEvent.click doesn't trip the
    // radix state machine reliably in jsdom).
    const bTrigger = await screen.findByTestId("taxonomy-mode-b");
    await userEvent.click(bTrigger);

    // Legacy section should render in closed state — toggle attribute is
    // data-open="false" and content is NOT in the DOM.
    const toggle = await screen.findByTestId("taxonomy-b-legacy-toggle");
    expect(toggle.getAttribute("data-open")).toBe("false");
    expect(screen.queryByTestId("taxonomy-b-legacy-content")).toBeFalsy();

    // The room_type axis card is NOT rendered while collapsed.
    expect(screen.queryByTestId("taxonomy-b-axis-room_type")).toBeFalsy();

    // Click to open.
    await userEvent.click(toggle);

    await waitFor(() => {
      expect(toggle.getAttribute("data-open")).toBe("true");
      expect(screen.getByTestId("taxonomy-b-legacy-content")).toBeTruthy();
      expect(screen.getByTestId("taxonomy-b-axis-room_type")).toBeTruthy();
    });
  });

  it("Hierarchy B primary axes do NOT include room_type or composition_type (mig 441/451 demoted them)", async () => {
    mount();
    const bTrigger = await screen.findByTestId("taxonomy-mode-b");
    await userEvent.click(bTrigger);

    // Wait for primary axes to render — including the two new mig-451 axes.
    await waitFor(() => {
      expect(screen.getByTestId("taxonomy-b-axis-image_type")).toBeTruthy();
      expect(screen.getByTestId("taxonomy-b-axis-space_type")).toBeTruthy();
      expect(screen.getByTestId("taxonomy-b-axis-zone_focus")).toBeTruthy();
      expect(
        screen.getByTestId("taxonomy-b-axis-vantage_position"),
      ).toBeTruthy();
      expect(
        screen.getByTestId("taxonomy-b-axis-composition_geometry"),
      ).toBeTruthy();
    });

    // room_type AND composition_type stay hidden (legacy section closed).
    expect(screen.queryByTestId("taxonomy-b-axis-room_type")).toBeFalsy();
    expect(screen.queryByTestId("taxonomy-b-axis-composition_type")).toBeFalsy();
  });

  // ─── mig 448: shot_scale + perspective_compression + orientation ──────────

  it("registers all 8 primary axes (mig 448 + mig 451 follow-ups)", async () => {
    mount();
    const bTrigger = await screen.findByTestId("taxonomy-mode-b");
    await userEvent.click(bTrigger);

    // 4 original axes + 3 new from mig 442 (C1) + 2 new from mig 451 (S1)
    // = 9. But mig 451 also DEMOTES composition_type to legacy, leaving 8
    // primary cards. All 8 render outside the legacy collapsible.
    await waitFor(() => {
      expect(screen.getByTestId("taxonomy-b-axis-image_type")).toBeTruthy();
      expect(screen.getByTestId("taxonomy-b-axis-space_type")).toBeTruthy();
      expect(screen.getByTestId("taxonomy-b-axis-shot_scale")).toBeTruthy();
      expect(screen.getByTestId("taxonomy-b-axis-zone_focus")).toBeTruthy();
      expect(
        screen.getByTestId("taxonomy-b-axis-vantage_position"),
      ).toBeTruthy();
      expect(
        screen.getByTestId("taxonomy-b-axis-composition_geometry"),
      ).toBeTruthy();
      expect(
        screen.getByTestId("taxonomy-b-axis-perspective_compression"),
      ).toBeTruthy();
      expect(screen.getByTestId("taxonomy-b-axis-orientation")).toBeTruthy();
    });

    // Each primary axis card carries data-legacy="false" so users can tell
    // primary vs legacy at a glance.
    expect(
      screen
        .getByTestId("taxonomy-b-axis-shot_scale")
        .getAttribute("data-legacy"),
    ).toBe("false");
    expect(
      screen
        .getByTestId("taxonomy-b-axis-perspective_compression")
        .getAttribute("data-legacy"),
    ).toBe("false");
    expect(
      screen
        .getByTestId("taxonomy-b-axis-orientation")
        .getAttribute("data-legacy"),
    ).toBe("false");
    expect(
      screen
        .getByTestId("taxonomy-b-axis-vantage_position")
        .getAttribute("data-legacy"),
    ).toBe("false");
    expect(
      screen
        .getByTestId("taxonomy-b-axis-composition_geometry")
        .getAttribute("data-legacy"),
    ).toBe("false");

    // The new axes have no production data yet — assert the empty-state
    // copy renders inside the new mig-451 cards.
    const vantageCard = screen.getByTestId("taxonomy-b-axis-vantage_position");
    expect(vantageCard.textContent).toMatch(
      /No classifications carry this axis yet/i,
    );
    const geometryCard = screen.getByTestId(
      "taxonomy-b-axis-composition_geometry",
    );
    expect(geometryCard.textContent).toMatch(
      /No classifications carry this axis yet/i,
    );

    // room_type AND composition_type still hidden (must NOT appear as
    // primary axes — both are in the legacy section now).
    expect(screen.queryByTestId("taxonomy-b-axis-room_type")).toBeFalsy();
    expect(screen.queryByTestId("taxonomy-b-axis-composition_type")).toBeFalsy();
  });

  // ── mig 451 (S1 / W11.6.29) — composition_type demoted to legacy ─────────
  it("Legacy section now contains BOTH room_type AND composition_type", async () => {
    mount();
    const bTrigger = await screen.findByTestId("taxonomy-mode-b");
    await userEvent.click(bTrigger);

    // Open the legacy collapsible.
    const toggle = await screen.findByTestId("taxonomy-b-legacy-toggle");
    await userEvent.click(toggle);

    await waitFor(() => {
      expect(toggle.getAttribute("data-open")).toBe("true");
      // Both legacy axes render INSIDE the legacy section.
      expect(screen.getByTestId("taxonomy-b-axis-room_type")).toBeTruthy();
      expect(
        screen.getByTestId("taxonomy-b-axis-composition_type"),
      ).toBeTruthy();
    });

    // Both legacy axis cards are flagged data-legacy="true".
    expect(
      screen
        .getByTestId("taxonomy-b-axis-room_type")
        .getAttribute("data-legacy"),
    ).toBe("true");
    expect(
      screen
        .getByTestId("taxonomy-b-axis-composition_type")
        .getAttribute("data-legacy"),
    ).toBe("true");
  });
});
