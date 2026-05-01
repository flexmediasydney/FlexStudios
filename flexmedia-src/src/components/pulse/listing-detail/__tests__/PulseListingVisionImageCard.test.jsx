/**
 * W15b.8 — PulseListingVisionImageCard tests.
 *
 * Run: npx vitest run flexmedia-src/src/components/pulse/listing-detail/__tests__/PulseListingVisionImageCard.test.jsx
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import PulseListingVisionImageCard from "../PulseListingVisionImageCard";

const SAMPLE_CLASS = {
  id: "cc-1",
  filename: "front-facade-001.jpg",
  source_image_url: "https://example.com/img/001.jpg",
  image_type: "is_dusk",
  analysis: "A dusk exterior of a contemporary white facade with warm interior glow.",
  style_archetype: "Contemporary",
  era_hint: "post-2010",
  material_palette_summary: ["white render", "timber accent"],
  external_specific: {
    package_signals: ["dusk_lighting", "drone_angle"],
    competitor_branding: {
      watermark: "RG Photography",
      photographer_credit: "Richard Gardiner",
      agency_logo: "Continuous Real Estate",
    },
  },
  observed_objects: [],
  confidence: 0.91,
  requires_human_review: false,
};

describe("PulseListingVisionImageCard", () => {
  it("renders image type badge for is_dusk", () => {
    render(<PulseListingVisionImageCard classification={SAMPLE_CLASS} index={0} />);
    const badge = screen.getByTestId("image-type-badge");
    expect(badge.textContent).toContain("dusk");
  });

  it("toggles Why? expander revealing package_signals + competitor branding", () => {
    render(<PulseListingVisionImageCard classification={SAMPLE_CLASS} index={0} />);
    // Why? content not yet visible
    expect(screen.queryByTestId("why-content")).toBeNull();
    fireEvent.click(screen.getByTestId("why-toggle"));
    const content = screen.getByTestId("why-content");
    expect(content).toBeInTheDocument();
    expect(content.textContent).toContain("dusk exterior");
    // Architecture & Style
    expect(screen.getByTestId("architecture-style").textContent).toContain("Contemporary");
    expect(screen.getByTestId("architecture-style").textContent).toContain("post-2010");
    expect(screen.getByTestId("architecture-style").textContent).toContain("white render");
    // Competitor branding
    expect(screen.getByTestId("competitor-branding").textContent).toContain("Richard Gardiner");
    expect(screen.getByTestId("competitor-branding").textContent).toContain("Continuous");
  });

  it("renders package_signals at top level (visible without expanding Why?)", () => {
    render(<PulseListingVisionImageCard classification={SAMPLE_CLASS} index={0} />);
    const sigBlock = screen.getByTestId("package-signals");
    expect(sigBlock.textContent).toContain("dusk lighting");
    expect(sigBlock.textContent).toContain("drone angle");
  });

  it("calls onOpenLightbox when thumbnail is clicked", () => {
    const onOpen = vi.fn();
    render(
      <PulseListingVisionImageCard
        classification={SAMPLE_CLASS}
        index={5}
        onOpenLightbox={onOpen}
      />
    );
    const card = screen.getByTestId("vision-image-card");
    const thumb = card.querySelector('[role="button"]');
    fireEvent.click(thumb);
    expect(onOpen).toHaveBeenCalledWith(5, SAMPLE_CLASS);
  });

  it("handles classification with no source_image_url (fallback placeholder)", () => {
    const c = { ...SAMPLE_CLASS, source_image_url: null, dropbox_preview_path: null };
    render(<PulseListingVisionImageCard classification={c} index={0} />);
    const fallback = document.querySelector("[data-fallback]");
    expect(fallback).toBeInTheDocument();
    expect(fallback.classList.contains("hidden")).toBe(false);
  });

  it("handles classification with empty external_specific gracefully", () => {
    const c = { ...SAMPLE_CLASS, external_specific: {}, package_signals: undefined };
    render(<PulseListingVisionImageCard classification={c} index={0} />);
    // No package signals row
    expect(screen.queryByTestId("package-signals")).toBeNull();
    // Why? expander still works
    fireEvent.click(screen.getByTestId("why-toggle"));
    expect(screen.getByTestId("why-content")).toBeInTheDocument();
    // Competitor branding section absent
    expect(screen.queryByTestId("competitor-branding")).toBeNull();
  });
});
