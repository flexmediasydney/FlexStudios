/**
 * ObjectRegistryDiscoveryQueueTab — focused vitest suite (W12.B).
 *
 * Coverage:
 *   1. List request goes to the object-registry-admin edge fn with action=list_candidates.
 *   2. Approve fires { action: 'approve_candidate', candidate_id }.
 *   3. Reject opens a dialog that requires ≥3 char reason; submit fires
 *      { action: 'reject_candidate', candidate_id, reason }.
 *   4. Bulk select-all checkbox toggles ON visible rows up to the 50 cap.
 *   5. Empty state renders when total=0.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/supabaseClient", () => ({
  api: {
    functions: { invoke: vi.fn() },
    entities: {},
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

import ObjectRegistryDiscoveryQueueTab, {
  BULK_BATCH_CAP,
} from "../ObjectRegistryDiscoveryQueueTab";

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ObjectRegistryDiscoveryQueueTab />
    </QueryClientProvider>,
  );
}

const mockCandidates = (n) =>
  Array.from({ length: n }).map((_, i) => ({
    id: `cand-${i + 1}`,
    candidate_type: "object",
    proposed_canonical_label: `proposed_${i + 1}`,
    proposed_display_name: `Proposed ${i + 1}`,
    observed_count: 10 - i,
    first_proposed_at: new Date().toISOString(),
    proposed_level_0_class: "kitchen",
    similarity_to_existing: { matches: [] },
  }));

describe("ObjectRegistryDiscoveryQueueTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls list_candidates on mount", async () => {
    const { api } = await import("@/api/supabaseClient");
    api.functions.invoke.mockResolvedValue({ data: { candidates: [], total: 0 } });
    renderTab();
    await waitFor(() => {
      expect(api.functions.invoke).toHaveBeenCalledWith(
        "object-registry-admin",
        expect.objectContaining({
          action: "list_candidates",
          status: "pending",
        }),
      );
    });
  });

  it("renders the empty state when there are no candidates", async () => {
    const { api } = await import("@/api/supabaseClient");
    api.functions.invoke.mockResolvedValue({ data: { candidates: [], total: 0 } });
    renderTab();
    expect(
      await screen.findByText(/No candidates pending review/i),
    ).toBeInTheDocument();
  });

  it("approve action sends { action: approve_candidate, candidate_id }", async () => {
    const { api } = await import("@/api/supabaseClient");
    api.functions.invoke.mockImplementation(async (_fn, body) => {
      if (body?.action === "list_candidates") {
        return { data: { candidates: mockCandidates(2), total: 2 } };
      }
      if (body?.action === "approve_candidate") {
        return { data: { canonical_id: "approved" } };
      }
      return { data: {} };
    });

    renderTab();
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

  it("reject dialog requires reason ≥ 3 chars + submits with the reason", async () => {
    const { api } = await import("@/api/supabaseClient");
    api.functions.invoke.mockImplementation(async (_fn, body) => {
      if (body?.action === "list_candidates") {
        return { data: { candidates: mockCandidates(1), total: 1 } };
      }
      if (body?.action === "reject_candidate") {
        return { data: { status: "rejected" } };
      }
      return { data: {} };
    });

    renderTab();
    const reject = await screen.findByTestId("reject-button-cand-1");
    fireEvent.click(reject);

    const reasonInput = await screen.findByTestId("reject-reason-input");
    const submit = await screen.findByTestId("reject-submit-button");

    // Initially disabled (reason empty).
    expect(submit).toBeDisabled();

    // Typing a reason of length ≥ 3 enables submit.
    fireEvent.change(reasonInput, { target: { value: "duplicates" } });
    expect(submit).not.toBeDisabled();

    fireEvent.click(submit);
    await waitFor(() => {
      expect(api.functions.invoke).toHaveBeenCalledWith(
        "object-registry-admin",
        expect.objectContaining({
          action: "reject_candidate",
          candidate_id: "cand-1",
          reason: "duplicates",
        }),
      );
    });
  });

  it("BULK_BATCH_CAP exported as 50 (the spec contract)", () => {
    expect(BULK_BATCH_CAP).toBe(50);
  });

  it("bulk select-all toggles all visible rows", async () => {
    const { api } = await import("@/api/supabaseClient");
    api.functions.invoke.mockResolvedValue({
      data: { candidates: mockCandidates(3), total: 3 },
    });

    renderTab();
    const masterToggle = await screen.findByTestId("bulk-select-all");
    fireEvent.click(masterToggle);
    // After toggle, 3 selected.
    await waitFor(() => {
      expect(screen.getByTestId("bulk-count")).toHaveTextContent("3 selected");
    });
  });

  it("bulk action toolbar surfaces Merge + Reject when ≥1 selected", async () => {
    const { api } = await import("@/api/supabaseClient");
    api.functions.invoke.mockResolvedValue({
      data: { candidates: mockCandidates(2), total: 2 },
    });

    renderTab();
    const checkbox = await screen.findByTestId("row-checkbox-cand-1");
    fireEvent.click(checkbox);
    expect(await screen.findByTestId("bulk-merge-button")).toBeInTheDocument();
    expect(screen.getByTestId("bulk-reject-button")).toBeInTheDocument();
  });
});
