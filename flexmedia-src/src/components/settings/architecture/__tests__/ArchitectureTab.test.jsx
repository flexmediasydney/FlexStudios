/**
 * ArchitectureTab — vitest suite (Wave 11.6.23).
 *
 * Coverage:
 *   1. ArchitectureTab renders without crash on empty RPC data
 *   2. HierarchyDiagram renders all expected nodes
 *   3. countToText / colourClassFor / aggregateStats / badgeClassFor /
 *      suggestionLabel pure helpers
 *   4. Clicking a hierarchy node opens the drawer (mock fixture)
 *   5. Coverage matrix renders one row per slot, one column per round
 *   6. Coverage matrix cell colour states reflect fixture data
 *   7. Aggregate stats string renders from fixture
 *   8. Heuristic suggestions render and the Approve button links to
 *      AI Suggestions tab
 *   9. RPC mock returns expected shape; component handles loading/error
 *  10. Empty states (no rounds, no slots, no heuristics)
 *  11. Export-as-PNG button is wired (smoke test)
 *  12. Reactive suggestion link points at the right tab
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ── Mocks ─────────────────────────────────────────────────────────────────

vi.mock("@/api/supabaseClient", () => ({
  api: {
    rpc: vi.fn(),
  },
}));

vi.mock("@/components/ui/sheet", async () => {
  // Lightweight Sheet mock — keep accessibility behaviour by toggling
  // visibility on `open`. The radix-ui sheet portal-renders, which makes
  // jsdom assertions brittle, so we render inline instead.
  const React = await import("react");
  const Sheet = ({ open, children }) =>
    open ? React.createElement("div", { role: "dialog" }, children) : null;
  const Pass = ({ children, ...rest }) =>
    React.createElement("div", rest, children);
  return {
    Sheet,
    SheetContent: Pass,
    SheetHeader: Pass,
    SheetTitle: Pass,
    SheetDescription: Pass,
    SheetTrigger: Pass,
  };
});

import ArchitectureTab from "../ArchitectureTab";
import HierarchyDiagram, {
  buildNodes,
  buildEdges,
  countToText,
} from "../HierarchyDiagram";
import SlotCoverageMatrix, {
  colourClassFor,
  aggregateStats,
} from "../SlotCoverageMatrix";
import HeuristicSuggestions, {
  badgeClassFor,
  suggestionLabel,
} from "../HeuristicSuggestions";

const FIXTURE = Object.freeze({
  project_count: 126,
  products_count: 28,
  engine_role_distribution: {
    photo_day_shortlist: 2,
    video_day_shortlist: 9,
    drone_shortlist: 1,
  },
  slot_count_total: 12,
  slot_count_active: 12,
  slot_count_by_phase: { 1: 4, 2: 8 },
  slot_count_by_selection_mode: { ai_decides: 12 },
  round_count_30d: 4,
  composition_count: 148,
  composition_group_count: 143,
  raw_observation_count: 594,
  object_registry_size: 191,
  attribute_value_count: 0,
  slot_suggestion_pending_count: 2,
  room_type_distribution: [
    { room_type: "kitchen_main", n: 16 },
    { room_type: "living_room", n: 19 },
  ],
  space_type_distribution: [{ space_type: "unset", n: 148 }],
  zone_focus_distribution: [{ zone_focus: "unset", n: 148 }],
  image_type_distribution: [{ image_type: "is_day", n: 36 }],
  slot_coverage_matrix: [
    {
      slot_id: "kitchen_hero",
      phase: 1,
      rounds: [
        {
          round_id: "r1",
          fill_state: "green",
          filled_count: 1,
          backfill_count: 0,
          min_required: 1,
        },
        {
          round_id: "r2",
          fill_state: "red",
          filled_count: 0,
          backfill_count: 0,
          min_required: 1,
        },
      ],
    },
    {
      slot_id: "exterior_front_hero",
      phase: 1,
      rounds: [
        {
          round_id: "r1",
          fill_state: "amber",
          filled_count: 1,
          backfill_count: 1,
          min_required: 1,
        },
        {
          round_id: "r2",
          fill_state: "grey",
          filled_count: 0,
          backfill_count: 0,
          min_required: 1,
        },
      ],
    },
  ],
  coverage_aggregate_stats: {
    total_cells: 4,
    filled_cells: 2,
    pct_filled: 50.0,
    red_round_count: 1,
    zero_fill_slot_count: 0,
  },
  heuristic_slot_suggestions: [
    {
      type: "deletion_candidate",
      slot_id: "ensuite_hero",
      rounds_empty: 4,
      rounds_total: 4,
      rationale:
        "Slot ensuite_hero was empty in 4 of 4 rounds (100%). Consider retiring or relaxing eligibility filters.",
    },
    {
      type: "split",
      slot_id: "bedroom_secondary",
      avg_fill_count: 2.5,
      peak_fill: 3,
      max_allowed: 2,
      evidence_round_count: 4,
      rationale: "Slot bedroom_secondary averaged 2.5 …",
    },
    {
      type: "new_slot_needed",
      zone_focus: "pool_close_up",
      evidence_round_count: 3,
      rationale: "zone_focus=pool_close_up appeared in 3 rounds …",
    },
  ],
  window_days: 30,
  computed_at: "2026-05-02T00:00:00Z",
});

function withProviders(node) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

// ── 1. Pure helpers ────────────────────────────────────────────────────────

describe("HierarchyDiagram pure helpers", () => {
  it("countToText handles standard cases + nullables", () => {
    expect(countToText(0)).toBe("0 rows");
    expect(countToText(1247)).toBe("1,247 rows");
    expect(countToText(null)).toBe("0 rows");
    expect(countToText(undefined)).toBe("0 rows");
    expect(countToText("not a number")).toBe("0 rows");
  });

  it("buildNodes returns one node per layer + projects count flows through", () => {
    const nodes = buildNodes(FIXTURE);
    const ids = nodes.map((n) => n.id);
    expect(ids).toContain("project");
    expect(ids).toContain("products");
    expect(ids).toContain("engine_roles");
    expect(ids).toContain("slots");
    expect(ids).toContain("compositions");
    expect(ids).toContain("rounds");
    expect(ids).toContain("object_registry");
    const proj = nodes.find((n) => n.id === "project");
    expect(proj.count).toBe(126);
  });

  it("buildNodes degrades gracefully on empty data", () => {
    const nodes = buildNodes({});
    for (const n of nodes) {
      expect(typeof n.count).toBe("number");
      expect(n.count).toBeGreaterThanOrEqual(0);
    }
  });

  it("buildEdges has correct topology: project→products→engine_roles→slots", () => {
    const edges = buildEdges();
    const flat = edges.map((e) => `${e.from}→${e.to}`);
    expect(flat).toContain("project→products");
    expect(flat).toContain("products→engine_roles");
    expect(flat).toContain("engine_roles→slots");
    expect(flat).toContain("slots→compositions");
    expect(flat).toContain("compositions→object_registry");
  });
});

describe("SlotCoverageMatrix pure helpers", () => {
  it("colourClassFor returns distinct classes for each state", () => {
    const states = ["green", "amber", "red", "grey"];
    const classes = states.map(colourClassFor);
    expect(new Set(classes).size).toBe(states.length);
    expect(colourClassFor("unknown")).toBe(colourClassFor("grey")); // default
  });

  it("aggregateStats computes pctFilled / redRoundCount / zeroFillSlotCount", () => {
    const result = aggregateStats(FIXTURE.slot_coverage_matrix);
    expect(result.totalCells).toBe(4);
    expect(result.filledCells).toBe(2);
    expect(result.pctFilled).toBe(50.0);
    expect(result.redRoundCount).toBe(1);
    expect(result.zeroFillSlotCount).toBe(0);
  });

  it("aggregateStats degrades on empty / non-array input", () => {
    expect(aggregateStats([]).totalCells).toBe(0);
    expect(aggregateStats(null).totalCells).toBe(0);
    expect(aggregateStats(undefined).totalCells).toBe(0);
    expect(aggregateStats({}).totalCells).toBe(0);
  });

  it("aggregateStats counts a slot as zero-fill when nothing is green/amber", () => {
    const allRed = [
      {
        slot_id: "x",
        phase: 1,
        rounds: [
          { round_id: "r1", fill_state: "red", filled_count: 0 },
          { round_id: "r2", fill_state: "red", filled_count: 0 },
        ],
      },
    ];
    expect(aggregateStats(allRed).zeroFillSlotCount).toBe(1);
  });
});

describe("HeuristicSuggestions pure helpers", () => {
  it("badgeClassFor returns distinct classes per type", () => {
    const types = ["split", "deletion_candidate", "new_slot_needed"];
    const classes = types.map(badgeClassFor);
    expect(new Set(classes).size).toBe(types.length);
  });

  it("suggestionLabel returns user-facing labels", () => {
    expect(suggestionLabel("split")).toBe("Split slot");
    expect(suggestionLabel("deletion_candidate")).toBe("Deletion candidate");
    expect(suggestionLabel("new_slot_needed")).toBe("New slot needed");
    expect(suggestionLabel(undefined)).toMatch(/Suggestion/i);
  });
});

// ── 2. Component renders ───────────────────────────────────────────────────

describe("ArchitectureTab — render", () => {
  beforeEach(async () => {
    const { api } = await import("@/api/supabaseClient");
    api.rpc.mockReset();
    api.rpc.mockResolvedValue(FIXTURE);
  });

  it("renders without crashing on empty data", async () => {
    const { api } = await import("@/api/supabaseClient");
    api.rpc.mockResolvedValueOnce({});
    withProviders(<ArchitectureTab />);
    expect(screen.getByTestId("architecture-tab")).toBeTruthy();
    expect(screen.getByTestId("hierarchy-diagram")).toBeTruthy();
    expect(screen.getByTestId("slot-coverage-matrix")).toBeTruthy();
    expect(screen.getByTestId("heuristic-suggestions")).toBeTruthy();
  });

  it("renders all hierarchy nodes from a populated fixture", () => {
    withProviders(<HierarchyDiagram data={FIXTURE} loading={false} />);
    expect(screen.getByTestId("node-project")).toBeTruthy();
    expect(screen.getByTestId("node-products")).toBeTruthy();
    expect(screen.getByTestId("node-engine_roles")).toBeTruthy();
    expect(screen.getByTestId("node-slots")).toBeTruthy();
    expect(screen.getByTestId("node-compositions")).toBeTruthy();
    expect(screen.getByTestId("node-rounds")).toBeTruthy();
    expect(screen.getByTestId("node-object_registry")).toBeTruthy();
    // Counts visible.
    expect(screen.getByTestId("node-project-count").textContent).toContain(
      "126",
    );
    expect(
      screen.getByTestId("node-object_registry-count").textContent,
    ).toContain("191");
  });

  it("clicking a hierarchy node opens the drawer with correct content", () => {
    withProviders(<HierarchyDiagram data={FIXTURE} loading={false} />);
    fireEvent.click(screen.getByTestId("node-engine_roles"));
    // Sheet now visible (mocked dialog).
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(
      screen.getByTestId("drawer-count-engine_roles").textContent,
    ).toContain("3"); // three engine_role distribution keys
  });

  it("export-as-PNG button is wired (smoke test — does not crash)", () => {
    withProviders(<HierarchyDiagram data={FIXTURE} loading={false} />);
    const btn = screen.getByTestId("hierarchy-export-png");
    expect(btn).toBeTruthy();
    // We don't actually trigger html2canvas in jsdom — just verify no crash
    // when clicking.
    expect(() => fireEvent.click(btn)).not.toThrow();
  });

  it("coverage matrix renders one row per slot and one column per distinct round", () => {
    withProviders(<SlotCoverageMatrix data={FIXTURE} loading={false} />);
    expect(screen.getByTestId("row-kitchen_hero")).toBeTruthy();
    expect(screen.getByTestId("row-exterior_front_hero")).toBeTruthy();
    // Two slots × two rounds = 4 cells in the matrix.
    expect(screen.getByTestId("cell-kitchen_hero-r1")).toBeTruthy();
    expect(screen.getByTestId("cell-kitchen_hero-r2")).toBeTruthy();
    expect(screen.getByTestId("cell-exterior_front_hero-r1")).toBeTruthy();
    expect(screen.getByTestId("cell-exterior_front_hero-r2")).toBeTruthy();
  });

  it("coverage matrix cells use the correct colour class per fill state", () => {
    withProviders(<SlotCoverageMatrix data={FIXTURE} loading={false} />);
    const greenBtn = screen.getByTestId("cell-button-kitchen_hero-r1");
    const redBtn = screen.getByTestId("cell-button-kitchen_hero-r2");
    const amberBtn = screen.getByTestId("cell-button-exterior_front_hero-r1");
    const greyBtn = screen.getByTestId("cell-button-exterior_front_hero-r2");
    expect(greenBtn.className).toContain("emerald");
    expect(redBtn.className).toContain("rose");
    expect(amberBtn.className).toContain("amber");
    expect(greyBtn.className).toContain("slate");
  });

  it("aggregate stats line renders from server-side fixture", () => {
    withProviders(<SlotCoverageMatrix data={FIXTURE} loading={false} />);
    const line = screen.getByTestId("coverage-aggregate-stats");
    expect(line.textContent).toContain("50");
    expect(line.textContent).toContain("4 mandatory cells");
    expect(line.textContent).toContain("1 rounds with 1+ red");
  });

  it("clicking a coverage cell opens the drawer with that cell's detail", () => {
    withProviders(<SlotCoverageMatrix data={FIXTURE} loading={false} />);
    fireEvent.click(screen.getByTestId("cell-button-kitchen_hero-r2"));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("heuristic suggestions render with badge + rationale", () => {
    withProviders(<HeuristicSuggestions data={FIXTURE} loading={false} />);
    expect(
      screen.getByTestId("heuristic-deletion_candidate-ensuite_hero"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("heuristic-split-bedroom_secondary"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("heuristic-new_slot_needed-pool_close_up"),
    ).toBeTruthy();
  });

  it("heuristic Approve buttons link to the AI Suggestions tab", () => {
    withProviders(<HeuristicSuggestions data={FIXTURE} loading={false} />);
    const link = screen.getByTestId("heuristic-approve-ensuite_hero");
    // Anchor is rendered inside the Button asChild. Its `href` should
    // point at the umbrella's suggestions tab.
    const anchor = link.querySelector("a") || link;
    expect(anchor.getAttribute("href")).toBe(
      "/SettingsShortlistingCommandCenter?tab=suggestions",
    );
  });

  it("reactive suggestion count link points at suggestions tab", () => {
    withProviders(<HeuristicSuggestions data={FIXTURE} loading={false} />);
    const link = screen.getByTestId("link-suggestions-tab");
    expect(link.getAttribute("href")).toBe(
      "/SettingsShortlistingCommandCenter?tab=suggestions",
    );
  });

  it("empty heuristic state renders gracefully when no suggestions", () => {
    const empty = { ...FIXTURE, heuristic_slot_suggestions: [] };
    withProviders(<HeuristicSuggestions data={empty} loading={false} />);
    expect(screen.getByTestId("heuristic-empty")).toBeTruthy();
  });

  it("empty coverage matrix renders the 'no slot data' empty state", () => {
    const empty = { ...FIXTURE, slot_coverage_matrix: [] };
    withProviders(<SlotCoverageMatrix data={empty} loading={false} />);
    expect(screen.getByTestId("coverage-empty")).toBeTruthy();
  });

  it("ArchitectureTab handles a thrown error from the RPC without crashing", async () => {
    const { api } = await import("@/api/supabaseClient");
    api.rpc.mockRejectedValueOnce(new Error("boom"));
    withProviders(<ArchitectureTab />);
    // Tab still renders even when the query rejects (error banner appears
    // asynchronously; we just need to confirm the wrapper mounted).
    expect(screen.getByTestId("architecture-tab")).toBeTruthy();
  });
});
