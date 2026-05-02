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
    const { result } = renderHook(() => useLightboxAnnotations("drone"));
    expect(result.current.settings).toEqual({
      enabled: true,
      confidenceThreshold: 0.5,
      categoryFilter: [],
    });
  });

  it("setEnabled(false) persists to localStorage under scoped key", () => {
    const { result } = renderHook(() => useLightboxAnnotations("drone"));
    act(() => {
      result.current.setEnabled(false);
    });
    expect(result.current.settings.enabled).toBe(false);
    const stored = JSON.parse(window.localStorage.getItem("lightbox-annotations:drone"));
    expect(stored.enabled).toBe(false);
  });

  it("setConfidenceThreshold persists and clamps invalid input", () => {
    const { result } = renderHook(() => useLightboxAnnotations("drone"));
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
    const { result } = renderHook(() => useLightboxAnnotations("drone"));
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
    const { result } = renderHook(() => useLightboxAnnotations("drone"));
    act(() => {
      result.current.toggleCategory("nonsense");
    });
    expect(result.current.settings.categoryFilter).toEqual([]);
  });

  it("re-mounted hook reads previously-persisted settings", () => {
    const { result, unmount } = renderHook(() => useLightboxAnnotations("drone"));
    act(() => {
      result.current.setEnabled(false);
      result.current.setConfidenceThreshold(0.8);
      result.current.toggleCategory("fixture");
    });
    unmount();

    const { result: result2 } = renderHook(() => useLightboxAnnotations("drone"));
    expect(result2.current.settings).toEqual({
      enabled: false,
      confidenceThreshold: 0.8,
      categoryFilter: ["fixture"],
    });
  });

  it("ignores corrupted localStorage payloads gracefully", () => {
    window.localStorage.setItem("lightbox-annotations:drone", "{not json");
    const { result } = renderHook(() => useLightboxAnnotations("drone"));
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

describe("useLightboxAnnotations — scope isolation", () => {
  it("drone, shortlist, pulse each persist independently under their own keys", () => {
    const { result: drone } = renderHook(() => useLightboxAnnotations("drone"));
    const { result: shortlist } = renderHook(() => useLightboxAnnotations("shortlist"));
    const { result: pulse } = renderHook(() => useLightboxAnnotations("pulse"));

    act(() => {
      drone.current.setEnabled(false);
      shortlist.current.setConfidenceThreshold(0.8);
      pulse.current.toggleCategory("concern");
    });

    expect(JSON.parse(window.localStorage.getItem("lightbox-annotations:drone")).enabled).toBe(false);
    expect(JSON.parse(window.localStorage.getItem("lightbox-annotations:shortlist")).confidenceThreshold).toBe(0.8);
    expect(JSON.parse(window.localStorage.getItem("lightbox-annotations:pulse")).categoryFilter).toEqual(["concern"]);

    // Each surface unaffected by the others' writes.
    expect(drone.current.settings).toEqual({ enabled: false, confidenceThreshold: 0.5, categoryFilter: [] });
    expect(shortlist.current.settings).toEqual({ enabled: true, confidenceThreshold: 0.8, categoryFilter: [] });
    expect(pulse.current.settings).toEqual({ enabled: true, confidenceThreshold: 0.5, categoryFilter: ["concern"] });
  });

  it("drone scope adopts legacy unscoped key once if scoped key is missing", () => {
    // Pre-existing user with the old (pre-scope) write.
    window.localStorage.setItem(
      "lightbox-annotations",
      JSON.stringify({ enabled: false, confidenceThreshold: 0.6, categoryFilter: ["arch"] }),
    );
    const { result } = renderHook(() => useLightboxAnnotations("drone"));
    expect(result.current.settings).toEqual({
      enabled: false,
      confidenceThreshold: 0.6,
      categoryFilter: ["arch"],
    });
    // The migration writes the scoped key so subsequent reads are scope-pure.
    const scoped = JSON.parse(window.localStorage.getItem("lightbox-annotations:drone"));
    expect(scoped.enabled).toBe(false);
  });

  it("non-drone scopes ignore legacy unscoped key", () => {
    window.localStorage.setItem(
      "lightbox-annotations",
      JSON.stringify({ enabled: false, confidenceThreshold: 0.6, categoryFilter: ["arch"] }),
    );
    const { result } = renderHook(() => useLightboxAnnotations("shortlist"));
    // shortlist gets defaults — legacy migration is drone-only.
    expect(result.current.settings).toEqual({
      enabled: true,
      confidenceThreshold: 0.5,
      categoryFilter: [],
    });
  });
});
