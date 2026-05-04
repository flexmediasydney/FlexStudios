/**
 * CompactCard — purpose-built tile for the SwimlaneGridView.
 *
 * The full ShortlistingCard carries chrome that's irrelevant in a
 * scan-and-click grid surface (alts tray, why? expander, reclassify
 * pencils, hover bands).  This is a stripped-down tile that delivers
 * just the visual + the headline metadata the operator needs to
 * triage:
 *
 *   - Thumbnail (DroneThumbnail — same image source as the lane card)
 *   - Score chip (top-right): editorial_score when the round used the
 *     mig 465 editorial engine, falling back to combined_score
 *   - Stem (small, monospace, below)
 *   - Click → lightbox (full 17-section review)
 *   - Tooltip → role_label / slot_id when present
 *
 * Density mapped to swimlaneSize:
 *   sm  → 80×60   (~6 cards per cell row at 4fr lane width)
 *   md  → 110×82  (~4 cards per cell row)
 *   lg  → 140×105 (~3 cards per cell row)
 *
 * No drag/drop in grid mode (per Joseph: "just how it currently works
 * is fine") — operators use the lane view for action interactions.
 */

import { ImageIcon } from "lucide-react";
import DroneThumbnail from "@/components/drone/DroneThumbnail";
import { cn } from "@/lib/utils";

const DENSITY = {
  sm: { w: 80, h: 60, stemFs: "text-[8px]", scoreFs: "text-[8px]" },
  md: { w: 110, h: 82, stemFs: "text-[9px]", scoreFs: "text-[9px]" },
  lg: { w: 140, h: 105, stemFs: "text-[10px]", scoreFs: "text-[10px]" },
};

function scoreClass(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "text-white/60";
  if (n >= 8) return "text-emerald-300";
  if (n >= 6.5) return "text-lime-300";
  if (n >= 5) return "text-amber-300";
  return "text-rose-300";
}

function pickHeadlineScore(item) {
  // Editorial score (model's own confidence) takes precedence — that's
  // the figure the operator most often wants to see.
  const slot = item?.slot || null;
  if (slot?.editorial && typeof slot.editorial.editorial_score === "number") {
    return { value: slot.editorial.editorial_score, label: "ed" };
  }
  if (typeof slot?.slot_fit_score === "number") {
    return { value: slot.slot_fit_score, label: "ed" };
  }
  const combined = item?.classification?.combined_score;
  if (typeof combined === "number") return { value: combined, label: "Σ" };
  return null;
}

function pickRoleLabel(item) {
  const slot = item?.slot || null;
  if (slot?.editorial?.role_label) return slot.editorial.role_label;
  if (slot?.slot_id) return slot.slot_id;
  return null;
}

export default function CompactCard({ item, density = "md", onClick }) {
  const sz = DENSITY[density] || DENSITY.md;
  const stem = item?.delivery_reference_stem || item?.best_bracket_stem || item?.id;
  const score = pickHeadlineScore(item);
  const role = pickRoleLabel(item);
  const dropboxPath = item?.dropbox_preview_path || null;
  const tooltip = role ? `${stem || "image"}\n${role}` : stem || "image";

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group relative rounded-md overflow-hidden bg-muted/40 border border-border/40",
        "hover:border-primary/60 hover:shadow-md transition flex flex-col text-left shrink-0",
      )}
      style={{ width: sz.w }}
      title={tooltip}
      data-testid={`compact-card-${item?.id}`}
    >
      <div
        className="relative bg-muted overflow-hidden"
        style={{ height: sz.h }}
      >
        {dropboxPath ? (
          <DroneThumbnail dropboxPath={dropboxPath} alt={stem || "image"} />
        ) : (
          <div className="h-full w-full flex items-center justify-center">
            <ImageIcon className="h-4 w-4 text-muted-foreground/40" />
          </div>
        )}
        {score ? (
          <span
            className={cn(
              "absolute top-0.5 right-0.5 px-1 rounded bg-black/70 font-mono tabular-nums",
              sz.scoreFs,
              scoreClass(score.value),
            )}
          >
            {score.value.toFixed(1)}
          </span>
        ) : null}
      </div>
      <div className="px-1 py-0.5">
        <div className={cn("font-mono text-foreground truncate", sz.stemFs)}>
          {stem}
        </div>
      </div>
    </button>
  );
}
