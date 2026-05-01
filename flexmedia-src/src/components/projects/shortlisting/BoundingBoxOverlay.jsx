/**
 * BoundingBoxOverlay — W11.6.20
 *
 * Renders an SVG layer of object bounding boxes over an image inside the
 * lightbox. The boxes are absolutely positioned over an image-container ref
 * via `getBoundingClientRect()` so they track resize / object-fit math
 * correctly without us having to know the image's natural dimensions.
 *
 * Data contract (W11.7.17 in flight):
 *   observedObjects: Array<{
 *     raw_label:              string,           // e.g. "white shaker cabinets"
 *     proposed_canonical_id:  string | null,    // e.g. "obj_arch_kitchen_cab_001"
 *                                               //  null = first observation,
 *                                               //  W12 candidate
 *     confidence:             number,           // 0–1 cosine similarity
 *     bounding_box: { x_pct: number, y_pct: number,
 *                     w_pct: number, h_pct: number },  // normalised 0–1
 *     attributes:             Record<string, any> | null,
 *   }>
 *
 * Color coding (canonical-id prefix bucket):
 *   obj_arch_*       → blue   (architectural)
 *   obj_material_*   → green  (materials)
 *   obj_styling_*    → amber  (styling)
 *   obj_fixture_*    → purple (fixtures)
 *   concern_*        → red    (concerns)
 *   null / unknown   → grey   (W12 candidate)
 *
 * Confidence-based opacity:
 *   conf >= 0.85   → opacity 1.0, solid stroke
 *   0.5 <= conf<.85 → opacity 0.6, solid stroke
 *   conf < 0.5     → opacity 0.3, DASHED stroke
 *
 * Until W11.7.17 lands, observed_objects[] will be empty, so the component
 * renders nothing. Once that wave lands, the boxes appear automatically with
 * no further wiring.
 *
 * Props:
 *   observedObjects     - Array<ObservedObject> (may be undefined / empty)
 *   imageContainerRef   - React.RefObject<HTMLElement> (the image's wrapper)
 *   onObjectClick       - (obj) => void  (called when a box is clicked)
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// ── Color buckets ─────────────────────────────────────────────────────────
// Map a proposed_canonical_id to a Tailwind-friendly stroke color. We strip
// trailing numeric suffixes / id parts and bucket by prefix. Returning HEX
// values (not class names) keeps the SVG <rect stroke=…> branch-free; we
// drive opacity separately.
export function colorForCanonicalId(canonicalId) {
  if (!canonicalId || typeof canonicalId !== "string") {
    return { name: "grey", stroke: "#9ca3af", fill: "#9ca3af" }; // tailwind gray-400
  }
  const id = canonicalId.toLowerCase();
  if (id.startsWith("obj_arch_")) {
    return { name: "blue", stroke: "#3b82f6", fill: "#3b82f6" }; // blue-500
  }
  if (id.startsWith("obj_material_")) {
    return { name: "green", stroke: "#10b981", fill: "#10b981" }; // emerald-500
  }
  if (id.startsWith("obj_styling_")) {
    return { name: "amber", stroke: "#f59e0b", fill: "#f59e0b" }; // amber-500
  }
  if (id.startsWith("obj_fixture_")) {
    return { name: "purple", stroke: "#a855f7", fill: "#a855f7" }; // purple-500
  }
  if (id.startsWith("concern_")) {
    return { name: "red", stroke: "#ef4444", fill: "#ef4444" }; // red-500
  }
  return { name: "grey", stroke: "#9ca3af", fill: "#9ca3af" };
}

// ── Confidence styling ─────────────────────────────────────────────────────
// Returns {opacity, dashed} for a given cosine confidence (0–1).
export function styleForConfidence(confidence) {
  const c = typeof confidence === "number" ? confidence : 0;
  if (c >= 0.85) return { opacity: 1.0, dashed: false };
  if (c >= 0.5) return { opacity: 0.6, dashed: false };
  return { opacity: 0.3, dashed: true };
}

// ── Coordinate math ────────────────────────────────────────────────────────
// Normalised (0–1) box → pixel rect inside the container. Clamps to keep the
// rect from spilling outside if the upstream Stage 1 produced slightly OOB
// coords (rounding errors at the image edge).
export function normalisedToPixels(bbox, containerWidth, containerHeight) {
  if (!bbox || typeof bbox !== "object") return null;
  const { x_pct, y_pct, w_pct, h_pct } = bbox;
  if (
    typeof x_pct !== "number" ||
    typeof y_pct !== "number" ||
    typeof w_pct !== "number" ||
    typeof h_pct !== "number"
  ) {
    return null;
  }
  const W = Math.max(0, Number(containerWidth) || 0);
  const H = Math.max(0, Number(containerHeight) || 0);
  const x = Math.round(Math.max(0, Math.min(1, x_pct)) * W);
  const y = Math.round(Math.max(0, Math.min(1, y_pct)) * H);
  const w = Math.round(Math.max(0, Math.min(1 - x_pct, w_pct)) * W);
  const h = Math.round(Math.max(0, Math.min(1 - y_pct, h_pct)) * H);
  return { x, y, w, h };
}

export default function BoundingBoxOverlay({
  observedObjects,
  imageContainerRef,
  onObjectClick,
}) {
  // Container pixel dims — measured from the ref via getBoundingClientRect()
  // and re-measured on resize via ResizeObserver. Initial null so we don't
  // render zero-sized boxes on the first paint before the image has laid out.
  const [dims, setDims] = useState(null);
  // Measurement is throttled via rAF — ResizeObserver can fire many times in
  // a single frame on layout reflow, and we only need the final value.
  const rafRef = useRef(null);

  useEffect(() => {
    const el =
      imageContainerRef && "current" in imageContainerRef
        ? imageContainerRef.current
        : null;
    if (!el) {
      setDims(null);
      return undefined;
    }

    const measure = () => {
      const rect = el.getBoundingClientRect();
      setDims({ width: rect.width, height: rect.height });
    };
    // Initial measure on mount
    measure();

    // Bail gracefully if RO is unavailable (older browsers, jsdom without
    // mock — though our setup mocks it).
    if (typeof ResizeObserver === "undefined") return undefined;

    const ro = new ResizeObserver(() => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        measure();
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [imageContainerRef]);

  const items = useMemo(() => {
    if (!Array.isArray(observedObjects)) return [];
    return observedObjects;
  }, [observedObjects]);

  // Fast path: no objects → render nothing (callers wrap us in a div, the
  // null return removes our SVG layer entirely so no events / pointer
  // captures interfere with the underlying image).
  if (items.length === 0) return null;

  // We can render the SVG even before the dims have been measured (returns
  // 0×0 viewBox), but skip rect math until we have dims.
  const W = dims?.width || 0;
  const H = dims?.height || 0;

  return (
    <div
      data-testid="bbox-overlay-layer"
      className="absolute inset-0 pointer-events-none"
    >
      <TooltipProvider delayDuration={120}>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="100%"
          height="100%"
          viewBox={`0 0 ${Math.max(1, W)} ${Math.max(1, H)}`}
          preserveAspectRatio="none"
          className="absolute inset-0"
        >
          {items.map((obj, i) => {
            const px = normalisedToPixels(obj?.bounding_box, W, H);
            if (!px || px.w <= 0 || px.h <= 0) return null;
            const color = colorForCanonicalId(obj?.proposed_canonical_id);
            const { opacity, dashed } = styleForConfidence(obj?.confidence);
            const key = `${obj?.raw_label || "obj"}-${i}`;

            const cosine =
              typeof obj?.confidence === "number"
                ? obj.confidence.toFixed(2)
                : "—";

            return (
              <Tooltip key={key}>
                <TooltipTrigger asChild>
                  <g
                    data-testid={`bbox-rect-${i}`}
                    data-bbox-color={color.name}
                    data-bbox-opacity={opacity}
                    data-bbox-dashed={dashed ? "1" : "0"}
                    className="pointer-events-auto cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      onObjectClick?.(obj);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onObjectClick?.(obj);
                      }
                    }}
                    tabIndex={0}
                    role="button"
                    aria-label={
                      `Object: ${obj?.raw_label || "unknown"} ` +
                      `(canonical: ${obj?.proposed_canonical_id || "first observation"}, ` +
                      `cosine: ${cosine})`
                    }
                  >
                    <rect
                      x={px.x}
                      y={px.y}
                      width={px.w}
                      height={px.h}
                      fill={color.fill}
                      fillOpacity={0.08 * opacity}
                      stroke={color.stroke}
                      strokeOpacity={opacity}
                      strokeWidth={2}
                      strokeDasharray={dashed ? "6 4" : undefined}
                      vectorEffect="non-scaling-stroke"
                    />
                  </g>
                </TooltipTrigger>
                <TooltipContent
                  side="top"
                  className="max-w-[280px] text-xs leading-tight"
                >
                  <div className="font-medium">{obj?.raw_label || "(no label)"}</div>
                  <div className="font-mono text-[10px] opacity-80">
                    {obj?.proposed_canonical_id || "first observation"}
                  </div>
                  <div className="text-[10px] opacity-80">
                    cosine: {cosine}
                  </div>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </svg>
      </TooltipProvider>
    </div>
  );
}
