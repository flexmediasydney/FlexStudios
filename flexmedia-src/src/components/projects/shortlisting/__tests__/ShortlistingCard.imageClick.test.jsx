/**
 * W11.6.20 swimlane-lightbox — ShortlistingCard image-click wiring tests.
 *
 * Run: npx vitest run flexmedia-src/src/components/projects/shortlisting/__tests__/ShortlistingCard.imageClick.test.jsx
 *
 * Covers:
 *  1. Clicking the thumbnail wrapper fires onImageClick
 *  2. Pressing Enter on the focused thumbnail fires onImageClick
 *  3. Pressing Space on the focused thumbnail fires onImageClick
 *  4. Clicking the "Why?" expander does NOT fire onImageClick (event.stopPropagation
 *     in the toggleWhy handler combined with our own click listener on the
 *     thumbnail wrapper means the body of the card stays unaffected.)
 *  5. The card still renders normally when onImageClick is undefined (legacy)
 *  6. role="button" + tabIndex=0 + aria-label set when handler is provided
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/supabaseClient", () => ({
  api: {
    entities: {
      ShortlistingOverride: { filter: vi.fn(async () => []) },
      CompositionGroup: { filter: vi.fn(async () => []) },
    },
  },
  supabase: {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
                then: (resolve) => resolve({ data: [], error: null }),
              };
            },
          };
        },
      };
    },
  },
}));

vi.mock("@/components/drone/DroneThumbnail", () => ({
  default: function DroneThumbnailStub({ alt }) {
    return <div data-testid="drone-thumb-stub">{alt}</div>;
  },
}));

import ShortlistingCard from "../ShortlistingCard";

function wrapper({ children }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const COMPOSITION = {
  id: "group-001",
  round_id: "round-uuid-001",
  delivery_reference_stem: "IMG_5751",
  best_bracket_stem: "IMG_5751",
  dropbox_preview_path: "/preview/IMG_5751.jpg",
  classification: {
    room_type: "kitchen",
    analysis: "Strong composition.",
    technical_score: 7,
    lighting_score: 7,
    composition_score: 7,
    aesthetic_score: 7,
    combined_score: 7,
  },
  slot: { slot_id: "kitchen_hero", phase: 1, rank: 1 },
};

describe("ShortlistingCard — onImageClick wiring", () => {
  it("clicking the thumbnail wrapper fires onImageClick", () => {
    const onImageClick = vi.fn();
    render(
      <ShortlistingCard
        composition={COMPOSITION}
        column="proposed"
        onImageClick={onImageClick}
      />,
      { wrapper },
    );
    const thumb = screen.getByTestId("shortlisting-card-thumb-md");
    fireEvent.click(thumb);
    expect(onImageClick).toHaveBeenCalledTimes(1);
  });

  it("pressing Enter on the focused thumbnail fires onImageClick", () => {
    const onImageClick = vi.fn();
    render(
      <ShortlistingCard
        composition={COMPOSITION}
        column="proposed"
        onImageClick={onImageClick}
      />,
      { wrapper },
    );
    const thumb = screen.getByTestId("shortlisting-card-thumb-md");
    fireEvent.keyDown(thumb, { key: "Enter" });
    expect(onImageClick).toHaveBeenCalledTimes(1);
  });

  it("pressing Space on the focused thumbnail fires onImageClick", () => {
    const onImageClick = vi.fn();
    render(
      <ShortlistingCard
        composition={COMPOSITION}
        column="proposed"
        onImageClick={onImageClick}
      />,
      { wrapper },
    );
    const thumb = screen.getByTestId("shortlisting-card-thumb-md");
    fireEvent.keyDown(thumb, { key: " " });
    expect(onImageClick).toHaveBeenCalledTimes(1);
  });

  it("clicking the Why? expander does NOT fire onImageClick", () => {
    const onImageClick = vi.fn();
    render(
      <ShortlistingCard
        composition={COMPOSITION}
        column="proposed"
        onImageClick={onImageClick}
      />,
      { wrapper },
    );
    const whyButton = screen.getByText("Why?").closest("button");
    expect(whyButton).toBeTruthy();
    fireEvent.click(whyButton);
    // Why? toggle is in the body — separate from the thumbnail wrapper;
    // the lightbox handler should not fire.
    expect(onImageClick).not.toHaveBeenCalled();
  });

  it("renders normally when onImageClick is undefined (legacy)", () => {
    render(
      <ShortlistingCard composition={COMPOSITION} column="proposed" />,
      { wrapper },
    );
    const thumb = screen.getByTestId("shortlisting-card-thumb-md");
    expect(thumb.getAttribute("role")).toBeNull();
    expect(thumb.getAttribute("tabIndex")).toBeNull();
    // Click without a handler should not throw.
    fireEvent.click(thumb);
  });

  it("role=button + tabIndex=0 + aria-label set when onImageClick is provided", () => {
    render(
      <ShortlistingCard
        composition={COMPOSITION}
        column="proposed"
        onImageClick={() => {}}
      />,
      { wrapper },
    );
    const thumb = screen.getByTestId("shortlisting-card-thumb-md");
    expect(thumb.getAttribute("role")).toBe("button");
    expect(thumb.getAttribute("tabindex")).toBe("0");
    expect(thumb.getAttribute("aria-label")).toContain("Open");
  });
});
