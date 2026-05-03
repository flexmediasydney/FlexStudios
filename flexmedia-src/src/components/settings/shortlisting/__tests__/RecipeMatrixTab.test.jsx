/**
 * RecipeMatrixTab — vitest suite (W11.6.28b — price tier axis;
 * W11.6.29 / mig 451 — Position Editor restructure: friendly Room labels +
 * "More constraints" expander; Taxonomy Explorer registers
 * vantage_position + composition_geometry as primary axes).
 *
 * Coverage:
 *   1. Renders the help banner + matrix once references load.
 *   2. Matrix grid renders rows × columns with PRICE TIER columns
 *      (Standard / Premium) — engine grade is no longer an axis.
 *   3. Clicking a cell opens the cell editor dialog.
 *   4. Inheritance breadcrumb renders inside the cell editor.
 *   5. Tier defaults pseudo-row renders with both columns.
 *   6. Auto-promotion card hidden when no suggestions.
 *   7. Dual-number display: cell shows AUTHORED / TARGET.
 *   8. Sum-of-products fallback: when tier jsonb has no image_count,
 *      target = sum of products[].quantity.
 *   9. Over-target warning renders when authored > target.
 *  10. Engine-grade explanatory pill is present in the Cell Editor.
 *  11. Disabled cell when a package doesn't offer a tier.
 *  12. (mig 451) Position editor splits constraints into default-visible (4
 *      axes) and a collapsible "More constraints" expander (5 axes).
 *  13. (mig 451) Friendly Room labels: dropdown shows "Kitchen" not
 *      "kitchen_dedicated".
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
// Every chained method returns the builder; the terminal `then` resolves
// with the table's rows. This mirrors how `supabase.from('x').select()…`
// is awaited in the hooks module.
//
// All fixtures live inside the vi.mock factory so vi.mock's hoist-to-top
// rule doesn't blow up.

vi.mock("@/api/supabaseClient", () => {
  // Silver: tier image_count present + small recipe (1 authored / 5 target → green)
  // Gold:   no tier image_count, sum-of-products = 2+3+1 = 6 (4 authored / 6 target → green)
  // AI:     only standard tier offered (premium tier_not_offered → disabled)
  // Over:   over-target package: 8 authored / 4 target → amber + warning
  const PACKAGE_ROWS_INNER = [
    {
      id: "pkg-silver-uuid",
      name: "Silver Package",
      // Sales Images product so the cell editor's image-class filter
      // (W11.6.28c) renders a Sales Images tab. Tier image_count still
      // drives the cell target.
      products: [
        { product_id: "prod-sales", product_name: "Sales Images", quantity: 5 },
      ],
      standard_tier: { package_price: 100, image_count: 5 },
      premium_tier: { package_price: 150, image_count: 8 },
      expected_count_target: 5,
      expected_count_tolerance_below: 1,
      expected_count_tolerance_above: 1,
      engine_mode_override: null,
    },
    {
      id: "pkg-gold-uuid",
      name: "Gold Package",
      products: [
        { product_id: "prod-sales", product_name: "Sales Images", quantity: 2 },
        { product_id: "prod-drone", product_name: "Drone Shots", quantity: 3 },
        { product_id: "prod-floor", product_name: "Floor Plans", quantity: 1 },
      ],
      // No image_count in tier jsonb → forces sum-of-products fallback.
      standard_tier: { package_price: 220 },
      premium_tier: { package_price: 320 },
      expected_count_target: null,
      expected_count_tolerance_below: 2,
      expected_count_tolerance_above: 3,
      engine_mode_override: null,
    },
    {
      id: "pkg-ai-uuid",
      name: "AI Package",
      products: [],
      standard_tier: { package_price: 50, image_count: 12 },
      // No premium tier offered (empty jsonb) — but legacy
      // expected_count_target makes packageOffersTier still TRUE for
      // both. Force it FALSE here by also nulling expected_count_target
      // and giving an empty premium_tier.
      premium_tier: {},
      expected_count_target: null,
      expected_count_tolerance_below: null,
      expected_count_tolerance_above: null,
      engine_mode_override: null,
    },
    {
      id: "pkg-over-uuid",
      name: "Over Package",
      products: [],
      standard_tier: { image_count: 4 },
      premium_tier: { image_count: 6 },
      expected_count_target: null,
      expected_count_tolerance_below: null,
      expected_count_tolerance_above: null,
      engine_mode_override: null,
    },
    {
      // Video-only package — has only video products, NO image-class
      // engine_roles. The cell editor should render the empty-state when
      // operators open this cell (W11.6.28c — image-shortlist filter).
      id: "pkg-video-uuid",
      name: "Day Video Package",
      products: [
        { product_id: "prod-day-video", product_name: "Day Video", quantity: 1 },
      ],
      standard_tier: { package_price: 850 },
      premium_tier: { package_price: 1450 },
      expected_count_target: null,
      expected_count_tolerance_below: null,
      expected_count_tolerance_above: null,
      engine_mode_override: null,
    },
  ];

  const PRICE_TIER_ROWS_INNER = [
    {
      id: "a0000000-0000-4000-a000-000000000001",
      code: "standard",
      display_name: "Standard",
      display_order: 1,
    },
    {
      id: "a0000000-0000-4000-a000-000000000002",
      code: "premium",
      display_name: "Premium",
      display_order: 2,
    },
  ];

  const PROJECT_TYPE_ROWS_INNER = [{ id: "pt-residential", name: "Residential" }];
  const PRODUCT_ROWS_INNER = [
    {
      id: "prod-sales",
      name: "Sales Images",
      engine_role: "photo_day_shortlist",
      standard_tier: { image_count: 2 },
      premium_tier: { image_count: 3 },
      min_quantity: 1,
      max_quantity: 30,
    },
    {
      id: "prod-drone",
      name: "Drone Shots",
      engine_role: "drone_shortlist",
      standard_tier: { image_count: 3 },
      premium_tier: { image_count: 4 },
      min_quantity: 1,
      max_quantity: 10,
    },
    {
      id: "prod-floor",
      name: "Floor Plans",
      engine_role: "floor_plans",
      standard_tier: { image_count: 1 },
      premium_tier: { image_count: 1 },
      min_quantity: 1,
      max_quantity: 5,
    },
    {
      id: "prod-day-video",
      name: "Day Video",
      engine_role: "video_day_shortlist",
      standard_tier: { base_price: 850 },
      premium_tier: { base_price: 1450 },
      min_quantity: 1,
      max_quantity: 1,
    },
  ];
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

  // Cell counts source: each row is a gallery_positions row.
  // Silver × Standard: 1 row (1 authored / 5 target → green)
  // Gold   × Standard: 4 rows (4 authored / 6 target → green)
  // Over   × Standard: 8 rows (8 authored / 4 target → amber, over-target)
  const POSITION_ROWS_INNER = [
    // Silver × Standard
    //
    // Mig 451 (S1 / W11.6.29): `room_type` and `composition_type` columns
    // were dropped from gallery_positions. Fixture rows mirror the post-451
    // shape — `space_type` is the discriminator, `vantage_position` and
    // `composition_geometry` carry the decomposed composition axis.
    {
      id: "gp-silver-1",
      scope_type: "package_x_price_tier",
      scope_ref_id: "pkg-silver-uuid",
      scope_ref_id_2: "a0000000-0000-4000-a000-000000000001",
      engine_role: "photo_day_shortlist",
      position_index: 1,
      phase: "mandatory",
      selection_mode: "ai_decides",
      ai_backfill_on_gap: true,
      template_slot_id: null,
      notes: null,
      space_type: "kitchen_dedicated",
      zone_focus: null,
      image_type: null,
      shot_scale: "wide",
      perspective_compression: "compressed",
      vantage_position: "eye_level",
      composition_geometry: "two_point_perspective",
      lens_class: null,
      orientation: null,
    },
    // Gold × Standard (4 rows)
    ...Array.from({ length: 4 }).map((_, i) => ({
      id: `gp-gold-${i + 1}`,
      scope_type: "package_x_price_tier",
      scope_ref_id: "pkg-gold-uuid",
      scope_ref_id_2: "a0000000-0000-4000-a000-000000000001",
      engine_role: "photo_day_shortlist",
      position_index: i + 1,
      phase: "optional",
      selection_mode: "ai_decides",
      ai_backfill_on_gap: true,
      template_slot_id: null,
    })),
    // Over × Standard (8 rows → over target=4)
    ...Array.from({ length: 8 }).map((_, i) => ({
      id: `gp-over-${i + 1}`,
      scope_type: "package_x_price_tier",
      scope_ref_id: "pkg-over-uuid",
      scope_ref_id_2: "a0000000-0000-4000-a000-000000000001",
      engine_role: "photo_day_shortlist",
      position_index: i + 1,
      phase: "optional",
      selection_mode: "ai_decides",
      ai_backfill_on_gap: true,
      template_slot_id: null,
    })),
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
    package_price_tiers: PRICE_TIER_ROWS_INNER,
    project_types: PROJECT_TYPE_ROWS_INNER,
    products: PRODUCT_ROWS_INNER,
    shortlisting_slot_definitions: SLOT_ROWS_INNER,
    gallery_positions: POSITION_ROWS_INNER,
    gallery_position_template_suggestions: [],
  };

  return {
    supabase: {
      from(name) {
        return buildMock(tableMap[name] ?? []);
      },
    },
    api: {
      rpc: vi.fn(async (fn, args) => {
        if (fn === "resolve_gallery_positions_for_cell") {
          // Filter the position fixtures to the requested cell so the
          // editor renders matching positions.
          const all = POSITION_ROWS_INNER;
          const matched = all.filter(
            (p) =>
              p.scope_type === "package_x_price_tier" &&
              p.scope_ref_id === args?.p_package_id &&
              p.scope_ref_id_2 === args?.p_price_tier_id,
          );
          return {
            positions: matched,
            scopeChain: [
              { label: "Tier defaults", scope: "price_tier", override_count: 0 },
              {
                label: "This cell",
                scope: "package_x_price_tier",
                override_count: matched.length,
              },
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

const STD_ID = "a0000000-0000-4000-a000-000000000001";
const PRE_ID = "a0000000-0000-4000-a000-000000000002";

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

describe("RecipeMatrixTab — W11.6.28b (price tier axis)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the help banner once references load", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("recipe-matrix-tab")).toBeTruthy();
    });
    const tab = screen.getByTestId("recipe-matrix-tab");
    expect(tab.textContent).toMatch(/recipe/i);
    expect(tab.textContent).toMatch(/positions/i);
    // Help banner now mentions BOTH price tier and AUTHORED/TARGET.
    expect(tab.textContent).toMatch(/price tier/i);
    expect(tab.textContent).toMatch(/AUTHORED/i);
    expect(tab.textContent).toMatch(/TARGET/i);
    // And explicitly calls out grade is NOT an axis.
    expect(tab.textContent).toMatch(/does not affect|does not affect slot/i);
    expect(screen.getByTestId("open-help-drawer")).toBeTruthy();
  });

  it("renders the matrix grid with PRICE TIER columns (Standard / Premium)", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("matrix-grid")).toBeTruthy();
    });
    // Rows for each package
    expect(screen.getByTestId("matrix-row-pkg-silver-uuid")).toBeTruthy();
    expect(screen.getByTestId("matrix-row-pkg-gold-uuid")).toBeTruthy();
    expect(screen.getByTestId("matrix-row-pkg-ai-uuid")).toBeTruthy();
    // Tier headers — codes are the new package_price_tiers codes.
    expect(screen.getByTestId("matrix-tier-header-standard")).toBeTruthy();
    expect(screen.getByTestId("matrix-tier-header-premium")).toBeTruthy();
    // No engine-grade headers (Volume / Refined / Editorial) anywhere.
    expect(screen.queryByTestId("matrix-tier-header-V")).toBeNull();
    expect(screen.queryByTestId("matrix-tier-header-R")).toBeNull();
    expect(screen.queryByTestId("matrix-tier-header-E")).toBeNull();
    // Cell buttons for the silver package use price tier codes.
    expect(
      screen.getByTestId("matrix-cell-pkg-silver-uuid-standard"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("matrix-cell-pkg-silver-uuid-premium"),
    ).toBeTruthy();
  });

  it("clicking a cell opens the cell editor dialog with the price-tier title", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("matrix-grid")).toBeTruthy();
    });

    expect(screen.queryByTestId("cell-editor-dialog")).toBeNull();

    fireEvent.click(
      screen.getByTestId("matrix-cell-pkg-silver-uuid-standard"),
    );

    await waitFor(() => {
      expect(screen.getByTestId("cell-editor-dialog")).toBeTruthy();
    });
    const dialog = screen.getByTestId("cell-editor-dialog");
    expect(dialog.textContent).toMatch(/Silver Package.*Standard/);
  });

  it("renders the inheritance breadcrumb inside the cell editor", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("matrix-grid")).toBeTruthy();
    });
    fireEvent.click(
      screen.getByTestId("matrix-cell-pkg-silver-uuid-standard"),
    );
    await waitFor(() => {
      expect(screen.getByTestId("cell-editor-dialog")).toBeTruthy();
    });
    const breadcrumb = await waitFor(() =>
      screen.getByTestId("scope-breadcrumb"),
    );
    expect(breadcrumb).toBeTruthy();
    expect(breadcrumb.textContent).toMatch(/Tier defaults/);
    expect(breadcrumb.textContent).toMatch(/This cell/);
  });

  it("renders the Tier defaults pseudo-row above the matrix body", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("matrix-grid")).toBeTruthy();
    });
    expect(screen.getByTestId("matrix-cell-defaults-standard")).toBeTruthy();
    expect(screen.getByTestId("matrix-cell-defaults-premium")).toBeTruthy();
  });

  it("auto-promotion card stays hidden when there are no pending suggestions", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("recipe-matrix-tab")).toBeTruthy();
    });
    expect(screen.queryByTestId("auto-promotion-card")).toBeNull();
  });

  it("dual-number display: cell shows AUTHORED / TARGET", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("matrix-grid")).toBeTruthy();
    });
    // Silver × Standard: 1 authored / 5 target (target from tier image_count).
    const silverStd = screen.getByTestId("matrix-cell-pkg-silver-uuid-standard");
    expect(silverStd.textContent).toMatch(/1.*authored/i);
    expect(silverStd.textContent).toMatch(/5.*target/i);
  });

  it("sum-of-products fallback: target = SUM(image-class products[].quantity) when tier image_count missing", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("matrix-grid")).toBeTruthy();
    });
    // Gold × Standard: tier jsonb has no image_count, so target =
    // 2 (Sales, photo_day_shortlist) + 3 (Drone, drone_shortlist) = 5.
    // Floor Plans (engine_role='floor_plans') is NOT image-class and is
    // excluded from the sum (W11.6.28c — image-shortlist filter).
    const goldStd = screen.getByTestId("matrix-cell-pkg-gold-uuid-standard");
    expect(goldStd.textContent).toMatch(/4.*authored/i);
    expect(goldStd.textContent).toMatch(/5.*target/i);
  });

  it("over-target warning renders when authored > target", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("matrix-grid")).toBeTruthy();
    });
    // Over × Standard: 8 authored / 4 target → over-target.
    const overStd = screen.getByTestId("matrix-cell-pkg-over-uuid-standard");
    expect(overStd.dataset.overTarget).toBe("true");
    // Inline over-target message present.
    expect(
      screen.getByTestId("matrix-cell-pkg-over-uuid-standard-over-target-warning"),
    ).toBeTruthy();
  });

  it("renders the engine-grade explanatory pill inside the Cell Editor", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("matrix-grid")).toBeTruthy();
    });
    fireEvent.click(
      screen.getByTestId("matrix-cell-pkg-silver-uuid-standard"),
    );
    await waitFor(() => {
      expect(screen.getByTestId("cell-editor-dialog")).toBeTruthy();
    });
    const pill = await waitFor(() =>
      screen.getByTestId("engine-grade-pill"),
    );
    expect(pill.textContent).toMatch(/engine grade/i);
    expect(pill.textContent).toMatch(/per-round/i);
    expect(pill.textContent).toMatch(/does not/i);
  });

  it("over-target warning banner inside the Cell Editor", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("matrix-grid")).toBeTruthy();
    });
    fireEvent.click(
      screen.getByTestId("matrix-cell-pkg-over-uuid-standard"),
    );
    await waitFor(() => {
      expect(screen.getByTestId("cell-editor-dialog")).toBeTruthy();
    });
    const banner = await waitFor(() =>
      screen.getByTestId("cell-target-banner"),
    );
    // Banner contains the over-target copy.
    expect(banner.textContent).toMatch(/Over target/);
    expect(banner.textContent).toMatch(/8 authored.*4 target/);
    expect(banner.textContent).toMatch(/lowest-priority/);
  });

  it("Tier defaults cell opens editor in defaults mode (no over-target banner)", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("matrix-grid")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("matrix-cell-defaults-standard"));
    await waitFor(() => {
      expect(screen.getByTestId("cell-editor-dialog")).toBeTruthy();
    });
    // Defaults mode → no per-cell target banner.
    expect(screen.queryByTestId("cell-target-banner")).toBeNull();
  });

  it("Advanced — Slot Templates expander toggles open and closed", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("recipe-matrix-tab")).toBeTruthy();
    });
    const trigger = screen.getByTestId("advanced-slot-templates-trigger");
    expect(trigger).toBeTruthy();
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

  // ── W11.6.28c: image-shortlist scope filter inside the Cell Editor ──────
  it("Cell editor renders only image-class engine_role tabs (Silver: Sales only)", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("matrix-grid")).toBeTruthy();
    });
    fireEvent.click(
      screen.getByTestId("matrix-cell-pkg-silver-uuid-standard"),
    );
    await waitFor(() => {
      expect(screen.getByTestId("cell-editor-dialog")).toBeTruthy();
    });

    // Silver only carries Sales Images (photo_day_shortlist) — no Drone,
    // no Dusk. The Sales tab MUST render; the others MUST NOT.
    await waitFor(() => {
      expect(
        screen.getByTestId("engine-role-tab-photo_day_shortlist"),
      ).toBeTruthy();
    });
    expect(
      screen.queryByTestId("engine-role-tab-drone_shortlist"),
    ).toBeNull();
    expect(
      screen.queryByTestId("engine-role-tab-photo_dusk_shortlist"),
    ).toBeNull();

    // Floor Plans / video tabs MUST NOT appear — those engine_roles aren't
    // image-class.
    expect(screen.queryByTestId("engine-role-tab-floor_plans")).toBeNull();
    expect(
      screen.queryByTestId("engine-role-tab-video_day_shortlist"),
    ).toBeNull();
  });

  it("Cell editor renders Sales + Drone tabs for Gold (image-class products only)", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("matrix-grid")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("matrix-cell-pkg-gold-uuid-standard"));
    await waitFor(() => {
      expect(screen.getByTestId("cell-editor-dialog")).toBeTruthy();
    });

    // Gold has Sales (photo_day_shortlist) + Drone (drone_shortlist) +
    // Floor Plans (floor_plans, NOT image-class). The first two render;
    // Floor Plans tab is suppressed.
    await waitFor(() => {
      expect(
        screen.getByTestId("engine-role-tab-photo_day_shortlist"),
      ).toBeTruthy();
    });
    expect(
      screen.getByTestId("engine-role-tab-drone_shortlist"),
    ).toBeTruthy();
    expect(screen.queryByTestId("engine-role-tab-floor_plans")).toBeNull();
  });

  it("Cell editor renders empty-state for video-only package (no image-class products)", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("matrix-grid")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("matrix-cell-pkg-video-uuid-standard"));
    await waitFor(() => {
      expect(screen.getByTestId("cell-editor-dialog")).toBeTruthy();
    });

    // The cell editor surfaces the "no image-class products" empty state
    // and does NOT render any engine-role tabs.
    await waitFor(() => {
      expect(screen.getByTestId("cell-editor-empty-state")).toBeTruthy();
    });
    expect(
      screen.queryByTestId("engine-role-tab-photo_day_shortlist"),
    ).toBeNull();
    expect(
      screen.queryByTestId("engine-role-tab-drone_shortlist"),
    ).toBeNull();
  });
});

// ── Pure unit tests for the constants helpers ──────────────────────────
import {
  cellHealthColor,
  deriveCellTarget,
  describeTargetBreakdown,
  packageOffersTier,
  IMAGE_SHORTLIST_ENGINE_ROLES,
  isImageShortlistEngineRole,
} from "../recipe-matrix/constants";

describe("constants — cellHealthColor (W11.6.28b)", () => {
  it("returns slate when authored is 0", () => {
    expect(cellHealthColor(0, 5)).toBe("slate");
    expect(cellHealthColor(0, null)).toBe("slate");
  });
  it("returns red when target is 0", () => {
    expect(cellHealthColor(3, 0)).toBe("red");
  });
  it("returns green when 0 < authored ≤ target", () => {
    expect(cellHealthColor(1, 5)).toBe("green");
    expect(cellHealthColor(5, 5)).toBe("green");
  });
  it("returns amber when authored > target (over-target)", () => {
    expect(cellHealthColor(7, 5)).toBe("amber");
    expect(cellHealthColor(10, 1)).toBe("amber");
  });
  it("returns green when target unknown but authored > 0", () => {
    expect(cellHealthColor(3, null)).toBe("green");
  });
});

describe("constants — deriveCellTarget", () => {
  it("uses tier jsonb image_count as the primary source", () => {
    const pkg = {
      name: "Silver",
      products: [],
      standard_tier: { image_count: 5 },
      premium_tier: { image_count: 8 },
    };
    const t = deriveCellTarget(pkg, "standard");
    expect(t.value).toBe(5);
    expect(t.source).toBe("tier_image_count");
    expect(describeTargetBreakdown(t)).toMatch(/5 images/);
  });

  it("falls back to SUM(image-class products[].quantity) when tier jsonb has no image_count", () => {
    // W11.6.28c: only image-class engine_roles count toward the
    // image-shortlist target. Floor Plans (floor_plans / floorplan_qa) and
    // any non-image-class product is excluded from the sum.
    const pkg = {
      name: "Gold",
      products: [
        { product_id: "a", product_name: "Sales Images", quantity: 2 },
        { product_id: "b", product_name: "Drone Shots", quantity: 3 },
        { product_id: "c", product_name: "Floor Plans", quantity: 1 },
      ],
      standard_tier: { package_price: 220 },
      premium_tier: {},
    };
    const productLookup = new Map([
      ["a", { id: "a", name: "Sales Images", engine_role: "photo_day_shortlist" }],
      ["b", { id: "b", name: "Drone Shots", engine_role: "drone_shortlist" }],
      ["c", { id: "c", name: "Floor Plans", engine_role: "floorplan_qa" }],
    ]);
    const t = deriveCellTarget(pkg, "standard", productLookup);
    expect(t.value).toBe(5); // 2 (Sales) + 3 (Drone) — Floor Plans excluded.
    expect(t.source).toBe("sum_of_products");
    expect(t.breakdown.length).toBe(2);
    const desc = describeTargetBreakdown(t);
    expect(desc).toMatch(/Target: 5/);
    expect(desc).toMatch(/2 \(Sales Images\)/);
    expect(desc).toMatch(/3 \(Drone Shots\)/);
    // Floor Plans MUST NOT appear — it's been filtered out.
    expect(desc).not.toMatch(/Floor Plans/);
  });

  it("excludes products with NULL engine_role from sum-of-products", () => {
    // Surcharges, declutter, and other non-engine products carry NULL
    // engine_role and must not contribute to the image-shortlist target.
    const pkg = {
      name: "Mixed",
      products: [
        { product_id: "a", product_name: "Sales Images", quantity: 5 },
        { product_id: "b", product_name: "Saturday Surcharge", quantity: 1 },
      ],
      standard_tier: {},
      premium_tier: {},
    };
    const productLookup = new Map([
      ["a", { id: "a", name: "Sales Images", engine_role: "photo_day_shortlist" }],
      ["b", { id: "b", name: "Saturday Surcharge", engine_role: null }],
    ]);
    const t = deriveCellTarget(pkg, "standard", productLookup);
    expect(t.value).toBe(5);
    expect(t.breakdown.length).toBe(1);
  });

  it("prefers per-product tier image_count over line-item quantity", () => {
    const pkg = {
      name: "Mixed",
      products: [
        { product_id: "a", product_name: "Sales", quantity: 99 },
      ],
      standard_tier: {},
      premium_tier: {},
    };
    const productLookup = new Map([
      [
        "a",
        {
          id: "a",
          name: "Sales",
          engine_role: "photo_day_shortlist",
          standard_tier: { image_count: 4 },
          premium_tier: { image_count: 7 },
        },
      ],
    ]);
    const t = deriveCellTarget(pkg, "standard", productLookup);
    expect(t.value).toBe(4);
    expect(t.source).toBe("sum_of_products");
  });

  // Hotfix 7cc89a4 (2026-05-02) dropped the legacy expected_count_target
  // fallback — that column lives on shortlisting_rounds, not packages,
  // and was a phantom reference. With no tier image_count and no
  // products[], deriveCellTarget now returns {value: null, source:
  // 'unknown'}. The test below pins that contract.
  it("returns unknown (no expected_count_target fallback) when only legacy field present", () => {
    const pkg = {
      name: "Legacy",
      products: [],
      standard_tier: {},
      premium_tier: {},
      // expected_count_target was the old phantom — derive ignores it.
      expected_count_target: 11,
    };
    const t = deriveCellTarget(pkg, "standard");
    expect(t.value).toBe(null);
    expect(t.source).toBe("unknown");
  });

  it("returns null when no source available", () => {
    const pkg = {
      name: "Bare",
      products: [],
      standard_tier: {},
      premium_tier: {},
    };
    const t = deriveCellTarget(pkg, "standard");
    expect(t.value).toBe(null);
    expect(t.source).toBe("unknown");
  });
});

describe("constants — packageOffersTier", () => {
  it("returns true when tier jsonb has any field set", () => {
    const pkg = {
      name: "Silver",
      products: [],
      standard_tier: { image_count: 5 },
      premium_tier: { image_count: 8 },
    };
    expect(packageOffersTier(pkg, "standard")).toBe(true);
    expect(packageOffersTier(pkg, "premium")).toBe(true);
  });

  it("returns false when tier jsonb empty and no products[] (legacy expected_count_target NOT a signal)", () => {
    // Hotfix 7cc89a4: expected_count_target was a phantom — packageOffersTier
    // no longer treats it as a signal. With empty tier jsonb and no
    // products[], the package doesn't offer the tier.
    const pkg = {
      name: "Legacy",
      products: [],
      standard_tier: {},
      premium_tier: {},
      expected_count_target: 10,
    };
    expect(packageOffersTier(pkg, "standard")).toBe(false);
    expect(packageOffersTier(pkg, "premium")).toBe(false);
  });

  it("returns true when tier jsonb empty but products[] is non-empty (sum-of-products fallback, no lookup)", () => {
    // Without a productLookup, packageOffersTier defaults to TRUE for any
    // products[] entries (back-compat with the older callsites that don't
    // pass a lookup — the matrix grid always passes one).
    const pkg = {
      name: "Products",
      products: [
        { product_id: "a", quantity: 5 },
      ],
      standard_tier: {},
      premium_tier: {},
    };
    expect(packageOffersTier(pkg, "standard")).toBe(true);
    expect(packageOffersTier(pkg, "premium")).toBe(true);
  });

  it("returns FALSE when products[] only has non-image-class roles (with productLookup, W11.6.28c)", () => {
    // A package with ONLY video products (Day Video Package) has no
    // image-class engine_roles. With a lookup the helper recognises that
    // and reports the tier as not offered for image shortlisting — the
    // matrix renders the cell disabled with "tier not offered".
    const pkg = {
      name: "Day Video",
      products: [
        { product_id: "v1", quantity: 1, product_name: "Day Video" },
      ],
      standard_tier: {},
      premium_tier: {},
    };
    const lookup = new Map([
      ["v1", { id: "v1", name: "Day Video", engine_role: "video_day_shortlist" }],
    ]);
    expect(packageOffersTier(pkg, "standard", lookup)).toBe(false);
    expect(packageOffersTier(pkg, "premium", lookup)).toBe(false);
  });

  it("returns TRUE when products[] has at least one image-class role (with productLookup)", () => {
    const pkg = {
      name: "Mixed",
      products: [
        { product_id: "v1", quantity: 1 },
        { product_id: "s1", quantity: 5 },
      ],
      standard_tier: {},
      premium_tier: {},
    };
    const lookup = new Map([
      ["v1", { id: "v1", engine_role: "video_day_shortlist" }],
      ["s1", { id: "s1", engine_role: "photo_day_shortlist" }],
    ]);
    expect(packageOffersTier(pkg, "standard", lookup)).toBe(true);
  });

  it("returns false when tier jsonb empty and no fallback signals", () => {
    const pkg = {
      name: "Half",
      products: [],
      standard_tier: { image_count: 12 },
      premium_tier: {},
      expected_count_target: null,
    };
    expect(packageOffersTier(pkg, "standard")).toBe(true);
    expect(packageOffersTier(pkg, "premium")).toBe(false);
  });
});

describe("constants — IMAGE_SHORTLIST_ENGINE_ROLES + isImageShortlistEngineRole", () => {
  it("includes the three image-shortlist engine_roles", () => {
    expect(IMAGE_SHORTLIST_ENGINE_ROLES).toEqual([
      "photo_day_shortlist",
      "photo_dusk_shortlist",
      "drone_shortlist",
    ]);
  });

  it("isImageShortlistEngineRole returns true for image-class roles", () => {
    expect(isImageShortlistEngineRole("photo_day_shortlist")).toBe(true);
    expect(isImageShortlistEngineRole("photo_dusk_shortlist")).toBe(true);
    expect(isImageShortlistEngineRole("drone_shortlist")).toBe(true);
  });

  it("isImageShortlistEngineRole returns false for non-image classes", () => {
    expect(isImageShortlistEngineRole("video_day_shortlist")).toBe(false);
    expect(isImageShortlistEngineRole("video_dusk_shortlist")).toBe(false);
    expect(isImageShortlistEngineRole("floorplan_qa")).toBe(false);
    expect(isImageShortlistEngineRole("agent_portraits")).toBe(false);
    expect(isImageShortlistEngineRole(null)).toBe(false);
    expect(isImageShortlistEngineRole(undefined)).toBe(false);
    expect(isImageShortlistEngineRole("")).toBe(false);
  });
});

// ── mig 451 — Position Editor restructure ─────────────────────────────────
import {
  CONSTRAINT_AXES,
  CONSTRAINT_KEYS_DEFAULT,
  CONSTRAINT_KEYS_MORE,
  VANTAGE_POSITION_LABELS,
  COMPOSITION_GEOMETRY_LABELS,
  SPACE_TYPE_FRIENDLY_LABELS,
  friendlyLabelForSpaceType,
  friendlyLabelGeneric,
} from "../recipe-matrix/constants";

describe("constants — Position Editor restructure (mig 451)", () => {
  it("CONSTRAINT_KEYS_DEFAULT lists exactly 4 default-visible axes", () => {
    expect(CONSTRAINT_KEYS_DEFAULT).toEqual([
      "space_type",
      "zone_focus",
      "shot_scale",
      "perspective_compression",
    ]);
  });

  it("CONSTRAINT_KEYS_MORE includes the original 5 collapsed-by-default axes (W11.6.29 baseline)", () => {
    // W11.8 / mig 454 appended `instance_index` + `instance_unique_constraint`
    // to the More group. The exact-equality contract migrated to the
    // dedicated W11.8 spec further down — this test guards the original 5.
    for (const axis of [
      "vantage_position",
      "composition_geometry",
      "image_type",
      "lens_class",
      "orientation",
    ]) {
      expect(CONSTRAINT_KEYS_MORE).toContain(axis);
    }
  });

  it("CONSTRAINT_AXES no longer includes room_type or composition_type", () => {
    const keys = CONSTRAINT_AXES.map((a) => a.key);
    expect(keys).not.toContain("room_type");
    expect(keys).not.toContain("composition_type");
  });

  it("space_type axis is labelled 'Room' for operator copy", () => {
    const spaceAxis = CONSTRAINT_AXES.find((a) => a.key === "space_type");
    expect(spaceAxis).toBeTruthy();
    expect(spaceAxis.label).toBe("Room");
    expect(spaceAxis.group).toBe("default");
  });

  it("vantage_position + composition_geometry sit in the More group", () => {
    const vantage = CONSTRAINT_AXES.find((a) => a.key === "vantage_position");
    const geometry = CONSTRAINT_AXES.find(
      (a) => a.key === "composition_geometry",
    );
    expect(vantage.group).toBe("more");
    expect(geometry.group).toBe("more");
  });
});

describe("constants — friendly Room labels (mig 451)", () => {
  it("returns the curated label for known space_type values", () => {
    expect(friendlyLabelForSpaceType("kitchen_dedicated")).toBe("Kitchen");
    expect(friendlyLabelForSpaceType("kitchen_dining_living_combined")).toBe(
      "Open-plan kitchen/living",
    );
    expect(friendlyLabelForSpaceType("master_bedroom")).toBe("Master bedroom");
    expect(friendlyLabelForSpaceType("bedroom_secondary")).toBe(
      "Secondary bedroom",
    );
    expect(friendlyLabelForSpaceType("bathroom")).toBe("Bathroom");
    expect(friendlyLabelForSpaceType("ensuite")).toBe("Ensuite");
    expect(friendlyLabelForSpaceType("living_room_dedicated")).toBe(
      "Living room",
    );
    expect(friendlyLabelForSpaceType("dining_room_dedicated")).toBe(
      "Dining room",
    );
    expect(friendlyLabelForSpaceType("exterior_facade")).toBe("Front exterior");
    expect(friendlyLabelForSpaceType("exterior_rear")).toBe("Back exterior");
    expect(friendlyLabelForSpaceType("pool_area")).toBe("Pool area");
    expect(friendlyLabelForSpaceType("garden")).toBe("Garden");
    expect(friendlyLabelForSpaceType("streetscape")).toBe("Streetscape");
  });

  it("falls back to snake_case → 'Title case' for unknown values", () => {
    expect(friendlyLabelForSpaceType("garage_internal_carpet")).toBe(
      "Garage Internal Carpet",
    );
    expect(friendlyLabelForSpaceType("brand_new_value")).toBe(
      "Brand New Value",
    );
  });

  it("returns empty string for null/undefined/empty input", () => {
    expect(friendlyLabelForSpaceType(null)).toBe("");
    expect(friendlyLabelForSpaceType(undefined)).toBe("");
    expect(friendlyLabelForSpaceType("")).toBe("");
  });

  it("SPACE_TYPE_FRIENDLY_LABELS covers the high-frequency rooms operators use", () => {
    expect(SPACE_TYPE_FRIENDLY_LABELS.kitchen_dedicated).toBe("Kitchen");
    expect(SPACE_TYPE_FRIENDLY_LABELS.master_bedroom).toBe("Master bedroom");
    expect(SPACE_TYPE_FRIENDLY_LABELS.pool_area).toBe("Pool area");
    expect(SPACE_TYPE_FRIENDLY_LABELS.streetscape).toBe("Streetscape");
  });

  it("friendlyLabelGeneric handles snake_case and edge cases", () => {
    expect(friendlyLabelGeneric("eye_level")).toBe("Eye Level");
    expect(friendlyLabelGeneric("rule_of_thirds")).toBe("Rule Of Thirds");
    expect(friendlyLabelGeneric(null)).toBe("");
  });
});

describe("constants — vantage_position + composition_geometry labels (mig 451)", () => {
  it("VANTAGE_POSITION_LABELS exposes all 9 values with friendly copy", () => {
    expect(VANTAGE_POSITION_LABELS.eye_level).toBe("Eye level (default)");
    expect(VANTAGE_POSITION_LABELS.corner).toBe("Corner");
    expect(VANTAGE_POSITION_LABELS.square_to_wall).toBe("Square to wall");
    expect(VANTAGE_POSITION_LABELS.through_doorway).toBe("Through doorway");
    expect(VANTAGE_POSITION_LABELS.down_corridor).toBe("Down corridor");
    expect(VANTAGE_POSITION_LABELS.aerial_overhead).toBe("Aerial — overhead");
    expect(VANTAGE_POSITION_LABELS.aerial_oblique).toBe("Aerial — oblique");
    expect(VANTAGE_POSITION_LABELS.low_angle).toBe("Low angle");
    expect(VANTAGE_POSITION_LABELS.high_angle).toBe("High angle");
  });

  it("COMPOSITION_GEOMETRY_LABELS exposes all 8 values with friendly copy", () => {
    expect(COMPOSITION_GEOMETRY_LABELS.one_point_perspective).toBe(
      "1-point perspective",
    );
    expect(COMPOSITION_GEOMETRY_LABELS.two_point_perspective).toBe(
      "2-point perspective",
    );
    expect(COMPOSITION_GEOMETRY_LABELS.three_point_perspective).toBe(
      "3-point perspective",
    );
    expect(COMPOSITION_GEOMETRY_LABELS.leading_lines).toBe("Leading lines");
    expect(COMPOSITION_GEOMETRY_LABELS.symmetrical).toBe("Symmetrical");
    expect(COMPOSITION_GEOMETRY_LABELS.centered).toBe("Centered");
    expect(COMPOSITION_GEOMETRY_LABELS.rule_of_thirds).toBe("Rule of thirds");
    expect(COMPOSITION_GEOMETRY_LABELS.asymmetric_balance).toBe(
      "Asymmetric balance",
    );
  });
});

// ── W11.8 / mig 454 — instance_index + instance_unique_constraint registry ──
describe("constants — space-instance axes (W11.8 / mig 454)", () => {
  it("CONSTRAINT_AXES includes instance_index in the More group with select type", () => {
    const axis = CONSTRAINT_AXES.find((a) => a.key === "instance_index");
    expect(axis).toBeTruthy();
    expect(axis.group).toBe("more");
    expect(axis.kind).toBe("instance");
    expect(axis.type).toBe("select");
    // Five options — Any + 1st..4th detected.
    expect(axis.options.length).toBe(5);
    expect(axis.options[0]).toEqual({ value: null, label: "Any" });
    expect(axis.options[1]).toEqual({ value: 1, label: "1st detected" });
    expect(axis.options[4]).toEqual({ value: 4, label: "4th detected" });
    // Tooltip mentions multi-dwelling properties.
    expect(axis.tooltip).toMatch(/multi-dwelling|granny flat|Nth/i);
  });

  it("CONSTRAINT_AXES includes instance_unique_constraint as a checkbox", () => {
    const axis = CONSTRAINT_AXES.find(
      (a) => a.key === "instance_unique_constraint",
    );
    expect(axis).toBeTruthy();
    expect(axis.group).toBe("more");
    expect(axis.kind).toBe("instance");
    expect(axis.type).toBe("checkbox");
    expect(axis.default).toBe(false);
    expect(axis.tooltip).toMatch(/different physical room|unique/i);
  });

  it("CONSTRAINT_KEYS_MORE now includes the two new instance axes after the existing 5", () => {
    expect(CONSTRAINT_KEYS_MORE).toEqual([
      "vantage_position",
      "composition_geometry",
      "image_type",
      "lens_class",
      "orientation",
      "instance_index",
      "instance_unique_constraint",
    ]);
  });
});
