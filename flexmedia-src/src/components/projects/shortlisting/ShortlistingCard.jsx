/**
 * ShortlistingCard — Wave 6 Phase 6 SHORTLIST
 *
 * Per-composition card rendered in the swimlane columns.
 *
 * Per spec §20:
 *   - Thumbnail (4:3 aspect, fetched via media-proxy / Dropbox temp link)
 *   - Filename (monospace, truncated)
 *   - Room type label (human-readable)
 *   - Slot ID badge (only if shortlisted) with phase indicator
 *   - 4-dim scores (C / L / T / A / avg)
 *   - Shortlist / rejected badge
 *   - Analysis text — 3-line truncation, click to expand
 *   - Alternatives tray (collapsed by default)
 *
 * Drag handle is the whole card. The parent swimlane wires DragDropContext +
 * Draggable from @hello-pangea/dnd.
 */
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ChevronDown, ChevronUp, Sparkles, X } from "lucide-react";
import DroneThumbnail from "@/components/drone/DroneThumbnail";
import { cn } from "@/lib/utils";

// Human-readable room type labels — consistent with Pass 1 prompt taxonomy.
const ROOM_TYPE_LABEL = {
  master_bedroom: "Master Bedroom",
  bedroom_secondary: "Secondary Bedroom",
  bedroom: "Bedroom",
  kitchen_main: "Kitchen",
  kitchen: "Kitchen",
  living_main: "Living Room",
  living_secondary: "Secondary Living",
  living: "Living",
  dining: "Dining",
  bathroom_main: "Main Bathroom",
  bathroom_ensuite: "Ensuite",
  bathroom: "Bathroom",
  laundry: "Laundry",
  hallway: "Hallway",
  staircase: "Staircase",
  alfresco: "Alfresco",
  patio: "Patio",
  pool: "Pool",
  garden: "Garden",
  exterior_front: "Exterior Front",
  exterior_rear: "Exterior Rear",
  exterior_side: "Exterior Side",
  exterior: "Exterior",
  garage: "Garage",
  study: "Study/Office",
  office: "Office",
  detail: "Detail",
  twilight: "Twilight",
  drone: "Drone",
};

function humanRoomType(rt) {
  if (!rt) return "—";
  if (ROOM_TYPE_LABEL[rt]) return ROOM_TYPE_LABEL[rt];
  return rt
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function formatScore(n) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toFixed(1);
}

function shortFilename(s, max = 32) {
  if (!s) return "—";
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3)}...`;
}

/**
 * @param {object} props
 * @param {object} props.composition  composition group + classification + slot info
 * @param {string} props.column       'rejected' | 'proposed' | 'approved'
 * @param {Array}  props.alternatives top-2 alternatives for this slot, each
 *                                    { group_id, stem, combined_score, room_type, analysis }
 * @param {boolean} props.isDragging  true while @hello-pangea drag is active
 * @param {function} props.onSwapAlternative  invoked with (altGroupId) when an alt is tapped
 */
export default function ShortlistingCard({
  composition,
  column,
  alternatives = [],
  isDragging = false,
  onSwapAlternative,
}) {
  const [analysisExpanded, setAnalysisExpanded] = useState(false);
  const [altsExpanded, setAltsExpanded] = useState(false);

  const c = composition || {};
  const cls = c.classification || {};
  const slot = c.slot || null; // { slot_id, phase, rank } when shortlisted

  const filename = c.delivery_reference_stem || c.best_bracket_stem || "—";
  const roomType = humanRoomType(cls.room_type);
  const tScore = cls.technical_score;
  const lScore = cls.lighting_score;
  const compScore = cls.composition_score;
  const aScore = cls.aesthetic_score;
  const avgScore =
    cls.combined_score != null
      ? cls.combined_score
      : tScore != null && lScore != null && compScore != null && aScore != null
        ? (Number(tScore) + Number(lScore) + Number(compScore) + Number(aScore)) / 4
        : null;

  const previewPath = c.dropbox_preview_path;

  return (
    <Card
      className={cn(
        "rounded-md border bg-card overflow-hidden transition-shadow",
        isDragging && "ring-2 ring-primary/60 shadow-lg",
        column === "approved" && "border-emerald-300 dark:border-emerald-800",
        column === "rejected" && "border-red-200 dark:border-red-900",
      )}
    >
      {/* Thumbnail */}
      <div className="relative">
        <DroneThumbnail
          dropboxPath={previewPath}
          mode="thumb"
          alt={filename}
          aspectRatio="aspect-[4/3]"
          overlay={
            <>
              {column === "approved" && (
                <span className="absolute top-1 left-1 text-[9px] px-1 py-0.5 rounded bg-emerald-600 text-white pointer-events-none">
                  Approved
                </span>
              )}
              {column === "rejected" && (
                <span className="absolute top-1 left-1 text-[9px] px-1 py-0.5 rounded bg-red-600 text-white pointer-events-none">
                  Rejected
                </span>
              )}
              {column === "proposed" && slot?.slot_id && (
                <span className="absolute top-1 left-1 text-[9px] px-1 py-0.5 rounded bg-amber-500 text-white pointer-events-none">
                  Proposed
                </span>
              )}
            </>
          }
        />
      </div>

      {/* Body */}
      <div className="p-2 space-y-1.5">
        {/* Filename + room type */}
        <div className="space-y-0.5">
          <div
            className="text-[11px] font-mono truncate text-foreground"
            title={filename}
          >
            {shortFilename(filename)}
          </div>
          <div className="text-[10px] text-muted-foreground truncate">
            {roomType}
          </div>
        </div>

        {/* Slot badge */}
        {slot?.slot_id && (
          <div className="flex items-center gap-1 flex-wrap">
            <Badge
              variant="outline"
              className={cn(
                "text-[9px] h-4 px-1.5 font-medium",
                column === "approved"
                  ? "border-emerald-400 text-emerald-700 dark:text-emerald-300"
                  : "border-amber-400 text-amber-700 dark:text-amber-300",
              )}
            >
              {slot.slot_id}
            </Badge>
            {slot.phase != null && (
              <span className="text-[9px] text-muted-foreground">
                phase {slot.phase}
              </span>
            )}
          </div>
        )}

        {/* 4-dim scores */}
        <div className="flex items-center gap-1.5 flex-wrap text-[10px] font-mono text-muted-foreground">
          <span>C={formatScore(compScore)}</span>
          <span>L={formatScore(lScore)}</span>
          <span>T={formatScore(tScore)}</span>
          <span>A={formatScore(aScore)}</span>
          <span className="font-semibold text-foreground">
            avg={formatScore(avgScore)}
          </span>
        </div>

        {/* Flags */}
        {cls.flag_for_retouching && (
          <Badge variant="outline" className="text-[9px] h-4 px-1 border-amber-400 text-amber-700 dark:text-amber-300">
            <Sparkles className="h-2.5 w-2.5 mr-1" />
            Retouch
          </Badge>
        )}
        {cls.is_near_duplicate_candidate && column !== "approved" && (
          <Badge variant="outline" className="text-[9px] h-4 px-1 border-orange-400 text-orange-700 dark:text-orange-300">
            Near-dup
          </Badge>
        )}

        {/* Analysis (3-line truncation, click to expand) */}
        {cls.analysis && (
          <div className="space-y-0.5">
            <p
              className={cn(
                "text-[10px] leading-snug text-muted-foreground",
                !analysisExpanded && "line-clamp-3",
              )}
            >
              {cls.analysis}
            </p>
            {cls.analysis.length > 120 && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setAnalysisExpanded((v) => !v);
                }}
                className="text-[9px] text-primary hover:underline focus:outline-none"
              >
                {analysisExpanded ? "Show less" : "Show more"}
              </button>
            )}
          </div>
        )}

        {/* Alternatives tray (only on proposed/approved cards with alts) */}
        {alternatives.length > 0 && column !== "rejected" && (
          <div className="border-t pt-1.5 mt-1">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setAltsExpanded((v) => !v);
              }}
              className="flex items-center gap-1 text-[10px] text-primary hover:underline focus:outline-none"
            >
              {altsExpanded ? (
                <ChevronUp className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
              {alternatives.length} alternative{alternatives.length === 1 ? "" : "s"}
            </button>
            {altsExpanded && (
              <div className="space-y-1 mt-1">
                {alternatives.map((alt) => (
                  <button
                    key={alt.group_id}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (onSwapAlternative) onSwapAlternative(alt.group_id);
                    }}
                    className="w-full text-left rounded-sm bg-muted/50 hover:bg-muted px-1.5 py-1 text-[10px] flex items-center justify-between gap-1"
                    title="Click to swap into this slot"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-mono truncate">
                        {shortFilename(alt.stem || alt.delivery_reference_stem || "—", 24)}
                      </div>
                      {alt.analysis && (
                        <div className="text-muted-foreground truncate text-[9px]">
                          {alt.analysis}
                        </div>
                      )}
                    </div>
                    <span className="text-[9px] font-mono text-muted-foreground whitespace-nowrap">
                      avg={formatScore(alt.combined_score)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
