/**
 * SettingsShortlistingCommandCenter — vitest suite (W11.6.21 + W11.6.21b).
 *
 * Coverage:
 *   1. Route gate: registered + master_admin only (admin/manager/etc denied).
 *   2. Page renders all 19 tab triggers for master_admin.
 *   3. Default tab is "overview".
 *   4. URL ?tab=registry opens the Object Registry tab.
 *   5. resolveActiveTab pure helper handles unknown / missing input.
 *   6. KpiStrip renders zero-state without crashing on empty data.
 *   7. KpiStrip renders skeletons when loading.
 *   8. fmtUsd / fmtPct / fmtCount edge cases.
 *   9. summariseCalibrationStatuses formats correctly.
 *  10. Hard-cut: old standalone routes are no longer in ROUTE_ACCESS.
 *  11. W11.6.21b new tabs render without crashing (room types, standards,
 *      signals, calibration-ops, training, overrides-admin, prompts,
 *      engine-settings, vendor).
 *  12. W11.6.21b hard-cut: 9 additional standalone routes removed
 *      (room types ... vendor).
 *  13. Tab-key disambiguation: `calibration` vs `calibration-ops` and
 *      `overrides` vs `overrides-admin` resolve to distinct tabs.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
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
      rpc: vi.fn(async () => ({ data: {} })),
      auth: { me: vi.fn(async () => ({ id: "mock-user", role: "master_admin" })) },
      functions: { invoke: vi.fn() },
      entities: new Proxy(
        {},
        {
          get: () => ({
            filter: vi.fn(async () => []),
            list: vi.fn(async () => []),
            update: vi.fn(async () => ({})),
            create: vi.fn(async () => ({})),
          }),
        },
      ),
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

// Hooks used by inner pages we mount as tab content. Provide a no-op
// stub so the umbrella's render doesn't fail when one of those pages
// imports useActivePackages etc.
vi.mock("@/hooks/useActivePackages", () => ({
  // The hook returns { names: string[], isLoading, error } per
  // src/hooks/useActivePackages.js — the consumers destructure `names`.
  useActivePackages: () => ({
    names: [],
    data: [],
    isLoading: false,
    error: null,
  }),
}));

import SettingsShortlistingCommandCenter, {
  resolveActiveTab,
  VALID_TABS,
} from "../SettingsShortlistingCommandCenter";
import KpiStrip, {
  fmtUsd,
  fmtPct,
  fmtCount,
  summariseCalibrationStatuses,
} from "@/components/settings/shortlisting/KpiStrip";

function renderPage(initialPath = "/SettingsShortlistingCommandCenter") {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <SettingsShortlistingCommandCenter />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ── 1. Route gate ──────────────────────────────────────────────────────────
describe("SettingsShortlistingCommandCenter — route access", () => {
  it("is registered in ROUTE_ACCESS", () => {
    expect(ROUTE_ACCESS).toHaveProperty("SettingsShortlistingCommandCenter");
  });

  it("master_admin can access", () => {
    expect(
      canAccessRoute("SettingsShortlistingCommandCenter", "master_admin"),
    ).toBe(true);
  });

  it("admin / manager / employee / contractor cannot access", () => {
    for (const role of ["admin", "manager", "employee", "contractor"]) {
      expect(canAccessRoute("SettingsShortlistingCommandCenter", role)).toBe(
        false,
      );
    }
  });
});

// ── 2. Hard-cut: old routes have been removed ──────────────────────────────
describe("W11.6.21 hard-cut — old standalone routes removed", () => {
  const consolidatedRoutes = [
    // W11.6.21 (first sweep)
    "SettingsTierConfigs",
    "SettingsPackageTierMapping",
    "SettingsShortlistingSlots",
    "SettingsObjectRegistry",
    "SettingsObjectRegistryDiscovery",
    "SettingsAISuggestions",
    "SettingsRejectionReasonsDashboard",
    "SettingsCalibrationSessions",
    "SettingsEngineOverridePatterns",
    // W11.6.21b (second sweep)
    "SettingsShortlistingRoomTypes",
    "SettingsShortlistingStandards",
    "SettingsShortlistingSignals",
    "ShortlistingCalibration",
    "SettingsShortlistingTraining",
    "SettingsShortlistingOverrides",
    "SettingsShortlistingPrompts",
    "SettingsEngineSettings",
    "SettingsVendorComparison",
  ];

  for (const r of consolidatedRoutes) {
    it(`${r} is no longer registered (consolidated into umbrella)`, () => {
      expect(ROUTE_ACCESS).not.toHaveProperty(r);
    });
  }

  it("unlisted consolidated routes still default to master_admin only", () => {
    for (const r of consolidatedRoutes) {
      expect(canAccessRoute(r, "master_admin")).toBe(true);
      expect(canAccessRoute(r, "admin")).toBe(false);
      expect(canAccessRoute(r, "manager")).toBe(false);
    }
  });

  it("unlisted consolidated routes are NOT in the PAGES map", async () => {
    // Simulates a hard 404 — App.jsx/RouteGuard look up the route name in
    // PAGES; missing key → no React route mounted → URL falls through.
    const { PAGES } = await import("@/pages.config");
    for (const r of consolidatedRoutes) {
      expect(PAGES).not.toHaveProperty(r);
    }
  });
});

// ── 3. Page render — 19 tabs ───────────────────────────────────────────────
describe("SettingsShortlistingCommandCenter — render", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders all 19 tab triggers (W11.6.21 ten + W11.6.21b nine)", () => {
    renderPage();
    // W11.6.21
    expect(screen.getByTestId("tab-overview")).toBeTruthy();
    expect(screen.getByTestId("tab-tiers")).toBeTruthy();
    expect(screen.getByTestId("tab-mappings")).toBeTruthy();
    expect(screen.getByTestId("tab-slots")).toBeTruthy();
    expect(screen.getByTestId("tab-registry")).toBeTruthy();
    expect(screen.getByTestId("tab-suggestions")).toBeTruthy();
    expect(screen.getByTestId("tab-rejection")).toBeTruthy();
    expect(screen.getByTestId("tab-calibration")).toBeTruthy();
    expect(screen.getByTestId("tab-overrides")).toBeTruthy();
    expect(screen.getByTestId("tab-discovery")).toBeTruthy();
    // W11.6.21b
    expect(screen.getByTestId("tab-roomtypes")).toBeTruthy();
    expect(screen.getByTestId("tab-standards")).toBeTruthy();
    expect(screen.getByTestId("tab-signals")).toBeTruthy();
    expect(screen.getByTestId("tab-calibration-ops")).toBeTruthy();
    expect(screen.getByTestId("tab-training")).toBeTruthy();
    expect(screen.getByTestId("tab-overrides-admin")).toBeTruthy();
    expect(screen.getByTestId("tab-prompts")).toBeTruthy();
    expect(screen.getByTestId("tab-engine-settings")).toBeTruthy();
    expect(screen.getByTestId("tab-vendor")).toBeTruthy();
  });

  it("default tab is overview when no ?tab= query param", () => {
    renderPage("/SettingsShortlistingCommandCenter");
    expect(screen.getByTestId("overview-tab")).toBeTruthy();
  });

  it("?tab=invalid_value falls back to overview", () => {
    renderPage("/SettingsShortlistingCommandCenter?tab=NOT_A_REAL_TAB");
    expect(screen.getByTestId("overview-tab")).toBeTruthy();
  });

  // ── W11.6.21b: each new tab mounts without crashing ───────────────────
  // Mounting the umbrella with each ?tab= deep-link is the cheapest way
  // to verify the tab routes don't throw at import or render time.
  it.each([
    ["roomtypes"],
    ["standards"],
    ["signals"],
    ["calibration-ops"],
    ["training"],
    ["overrides-admin"],
    ["prompts"],
    ["engine-settings"],
    ["vendor"],
  ])("?tab=%s mounts the umbrella without crashing", (key) => {
    renderPage(`/SettingsShortlistingCommandCenter?tab=${key}`);
    expect(
      screen.getByTestId("settings-shortlisting-command-center"),
    ).toBeTruthy();
    // The trigger for the requested tab is present (active state).
    expect(screen.getByTestId(`tab-${key}`)).toBeTruthy();
  });
});

// ── 4. resolveActiveTab pure helper ────────────────────────────────────────
describe("resolveActiveTab", () => {
  it("returns the tab when valid", () => {
    expect(resolveActiveTab("overview")).toBe("overview");
    expect(resolveActiveTab("registry")).toBe("registry");
    expect(resolveActiveTab("calibration")).toBe("calibration");
  });

  it("returns overview for unknown values", () => {
    expect(resolveActiveTab("unknown")).toBe("overview");
    expect(resolveActiveTab("")).toBe("overview");
    expect(resolveActiveTab(null)).toBe("overview");
    expect(resolveActiveTab(undefined)).toBe("overview");
    expect(resolveActiveTab(42)).toBe("overview");
  });

  it("VALID_TABS exports the expected 19-entry set (W11.6.21 + W11.6.21b)", () => {
    expect(VALID_TABS).toEqual([
      // W11.6.21
      "overview",
      "tiers",
      "mappings",
      "slots",
      "registry",
      "suggestions",
      "rejection",
      "calibration",
      "overrides",
      "discovery",
      // W11.6.21b
      "roomtypes",
      "standards",
      "signals",
      "calibration-ops",
      "training",
      "overrides-admin",
      "prompts",
      "engine-settings",
      "vendor",
    ]);
  });

  it("W11.6.21b new tabs resolve via resolveActiveTab", () => {
    expect(resolveActiveTab("roomtypes")).toBe("roomtypes");
    expect(resolveActiveTab("standards")).toBe("standards");
    expect(resolveActiveTab("signals")).toBe("signals");
    expect(resolveActiveTab("calibration-ops")).toBe("calibration-ops");
    expect(resolveActiveTab("training")).toBe("training");
    expect(resolveActiveTab("overrides-admin")).toBe("overrides-admin");
    expect(resolveActiveTab("prompts")).toBe("prompts");
    expect(resolveActiveTab("engine-settings")).toBe("engine-settings");
    expect(resolveActiveTab("vendor")).toBe("vendor");
  });

  it("calibration vs calibration-ops are distinct (W11.6.21b disambiguation)", () => {
    expect(resolveActiveTab("calibration")).toBe("calibration");
    expect(resolveActiveTab("calibration-ops")).toBe("calibration-ops");
    expect(resolveActiveTab("calibration")).not.toBe(
      resolveActiveTab("calibration-ops"),
    );
  });

  it("overrides vs overrides-admin are distinct (W11.6.21b disambiguation)", () => {
    expect(resolveActiveTab("overrides")).toBe("overrides");
    expect(resolveActiveTab("overrides-admin")).toBe("overrides-admin");
    expect(resolveActiveTab("overrides")).not.toBe(
      resolveActiveTab("overrides-admin"),
    );
  });

  it("VALID_TABS has no duplicates", () => {
    expect(new Set(VALID_TABS).size).toBe(VALID_TABS.length);
  });
});

// ── 5. KpiStrip ────────────────────────────────────────────────────────────
describe("KpiStrip", () => {
  function renderStrip(props) {
    return render(<KpiStrip {...props} />);
  }

  it("renders skeletons when loading", () => {
    renderStrip({ loading: true });
    expect(screen.getByTestId("kpi-strip-loading")).toBeTruthy();
  });

  it("renders all 7 tiles when data is present (with sane defaults for missing fields)", () => {
    renderStrip({ data: {}, loading: false });
    const strip = screen.getByTestId("kpi-strip");
    expect(strip).toBeTruthy();
    // All 7 KPI tiles render even with zero data.
    expect(screen.getByTestId("kpi-todays-spend-value")).toBeTruthy();
    expect(screen.getByTestId("kpi-rounds-today-value")).toBeTruthy();
    expect(screen.getByTestId("kpi-avg-round-cost-value")).toBeTruthy();
    expect(screen.getByTestId("kpi-v2-rollout-value")).toBeTruthy();
    expect(screen.getByTestId("kpi-override-rate-value")).toBeTruthy();
    expect(screen.getByTestId("kpi-calibration-sessions-value")).toBeTruthy();
    expect(screen.getByTestId("kpi-object-registry-value")).toBeTruthy();
  });

  it("renders without crashing on null data", () => {
    renderStrip({ data: null, loading: false });
    expect(screen.getByTestId("kpi-strip")).toBeTruthy();
  });

  it("displays formatted values from a populated data object", () => {
    renderStrip({
      data: {
        todays_spend_usd: 12.5,
        rounds_today: 7,
        avg_round_cost_usd_7d: 3.45,
        v2_vision_rollout_pct: 16.7,
        v2_vision_total: 17811,
        v2_vision_match: 2972,
        override_rate_7d_pct: 39.1,
        override_count_7d: 25,
        slot_decision_count_7d: 64,
        calibration_session_total: 0,
        calibration_session_by_status: {},
        object_registry_size: 191,
        object_queue_pending: 306,
        window_days: 7,
      },
      loading: false,
    });
    expect(screen.getByTestId("kpi-todays-spend-value").textContent).toBe(
      "$12.50",
    );
    expect(screen.getByTestId("kpi-rounds-today-value").textContent).toBe("7");
    expect(
      screen.getByTestId("kpi-override-rate-value").textContent,
    ).toContain("39.1");
  });
});

// ── 6. Pure formatters ─────────────────────────────────────────────────────
describe("KpiStrip formatters", () => {
  it("fmtUsd handles standard cases", () => {
    expect(fmtUsd(0)).toBe("$0.00");
    expect(fmtUsd(3.5)).toBe("$3.50");
    expect(fmtUsd(0.005)).toBe("$0.0050");
    expect(fmtUsd(null)).toBe("$0.00");
    expect(fmtUsd(undefined)).toBe("$0.00");
    expect(fmtUsd("not a number")).toBe("$0.00");
  });

  it("fmtPct formats percent values", () => {
    expect(fmtPct(39.1)).toBe("39.1%");
    expect(fmtPct(0)).toBe("0.0%");
    expect(fmtPct(null)).toBe("—");
    expect(fmtPct(undefined)).toBe("—");
    expect(fmtPct("not a number")).toBe("—");
  });

  it("fmtCount formats integer counts", () => {
    expect(fmtCount(1234)).toBe("1,234");
    expect(fmtCount(0)).toBe("0");
    expect(fmtCount(null)).toBe("0");
    expect(fmtCount(undefined)).toBe("0");
  });
});

// ── 7. summariseCalibrationStatuses ────────────────────────────────────────
describe("summariseCalibrationStatuses", () => {
  it("returns empty string for null / non-objects", () => {
    expect(summariseCalibrationStatuses(null)).toBe("");
    expect(summariseCalibrationStatuses(undefined)).toBe("");
    expect(summariseCalibrationStatuses("not an object")).toBe("");
  });

  it("returns empty string when all counts are zero", () => {
    expect(
      summariseCalibrationStatuses({ open: 0, completed: 0 }),
    ).toBe("");
  });

  it("formats top 3 sorted by count desc", () => {
    const result = summariseCalibrationStatuses({
      open: 5,
      editor_phase: 12,
      diff_phase: 3,
      completed: 7,
    });
    expect(result).toBe("12 editor_phase · 7 completed · 5 open");
  });

  it("filters zero counts and sorts remaining", () => {
    const result = summariseCalibrationStatuses({
      open: 0,
      editor_phase: 4,
      completed: 1,
    });
    expect(result).toBe("4 editor_phase · 1 completed");
  });
});

// ── 8. W11.6.21b — internal-link redirect verification ─────────────────────
// Two `<Link to=...>` references inside engine pages were updated to point
// at the umbrella with the right ?tab= query. Static-source assertions
// guard against regressions where someone restores the old standalone URL.
describe("W11.6.21b — internal-link redirects", () => {
  it("EngineDashboard links to overrides-admin via the umbrella", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = await fs.readFile(
      path.resolve(__dirname, "../EngineDashboard.jsx"),
      "utf8",
    );
    expect(file).toContain(
      "/SettingsShortlistingCommandCenter?tab=overrides-admin",
    );
    expect(file).not.toMatch(/to="\/SettingsShortlistingOverrides"/);
  });

  it("SettingsEngineOverridePatterns links to engine-settings via the umbrella", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = await fs.readFile(
      path.resolve(__dirname, "../SettingsEngineOverridePatterns.jsx"),
      "utf8",
    );
    expect(file).toContain(
      "/SettingsShortlistingCommandCenter?tab=engine-settings",
    );
    expect(file).not.toMatch(/to="\/SettingsEngineSettings"/);
  });
});
