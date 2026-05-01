/**
 * W15b.8 — PulseListingVisionAggregateCard tests.
 *
 * Run: npx vitest run flexmedia-src/src/components/pulse/listing-detail/__tests__/PulseListingVisionAggregateCard.test.jsx
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import PulseListingVisionAggregateCard from "../PulseListingVisionAggregateCard";

const FRESH_EXTRACT = {
  id: "ext-1",
  listing_id: "lst-1",
  schema_version: "v1.0",
  status: "succeeded",
  extracted_at: "2026-04-30T12:00:00Z",
  photo_breakdown: {
    day_count: 10,
    dusk_count: 3,
    drone_count: 1,
    floorplan_count: 1,
    total_images: 15,
  },
  video_breakdown: {
    present: true,
    day_segments_count: 1,
    dusk_segments_count: 0,
    drone_segments_count: 0,
    agent_in_frame: true,
    car_in_frame: true,
    total_duration_s: 90,
  },
  competitor: {
    photographer_credit: "Richard Gardiner",
    dominant_brand_inferred: "Continuous",
  },
  total_cost_usd: 0.21,
  total_input_tokens: 500,
  total_output_tokens: 200,
  vendor: "google",
  model_version: "gemini-2.5-flash",
  triggered_by: "pulse_detail_enrich",
};

describe("PulseListingVisionAggregateCard", () => {
  it("renders nothing when extract is null", () => {
    const { container } = render(
      <PulseListingVisionAggregateCard extract={null} listingId="lst-1" />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders fresh status with cost + vendor + photo breakdown", () => {
    render(
      <PulseListingVisionAggregateCard
        extract={FRESH_EXTRACT}
        classificationCount={14}
        totalImagesOnListing={15}
        listingId="lst-1"
      />
    );
    const pill = screen.getByTestId("vision-status-pill");
    expect(pill.getAttribute("data-status")).toBe("succeeded");
    expect(pill.textContent).toContain("Fresh");
    expect(screen.getByTestId("photo-breakdown")).toBeInTheDocument();
    expect(screen.getByTestId("photo-breakdown").textContent).toContain("10");
    expect(screen.getByTestId("photo-breakdown").textContent).toContain("day");
    expect(screen.getByTestId("photo-breakdown").textContent).toContain("dusk");
    // Cost label
    expect(screen.getByText(/Cost:/i)).toBeInTheDocument();
    expect(screen.getByText(/\$0\.21/)).toBeInTheDocument();
    // Coverage
    expect(screen.getByTestId("coverage-badge").textContent).toContain("14/15");
  });

  it("renders pending status with loading hint", () => {
    render(
      <PulseListingVisionAggregateCard
        extract={{ ...FRESH_EXTRACT, status: "pending" }}
        listingId="lst-1"
      />
    );
    expect(screen.getByTestId("vision-status-pill").getAttribute("data-status")).toBe("pending");
    expect(screen.getByText(/in progress/i)).toBeInTheDocument();
  });

  it("renders failed status with failed_reason and retry hint", () => {
    render(
      <PulseListingVisionAggregateCard
        extract={{ ...FRESH_EXTRACT, status: "failed", failed_reason: "Gemini quota exceeded" }}
        listingId="lst-1"
      />
    );
    expect(screen.getByTestId("vision-status-pill").getAttribute("data-status")).toBe("failed");
    expect(screen.getByText(/Gemini quota exceeded/)).toBeInTheDocument();
  });

  it("renders manually_overridden status with override reason", () => {
    render(
      <PulseListingVisionAggregateCard
        extract={{
          ...FRESH_EXTRACT,
          status: "manually_overridden",
          manual_override_reason: "Operator override — auto miscounted dusk shots",
        }}
        listingId="lst-1"
      />
    );
    expect(screen.getByTestId("vision-status-pill").getAttribute("data-status")).toBe("manually_overridden");
    expect(screen.getByText(/Operator override/)).toBeInTheDocument();
  });

  it("hides Refresh + Manually classify buttons for non-master_admin", () => {
    render(
      <PulseListingVisionAggregateCard
        extract={FRESH_EXTRACT}
        listingId="lst-1"
        isMasterAdmin={false}
      />
    );
    expect(screen.queryByTestId("refresh-vision-btn")).toBeNull();
    expect(screen.queryByTestId("manual-classify-btn")).toBeNull();
    // command-center link is always visible
    expect(screen.getByTestId("open-command-center-btn")).toBeInTheDocument();
  });

  it("shows Refresh + Manually classify buttons for master_admin and wires onRefresh", () => {
    const onRefresh = vi.fn();
    const onManualClassify = vi.fn();
    render(
      <PulseListingVisionAggregateCard
        extract={FRESH_EXTRACT}
        listingId="lst-1"
        isMasterAdmin={true}
        onRefresh={onRefresh}
        onManualClassify={onManualClassify}
      />
    );
    const refreshBtn = screen.getByTestId("refresh-vision-btn");
    expect(refreshBtn).toBeInTheDocument();
    fireEvent.click(refreshBtn);
    expect(onRefresh).toHaveBeenCalled();

    const manualBtn = screen.getByTestId("manual-classify-btn");
    fireEvent.click(manualBtn);
    expect(onManualClassify).toHaveBeenCalled();
  });

  it("renders 'NO dusk footage' badge when video lacks dusk segments", () => {
    render(
      <PulseListingVisionAggregateCard
        extract={FRESH_EXTRACT}
        listingId="lst-1"
      />
    );
    const videoBlock = screen.getByTestId("video-breakdown");
    expect(videoBlock.textContent).toMatch(/no dusk footage/i);
    expect(videoBlock.textContent).toMatch(/agent in frame/i);
  });

  it("renders competitor photographer + brand info", () => {
    render(
      <PulseListingVisionAggregateCard
        extract={FRESH_EXTRACT}
        listingId="lst-1"
      />
    );
    const compBlock = screen.getByTestId("competitor-breakdown");
    expect(compBlock.textContent).toContain("Richard Gardiner");
    expect(compBlock.textContent).toContain("Continuous");
  });

  it("links 'Open in command center' to PulseMissedOpportunityCommandCenter", () => {
    render(
      <PulseListingVisionAggregateCard
        extract={FRESH_EXTRACT}
        listingId="lst-1"
      />
    );
    // Button asChild renders the anchor in place, so the testid lands on the
    // anchor itself rather than wrapping it.
    const link = screen.getByTestId("open-command-center-btn");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toContain("PulseMissedOpportunityCommandCenter");
    expect(link.getAttribute("href")).toContain("listing=lst-1");
  });
});
