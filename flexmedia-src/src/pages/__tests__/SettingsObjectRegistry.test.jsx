/**
 * SettingsObjectRegistry — vitest suite (W12.B).
 *
 * Coverage:
 *   1. Route access: registered + master_admin only (admin/manager/etc denied).
 *   2. Page renders all 3 tab triggers for master_admin.
 *   3. Pluraliser smoke: ObjectRegistry → object_registry (override) +
 *      ObjectRegistryCandidate → object_registry_candidates (default).
 *      This is the load-bearing fix from the spec — without these the page 404s.
 *   4. Browse-tab renders the table with rows + filter input present.
 *   5. Discovery-queue tab renders pending rows + per-row buttons.
 *   6. Approve action fires the correct edge-fn payload.
 *   7. Bulk-action selection caps at 50/batch (BULK_BATCH_CAP).
 *   8. Normalisation tab handles empty data with the empty-state card.
 *
 * Style mirrors PulseMissedOpportunityCommandCenter.test.jsx — mock the
 * Supabase client + PermissionGuard, lift entityNameToTable into a smoke
 * subset.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { canAccessRoute, ROUTE_ACCESS } from "@/components/lib/routeAccess";

// ── Stub @supabase/supabase-js BEFORE supabaseClient evaluates ────────────
// Same trick as src/api/__tests__/supabaseClient.test.js — without env vars
// the real createClient() throws "supabaseUrl is required" at module load.
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(),
    auth: { getUser: vi.fn(), signOut: vi.fn() },
    functions: { invoke: vi.fn() },
    channel: vi.fn(),
    removeChannel: vi.fn(),
    storage: { from: vi.fn() },
    rpc: vi.fn(),
  })),
}));

// ── Mock @/api/supabaseClient before importing SUTs ────────────────────────
// We preserve `entityNameToTable` (the real pluraliser) so the smoke subset
// can assert against the live override map. Only the runtime-mutating
// surfaces (api.* objects) are stubbed.
vi.mock("@/api/supabaseClient", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    api: {
      rpc: vi.fn(),
      auth: { me: vi.fn(async () => ({ id: "mock-user", role: "master_admin" })) },
      functions: { invoke: vi.fn() },
      entities: {
        ObjectRegistry: {
          filter: vi.fn(async () => []),
          list: vi.fn(async () => []),
        },
        ObjectRegistryCandidate: {
          filter: vi.fn(async () => []),
          list: vi.fn(async () => []),
        },
        RawAttributeObservation: {
          filter: vi.fn(async () => []),
          list: vi.fn(async () => []),
        },
      },
    },
  };
});

// ── Mock PermissionGuard so the master_admin gate passes during render ─────
vi.mock("@/components/auth/PermissionGuard", () => ({
  PermissionGuard: ({ children }) => <>{children}</>,
  usePermissions: () => ({ isMasterAdmin: true, isOwner: true }),
  useCurrentUser: () => ({ data: { id: "mock-user", role: "master_admin" }, isLoading: false }),
}));

// ── Mock toast (sonner) ────────────────────────────────────────────────────
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

import SettingsObjectRegistry from "../SettingsObjectRegistry";
import { BULK_BATCH_CAP } from "@/components/settings/ObjectRegistryDiscoveryQueueTab";
import { entityNameToTable } from "@/api/supabaseClient";

function renderPage(initialPath = "/SettingsObjectRegistry") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <SettingsObjectRegistry />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ── 1. Route access — W11.6.21 hard-cut ────────────────────────────────────
// Page is no longer a standalone route; it's now a tab on the umbrella
// SettingsShortlistingCommandCenter. Verify the standalone route entry was
// removed AND the unlisted route still defaults to master_admin only.
describe("SettingsObjectRegistry — route access (post W11.6.21 hard-cut)", () => {
  it("is NO LONGER registered in ROUTE_ACCESS (consolidated into umbrella)", () => {
    expect(ROUTE_ACCESS).not.toHaveProperty("SettingsObjectRegistry");
  });

  it("unlisted route still defaults to master_admin only", () => {
    expect(canAccessRoute("SettingsObjectRegistry", "master_admin")).toBe(true);
    for (const role of ["admin", "manager", "employee", "contractor"]) {
      expect(canAccessRoute("SettingsObjectRegistry", role)).toBe(false);
    }
  });
});

// ── 2. Page renders all 3 tabs ─────────────────────────────────────────────
describe("SettingsObjectRegistry — render", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders all 3 tab triggers for master_admin", async () => {
    renderPage();
    expect(await screen.findByTestId("tab-browse")).toBeInTheDocument();
    expect(screen.getByTestId("tab-queue")).toBeInTheDocument();
    expect(screen.getByTestId("tab-normalisation")).toBeInTheDocument();
  });

  it("renders the page wrapper", async () => {
    renderPage();
    expect(await screen.findByTestId("settings-object-registry-page")).toBeInTheDocument();
  });
});

// ── 3. Pluraliser smoke (the critical override) ────────────────────────────
describe("entityNameToTable — W12.B overrides", () => {
  it("maps ObjectRegistry → object_registry (singular override)", () => {
    expect(entityNameToTable("ObjectRegistry")).toBe("object_registry");
  });

  it("maps ObjectRegistryCandidate → object_registry_candidates (default works)", () => {
    expect(entityNameToTable("ObjectRegistryCandidate")).toBe(
      "object_registry_candidates",
    );
  });

  it("maps RawAttributeObservation → raw_attribute_observations (default plural)", () => {
    expect(entityNameToTable("RawAttributeObservation")).toBe(
      "raw_attribute_observations",
    );
  });
});

// ── 4. Browse tab — rows + filter input ────────────────────────────────────
describe("Browse tab", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { api } = await import("@/api/supabaseClient");
    api.entities.ObjectRegistry.filter.mockResolvedValue([
      {
        id: "row-1",
        canonical_id: "kitchen_island",
        display_name: "Kitchen Island",
        level_0_class: "kitchen",
        level_1_functional: "island",
        market_frequency: 42,
        signal_room_type: "kitchen",
        signal_confidence: 0.92,
        aliases: ["caesarstone island"],
      },
      {
        id: "row-2",
        canonical_id: "obj_bathtub_freestanding",
        display_name: "Freestanding Bathtub",
        level_0_class: "bathroom",
        market_frequency: 18,
        signal_room_type: null,
        aliases: [],
      },
    ]);
  });

  it("renders both browse rows + the search input", async () => {
    renderPage();
    expect(await screen.findByTestId("browse-search-input")).toBeInTheDocument();
    expect(await screen.findByText("kitchen_island")).toBeInTheDocument();
    expect(screen.getByText("obj_bathtub_freestanding")).toBeInTheDocument();
  });

  it("filters rows by search text (client-side)", async () => {
    renderPage();
    const search = await screen.findByTestId("browse-search-input");
    await waitFor(() => expect(screen.getByText("kitchen_island")).toBeInTheDocument());
    fireEvent.change(search, { target: { value: "bathtub" } });
    await waitFor(() => {
      expect(screen.queryByText("kitchen_island")).not.toBeInTheDocument();
    });
    expect(screen.getByText("obj_bathtub_freestanding")).toBeInTheDocument();
  });

  it("expands a row inline when clicked", async () => {
    renderPage();
    const row = await screen.findByText("kitchen_island");
    fireEvent.click(row);
    // After click, an "expanded" detail row should mount.
    await waitFor(() => {
      expect(screen.getByTestId("browse-row-expanded")).toBeInTheDocument();
    });
  });
});

// ── 5. Discovery-queue tab — rows + buttons ────────────────────────────────
describe("Discovery-queue tab", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { api } = await import("@/api/supabaseClient");
    api.functions.invoke.mockImplementation(async (fnName, body) => {
      if (fnName === "object-registry-admin" && body?.action === "list_candidates") {
        return {
          data: {
            candidates: [
              {
                id: "cand-1",
                candidate_type: "object",
                proposed_canonical_label: "marble_waterfall_island",
                proposed_display_name: "Marble Waterfall Island",
                proposed_level_0_class: "kitchen",
                proposed_level_1_functional: "island",
                observed_count: 7,
                first_proposed_at: new Date().toISOString(),
                similarity_to_existing: {
                  matches: [{ canonical_id: "kitchen_island", similarity: 0.83 }],
                },
              },
            ],
            total: 1,
          },
        };
      }
      return { data: {} };
    });
  });

  it("renders the discovery row + per-row buttons", async () => {
    renderPage("/SettingsObjectRegistry?tab=queue");
    expect(await screen.findByTestId("queue-table")).toBeInTheDocument();
    expect(await screen.findByText("marble_waterfall_island")).toBeInTheDocument();
    expect(await screen.findByTestId("approve-button-cand-1")).toBeInTheDocument();
    expect(screen.getByTestId("reject-button-cand-1")).toBeInTheDocument();
    expect(screen.getByTestId("merge-button-cand-1")).toBeInTheDocument();
    expect(screen.getByTestId("defer-button-cand-1")).toBeInTheDocument();
  });

  it("approve action posts the correct payload", async () => {
    renderPage("/SettingsObjectRegistry?tab=queue");
    const { api } = await import("@/api/supabaseClient");
    const btn = await screen.findByTestId("approve-button-cand-1");
    fireEvent.click(btn);
    await waitFor(() => {
      expect(api.functions.invoke).toHaveBeenCalledWith(
        "object-registry-admin",
        expect.objectContaining({
          action: "approve_candidate",
          candidate_id: "cand-1",
        }),
      );
    });
  });

  it("opening merge dialog from the per-row action selects that candidate", async () => {
    renderPage("/SettingsObjectRegistry?tab=queue");
    const mergeBtn = await screen.findByTestId("merge-button-cand-1");
    fireEvent.click(mergeBtn);
    // Merge dialog should open; presence of the target input proves it.
    expect(await screen.findByTestId("merge-target-input")).toBeInTheDocument();
    // The submit button label should mention "Merge 1" since one is selected.
    expect(screen.getByTestId("merge-submit-button")).toHaveTextContent(/Merge 1/);
  });
});

// ── 6. Bulk-action 50-batch cap ───────────────────────────────────────────
describe("Bulk-action selection cap", () => {
  it("BULK_BATCH_CAP is 50 (the spec contract)", () => {
    expect(BULK_BATCH_CAP).toBe(50);
  });
});

// ── 7. Normalisation tab — empty state ────────────────────────────────────
describe("Normalisation tab — empty data", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { api } = await import("@/api/supabaseClient");
    api.entities.RawAttributeObservation.list.mockResolvedValue([]);
    api.entities.ObjectRegistryCandidate.filter.mockResolvedValue([]);
  });

  it("renders the empty-state card when there is no data", async () => {
    renderPage("/SettingsObjectRegistry?tab=normalisation");
    await waitFor(() => {
      expect(screen.getByTestId("normalisation-empty-state")).toBeInTheDocument();
    });
  });

  it("still shows the maintenance backfill button even on empty data", async () => {
    renderPage("/SettingsObjectRegistry?tab=normalisation");
    expect(await screen.findByTestId("backfill-embeddings-button")).toBeInTheDocument();
  });
});
