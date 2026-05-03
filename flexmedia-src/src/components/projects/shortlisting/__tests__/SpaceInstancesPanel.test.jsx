/**
 * SpaceInstancesPanel — W11.8 audit panel tests.
 *
 * Validates the four operator affordances (list / rename / split / merge),
 * the low-confidence badge, and the Show-merged toggle.
 *
 * Run: npx vitest run flexmedia-src/src/components/projects/shortlisting/__tests__/SpaceInstancesPanel.test.jsx
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockRpc = vi.fn();
const mockEntityFilter = vi.fn();

vi.mock("@/api/supabaseClient", () => ({
  api: {
    rpc: (...args) => mockRpc(...args),
    entities: {
      CompositionGroup: { filter: (...args) => mockEntityFilter(...args) },
    },
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

// DroneThumbnail performs a Dropbox preview fetch — stub to keep tests pure.
vi.mock("@/components/drone/DroneThumbnail", () => ({
  default: ({ alt }) => (
    <div data-testid="thumb-stub" aria-label={alt || "thumb"} />
  ),
}));

import SpaceInstancesPanel from "../audit/SpaceInstancesPanel";

const ROUND_ID = "round-uuid-001";

const SAMPLE_LIVING_PRIMARY = {
  id: "inst-living-1",
  round_id: ROUND_ID,
  space_type: "LIVING_ROOM_DEDICATED",
  instance_index: 1,
  display_label: "Living room",
  display_label_source: "engine_derived",
  dominant_colors: ["white", "timber"],
  distinctive_features: ["fireplace"],
  representative_group_id: "g-1",
  representative_dropbox_path: "/proj/group_1.jpg",
  member_group_count: 5,
  member_group_ids: ["g-1", "g-2", "g-3", "g-4", "g-5"],
  cluster_confidence: 0.92,
  operator_renamed: false,
  operator_split_from: null,
  operator_merged_into: null,
};

const SAMPLE_LIVING_SECONDARY = {
  id: "inst-living-2",
  round_id: ROUND_ID,
  space_type: "LIVING_ROOM_DEDICATED",
  instance_index: 2,
  display_label: "Living room 2",
  display_label_source: "engine_derived",
  dominant_colors: ["carpet"],
  distinctive_features: ["panelled walls"],
  representative_group_id: "g-6",
  representative_dropbox_path: "/proj/group_6.jpg",
  member_group_count: 3,
  member_group_ids: ["g-6", "g-7", "g-8"],
  cluster_confidence: 0.55, // low-confidence → uncertain badge
  operator_renamed: false,
  operator_split_from: null,
  operator_merged_into: null,
};

const SAMPLE_KITCHEN = {
  id: "inst-kitchen-1",
  round_id: ROUND_ID,
  space_type: "KITCHEN_DEDICATED",
  instance_index: 1,
  display_label: "Kitchen",
  display_label_source: "engine_derived",
  dominant_colors: ["white"],
  distinctive_features: ["island bench"],
  representative_group_id: "g-9",
  representative_dropbox_path: "/proj/group_9.jpg",
  member_group_count: 4,
  member_group_ids: ["g-9", "g-10", "g-11", "g-12"],
  cluster_confidence: 0.88,
  operator_renamed: false,
  operator_split_from: null,
  operator_merged_into: null,
};

function createWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function setListResponse(rows) {
  mockRpc.mockImplementation(async (name) => {
    if (name === "list_space_instances") return rows;
    if (name === "rename_space_instance") return null;
    if (name === "merge_space_instances") return null;
    if (name === "split_space_instances") return "new-uuid";
    return null;
  });
}

describe("SpaceInstancesPanel", () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockEntityFilter.mockReset();
    mockEntityFilter.mockResolvedValue([
      {
        id: "g-6",
        delivery_reference_stem: "IMG_4001",
        dropbox_preview_path: "/proj/group_6.jpg",
      },
      {
        id: "g-7",
        delivery_reference_stem: "IMG_4002",
        dropbox_preview_path: "/proj/group_7.jpg",
      },
      {
        id: "g-8",
        delivery_reference_stem: "IMG_4003",
        dropbox_preview_path: "/proj/group_8.jpg",
      },
    ]);
  });

  it("renders instances grouped by space_type", async () => {
    setListResponse([SAMPLE_LIVING_PRIMARY, SAMPLE_LIVING_SECONDARY, SAMPLE_KITCHEN]);
    render(<SpaceInstancesPanel roundId={ROUND_ID} />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(
        screen.getByTestId("space-instance-card-inst-living-1"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId("space-instance-card-inst-living-2"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("space-instance-card-inst-kitchen-1"),
    ).toBeInTheDocument();

    // Headers expose member counts.
    expect(screen.getByTestId("space-instance-group-LIVING_ROOM_DEDICATED").textContent).toMatch(
      /2 instances detected/,
    );
    expect(screen.getByTestId("space-instance-group-KITCHEN_DEDICATED").textContent).toMatch(
      /1 instance detected/,
    );
  });

  it("shows the uncertain badge when cluster_confidence < 0.7", async () => {
    setListResponse([SAMPLE_LIVING_PRIMARY, SAMPLE_LIVING_SECONDARY]);
    render(<SpaceInstancesPanel roundId={ROUND_ID} />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(screen.getByTestId("low-confidence-badge-inst-living-2")).toBeInTheDocument(),
    );
    // High-confidence row does NOT carry the badge.
    expect(screen.queryByTestId("low-confidence-badge-inst-living-1")).toBeNull();
  });

  it("opens and submits the rename dialog → calls rename_space_instance RPC", async () => {
    setListResponse([SAMPLE_LIVING_PRIMARY]);
    render(<SpaceInstancesPanel roundId={ROUND_ID} />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(screen.getByTestId("rename-instance-btn-inst-living-1")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("rename-instance-btn-inst-living-1"));

    const dialog = await screen.findByTestId("rename-instance-dialog");
    expect(dialog).toBeInTheDocument();
    const input = within(dialog).getByTestId("rename-instance-input");
    fireEvent.change(input, { target: { value: "Lounge" } });
    fireEvent.click(within(dialog).getByTestId("rename-instance-submit"));

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith("rename_space_instance", {
        p_instance_id: "inst-living-1",
        p_new_label: "Lounge",
      });
    });
  });

  it("opens and submits the merge dialog → calls merge_space_instances RPC", async () => {
    setListResponse([SAMPLE_LIVING_PRIMARY, SAMPLE_LIVING_SECONDARY]);
    render(<SpaceInstancesPanel roundId={ROUND_ID} />, { wrapper: createWrapper() });

    // Merge button only renders for instance_index > 1 → secondary card.
    await waitFor(() =>
      expect(screen.getByTestId("merge-instance-btn-inst-living-2")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("merge-instance-btn-inst-living-1")).toBeNull();

    fireEvent.click(screen.getByTestId("merge-instance-btn-inst-living-2"));
    const dialog = await screen.findByTestId("merge-instance-dialog");
    fireEvent.click(within(dialog).getByTestId("merge-instance-submit"));

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith("merge_space_instances", {
        p_keep_id: "inst-living-1",
        p_drop_id: "inst-living-2",
      });
    });
  });

  it("opens and submits the split dialog → calls split_space_instances RPC", async () => {
    setListResponse([SAMPLE_LIVING_SECONDARY]);
    render(<SpaceInstancesPanel roundId={ROUND_ID} />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(screen.getByTestId("split-instance-btn-inst-living-2")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("split-instance-btn-inst-living-2"));

    const dialog = await screen.findByTestId("split-instance-dialog");
    expect(dialog).toBeInTheDocument();

    // Wait for the lazy-loaded composition_groups to materialise inside the
    // dialog (mockEntityFilter resolves with 3 rows in beforeEach).
    await waitFor(() =>
      expect(within(dialog).getByTestId("split-instance-group-g-6")).toBeInTheDocument(),
    );

    // Toggle the first group's checkbox via clicking its row.
    const row = within(dialog).getByTestId("split-instance-group-g-6");
    fireEvent.click(within(row).getByRole("checkbox"));

    fireEvent.change(within(dialog).getByTestId("split-instance-new-label"), {
      target: { value: "Studio" },
    });

    fireEvent.click(within(dialog).getByTestId("split-instance-submit"));

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith("split_space_instances", {
        p_source_id: "inst-living-2",
        p_group_ids_to_split: ["g-6"],
        p_new_label: "Studio",
      });
    });
  });

  it("refresh button triggers a re-fetch", async () => {
    setListResponse([SAMPLE_LIVING_PRIMARY]);
    render(<SpaceInstancesPanel roundId={ROUND_ID} />, { wrapper: createWrapper() });

    // Wait for the first fetch to settle (card mounted) so the Refresh
    // button isn't disabled by isFetching=true.
    await waitFor(() =>
      expect(screen.getByTestId("space-instance-card-inst-living-1")).toBeInTheDocument(),
    );
    expect(mockRpc).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("space-instances-refresh"));
    await waitFor(() => expect(mockRpc.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("show-merged toggle re-fetches with p_include_merged=true", async () => {
    setListResponse([SAMPLE_LIVING_PRIMARY]);
    render(<SpaceInstancesPanel roundId={ROUND_ID} />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith("list_space_instances", {
        p_round_id: ROUND_ID,
        p_include_merged: false,
      }),
    );

    fireEvent.click(screen.getByTestId("space-instances-show-merged"));

    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith("list_space_instances", {
        p_round_id: ROUND_ID,
        p_include_merged: true,
      }),
    );
  });

  it("renders an empty state when no instances are detected", async () => {
    setListResponse([]);
    render(<SpaceInstancesPanel roundId={ROUND_ID} />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(screen.getByText(/No space instances detected/i)).toBeInTheDocument(),
    );
  });

  it("does not render Rename/Split/Merge for soft-deleted (merged) rows", async () => {
    const merged = {
      ...SAMPLE_LIVING_SECONDARY,
      operator_merged_into: SAMPLE_LIVING_PRIMARY.id,
    };
    setListResponse([SAMPLE_LIVING_PRIMARY, merged]);
    render(<SpaceInstancesPanel roundId={ROUND_ID} />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(screen.getByTestId("space-instance-card-inst-living-2")).toBeInTheDocument(),
    );
    // Action buttons hidden for the merged row.
    expect(screen.queryByTestId("rename-instance-btn-inst-living-2")).toBeNull();
    expect(screen.queryByTestId("split-instance-btn-inst-living-2")).toBeNull();
    expect(screen.queryByTestId("merge-instance-btn-inst-living-2")).toBeNull();
  });
});
