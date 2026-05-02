/**
 * SettingsAISuggestions — vitest suite (W12.7-12.8).
 *
 * Coverage:
 *   1. Route access — registered + master_admin only.
 *   2. Page renders both tabs + the run-engine button.
 *   3. Empty state copy on each tab when no pending suggestions.
 *   4. Run engine fires the correct edge-fn payload.
 *   5. Slot-suggestions tab shows rows + approve fires the right update.
 *   6. Room-type-suggestions tab approve creates a ShortlistingRoomType row.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { canAccessRoute, ROUTE_ACCESS } from "@/components/lib/routeAccess";

// Stub @supabase/supabase-js so module load doesn't crash on missing env.
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

vi.mock("@/api/supabaseClient", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    api: {
      rpc: vi.fn(),
      auth: { me: vi.fn(async () => ({ id: "mock-user", role: "master_admin" })) },
      functions: { invoke: vi.fn() },
      entities: {
        ShortlistingSlotSuggestion: {
          filter: vi.fn(async () => []),
          list: vi.fn(async () => []),
          update: vi.fn(async () => ({})),
        },
        ShortlistingRoomTypeSuggestion: {
          filter: vi.fn(async () => []),
          list: vi.fn(async () => []),
          update: vi.fn(async () => ({})),
        },
        ShortlistingRoomType: {
          create: vi.fn(async () => ({ id: "new-rt-id" })),
        },
      },
    },
  };
});

vi.mock("@/components/auth/PermissionGuard", () => ({
  PermissionGuard: ({ children }) => <>{children}</>,
  usePermissions: () => ({ isMasterAdmin: true, isOwner: true }),
  useCurrentUser: () => ({
    data: { id: "mock-user", role: "master_admin" },
    isLoading: false,
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

import SettingsAISuggestions from "../SettingsAISuggestions";

function renderPage(initialPath = "/SettingsAISuggestions") {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <SettingsAISuggestions />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ── 1. Route access ────────────────────────────────────────────────────────
describe("SettingsAISuggestions — route access", () => {
  it("is registered in ROUTE_ACCESS", () => {
    expect(ROUTE_ACCESS).toHaveProperty("SettingsAISuggestions");
  });

  it("master_admin can access", () => {
    expect(canAccessRoute("SettingsAISuggestions", "master_admin")).toBe(true);
  });

  it("admin / manager / employee / contractor cannot access", () => {
    for (const role of ["admin", "manager", "employee", "contractor"]) {
      expect(canAccessRoute("SettingsAISuggestions", role)).toBe(false);
    }
  });
});

// ── 2. Page render ─────────────────────────────────────────────────────────
describe("SettingsAISuggestions — render", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the page wrapper + both tabs + run-engine button", async () => {
    renderPage();
    expect(
      await screen.findByTestId("settings-ai-suggestions-page"),
    ).toBeInTheDocument();
    expect(await screen.findByTestId("tab-slots")).toBeInTheDocument();
    expect(screen.getByTestId("tab-room-types")).toBeInTheDocument();
    expect(screen.getByTestId("run-engine-button")).toBeInTheDocument();
  });
});

// ── 3. Empty states ────────────────────────────────────────────────────────
describe("SettingsAISuggestions — empty state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("slots tab shows empty state when no pending suggestions", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("empty-state-slots")).toBeInTheDocument();
    });
  });

  it("room-types tab shows empty state when navigated to with no rows", async () => {
    renderPage("/SettingsAISuggestions?tab=room_types");
    await waitFor(() => {
      expect(screen.getByTestId("empty-state-room-types")).toBeInTheDocument();
    });
  });
});

// ── 4. Run-engine button ──────────────────────────────────────────────────
describe("SettingsAISuggestions — run engine", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { api } = await import("@/api/supabaseClient");
    api.functions.invoke.mockResolvedValue({
      data: {
        ok: true,
        elapsed_ms: 123,
        slot_suggestions: [],
        room_type_suggestions: [],
        upserts: { slot_suggestions: 0, room_type_suggestions: 0 },
      },
    });
  });

  it("clicking 'Run engine' invokes the suggestion-engine fn with correct payload", async () => {
    renderPage();
    const { api } = await import("@/api/supabaseClient");
    const btn = await screen.findByTestId("run-engine-button");
    fireEvent.click(btn);
    await waitFor(() => {
      expect(api.functions.invoke).toHaveBeenCalledWith(
        "shortlisting-suggestion-engine",
        expect.objectContaining({
          days_back: 90,
          cluster_days_back: 120,
          dry_run: false,
        }),
      );
    });
    // Last-run summary should appear after success
    await waitFor(() => {
      expect(screen.getByTestId("last-run-summary")).toBeInTheDocument();
    });
  });
});

// ── 5. Slot suggestion approve ────────────────────────────────────────────
describe("SettingsAISuggestions — slot approve", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { api } = await import("@/api/supabaseClient");
    api.entities.ShortlistingSlotSuggestion.filter.mockResolvedValue([
      {
        id: "slot-sug-1",
        proposed_slot_id: "wine_cellar_hero",
        proposed_display_name: "Wine Cellar Hero",
        trigger_source: "pass2_event",
        evidence_round_count: 6,
        evidence_total_proposals: 8,
        last_observed_at: new Date().toISOString(),
        sample_round_ids: ["r1", "r2", "r3"],
        sample_reasoning: ["Underground cellar with 200+ bottles."],
      },
    ]);
  });

  it("renders the slot suggestion row", async () => {
    renderPage();
    expect(
      await screen.findByTestId("slot-suggestion-wine_cellar_hero"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("approve-wine_cellar_hero")).toBeInTheDocument();
    expect(screen.getByTestId("merge-wine_cellar_hero")).toBeInTheDocument();
    expect(screen.getByTestId("reject-wine_cellar_hero")).toBeInTheDocument();
  });

  it("approve action calls update with status=approved + approved_slot_id", async () => {
    renderPage();
    const { api } = await import("@/api/supabaseClient");
    const btn = await screen.findByTestId("approve-wine_cellar_hero");
    fireEvent.click(btn);
    await waitFor(() => {
      expect(
        api.entities.ShortlistingSlotSuggestion.update,
      ).toHaveBeenCalledWith(
        "slot-sug-1",
        expect.objectContaining({
          status: "approved",
          approved_slot_id: "wine_cellar_hero",
        }),
      );
    });
  });
});

// ── 6. Room-type approve creates canonical ────────────────────────────────
describe("SettingsAISuggestions — room-type approve", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { api } = await import("@/api/supabaseClient");
    api.entities.ShortlistingRoomTypeSuggestion.filter.mockResolvedValue([
      {
        id: "rt-sug-1",
        proposed_key: "cigar_lounge",
        proposed_display_name: "Cigar Lounge",
        trigger_source: "forced_fallback",
        evidence_count: 7,
        avg_confidence: 0.85,
        last_observed_at: new Date().toISOString(),
        sample_analysis_excerpts: ["Dedicated cigar lounge with leather seating."],
      },
    ]);
  });

  it("approve creates a ShortlistingRoomType + flips the suggestion to approved", async () => {
    renderPage("/SettingsAISuggestions?tab=room_types");
    const { api } = await import("@/api/supabaseClient");
    const btn = await screen.findByTestId("approve-cigar_lounge");
    fireEvent.click(btn);
    await waitFor(() => {
      expect(api.entities.ShortlistingRoomType.create).toHaveBeenCalledWith(
        expect.objectContaining({
          key: "cigar_lounge",
          display_name: "Cigar Lounge",
          is_active: true,
        }),
      );
    });
    await waitFor(() => {
      expect(
        api.entities.ShortlistingRoomTypeSuggestion.update,
      ).toHaveBeenCalledWith(
        "rt-sug-1",
        expect.objectContaining({ status: "approved" }),
      );
    });
  });
});
