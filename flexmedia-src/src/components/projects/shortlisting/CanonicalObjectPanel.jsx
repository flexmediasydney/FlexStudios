/**
 * CanonicalObjectPanel — W11.6.20
 *
 * Slide-out side panel that opens when an operator clicks a bounding box in
 * the lightbox. Shows the full record for the selected observed object plus
 * "other instances on this round" so the operator can quickly cross-check
 * a canonical id without leaving the lightbox.
 *
 * Props:
 *   object                       - ObservedObject | null
 *                                  When null, renders nothing.
 *   allClassificationsInRound    - Array<CompositionClassification>
 *                                  Already loaded by parent (the swimlane's
 *                                  composition_classifications query).
 *                                  We mine this for cross-image instances —
 *                                  no extra fetch needed.
 *   onClose                      - () => void  (Esc + backdrop click)
 *
 * No-fetch design:
 *   The parent already holds composition_classifications for the round, so
 *   the panel does its cross-image lookup locally. This avoids a redundant
 *   network request and means the panel is instant on click.
 */
import { useEffect, useMemo } from "react";
import { X, ExternalLink } from "lucide-react";
import { createPageUrl } from "@/utils";
import { cn } from "@/lib/utils";
import { colorForCanonicalId } from "./BoundingBoxOverlay";

export default function CanonicalObjectPanel({
  object,
  allClassificationsInRound,
  onClose,
}) {
  // Esc-to-close — only register when open. Without the gate we'd be leaking
  // listeners between renders.
  useEffect(() => {
    if (!object) return undefined;
    const handler = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose?.();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [object, onClose]);

  // Other instances on the round: walk every classification's
  // observed_objects[] and pull the ones whose canonical_id matches. We skip
  // the currently-selected object (same raw_label + same canonical_id) so
  // the panel doesn't show "you" in the list of "others".
  const otherInstances = useMemo(() => {
    if (!object?.proposed_canonical_id) return [];
    if (!Array.isArray(allClassificationsInRound)) return [];
    const target = object.proposed_canonical_id;
    const out = [];
    for (const cc of allClassificationsInRound) {
      const objs = Array.isArray(cc?.observed_objects)
        ? cc.observed_objects
        : [];
      for (const o of objs) {
        if (o?.proposed_canonical_id !== target) continue;
        // Skip the very same observation
        if (
          o?.raw_label === object?.raw_label &&
          o?.bounding_box?.x_pct === object?.bounding_box?.x_pct &&
          o?.bounding_box?.y_pct === object?.bounding_box?.y_pct
        ) {
          continue;
        }
        out.push({
          classification: cc,
          object: o,
        });
      }
    }
    return out;
  }, [object, allClassificationsInRound]);

  if (!object) return null;

  const color = colorForCanonicalId(object.proposed_canonical_id);
  const cosine =
    typeof object.confidence === "number" ? object.confidence : 0;
  const cosinePct = Math.max(0, Math.min(100, Math.round(cosine * 100)));
  const attributes =
    object.attributes && typeof object.attributes === "object"
      ? Object.entries(object.attributes)
      : [];

  return (
    <>
      {/* Backdrop — click to close, sits below panel z-index */}
      <div
        data-testid="canonical-panel-backdrop"
        className="absolute inset-0 z-20 bg-black/30"
        onClick={(e) => {
          e.stopPropagation();
          onClose?.();
        }}
      />

      {/* Slide-out panel */}
      <aside
        data-testid="canonical-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Canonical object: ${object.raw_label || "unknown"}`}
        className={cn(
          "absolute right-0 top-0 bottom-0 z-30 w-[360px] max-w-[80vw]",
          "bg-slate-900/95 backdrop-blur text-white",
          "border-l border-white/10 shadow-2xl",
          "flex flex-col",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-2 px-4 pt-4 pb-3 border-b border-white/10">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold leading-tight break-words">
              {object.raw_label || "(no label)"}
            </h2>
            <div
              className="mt-1 font-mono text-[11px] text-white/70 break-all"
              data-testid="canonical-id"
            >
              {object.proposed_canonical_id || "first observation (W12 candidate)"}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded text-white/70 hover:text-white hover:bg-white/10 shrink-0"
            aria-label="Close panel"
            title="Close (Esc)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body — scroll if overflows */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 text-sm">
          {/* Cosine confidence bar */}
          <div>
            <div className="flex items-center justify-between text-[11px] mb-1">
              <span className="text-white/70">Cosine confidence</span>
              <span className="font-mono">{cosine.toFixed(3)}</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
              <div
                data-testid="cosine-bar"
                className="h-full"
                style={{
                  width: `${cosinePct}%`,
                  backgroundColor: color.stroke,
                }}
              />
            </div>
          </div>

          {/* Attributes table */}
          {attributes.length > 0 ? (
            <div>
              <div className="text-[11px] uppercase tracking-wide text-white/60 mb-1">
                Attributes
              </div>
              <table className="w-full text-[12px]">
                <tbody>
                  {attributes.map(([k, v]) => (
                    <tr key={k} className="border-b border-white/5 last:border-b-0">
                      <td className="py-1 pr-2 text-white/60 align-top whitespace-nowrap font-mono text-[11px]">
                        {k}
                      </td>
                      <td className="py-1 text-white/90 break-words">
                        {typeof v === "object"
                          ? JSON.stringify(v)
                          : String(v)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-[11px] text-white/40 italic">
              No attributes recorded
            </div>
          )}

          {/* Other instances on round */}
          <div>
            <div className="text-[11px] uppercase tracking-wide text-white/60 mb-1">
              Other instances on round
            </div>
            {otherInstances.length === 0 ? (
              <div className="text-[11px] text-white/40 italic">
                {object.proposed_canonical_id
                  ? "No other instances of this canonical found in this round."
                  : "Canonical id not yet assigned."}
              </div>
            ) : (
              <ul
                data-testid="other-instances-list"
                className="space-y-1.5"
              >
                {otherInstances.map((ent, i) => {
                  const cc = ent.classification;
                  const o = ent.object;
                  return (
                    <li
                      key={`${cc?.id || "cc"}-${i}`}
                      className="flex items-start gap-2 rounded bg-white/5 px-2 py-1.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] truncate">
                          {cc?.filename || cc?.dropbox_path || "(unknown image)"}
                        </div>
                        <div className="text-[10px] text-white/60 truncate">
                          {o?.raw_label || ""} · cosine{" "}
                          {typeof o?.confidence === "number"
                            ? o.confidence.toFixed(2)
                            : "—"}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Open in W12 registry — W11.6.21 link target is now the */}
          {/* Shortlisting Command Center umbrella ?tab=discovery panel. */}
          {object.proposed_canonical_id && (
            <div className="pt-1">
              <a
                href={createPageUrl(
                  `SettingsShortlistingCommandCenter?tab=discovery&canonical=${encodeURIComponent(object.proposed_canonical_id)}`,
                )}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[12px] text-blue-300 hover:text-blue-200 hover:underline"
              >
                Open in W12 registry
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
