/**
 * W11.6.20 — CanonicalObjectPanel tests.
 *
 * Run: npx vitest run flexmedia-src/src/components/projects/shortlisting/__tests__/CanonicalObjectPanel.test.jsx
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import CanonicalObjectPanel from "../CanonicalObjectPanel";

const SAMPLE_OBJECT = {
  raw_label: "white shaker cabinets",
  proposed_canonical_id: "obj_arch_kitchen_cab_001",
  confidence: 0.92,
  bounding_box: { x_pct: 0.1, y_pct: 0.1, w_pct: 0.4, h_pct: 0.4 },
  attributes: {
    color: "white",
    style: "shaker",
    handle_type: "cup_pull",
  },
};

describe("CanonicalObjectPanel", () => {
  it("renders nothing when object is null", () => {
    const { container } = render(
      <CanonicalObjectPanel
        object={null}
        allClassificationsInRound={[]}
        onClose={() => {}}
      />,
    );
    expect(container.querySelector("[data-testid='canonical-panel']")).toBeNull();
  });

  it("renders raw_label as the heading and canonical_id mono", () => {
    render(
      <CanonicalObjectPanel
        object={SAMPLE_OBJECT}
        allClassificationsInRound={[]}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("white shaker cabinets")).toBeInTheDocument();
    expect(screen.getByTestId("canonical-id").textContent).toBe(
      "obj_arch_kitchen_cab_001",
    );
  });

  it("renders attributes table from the attributes prop", () => {
    render(
      <CanonicalObjectPanel
        object={SAMPLE_OBJECT}
        allClassificationsInRound={[]}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("color")).toBeInTheDocument();
    expect(screen.getByText("white")).toBeInTheDocument();
    expect(screen.getByText("style")).toBeInTheDocument();
    expect(screen.getByText("shaker")).toBeInTheDocument();
  });

  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    render(
      <CanonicalObjectPanel
        object={SAMPLE_OBJECT}
        allClassificationsInRound={[]}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when backdrop is clicked", () => {
    const onClose = vi.fn();
    render(
      <CanonicalObjectPanel
        object={SAMPLE_OBJECT}
        allClassificationsInRound={[]}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByTestId("canonical-panel-backdrop"));
    expect(onClose).toHaveBeenCalled();
  });

  it("lists other instances on round whose canonical id matches", () => {
    // Round has 2 other classifications; first matches, second doesn't.
    const allClassifications = [
      {
        id: "cc-1",
        filename: "IMG_5751.jpg",
        observed_objects: [
          {
            raw_label: "shaker cabinets",
            proposed_canonical_id: "obj_arch_kitchen_cab_001",
            confidence: 0.85,
            bounding_box: { x_pct: 0.05, y_pct: 0.05, w_pct: 0.3, h_pct: 0.3 },
          },
        ],
      },
      {
        id: "cc-2",
        filename: "IMG_5762.jpg",
        observed_objects: [
          {
            raw_label: "marble splashback",
            proposed_canonical_id: "obj_material_marble_007",
            confidence: 0.9,
            bounding_box: { x_pct: 0.2, y_pct: 0.2, w_pct: 0.2, h_pct: 0.2 },
          },
        ],
      },
    ];
    render(
      <CanonicalObjectPanel
        object={SAMPLE_OBJECT}
        allClassificationsInRound={allClassifications}
        onClose={() => {}}
      />,
    );
    const list = screen.getByTestId("other-instances-list");
    expect(list).toBeInTheDocument();
    expect(list.textContent).toContain("IMG_5751.jpg");
    expect(list.textContent).not.toContain("IMG_5762.jpg");
  });

  it("renders W12 registry link with the canonical id encoded", () => {
    render(
      <CanonicalObjectPanel
        object={SAMPLE_OBJECT}
        allClassificationsInRound={[]}
        onClose={() => {}}
      />,
    );
    const link = screen.getByText(/Open in W12 registry/).closest("a");
    expect(link).toBeInTheDocument();
    // W11.6.21 hard-cut: the link target moved from the standalone
    // /SettingsObjectRegistryDiscovery route to the umbrella
    // /SettingsShortlistingCommandCenter?tab=discovery&canonical=...
    expect(link.getAttribute("href")).toContain("SettingsShortlistingCommandCenter");
    expect(link.getAttribute("href")).toContain("tab=discovery");
    expect(link.getAttribute("href")).toContain("canonical=obj_arch_kitchen_cab_001");
  });

  it("hides W12 link when object has no canonical id (first observation)", () => {
    render(
      <CanonicalObjectPanel
        object={{ ...SAMPLE_OBJECT, proposed_canonical_id: null }}
        allClassificationsInRound={[]}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText(/Open in W12 registry/)).toBeNull();
  });
});
