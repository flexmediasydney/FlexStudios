/**
 * W15b.8 — PulseListingVisionTab integration tests.
 *
 * These exercise the empty / loading / fresh / failed branches via mocked
 * supabase client. We don't bring up @tanstack/react-query against a real
 * network — the queryFn fetches via supabase.from(...).select(...), and we
 * mock that chain to return canned data per scenario.
 *
 * Run: npx vitest run flexmedia-src/src/components/pulse/listing-detail/__tests__/PulseListingVisionTab.test.jsx
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Supabase client: chain-mock the .from(table).select().eq()...maybeSingle/limit
const mockFrom = vi.fn();

vi.mock("@/api/supabaseClient", () => ({
  api: {
    functions: { invoke: vi.fn(async () => ({ data: { ok: true } })) },
  },
  supabase: {
    from: (...args) => mockFrom(...args),
  },
}));

// Permissions mock — flip to control master_admin gating in tests
let __mockIsMasterAdmin = false;
vi.mock("@/components/auth/PermissionGuard", () => ({
  usePermissions: () => ({ isMasterAdmin: __mockIsMasterAdmin }),
}));

// Lightbox / dialog deps — render to nothing, we don't exercise them here
vi.mock("../ExternalListingLightbox", () => ({
  default: () => null,
}));
vi.mock("../ManualClassifyDialog", () => ({
  default: () => null,
}));

// ── helpers ──────────────────────────────────────────────────────────────────

function makeChain({ extracts = null, classifications = [] } = {}) {
  // Returns a function that reads (table, ...) and returns a chainable object
  // with .select(), .eq(), .order(), .limit(), .maybeSingle()
  return (table) => {
    const rows = table === "pulse_listing_vision_extracts" ? extracts : classifications;
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => Promise.resolve({ data: rows, error: null }),
      maybeSingle: () => Promise.resolve({ data: rows?.[0] ?? null, error: null }),
    };
    return chain;
  };
}

function renderTab(ui) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
    },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

// ── tests ────────────────────────────────────────────────────────────────────

import PulseListingVisionTab from "../PulseListingVisionTab";

const LISTING = { id: "lst-abc", media_items: [], images: [] };

describe("PulseListingVisionTab", () => {
  beforeEach(() => {
    mockFrom.mockReset();
    __mockIsMasterAdmin = false;
  });

  it("shows empty state when no extract row exists", async () => {
    mockFrom.mockImplementation(makeChain({ extracts: [] }));
    renderTab(<PulseListingVisionTab listing={LISTING} />);
    await waitFor(() => {
      expect(screen.getByTestId("vision-empty-state")).toBeInTheDocument();
    });
    expect(screen.getByText(/Vision analysis hasn't been run yet/i)).toBeInTheDocument();
    // Run-now hidden for non-master_admin
    expect(screen.queryByTestId("run-now-btn")).toBeNull();
  });

  it("shows Run now button on empty state for master_admin", async () => {
    __mockIsMasterAdmin = true;
    mockFrom.mockImplementation(makeChain({ extracts: [] }));
    renderTab(<PulseListingVisionTab listing={LISTING} />);
    await waitFor(() => {
      expect(screen.getByTestId("run-now-btn")).toBeInTheDocument();
    });
  });

  it("renders aggregate card + image grid when extract is fresh and classifications exist", async () => {
    const FRESH = {
      id: "ext-1",
      listing_id: LISTING.id,
      schema_version: "v1.0",
      status: "succeeded",
      extracted_at: "2026-04-30T12:00:00Z",
      photo_breakdown: { day_count: 5, dusk_count: 2, total_images: 7 },
      video_breakdown: null,
      competitor: {},
      total_cost_usd: 0.1,
    };
    const CLASSES = [
      {
        id: "cc-1",
        filename: "img1.jpg",
        image_type: "is_day",
        source_image_url: "https://example.com/1.jpg",
        analysis: "Day exterior shot.",
        external_specific: { package_signals: [] },
      },
      {
        id: "cc-2",
        filename: "img2.jpg",
        image_type: "is_dusk",
        source_image_url: "https://example.com/2.jpg",
        analysis: "Dusk image.",
        external_specific: { package_signals: ["dusk_lighting"] },
      },
    ];
    mockFrom.mockImplementation(makeChain({ extracts: [FRESH], classifications: CLASSES }));
    renderTab(<PulseListingVisionTab listing={LISTING} />);
    await waitFor(() => {
      expect(screen.getByTestId("vision-aggregate-card")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId("vision-image-grid")).toBeInTheDocument();
    });
    const cards = screen.getAllByTestId("vision-image-card");
    expect(cards).toHaveLength(2);
  });

  it("renders empty-classifications message when extract exists but no per-image rows", async () => {
    const FRESH = {
      id: "ext-1",
      listing_id: LISTING.id,
      status: "succeeded",
      photo_breakdown: { total_images: 0 },
    };
    mockFrom.mockImplementation(makeChain({ extracts: [FRESH], classifications: [] }));
    renderTab(<PulseListingVisionTab listing={LISTING} />);
    await waitFor(() => {
      expect(screen.getByTestId("vision-aggregate-card")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId("empty-classifications")).toBeInTheDocument();
    });
  });

  it("uses responsive grid classes (grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4)", async () => {
    const FRESH = {
      id: "ext-1",
      listing_id: LISTING.id,
      status: "succeeded",
      photo_breakdown: { total_images: 1 },
    };
    const CLASSES = [
      { id: "cc-1", filename: "x.jpg", image_type: "is_day", source_image_url: "x", external_specific: {} },
    ];
    mockFrom.mockImplementation(makeChain({ extracts: [FRESH], classifications: CLASSES }));
    renderTab(<PulseListingVisionTab listing={LISTING} />);
    await waitFor(() => {
      expect(screen.getByTestId("vision-image-grid")).toBeInTheDocument();
    });
    const grid = screen.getByTestId("vision-image-grid");
    const cls = grid.className;
    // Verify the breakpoint classes — these are what the brief calls out for
    // mobile-friendly behaviour (1 col mobile, 2 col tablet, 3+ col desktop).
    expect(cls).toContain("grid-cols-1");
    expect(cls).toContain("sm:grid-cols-2");
    expect(cls).toContain("lg:grid-cols-3");
    expect(cls).toContain("xl:grid-cols-4");
  });
});
