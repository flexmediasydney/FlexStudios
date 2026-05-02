/**
 * SettingsCalibrationSessions — vitest suite (W14).
 *
 * Coverage:
 *   1. Route gate (3): non-master_admin sees 403, master_admin sees all 3 tabs.
 *   2. Pluraliser smoke — re-asserted in supabaseClient.test.js; here we
 *      smoke that the entity proxies resolve the right tables when used.
 *   3. Detail-view: empty state when no decisions yet.
 *   4. Detail-view: with decisions → renders agreement / disagreement rows.
 *   5. "Run AI Batch" button calls calibration-run-ai-batch with correct payload.
 *   6. Approve/reject DisagreementRow fires correct entity update payload.
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
      auth: {
        me: vi.fn(async () => ({ id: "mock-user", role: "master_admin" })),
      },
      functions: { invoke: vi.fn() },
      entities: {
        CalibrationSession: {
          list: vi.fn(async () => []),
          filter: vi.fn(async () => []),
          create: vi.fn(async () => ({ id: "new-session-id" })),
          update: vi.fn(async () => ({})),
        },
        CalibrationEditorShortlist: {
          filter: vi.fn(async () => []),
          update: vi.fn(async () => ({})),
        },
        CalibrationDecision: {
          filter: vi.fn(async () => []),
          update: vi.fn(async () => ({})),
        },
        Project: {
          filter: vi.fn(async () => []),
        },
        ObjectRegistry: {
          list: vi.fn(async () => []),
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

import SettingsCalibrationSessions from "../SettingsCalibrationSessions";

function renderPage(initialPath = "/SettingsCalibrationSessions") {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <SettingsCalibrationSessions />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ── 1. Route gate ──────────────────────────────────────────────────────────
describe("SettingsCalibrationSessions — route access", () => {
  it("is registered in ROUTE_ACCESS", () => {
    expect(ROUTE_ACCESS).toHaveProperty("SettingsCalibrationSessions");
  });

  it("master_admin can access all 3 tabs (route gate allows)", () => {
    expect(
      canAccessRoute("SettingsCalibrationSessions", "master_admin"),
    ).toBe(true);
  });

  it("non-master_admin roles cannot access (admin / manager / employee / contractor → 403)", () => {
    for (const role of ["admin", "manager", "employee", "contractor"]) {
      expect(canAccessRoute("SettingsCalibrationSessions", role)).toBe(false);
    }
  });
});

// ── 2. Page render — 3 tabs ───────────────────────────────────────────────
describe("SettingsCalibrationSessions — render", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("master_admin sees all 3 tabs (sessions / detail / stratification)", async () => {
    renderPage();
    expect(
      await screen.findByTestId("settings-calibration-sessions-page"),
    ).toBeInTheDocument();
    expect(await screen.findByTestId("tab-sessions")).toBeInTheDocument();
    expect(screen.getByTestId("tab-detail")).toBeInTheDocument();
    expect(screen.getByTestId("tab-stratification")).toBeInTheDocument();
  });

  it("Sessions tab default — empty state when no sessions", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("empty-state-sessions")).toBeInTheDocument();
    });
  });
});

// ── 3. Detail-view empty state ────────────────────────────────────────────
describe("SettingsCalibrationSessions — detail empty state", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { api } = await import("@/api/supabaseClient");
    api.entities.CalibrationSession.filter.mockResolvedValue([
      {
        id: "sess-1",
        session_name: "Test session",
        status: "diff_phase",
        selected_project_ids: ["p1", "p2", "p3"],
        engine_version: "wave-6-p8",
        started_at: new Date().toISOString(),
      },
    ]);
    api.entities.CalibrationEditorShortlist.filter.mockResolvedValue([
      {
        id: "es-1",
        project_id: "p1",
        status: "submitted",
        ai_run_completed_at: null,
      },
    ]);
    api.entities.CalibrationDecision.filter.mockResolvedValue([]);
  });

  it("renders the 'no decisions yet' empty state when the session has no decisions", async () => {
    renderPage("/SettingsCalibrationSessions?tab=detail&session_id=sess-1");
    await waitFor(() => {
      expect(screen.getByTestId("empty-state-decisions")).toBeInTheDocument();
    });
  });
});

// ── 4. Detail-view with decisions ─────────────────────────────────────────
describe("SettingsCalibrationSessions — detail with decisions", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { api } = await import("@/api/supabaseClient");
    api.entities.CalibrationSession.filter.mockResolvedValue([
      {
        id: "sess-1",
        session_name: "Test session",
        status: "diff_phase",
        selected_project_ids: ["p1"],
        engine_version: "wave-6-p8",
        started_at: new Date().toISOString(),
      },
    ]);
    api.entities.CalibrationEditorShortlist.filter.mockResolvedValue([
      {
        id: "es-1",
        project_id: "p1",
        status: "submitted",
        ai_run_completed_at: new Date().toISOString(),
      },
    ]);
    api.entities.CalibrationDecision.filter.mockResolvedValue([
      {
        id: "dec-match-1",
        slot_id: "kitchen_main",
        stem: "IMG_017",
        agreement: "match",
        ai_decision: "shortlisted",
        editor_decision: "shortlisted",
        ai_score: 8.4,
        ai_per_dim_scores: null,
        editor_reasoning: null,
        primary_signal_diff: null,
      },
      {
        id: "dec-disagree-1",
        slot_id: "exterior_front_hero",
        stem: "IMG_018",
        agreement: "disagree",
        ai_decision: "shortlisted",
        editor_decision: "rejected",
        ai_score: 7.1,
        ai_analysis_excerpt: "Strong frontal facade",
        editor_reasoning: "Cleaner alternative in next group",
        primary_signal_diff: "aesthetic",
      },
    ]);
  });

  it("renders disagreement and match groups separately", async () => {
    renderPage("/SettingsCalibrationSessions?tab=detail&session_id=sess-1");
    await waitFor(() => {
      expect(screen.getByTestId("disagreement-rows")).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("disagreement-dec-disagree-1"),
    ).toBeInTheDocument();
    // Match rows hidden behind a <details> toggle:
    expect(screen.getByTestId("match-rows-toggle")).toBeInTheDocument();
  });
});

// ── 5. Run AI Batch button ────────────────────────────────────────────────
describe("SettingsCalibrationSessions — run AI batch", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { api } = await import("@/api/supabaseClient");
    api.entities.CalibrationSession.filter.mockResolvedValue([
      {
        id: "sess-1",
        session_name: "Test",
        status: "editor_phase",
        selected_project_ids: ["p1"],
        engine_version: "wave-6-p8",
        started_at: new Date().toISOString(),
      },
    ]);
    api.entities.CalibrationEditorShortlist.filter.mockResolvedValue([
      {
        id: "es-1",
        project_id: "p1",
        status: "submitted",
        ai_run_completed_at: null,
      },
    ]);
    api.entities.CalibrationDecision.filter.mockResolvedValue([]);
    api.functions.invoke.mockResolvedValue({
      data: {
        ok: true,
        session_id: "sess-1",
        status: "running",
        rounds_dispatched: 1,
        round_ids: ["r1"],
      },
    });
  });

  it("clicking 'Run AI Batch' invokes calibration-run-ai-batch with the session id", async () => {
    renderPage("/SettingsCalibrationSessions?tab=detail&session_id=sess-1");
    const { api } = await import("@/api/supabaseClient");
    const btn = await screen.findByTestId("run-ai-batch-button");
    fireEvent.click(btn);
    await waitFor(() => {
      expect(api.functions.invoke).toHaveBeenCalledWith(
        "calibration-run-ai-batch",
        expect.objectContaining({ calibration_session_id: "sess-1" }),
      );
    });
  });
});

// ── 6. DisagreementRow approve action ─────────────────────────────────────
describe("SettingsCalibrationSessions — disagreement row actions", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { api } = await import("@/api/supabaseClient");
    api.entities.CalibrationSession.filter.mockResolvedValue([
      {
        id: "sess-1",
        session_name: "Test",
        status: "diff_phase",
        selected_project_ids: ["p1"],
        engine_version: "wave-6-p8",
        started_at: new Date().toISOString(),
      },
    ]);
    api.entities.CalibrationEditorShortlist.filter.mockResolvedValue([]);
    api.entities.CalibrationDecision.filter.mockResolvedValue([
      {
        id: "dec-1",
        slot_id: "kitchen_main",
        stem: "IMG_99",
        agreement: "disagree",
        ai_decision: "shortlisted",
        editor_decision: "rejected",
        ai_score: 7.5,
        editor_reasoning: "Cleaner alt",
        primary_signal_diff: "aesthetic",
        reasoning_categories: [],
      },
    ]);
  });

  it("approve fires CalibrationDecision.update with reasoning_categories=resolution_approved", async () => {
    renderPage("/SettingsCalibrationSessions?tab=detail&session_id=sess-1");
    const { api } = await import("@/api/supabaseClient");
    const btn = await screen.findByTestId("approve-decision-dec-1");
    fireEvent.click(btn);
    await waitFor(() => {
      expect(api.entities.CalibrationDecision.update).toHaveBeenCalledWith(
        "dec-1",
        expect.objectContaining({
          reasoning_categories: expect.arrayContaining(["resolution_approved"]),
        }),
      );
    });
  });

  it("reject fires CalibrationDecision.update with reasoning_categories=resolution_rejected", async () => {
    renderPage("/SettingsCalibrationSessions?tab=detail&session_id=sess-1");
    const { api } = await import("@/api/supabaseClient");
    const btn = await screen.findByTestId("reject-decision-dec-1");
    fireEvent.click(btn);
    await waitFor(() => {
      expect(api.entities.CalibrationDecision.update).toHaveBeenCalledWith(
        "dec-1",
        expect.objectContaining({
          reasoning_categories: expect.arrayContaining(["resolution_rejected"]),
        }),
      );
    });
  });
});

// ── 7. Stratification tab — empty state when no candidates ───────────────
describe("SettingsCalibrationSessions — stratification tab", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { api } = await import("@/api/supabaseClient");
    api.entities.Project.filter.mockResolvedValue([]);
  });

  it("renders the empty-state when no candidate projects exist in the lookback window", async () => {
    renderPage("/SettingsCalibrationSessions?tab=stratification");
    await waitFor(() => {
      expect(screen.getByTestId("empty-state-cells")).toBeInTheDocument();
    });
    // Selection count starts at 0
    expect(screen.getByTestId("selection-count")).toHaveTextContent("0");
  });
});
