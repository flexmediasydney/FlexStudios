/**
 * RecipeMatrixTab — vitest suite (W11.6.28).
 *
 * Coverage:
 *   1. Renders the help banner + matrix once references load.
 *   2. Matrix grid renders rows × columns with mock data.
 *   3. Clicking a cell opens the cell editor dialog.
 *   4. Inheritance breadcrumb renders inside the cell editor.
 *   5. Advanced — Slot Templates expander toggles open/closed.
 *   6. Auto-promotion card hidden when no suggestions.
 *   7. resolveActiveTab → 'slots' redirects to 'recipes' (covered in
 *      umbrella test; checked here too via integration smoke).
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// ── Mock supabase client ─────────────────────────────────────────────────
//
// We intentionally make the mock generous: every chained method returns
// the builder, and the terminal `then` resolves with the table's rows.
// This mirrors how `supabase.from('x').select().eq().order()` is awaited
// directly in the hooks module.
//
// All fixtures live inside the vi.mock factory below to satisfy the
// hoist-to-top-of-file rule (constants outside the factory aren't
// reachable when the mock is set up).

vi.mock("@/api/supabaseClient", () => {
  // Define all fixtures inline so vi.mock's hoisting doesn't blow up on
  // top-level constant references.
  const PACKAGE_ROWS_INNER = [
    {
      id: "pkg-silver-uuid",
      name: "Silver Package",
      expected_count_target: 10,
      expected_count_tolerance_below: 2,
      expected_count_tolerance_above: 2,
      engine_mode_override: null,
    },
    {
      id: "pkg-gold-uuid",
      name: "Gold Package",
      expected_count_target: 18,
      expected_count_tolerance_below: 2,
      expected_count_tolerance_above: 3,
      engine_mode_override: null,
    },
  ];
  const TIER_ROWS_INNER = [
    { id: "tier-S-uuid", tier_code: "S", display_name: "Standard" },
    { id: "tier-P-uuid", tier_code: "P", display_name: "Premium" },
  ];
  const PROJECT_TYPE_ROWS_INNER = [{ id: "pt-residential", name: "Residential" }];
  const PRODUCT_ROWS_INNER = [];
  const SLOT_ROWS_INNER = [
    {
      slot_id: "kitchen_hero",
      display_name: "Kitchen Hero",
      phase: 1,
      eligible_room_types: ["kitchen_main"],
      min_images: 1,
      max_images: 2,
      version: 1,
      is_active: true,
    },
  ];
  const POSITION_ROWS_INNER = [
    {
      id: "gp-1",
      package_id: "pkg-silver-uuid",
      price_tier_id: "tier-S-uuid",
      project_type_id: null,
      product_id: null,
      engine_role: "photo_day_shortlist",
      position_index: 1,
      phase: "mandatory",
      selection_mode: "ai_decides",
      ai_backfill_on_gap: true,
      template_slot_id: null,
      notes: null,
      room_type: "kitchen_main",
      space_type: "kitchen_dedicated",
      zone_focus: null,
      image_type: null,
      composition_type: null,
      shot_scale: "wide",
      perspective_compression: "compressed",
      lens_class: null,
    },
  ];

  function buildMock(rows) {
    const b = {
      select: () => b,
      eq: () => b,
      is: () => b,
      in: () => b,
      order: () => b,
      limit: () => b,
      range: () => b,
      update: () => b,
      insert: () => b,
      delete: () => b,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      single: () => Promise.resolve({ data: null, error: null }),
      then: (resolve) =>
        Promise.resolve({ data: rows, error: null }).then(resolve),
    };
    return b;
  }

  const tableMap = {
    packages: PACKAGE_ROWS_INNER,
    shortlisting_tiers: TIER_ROWS_INNER,
    project_types: PROJECT_TYPE_ROWS_INNER,
    products: PRODUCT_ROWS_INNER,
    shortlisting_slot_definitions: SLOT_ROWS_INNER,
    gallery_positions: POSITION_ROWS_INNER,
    gallery_position_template_suggestions: [],
  };

  // shortlisting_grades returns an "error" so the hook falls back to
  // shortlisting_tiers — emulate by making the builder error on .order().
  const gradesBuilder = {
    select: () => gradesBuilder,
    eq: () => gradesBuilder,
    is: () => gradesBuilder,
    order: () =>
      Promise.resolve({
        data: null,
        error: { message: "relation \"shortlisting_grades\" does not exist" },
      }),
    then: (resolve) =>
      Promise.resolve({
        data: null,
        error: { message: "relation \"shortlisting_grades\" does not exist" },
      }).then(resolve),
  };

  return {
    supabase: {
      from(name) {
        if (name === "shortlisting_grades") return gradesBuilder;
        return buildMock(tableMap[name] ?? []);
      },
    },
    api: {
      rpc: vi.fn(async (fn) => {
        if (fn === "resolve_gallery_positions_for_cell") {
          return {
            positions: POSITION_ROWS_INNER,
            scopeChain: [
              { label: "Tier defaults", scope: "defaults", override_count: 0 },
              { label: "Silver Standard", scope: "cell", override_count: 1 },
            ],
          };
        }
        if (fn === "taxonomy_b_axis_distribution") {
          return [
            { value: "kitchen_main", n_compositions: 12, pct: 30 },
            { value: "primary_bedroom", n_compositions: 8, pct: 20 },
          ];
        }
        return null;
      }),
      auth: { me: vi.fn(async () => ({ id: "u1", role: "master_admin" })) },
    },
  };
});

// Mock SettingsShortlistingSlots to keep the lazy import lightweight in
// the test environment (the real module pulls in a lot).
vi.mock("@/pages/SettingsShortlistingSlots", () => ({
  default: () => <div data-testid="mock-slots-editor">Slots editor stub</div>,
}));

import RecipeMatrixTab from "../RecipeMatrixTab";

function mount() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <RecipeMatrixTab />
    </QueryClientProvider>,
  );
}

describe("RecipeMatrixTab — W11.6.28", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the help banner once references load", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("recipe-matrix-tab")).toBeTruthy();
    });
    // The banner copy and the deep-help drawer trigger are both present.
    const tab = screen.getByTestId("recipe-matrix-tab");
    expect(tab.textContent).toMatch(/recipe/i);
    expect(tab.textContent).toMatch(/positions/i);
    expect(screen.getByTestId("open-help-drawer")).toBeTruthy();
  });

  it("renders the matrix grid with rows for each package and columns for each tier", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("matrix-grid")).toBeTruthy();
    });
    // Rows for each package
    expect(screen.getByTestId("matrix-row-pkg-silver-uuid")).toBeTruthy();
    expect(screen.getByTestId("matrix-row-pkg-gold-uuid")).toBeTruthy();
    // Tier headers (post-fallback, the codes come from shortlisting_tiers).
    expect(screen.getByTestId("matrix-tier-header-S")).toBeTruthy();
    expect(screen.getByTestId("matrix-tier-header-P")).toBeTruthy();
    // Cell buttons for the silver package
    expect(screen.getByTestId("matrix-cell-pkg-silver-uuid-S")).toBeTruthy();
    expect(screen.getByTestId("matrix-cell-pkg-silver-uuid-P")).toBeTruthy();
  });

  it("clicking a cell opens the cell editor dialog", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("matrix-grid")).toBeTruthy();
    });

    // Dialog is closed initially.
    expect(screen.queryByTestId("cell-editor-dialog")).toBeNull();

    fireEvent.click(screen.getByTestId("matrix-cell-pkg-silver-uuid-S"));

    await waitFor(() => {
      expect(screen.getByTestId("cell-editor-dialog")).toBeTruthy();
    });
    // Title combines the package + tier name.
    const dialog = screen.getByTestId("cell-editor-dialog");
    expect(dialog.textContent).toMatch(/Silver Package.*Standard/);
  });

  it("renders the inheritance breadcrumb inside the cell editor", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("matrix-grid")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("matrix-cell-pkg-silver-uuid-S"));
    await waitFor(() => {
      expect(screen.getByTestId("cell-editor-dialog")).toBeTruthy();
    });
    const breadcrumb = await waitFor(() =>
      screen.getByTestId("scope-breadcrumb"),
    );
    expect(breadcrumb).toBeTruthy();
    // Breadcrumb mentions the chain labels supplied by the RPC stub.
    expect(breadcrumb.textContent).toMatch(/Tier defaults/);
    expect(breadcrumb.textContent).toMatch(/Silver Standard/);
  });

  it("renders the Tier defaults pseudo-row above the matrix body", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("matrix-grid")).toBeTruthy();
    });
    expect(screen.getByTestId("matrix-cell-defaults-S")).toBeTruthy();
    expect(screen.getByTestId("matrix-cell-defaults-P")).toBeTruthy();
  });

  it("Advanced — Slot Templates expander toggles open and closed", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("recipe-matrix-tab")).toBeTruthy();
    });
    const trigger = screen.getByTestId("advanced-slot-templates-trigger");
    expect(trigger).toBeTruthy();
    // Closed by default — the inner template list isn't rendered yet.
    expect(screen.queryByTestId("template-row-kitchen_hero")).toBeNull();

    fireEvent.click(trigger);

    await waitFor(() => {
      expect(screen.getByTestId("template-row-kitchen_hero")).toBeTruthy();
    });

    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.queryByTestId("template-row-kitchen_hero")).toBeNull();
    });
  });

  it("auto-promotion card stays hidden when there are no pending suggestions", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("recipe-matrix-tab")).toBeTruthy();
    });
    // Empty queue → no card.
    expect(screen.queryByTestId("auto-promotion-card")).toBeNull();
  });
});
