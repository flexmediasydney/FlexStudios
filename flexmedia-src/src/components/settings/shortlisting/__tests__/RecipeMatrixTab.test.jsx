/**
 * RecipeMatrixTab — vitest suite (W11.6.28b — price tier axis).
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
      products: [],
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
      room_type: "kitchen_main",
      space_type: "kitchen_dedicated",
      zone_focus: null,
      image_type: null,
      composition_type: null,
      shot_scale: "wide",
      perspective_compression: "compressed",
      lens_class: null,
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

  it("sum-of-products fallback: target = SUM(products[].quantity) when tier image_count missing", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("matrix-grid")).toBeTruthy();
    });
    // Gold × Standard: tier jsonb has no image_count, so target =
    // 2 (Sales) + 3 (Drone) + 1 (Floor Plans) = 6.
    const goldStd = screen.getByTestId("matrix-cell-pkg-gold-uuid-standard");
    expect(goldStd.textContent).toMatch(/4.*authored/i);
    expect(goldStd.textContent).toMatch(/6.*target/i);
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
});

// ── Pure unit tests for the constants helpers ──────────────────────────
import {
  cellHealthColor,
  deriveCellTarget,
  describeTargetBreakdown,
  packageOffersTier,
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

  it("falls back to SUM(products[].quantity) when tier jsonb has no image_count", () => {
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
    const t = deriveCellTarget(pkg, "standard");
    expect(t.value).toBe(6);
    expect(t.source).toBe("sum_of_products");
    expect(t.breakdown.length).toBe(3);
    const desc = describeTargetBreakdown(t);
    expect(desc).toMatch(/Target: 6/);
    expect(desc).toMatch(/2 \(Sales Images\)/);
    expect(desc).toMatch(/3 \(Drone Shots\)/);
    expect(desc).toMatch(/1 \(Floor Plans\)/);
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

  it("returns true when tier jsonb empty but products[] is non-empty (sum-of-products fallback)", () => {
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
