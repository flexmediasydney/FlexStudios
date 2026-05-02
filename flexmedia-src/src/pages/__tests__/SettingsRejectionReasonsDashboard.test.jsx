/**
 * SettingsRejectionReasonsDashboard — vitest suite (W11.6)
 *
 * Coverage strategy mirrors PulseMissedOpportunityCommandCenter.test.jsx:
 *   - Pure helpers exported and asserted directly (no DOM)
 *   - Route gate asserted against the routeAccess matrix
 *   - One render integration test per loading/empty/populated state
 *
 * Tests:
 *   1. Route gate — registered + master_admin only
 *   2. Pure helpers — clampDayWindow, heatmapRowTone, truncateLabel,
 *      formatStageTransition, buildTierSegments, tierTone, formatMetric,
 *      coverageTone, fmtUsdCost, totalCostTone
 *   3. Lockout when not master_admin
 *   4. Renders all six widget headings when master_admin
 *   5. RPC integration — empty payload (zero state on every widget)
 *   6. RPC integration — populated payload (rendered values appear)
 *   7. Day-window picker — clampDayWindow normalises invalid values
 *   8. Pluraliser smoke — STATUS string assertion (any new term)
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { canAccessRoute, ROUTE_ACCESS } from "@/components/lib/routeAccess";

// ── Mock supabase client BEFORE importing SUT ─────────────────────────────
vi.mock("@/api/supabaseClient", () => ({
  api: {
    rpc: vi.fn(),
    auth: { me: vi.fn(async () => ({ id: "mock-user" })) },
    functions: { invoke: vi.fn() },
    entities: {},
  },
}));

// ── Mock usePermissions so we can flip master_admin per-test ──────────────
vi.mock("@/components/auth/PermissionGuard", () => ({
  usePermissions: () => ({
    isMasterAdmin: globalThis.__W11_6_TEST_IS_MASTER_ADMIN__ ?? true,
    isAdminOrAbove: true,
    isOwner: globalThis.__W11_6_TEST_IS_MASTER_ADMIN__ ?? true,
  }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// SUT + helpers from each widget
import SettingsRejectionReasonsDashboard, {
  clampDayWindow,
} from "../SettingsRejectionReasonsDashboard";
import {
  heatmapRowTone,
  truncateLabel,
} from "@/components/settings/rejection/HumanOverrideHeatmap";
import { formatStageTransition } from "@/components/settings/rejection/Stage4SelfCorrectionPanel";
import {
  buildTierSegments,
  tierTone,
} from "@/components/settings/rejection/VoiceTierDistribution";
import { formatMetric } from "@/components/settings/rejection/MasterListingMetrics";
import { coverageTone } from "@/components/settings/rejection/RegistryCoverageWidget";
import {
  fmtUsdCost,
  totalCostTone,
} from "@/components/settings/rejection/CostAttributionWidget";

// ── 1. Route gate — W11.6.21 hard-cut ─────────────────────────────────────
describe("SettingsRejectionReasonsDashboard — route access (post W11.6.21)", () => {
  it("is NO LONGER registered in ROUTE_ACCESS (consolidated into umbrella)", () => {
    expect(ROUTE_ACCESS).not.toHaveProperty("SettingsRejectionReasonsDashboard");
  });
  it("unlisted route still defaults to master_admin only", () => {
    expect(canAccessRoute("SettingsRejectionReasonsDashboard", "master_admin")).toBe(true);
    for (const role of ["admin", "manager", "employee", "contractor"]) {
      expect(canAccessRoute("SettingsRejectionReasonsDashboard", role)).toBe(false);
    }
  });
});

// ── 2. Pure helpers ────────────────────────────────────────────────────────
describe("clampDayWindow", () => {
  it("returns valid day windows untouched", () => {
    expect(clampDayWindow(7)).toBe(7);
    expect(clampDayWindow(30)).toBe(30);
    expect(clampDayWindow(90)).toBe(90);
  });
  it("normalises strings", () => {
    expect(clampDayWindow("30")).toBe(30);
  });
  it("falls back to 30 on garbage input", () => {
    expect(clampDayWindow("abc")).toBe(30);
    expect(clampDayWindow(null)).toBe(30);
    expect(clampDayWindow(undefined)).toBe(30);
    expect(clampDayWindow(99999)).toBe(30);
  });
});

describe("heatmapRowTone", () => {
  it("applies red tone for top 25% of rows", () => {
    expect(heatmapRowTone(80, 100)).toContain("red");
  });
  it("applies amber tone for top 40-75%", () => {
    expect(heatmapRowTone(50, 100)).toContain("amber");
  });
  it("applies slate tone for bottom rows", () => {
    expect(heatmapRowTone(10, 100)).toContain("slate");
  });
  it("handles zero/null gracefully", () => {
    expect(heatmapRowTone(null, null)).toContain("slate");
    expect(heatmapRowTone(0, 0)).toContain("slate");
  });
});

describe("truncateLabel", () => {
  it("returns short labels untouched", () => {
    expect(truncateLabel("hello")).toBe("hello");
  });
  it("truncates with ellipsis", () => {
    const long = "a".repeat(100);
    const out = truncateLabel(long, 20);
    expect(out.length).toBe(20);
    expect(out.endsWith("…")).toBe(true);
  });
  it("handles null/non-string", () => {
    expect(truncateLabel(null)).toBe("—");
    expect(truncateLabel(undefined)).toBe("—");
    expect(truncateLabel(42)).toBe("—");
  });
});

describe("formatStageTransition", () => {
  it("formats two values", () => {
    expect(formatStageTransition("a", "b")).toBe("a → b");
  });
  it("renders null as (null)", () => {
    expect(formatStageTransition(null, "b")).toBe("(null) → b");
  });
});

describe("buildTierSegments", () => {
  it("returns empty array for no input", () => {
    expect(buildTierSegments([], 0)).toEqual([]);
    expect(buildTierSegments(null, 0)).toEqual([]);
  });
  it("computes per-segment percentages", () => {
    const segs = buildTierSegments(
      [
        { tier: "premium", count: 30 },
        { tier: "standard", count: 60 },
        { tier: "approachable", count: 10 },
      ],
      100,
    );
    expect(segs.length).toBe(3);
    expect(segs.find((s) => s.tier === "premium").pct).toBe(30);
    expect(segs.find((s) => s.tier === "standard").pct).toBe(60);
  });
  it("orders premium → standard → approachable", () => {
    const segs = buildTierSegments(
      [
        { tier: "approachable", count: 10 },
        { tier: "premium", count: 30 },
        { tier: "standard", count: 60 },
      ],
      100,
    );
    expect(segs[0].tier).toBe("premium");
    expect(segs[1].tier).toBe("standard");
    expect(segs[2].tier).toBe("approachable");
  });
});

describe("tierTone", () => {
  it("maps known tiers", () => {
    expect(tierTone("premium")).toContain("violet");
    expect(tierTone("standard")).toContain("blue");
    expect(tierTone("approachable")).toContain("emerald");
  });
  it("falls back to slate for unknown", () => {
    expect(tierTone("alien")).toContain("slate");
    expect(tierTone(null)).toContain("slate");
  });
});

describe("formatMetric", () => {
  it("formats integers without decimals", () => {
    expect(formatMetric(120)).toBe("120");
  });
  it("formats floats with one decimal by default", () => {
    expect(formatMetric(10.456)).toBe("10.5");
  });
  it("respects explicit decimals option", () => {
    expect(formatMetric(10, { decimals: 2 })).toBe("10.00");
  });
  it("handles null / NaN", () => {
    expect(formatMetric(null)).toBe("—");
    expect(formatMetric(undefined)).toBe("—");
    expect(formatMetric(NaN)).toBe("—");
  });
});

describe("coverageTone", () => {
  it("greens when ≥80%", () => {
    expect(coverageTone(90)).toContain("emerald");
  });
  it("ambers between 50% and 80%", () => {
    expect(coverageTone(70)).toContain("amber");
  });
  it("reds below 50%", () => {
    expect(coverageTone(30)).toContain("red");
  });
});

describe("fmtUsdCost", () => {
  it("formats >$1 with 2 decimals", () => {
    expect(fmtUsdCost(3.84)).toBe("$3.84");
  });
  it("formats sub-dollar with 3 decimals", () => {
    expect(fmtUsdCost(0.5)).toBe("$0.500");
  });
  it("formats sub-cent with 4 decimals", () => {
    expect(fmtUsdCost(0.0034)).toBe("$0.0034");
  });
  it("returns $0.00 for null/NaN", () => {
    expect(fmtUsdCost(null)).toBe("$0.00");
    expect(fmtUsdCost(NaN)).toBe("$0.00");
  });
});

describe("totalCostTone", () => {
  it("greens under $5", () => {
    expect(totalCostTone(3.84)).toContain("emerald");
  });
  it("ambers $5-$8", () => {
    expect(totalCostTone(6)).toContain("amber");
  });
  it("reds at or above $8", () => {
    expect(totalCostTone(10)).toContain("red");
  });
});

// ── 3-6. Render integration tests ──────────────────────────────────────────
describe("SettingsRejectionReasonsDashboard render", () => {
  function renderPage() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/SettingsRejectionReasonsDashboard"]}>
          <SettingsRejectionReasonsDashboard />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  beforeEach(() => {
    globalThis.__W11_6_TEST_IS_MASTER_ADMIN__ = true;
  });

  it("renders the master_admin lockout when not master_admin", async () => {
    globalThis.__W11_6_TEST_IS_MASTER_ADMIN__ = false;
    renderPage();
    expect(screen.getByText(/master_admin only/i)).toBeInTheDocument();
  });

  it("renders the page header for a master_admin (loading state)", async () => {
    const { api } = await import("@/api/supabaseClient");
    // Slow promise so the loading skeletons are visible
    api.rpc.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByText(/Rejection Reasons Dashboard/i)).toBeInTheDocument();
  });

  it("renders all six widgets with empty data without crashing", async () => {
    const { api } = await import("@/api/supabaseClient");
    api.rpc.mockResolvedValue({
      window_days: 30,
      computed_at: new Date().toISOString(),
      human_override_heatmap: { total: 0, top_labels: [] },
      stage4_self_corrections: { total: 0, by_field: [] },
      voice_tier_distribution: { total: 0, by_tier: [] },
      master_listing_metrics: {
        avg_word_count: 0,
        avg_reading_grade_level: 0,
        p50_word_count: 0,
        p95_word_count: 0,
        p50_reading_grade: 0,
        sample_size: 0,
      },
      canonical_registry_coverage: {
        total_objects: 0,
        resolved_count: 0,
        resolved_pct: 0,
        top_unresolved: [],
      },
      cost_per_stage: {
        window_days: 7,
        sample_size: 0,
        avg_stage1_cost_usd: 0,
        avg_stage4_cost_usd: 0,
        avg_total_cost_usd: 0,
        sum_total_cost_usd: 0,
        rounds_completed: 0,
        failover_rate_pct: 0,
      },
    });
    renderPage();
    // Wait for the empty-state markers to appear. These render after the
    // RPC settles AND the widget transitions out of its loading-skeleton
    // branch. Using findByTestId waits for the async transition; the rest
    // are sync after the first one resolves.
    await screen.findByTestId("heatmap-empty");
    expect(screen.getByTestId("stage4-empty")).toBeInTheDocument();
    expect(screen.getByTestId("voice-empty")).toBeInTheDocument();
    expect(screen.getByTestId("copy-empty")).toBeInTheDocument();
    expect(screen.getByTestId("coverage-empty")).toBeInTheDocument();
    expect(screen.getByTestId("cost-empty")).toBeInTheDocument();
    // Headings should appear at least once (widget heading + page subtitle).
    expect(screen.getAllByText(/Stage 4 self-corrections/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Voice tier distribution/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Master listing copy metrics/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Canonical registry coverage/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Cost-per-stage attribution/i).length).toBeGreaterThan(0);
  });

  it("renders populated data — every widget shows a value", async () => {
    const { api } = await import("@/api/supabaseClient");
    api.rpc.mockResolvedValue({
      window_days: 30,
      computed_at: new Date().toISOString(),
      human_override_heatmap: {
        total: 47,
        top_labels: [
          { raw_label: "room_type:exterior_rear", count: 12 },
          { raw_label: "shortlist_action:removed:cluttered_foreground", count: 8 },
        ],
      },
      stage4_self_corrections: {
        total: 23,
        by_field: [
          {
            field: "room_type",
            count: 14,
            samples: [
              {
                stem: "IMG_6193",
                stage_1_value: "exterior_front",
                stage_4_value: "exterior_rear",
                reason: "Hills hoist + hot-water unit visible.",
                created_at: new Date().toISOString(),
              },
            ],
          },
        ],
      },
      voice_tier_distribution: {
        total: 30,
        by_tier: [
          { tier: "standard", count: 18 },
          { tier: "premium", count: 9 },
          { tier: "approachable", count: 3 },
        ],
      },
      master_listing_metrics: {
        avg_word_count: 152,
        avg_reading_grade_level: 9.8,
        p50_word_count: 148,
        p95_word_count: 218,
        p50_reading_grade: 9.5,
        sample_size: 30,
      },
      canonical_registry_coverage: {
        total_objects: 12_400,
        resolved_count: 9_600,
        resolved_pct: 77.4,
        top_unresolved: [
          { raw_label: "designer Caesarstone bench", count: 18 },
        ],
      },
      cost_per_stage: {
        window_days: 7,
        sample_size: 22,
        avg_stage1_cost_usd: 2.21,
        avg_stage4_cost_usd: 1.62,
        avg_total_cost_usd: 3.83,
        sum_total_cost_usd: 84.26,
        rounds_completed: 22,
        failover_rate_pct: 4.5,
      },
    });
    renderPage();
    // Heatmap label appears
    expect(await screen.findByText(/room_type:exterior_rear/i)).toBeInTheDocument();
    // Stage 4 sample
    expect(screen.getByText(/Hills hoist/i)).toBeInTheDocument();
    // Voice tier — segments rendered (test legend has tiers)
    expect(screen.getAllByText(/standard/i).length).toBeGreaterThan(0);
    // Master listing metric tile
    expect(screen.getByText(/152/)).toBeInTheDocument();
    // Canonical coverage pct
    expect(screen.getByText(/77\.4%/)).toBeInTheDocument();
    // Cost — avg total
    expect(screen.getByText(/\$3\.83/)).toBeInTheDocument();
  });
});

// ── 7. Day-window picker — clampDayWindow handles invalid values ───────────
describe("Day-window picker normalisation", () => {
  it("invalid day windows fall back to 30", () => {
    expect(clampDayWindow("0")).toBe(30);
    expect(clampDayWindow(-1)).toBe(30);
    expect(clampDayWindow(45)).toBe(30); // not in [7,30,90]
  });
  it("string-encoded valid windows decode correctly", () => {
    expect(clampDayWindow("7")).toBe(7);
    expect(clampDayWindow("90")).toBe(90);
  });
});

// ── 8. Pluraliser / stable-text smoke ──────────────────────────────────────
//
// The dashboard text strings are part of the public surface for ops + docs
// search. This test asserts the new strings haven't drifted (it's a
// canary for accidental rewording during a refactor).
describe("Stable text contract", () => {
  it("clampDayWindow contract is exposed", () => {
    expect(typeof clampDayWindow).toBe("function");
  });
  it("widget headings contract — voice tier widget mentions 'voice tier'", async () => {
    // Smoke render
    const { api } = await import("@/api/supabaseClient");
    api.rpc.mockResolvedValue({
      window_days: 30,
      computed_at: new Date().toISOString(),
      human_override_heatmap: { total: 0, top_labels: [] },
      stage4_self_corrections: { total: 0, by_field: [] },
      voice_tier_distribution: { total: 0, by_tier: [] },
      master_listing_metrics: { sample_size: 0 },
      canonical_registry_coverage: { total_objects: 0, resolved_count: 0, resolved_pct: 0, top_unresolved: [] },
      cost_per_stage: { sample_size: 0, window_days: 7 },
    });
    globalThis.__W11_6_TEST_IS_MASTER_ADMIN__ = true;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/SettingsRejectionReasonsDashboard"]}>
          <SettingsRejectionReasonsDashboard />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // The widget heading should literally contain 'voice tier'
    expect(await screen.findByText(/voice tier/i)).toBeInTheDocument();
  });
});
