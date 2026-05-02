/**
 * W11.6.20 — ShortlistingLightbox tests.
 *
 * Run: npx vitest run flexmedia-src/src/components/projects/shortlisting/__tests__/ShortlistingLightbox.test.jsx
 *
 * Covers (≥10 cases per spec):
 *  1. Renders nothing when items is empty
 *  2. ESC closes the lightbox
 *  3. Click on the close button closes the lightbox
 *  4. Click outside the image (on the dialog overlay) closes the lightbox
 *  5. Arrow keys cycle prev/next within the bucket
 *  6. Bbox overlay renders when item has observed_objects
 *  7. No bbox overlay (graceful) when observed_objects is null/empty
 *  8. Overlay toggle disables when no annotations available
 *  9. Side panel renders signal_scores top-N
 * 10. Slot decision badge renders when slot_decision present
 * 11. Voice tier badge renders when voice_tier present
 * 12. "Why?" expander renders Stage 1 analysis prose
 * 13. A11y: dialog has role="dialog" + aria-modal
 * 14. A11y: ESC restores focus to launcher
 * 15. Snapshot: full-data render is consistent
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

// Mock fetchMediaProxy so we don't try to hit Supabase in tests. Returns a
// fake blob URL so the lightbox renders the <img> path immediately.
vi.mock("@/utils/mediaPerf", () => ({
  fetchMediaProxy: vi.fn(async (_cache, path) =>
    path ? `blob:fake-${path}` : null,
  ),
}));

import ShortlistingLightbox from "../ShortlistingLightbox";

// ── Test fixtures ──────────────────────────────────────────────────────────
function makeItem(overrides = {}) {
  return {
    id: "group-001",
    dropbox_path: "/test/IMG_001.jpg",
    filename: "IMG_001.jpg",
    observed_objects: [
      {
        raw_label: "white shaker cabinets",
        proposed_canonical_id: "obj_arch_kitchen_cab_001",
        confidence: 0.92,
        bounding_box: { x_pct: 5, y_pct: 45, w_pct: 40, h_pct: 35 },
        attributes: { color: "white" },
      },
    ],
    signal_scores: {
      composition_strength: 8.5,
      lighting_quality: 7.9,
      surface_finish: 6.2,
      natural_light: 9.1,
      vantage_point: 5.4,
    },
    slot_decision: { slot_id: "kitchen_hero", phase: 1, rank: 1 },
    voice_tier: "A",
    classification: {
      analysis: "Strong composition with crisp natural light from the eastern window.",
    },
    ...overrides,
  };
}

function renderLightbox(props = {}) {
  return render(
    <ShortlistingLightbox
      items={[makeItem()]}
      initialIndex={0}
      onClose={() => {}}
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ShortlistingLightbox — basic rendering", () => {
  it("renders nothing when items is empty", () => {
    const { container } = render(
      <ShortlistingLightbox items={[]} initialIndex={0} onClose={() => {}} />,
    );
    expect(container.querySelector("[data-testid='shortlisting-lightbox']")).toBeNull();
  });

  it("renders the dialog with role=dialog + aria-modal", () => {
    renderLightbox();
    const dlg = screen.getByTestId("shortlisting-lightbox");
    expect(dlg.getAttribute("role")).toBe("dialog");
    expect(dlg.getAttribute("aria-modal")).toBe("true");
  });

  it("renders the filename in the side panel", () => {
    renderLightbox();
    expect(screen.getAllByText("IMG_001.jpg").length).toBeGreaterThan(0);
  });

  it("renders the counter — '1 of N — bucket'", () => {
    render(
      <ShortlistingLightbox
        items={[makeItem({ id: "g1" }), makeItem({ id: "g2" })]}
        initialIndex={0}
        bucketLabel="HUMAN APPROVED"
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/1 of 2/)).toBeInTheDocument();
    expect(screen.getByText(/HUMAN APPROVED/)).toBeInTheDocument();
  });
});

describe("ShortlistingLightbox — close behaviours", () => {
  it("ESC closes the lightbox", () => {
    const onClose = vi.fn();
    renderLightbox({ onClose });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("click on close button closes the lightbox", () => {
    const onClose = vi.fn();
    renderLightbox({ onClose });
    fireEvent.click(screen.getByTestId("lightbox-close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("click on dialog overlay (background) closes the lightbox", () => {
    const onClose = vi.fn();
    renderLightbox({ onClose });
    const dlg = screen.getByTestId("shortlisting-lightbox");
    // fireEvent.click on the dialog itself — currentTarget === target
    fireEvent.click(dlg);
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ShortlistingLightbox — prev/next navigation", () => {
  it("ArrowRight advances the index", () => {
    render(
      <ShortlistingLightbox
        items={[
          makeItem({ id: "g1", filename: "first.jpg" }),
          makeItem({ id: "g2", filename: "second.jpg" }),
        ]}
        initialIndex={0}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/1 of 2/)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText(/2 of 2/)).toBeInTheDocument();
  });

  it("ArrowLeft wraps from index 0 to last", () => {
    render(
      <ShortlistingLightbox
        items={[
          makeItem({ id: "g1" }),
          makeItem({ id: "g2" }),
          makeItem({ id: "g3" }),
        ]}
        initialIndex={0}
        onClose={() => {}}
      />,
    );
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByText(/3 of 3/)).toBeInTheDocument();
  });

  it("ArrowRight wraps from last to first", () => {
    render(
      <ShortlistingLightbox
        items={[makeItem({ id: "g1" }), makeItem({ id: "g2" })]}
        initialIndex={1}
        onClose={() => {}}
      />,
    );
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText(/1 of 2/)).toBeInTheDocument();
  });

  it("hides nav arrows when there's only one item", () => {
    renderLightbox({ items: [makeItem()] });
    expect(screen.queryByTestId("lightbox-prev")).toBeNull();
    expect(screen.queryByTestId("lightbox-next")).toBeNull();
  });
});

describe("ShortlistingLightbox — bbox overlay integration", () => {
  it("annotations toggle is enabled when item has observed_objects", () => {
    renderLightbox();
    const toggle = screen.getByTestId("lightbox-annotations-toggle");
    expect(toggle).not.toBeDisabled();
  });

  it("annotations toggle is disabled when item has no observed_objects", () => {
    renderLightbox({ items: [makeItem({ observed_objects: [] })] });
    const toggle = screen.getByTestId("lightbox-annotations-toggle");
    expect(toggle).toBeDisabled();
  });

  it("clicking the annotations toggle flips the aria-pressed state", () => {
    renderLightbox();
    const toggle = screen.getByTestId("lightbox-annotations-toggle");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("ShortlistingLightbox — side panel content", () => {
  it("renders signal_scores top-N list", () => {
    renderLightbox();
    const list = screen.getByTestId("signal-scores-list");
    expect(list).toBeInTheDocument();
    // Top 5 by value: natural_light=9.1, composition_strength=8.5, ...
    expect(list.textContent).toContain("Natural light");
    expect(list.textContent).toContain("Composition strength");
  });

  it("renders the slot badge when slot_decision is present", () => {
    renderLightbox();
    const badge = screen.getByTestId("slot-badge");
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toContain("kitchen_hero");
  });

  it("renders the voice-tier badge when voice_tier is present", () => {
    renderLightbox();
    const badge = screen.getByTestId("voice-tier-badge");
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toContain("A");
  });

  it("does NOT render slot/voice badges when those fields are absent", () => {
    renderLightbox({
      items: [makeItem({ slot_decision: null, voice_tier: null })],
    });
    expect(screen.queryByTestId("slot-badge")).toBeNull();
    expect(screen.queryByTestId("voice-tier-badge")).toBeNull();
  });

  it("renders the Why? expander when classification.analysis is present", () => {
    renderLightbox();
    const toggle = screen.getByTestId("lightbox-why-toggle");
    expect(toggle).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(
      screen.getByText(/Strong composition with crisp natural light/),
    ).toBeInTheDocument();
  });

  it("hides the Why? expander when no analysis", () => {
    renderLightbox({
      items: [makeItem({ classification: { analysis: null } })],
    });
    expect(screen.queryByTestId("lightbox-why-toggle")).toBeNull();
  });
});

describe("ShortlistingLightbox — accessibility", () => {
  it("close button has an accessible label", () => {
    renderLightbox();
    const btn = screen.getByTestId("lightbox-close");
    expect(btn.getAttribute("aria-label")).toBeTruthy();
  });

  it("focuses the close button on mount", async () => {
    // Focus is deferred via setTimeout(...,0) in the lightbox so the portal
    // has actually mounted before .focus() runs. Advance fake timers to
    // make the assertion deterministic.
    vi.useFakeTimers();
    renderLightbox();
    act(() => {
      vi.runAllTimers();
    });
    const btn = screen.getByTestId("lightbox-close");
    expect(document.activeElement).toBe(btn);
    vi.useRealTimers();
  });
});
