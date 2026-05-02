/**
 * SlotRecipesTab — vitest suite (W11.6.25).
 *
 * Coverage:
 *   1. Renders the tab heading + scope picker once data loads.
 *   2. Tolerance card not shown by default (scope is package_tier).
 *   3. Resolved-recipe preview not shown before a scope is picked.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function makeBuilder(rows) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    range: () => builder,
    update: () => builder,
    insert: () => builder,
    delete: () => builder,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    single: () => Promise.resolve({ data: null, error: null }),
    then: (resolve) =>
      Promise.resolve({ data: rows, error: null }).then(resolve),
  };
  return builder;
}

const TIER_ROWS = [
  { id: "tier-S-uuid", tier_code: "S", display_name: "Standard" },
  { id: "tier-P-uuid", tier_code: "P", display_name: "Premium" },
];
const PACKAGE_ROWS = [
  {
    id: "pkg-gold-uuid",
    name: "Gold Package",
    expected_count_tolerance_below: null,
    expected_count_tolerance_above: null,
  },
];
const PROJECT_TYPE_ROWS = [
  { id: "pt-residential-uuid", name: "Residential Sales" },
];
const PRODUCT_ROWS = [{ id: "prod-dusk-uuid", name: "Dusk add-on" }];
const SLOT_ROWS = [
  {
    slot_id: "kitchen_hero",
    display_name: "Kitchen Hero",
    phase: 1,
    min_images: 1,
    max_images: 2,
    version: 1,
    is_active: true,
  },
];
const ENGINE_SETTINGS_ROWS = [
  { key: "expected_count_tolerance_below", value: 3 },
  { key: "expected_count_tolerance_above", value: 3 },
];

vi.mock("@/api/supabaseClient", () => {
  return {
    api: { auth: { me: vi.fn(async () => ({ id: "u1", role: "master_admin" })) } },
    supabase: {
      from(table) {
        const map = {
          shortlisting_tiers: TIER_ROWS,
          packages: PACKAGE_ROWS,
          project_types: PROJECT_TYPE_ROWS,
          products: PRODUCT_ROWS,
          shortlisting_slot_definitions: SLOT_ROWS,
          shortlisting_slot_allocations: [],
          engine_settings: ENGINE_SETTINGS_ROWS,
        };
        return makeBuilder(map[table] ?? []);
      },
    },
  };
});

import SlotRecipesTab from "../SlotRecipesTab";

function mount() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <SlotRecipesTab />
    </QueryClientProvider>,
  );
}

describe("SlotRecipesTab — W11.6.25", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the tab heading + scope picker once references load", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("slot-recipes-tab")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByText("Slot Recipes")).toBeTruthy();
      expect(screen.getByText("Scope type")).toBeTruthy();
      expect(screen.getByText("Scope target")).toBeTruthy();
    });
  });

  it("does not render the tolerance card by default (scope is package_tier)", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("slot-recipes-tab")).toBeTruthy();
    });
    expect(screen.queryByTestId("tolerance-card")).toBeNull();
  });

  it("does not render the resolved-recipe preview before a scope is picked", async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByTestId("slot-recipes-tab")).toBeTruthy();
    });
    expect(screen.queryByTestId("resolved-preview")).toBeNull();
  });
});
