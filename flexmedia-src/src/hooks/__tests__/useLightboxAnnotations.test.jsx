/**
 * W11.6.20 — useLightboxAnnotations tests.
 *
 * Run: npx vitest run flexmedia-src/src/hooks/__tests__/useLightboxAnnotations.test.jsx
 */
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import useLightboxAnnotations, {
  ANNOTATION_CATEGORIES,
} from "../useLightboxAnnotations";

beforeEach(() => {
  // Wipe storage between tests so each starts fresh.
  if (typeof window !== "undefined" && window.localStorage) {
    window.localStorage.clear();
  }
});

describe("useLightboxAnnotations — defaults + persistence", () => {
  it("defaults: enabled=true, threshold=0.5, categoryFilter=[]", () => {
    const { result } = renderHook(() => useLightboxAnnotations());
    expect(result.current.settings).toEqual({
      enabled: true,
      confidenceThreshold: 0.5,
      categoryFilter: [],
    });
  });

  it("setEnabled(false) persists to localStorage", () => {
    const { result } = renderHook(() => useLightboxAnnotations());
    act(() => {
      result.current.setEnabled(false);
    });
    expect(result.current.settings.enabled).toBe(false);
    const stored = JSON.parse(window.localStorage.getItem("lightbox-annotations"));
    expect(stored.enabled).toBe(false);
  });

  it("setConfidenceThreshold persists and clamps invalid input", () => {
    const { result } = renderHook(() => useLightboxAnnotations());
    act(() => {
      result.current.setConfidenceThreshold(0.7);
    });
    expect(result.current.settings.confidenceThreshold).toBe(0.7);

    // Invalid → falls back to default 0.5
    act(() => {
      result.current.setConfidenceThreshold(2);
    });
    expect(result.current.settings.confidenceThreshold).toBe(0.5);

    act(() => {
      result.current.setConfidenceThreshold("nope");
    });
    expect(result.current.settings.confidenceThreshold).toBe(0.5);
  });

  it("toggleCategory adds + removes a known category", () => {
    const { result } = renderHook(() => useLightboxAnnotations());
    act(() => {
      result.current.toggleCategory("arch");
    });
    expect(result.current.settings.categoryFilter).toEqual(["arch"]);

    act(() => {
      result.current.toggleCategory("concern");
    });
    expect(result.current.settings.categoryFilter).toEqual(["arch", "concern"]);

    act(() => {
      result.current.toggleCategory("arch");
    });
    expect(result.current.settings.categoryFilter).toEqual(["concern"]);
  });

  it("toggleCategory ignores unknown categories", () => {
    const { result } = renderHook(() => useLightboxAnnotations());
    act(() => {
      result.current.toggleCategory("nonsense");
    });
    expect(result.current.settings.categoryFilter).toEqual([]);
  });

  it("re-mounted hook reads previously-persisted settings", () => {
    const { result, unmount } = renderHook(() => useLightboxAnnotations());
    act(() => {
      result.current.setEnabled(false);
      result.current.setConfidenceThreshold(0.8);
      result.current.toggleCategory("fixture");
    });
    unmount();

    const { result: result2 } = renderHook(() => useLightboxAnnotations());
    expect(result2.current.settings).toEqual({
      enabled: false,
      confidenceThreshold: 0.8,
      categoryFilter: ["fixture"],
    });
  });

  it("ignores corrupted localStorage payloads gracefully", () => {
    window.localStorage.setItem("lightbox-annotations", "{not json");
    const { result } = renderHook(() => useLightboxAnnotations());
    expect(result.current.settings).toEqual({
      enabled: true,
      confidenceThreshold: 0.5,
      categoryFilter: [],
    });
  });

  it("ANNOTATION_CATEGORIES exposes the bucket list", () => {
    expect(ANNOTATION_CATEGORIES).toEqual([
      "arch",
      "material",
      "styling",
      "fixture",
      "concern",
      "unknown",
    ]);
  });
});
