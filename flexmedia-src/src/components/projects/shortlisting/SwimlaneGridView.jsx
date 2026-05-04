/**
 * SwimlaneGridView — 2D shortlisting swimlane.
 *
 * Replaces the legacy "group by slot" toggle that grouped cards within
 * a single bucket.  Operators wanted the OPPOSITE axis — grouping
 * across all three buckets so they can see all candidates for a single
 * position (rejected + proposed + approved) side-by-side.
 *
 * Layout:
 *
 *                              REJECTED              PROPOSED            APPROVED
 *   Kitchen (8 / 2 / 0)        ◆◆◆◆◆◆                ◆◆
 *   Master bedroom (3 / 1 / 0) ◆◆                    ◆
 *   Bedroom secondary
 *     ▸ Instance 1 (5 / 1 / 0) ◆◆                    ◆
 *     ▸ Instance 2 (3 / 1 / 0) ◆                     ◆
 *     ▸ Instance 3 (1 / 1 / 0)                       ◆
 *   …
 *   Unclassified (4 / 0 / 0)   ◆◆◆◆
 *
 * Rows = composition_classifications.space_type (or room_type fallback,
 *        or "Unclassified" bucket).
 * Sub-rows = composition_groups.space_instance_id (only when >1 instance
 *            for that space_type — single-instance rooms render flat).
 * Cols = the 3 swimlane buckets.
 *
 * Sort:
 *   - Rows: hero rooms first (policy.common_residential_rooms order),
 *           then by total candidate count desc, "Unclassified" last.
 *   - Sub-rows: by instance_index asc (1, 2, 3…).
 *   - Cells: by editorial_score desc (parsed from
 *            shortlisting_overrides.ai_proposed_analysis), then by
 *            classification.combined_score desc.
 *
 * Density:
 *   Inherits the swimlane previewSize (sm/md/lg) — sm fits ~4 cards
 *   per cell row, md fits ~3, lg fits ~2.
 *
 * Filters:
 *   Apply BEFORE the row grouping; the parent feeds the already-
 *   filtered columnItems in.
 *
 * Mobile:
 *   Below `lg` the parent should not render this — the toolbar toggle
 *   is disabled with a tooltip.  This component assumes lg+ width.
 *
 * Out of scope (v1):
 *   - Drag-and-drop across cells (would require swap mutation routing).
 *   - Inline approve/reject controls (per Joseph: "just how it currently
 *     works is fine" — operators use the lane view for those interactions).
 *   - Cell-level virtualisation (a kitchen with 30 candidates renders
 *     all 30; horizontal scroll inside the cell handles overflow).
 */

import { useMemo, useState } from "react";
import { ChevronRight, ChevronDown, ImageIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import DroneThumbnail from "@/components/drone/DroneThumbnail";
import { cn } from "@/lib/utils";

const BUCKET_META = [
  { key: "rejected", label: "Rejected", tone: "text-rose-700 dark:text-rose-300" },
  { key: "proposed", label: "AI Proposed", tone: "text-amber-700 dark:text-amber-300" },
  { key: "approved", label: "Human Approved", tone: "text-emerald-700 dark:text-emerald-300" },
];

const PREVIEW_SIZE_TO_CARD_PX = {
  sm: { thumb: 96, card: 120 },
  md: { thumb: 144, card: 180 },
  lg: { thumb: 200, card: 240 },
};

// Helpers ────────────────────────────────────────────────────────────────────

function snakeToTitle(s) {
  if (!s || typeof s !== "string") return s;
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseEditorialScore(rawAnalysis) {
  if (typeof rawAnalysis !== "string" || !rawAnalysis) return null;
  try {
    const parsed = JSON.parse(rawAnalysis);
    const ed = parsed?.editorial || parsed;
    if (ed && typeof ed.editorial_score === "number") return ed.editorial_score;
  } catch {
    // not a JSON envelope (legacy rounds) — no editorial score
  }
  return null;
}

function pickDisplayScore(item) {
  // 1. Editorial score from the JSON envelope (when round used mig 465).
  const slot = item?.slot || null;
  const editorial = slot?.editorial?.editorial_score;
  if (typeof editorial === "number") return { value: editorial, label: "ed", tone: "text-amber-300" };
  if (typeof slot?.slot_fit_score === "number") {
    return { value: slot.slot_fit_score, label: "ed", tone: "text-amber-300" };
  }
  const combined = item?.classification?.combined_score;
  if (typeof combined === "number") {
    return { value: combined, label: "Σ", tone: "text-blue-300" };
  }
  return null;
}

function instanceLabel(instance, fallbackIndex) {
  if (!instance) {
    return fallbackIndex != null ? `Instance ${fallbackIndex}` : "Instance —";
  }
  if (instance.display_label && instance.display_label.trim()) {
    return instance.display_label.trim();
  }
  if (typeof instance.instance_index === "number") {
    return `Instance ${instance.instance_index}`;
  }
  return "Instance —";
}

// Build the row list ─────────────────────────────────────────────────────────
//
// Group every card across the 3 buckets by space_type → space_instance_id.
// Returns an ordered array of row objects ready for rendering, with per-
// (row, bucket) card lists already sorted.

function buildGridRows({
  columnItems,
  spaceInstancesById,
  heroRoomsOrder,
}) {
  // Map: space_type -> { instances: Map<instId|'__none__', { row meta + buckets }> , totals }
  const byRoom = new Map();
  const heroIndex = new Map();
  heroRoomsOrder.forEach((r, i) => heroIndex.set(r.toLowerCase(), i));

  const sortCellByScore = (a, b) => {
    const sa = pickDisplayScore(a)?.value ?? -Infinity;
    const sb = pickDisplayScore(b)?.value ?? -Infinity;
    if (sb !== sa) return sb - sa;
    return (a?.group_index ?? 0) - (b?.group_index ?? 0);
  };

  for (const bucketKey of ["rejected", "proposed", "approved"]) {
    const items = Array.isArray(columnItems?.[bucketKey])
      ? columnItems[bucketKey]
      : [];
    for (const it of items) {
      const cls = it?.classification || null;
      const roomKey = cls?.space_type || cls?.room_type || "__unclassified__";
      const instanceId = it?.space_instance_id || cls?.space_instance_id || null;
      let roomBucket = byRoom.get(roomKey);
      if (!roomBucket) {
        roomBucket = {
          roomKey,
          isUnclassified: roomKey === "__unclassified__",
          instances: new Map(),
          totalCount: 0,
        };
        byRoom.set(roomKey, roomBucket);
      }
      const instKey = instanceId || "__none__";
      let inst = roomBucket.instances.get(instKey);
      if (!inst) {
        const instRow = instanceId ? spaceInstancesById?.[instanceId] || null : null;
        inst = {
          instKey,
          instanceId,
          instanceRow: instRow,
          rejected: [],
          proposed: [],
          approved: [],
          totalCount: 0,
        };
        roomBucket.instances.set(instKey, inst);
      }
      inst[bucketKey].push(it);
      inst.totalCount += 1;
      roomBucket.totalCount += 1;
    }
  }

  // Sort each instance's cells.
  for (const room of byRoom.values()) {
    for (const inst of room.instances.values()) {
      inst.rejected.sort(sortCellByScore);
      inst.proposed.sort(sortCellByScore);
      inst.approved.sort(sortCellByScore);
    }
  }

  // Stable row ordering:
  //   1. Hero rooms first (in policy.common_residential_rooms order)
  //   2. Then by totalCount desc
  //   3. Unclassified last
  const rows = Array.from(byRoom.values()).sort((a, b) => {
    if (a.isUnclassified && !b.isUnclassified) return 1;
    if (b.isUnclassified && !a.isUnclassified) return -1;
    const ai = heroIndex.has(a.roomKey.toLowerCase())
      ? heroIndex.get(a.roomKey.toLowerCase())
      : 9999;
    const bi = heroIndex.has(b.roomKey.toLowerCase())
      ? heroIndex.get(b.roomKey.toLowerCase())
      : 9999;
    if (ai !== bi) return ai - bi;
    if (b.totalCount !== a.totalCount) return b.totalCount - a.totalCount;
    return a.roomKey.localeCompare(b.roomKey);
  });

  // Sort each room's instances by instance_index asc; instances WITHOUT an
  // index sink to the bottom of the room.
  for (const room of rows) {
    const arr = Array.from(room.instances.values()).sort((a, b) => {
      const ai = a.instanceRow?.instance_index;
      const bi = b.instanceRow?.instance_index;
      if (typeof ai === "number" && typeof bi === "number") return ai - bi;
      if (typeof ai === "number") return -1;
      if (typeof bi === "number") return 1;
      return 0;
    });
    room.instancesOrdered = arr;
  }

  return rows;
}

// Cell — bucket × instance ──────────────────────────────────────────────────

function GridCell({ items, bucketKey, density, onCardClick }) {
  if (!items || items.length === 0) {
    return (
      <div
        className="h-full min-h-[60px] border border-dashed border-white/5 dark:border-white/10 rounded-md flex items-center justify-center"
        data-testid={`grid-cell-empty-${bucketKey}`}
      >
        <span className="text-[10px] text-muted-foreground/50">—</span>
      </div>
    );
  }
  return (
    <div
      className="flex flex-wrap gap-1.5 p-1.5"
      data-testid={`grid-cell-${bucketKey}`}
    >
      {items.map((it) => (
        <GridCard
          key={it.id}
          item={it}
          density={density}
          onClick={() => onCardClick?.(it, bucketKey)}
        />
      ))}
    </div>
  );
}

function GridCard({ item, density, onClick }) {
  const sizeMeta = PREVIEW_SIZE_TO_CARD_PX[density] || PREVIEW_SIZE_TO_CARD_PX.md;
  const stem = item?.delivery_reference_stem || item?.best_bracket_stem || item?.id;
  const score = pickDisplayScore(item);
  const slotLabel = item?.slot?.slot_id || null;
  const dropboxPath = item?.dropbox_preview_path || null;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ width: sizeMeta.card }}
      className={cn(
        "relative group rounded-md overflow-hidden bg-muted/40 border border-border/40 hover:border-primary/60 transition",
        "text-left flex flex-col",
      )}
      data-testid={`grid-card-${item.id}`}
      title={stem || "image"}
    >
      <div
        className="relative bg-muted overflow-hidden"
        style={{ height: Math.round(sizeMeta.thumb * 0.66) }}
      >
        {dropboxPath ? (
          <DroneThumbnail dropboxPath={dropboxPath} alt={stem || "image"} />
        ) : (
          <div className="h-full w-full flex items-center justify-center">
            <ImageIcon className="h-5 w-5 text-muted-foreground/40" />
          </div>
        )}
        {score ? (
          <span
            className={cn(
              "absolute top-1 right-1 px-1 py-0.5 rounded bg-black/70 text-[9px] font-mono tabular-nums",
              score.tone,
            )}
          >
            {score.label} {score.value.toFixed(1)}
          </span>
        ) : null}
      </div>
      <div className="px-1.5 py-1 space-y-0.5">
        <div className="text-[10px] font-mono text-foreground truncate">
          {stem}
        </div>
        {slotLabel ? (
          <div className="text-[9px] text-muted-foreground truncate" title={slotLabel}>
            {slotLabel}
          </div>
        ) : null}
      </div>
    </button>
  );
}

// Row & sub-row renderers ────────────────────────────────────────────────────

function RowHeader({ title, subtitle, counts, indented, topBorder }) {
  return (
    <div
      className={cn(
        "sticky left-0 z-10 bg-background/95 backdrop-blur-sm border-r border-border/40 px-2 py-1.5 text-xs",
        indented && "pl-6",
        topBorder && "border-t",
      )}
      style={{ minHeight: 60 }}
    >
      <div className={cn("font-medium truncate", indented && "text-muted-foreground font-normal")}>
        {title}
      </div>
      {subtitle ? (
        <div className="text-[10px] text-muted-foreground truncate">{subtitle}</div>
      ) : null}
      {counts ? (
        <div className="text-[9px] font-mono tabular-nums text-muted-foreground mt-0.5">
          {counts}
        </div>
      ) : null}
    </div>
  );
}

function GridRow({ room, density, onCardClick, isFirst }) {
  const [expanded, setExpanded] = useState(true);
  const hasMultipleInstances = (room.instancesOrdered?.length || 0) > 1;
  const totals = room.instancesOrdered.reduce(
    (acc, inst) => {
      acc.rejected += inst.rejected.length;
      acc.proposed += inst.proposed.length;
      acc.approved += inst.approved.length;
      return acc;
    },
    { rejected: 0, proposed: 0, approved: 0 },
  );
  const flat = !hasMultipleInstances;
  const flatInst = flat ? room.instancesOrdered[0] : null;

  const roomTitle = room.isUnclassified
    ? "Unclassified"
    : snakeToTitle(room.roomKey);
  const roomCounts = `${totals.rejected} R · ${totals.proposed} P · ${totals.approved} A`;

  return (
    <>
      <RowHeader
        title={
          <span className="flex items-center gap-1">
            {hasMultipleInstances ? (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="p-0.5 rounded hover:bg-muted"
                aria-label={expanded ? "Collapse instances" : "Expand instances"}
              >
                {expanded ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
              </button>
            ) : null}
            {roomTitle}
          </span>
        }
        subtitle={
          hasMultipleInstances
            ? `${room.instancesOrdered.length} instances · ${room.totalCount} candidates`
            : `${room.totalCount} candidates`
        }
        counts={roomCounts}
        topBorder={!isFirst}
      />
      {flat
        ? BUCKET_META.map((b) => (
            <div
              key={b.key}
              className={cn(!isFirst && "border-t")}
              data-testid={`grid-row-${room.roomKey}-bucket-${b.key}`}
            >
              <GridCell
                items={flatInst?.[b.key] || []}
                bucketKey={b.key}
                density={density}
                onCardClick={onCardClick}
              />
            </div>
          ))
        : BUCKET_META.map((b) => (
            <div
              key={b.key}
              className={cn(
                "flex items-center justify-center text-[10px] text-muted-foreground italic",
                !isFirst && "border-t",
              )}
            >
              {expanded ? "↓ split by instance" : `${totals[b.key]} (collapsed)`}
            </div>
          ))}

      {hasMultipleInstances && expanded
        ? room.instancesOrdered.map((inst) => (
            <SubRow
              key={inst.instKey}
              inst={inst}
              density={density}
              onCardClick={onCardClick}
            />
          ))
        : null}
    </>
  );
}

function SubRow({ inst, density, onCardClick }) {
  return (
    <>
      <RowHeader
        title={instanceLabel(
          inst.instanceRow,
          inst.instanceRow?.instance_index,
        )}
        subtitle={
          inst.instanceRow?.distinctive_features?.length > 0
            ? inst.instanceRow.distinctive_features.slice(0, 2).join(", ")
            : null
        }
        counts={`${inst.rejected.length} R · ${inst.proposed.length} P · ${inst.approved.length} A`}
        indented
        topBorder
      />
      {BUCKET_META.map((b) => (
        <div
          key={b.key}
          className="border-t"
          data-testid={`grid-subrow-${inst.instKey}-bucket-${b.key}`}
        >
          <GridCell
            items={inst[b.key]}
            bucketKey={b.key}
            density={density}
            onCardClick={onCardClick}
          />
        </div>
      ))}
    </>
  );
}

// Main component ─────────────────────────────────────────────────────────────

export default function SwimlaneGridView({
  columnItems,
  spaceInstancesById,
  heroRoomsOrder = [],
  density = "md",
  onCardClick,
}) {
  const rows = useMemo(
    () => buildGridRows({ columnItems, spaceInstancesById, heroRoomsOrder }),
    [columnItems, spaceInstancesById, heroRoomsOrder],
  );

  if (rows.length === 0) {
    return (
      <div
        className="rounded-md border bg-muted/20 p-6 text-sm text-muted-foreground text-center"
        data-testid="grid-view-empty"
      >
        No cards to display in the grid view.
      </div>
    );
  }

  // CSS Grid: column-1 = sticky room label (240px), columns 2-4 = bucket cells.
  // Each bucket cell takes the remaining space equally.
  const gridStyle = {
    display: "grid",
    gridTemplateColumns: "240px repeat(3, minmax(0, 1fr))",
    gap: "0px",
  };

  const totals = rows.reduce(
    (acc, row) => {
      for (const inst of row.instancesOrdered) {
        acc.rejected += inst.rejected.length;
        acc.proposed += inst.proposed.length;
        acc.approved += inst.approved.length;
      }
      return acc;
    },
    { rejected: 0, proposed: 0, approved: 0 },
  );

  return (
    <div
      className="rounded-md border bg-card overflow-x-auto"
      data-testid="swimlane-grid-view"
    >
      <div style={gridStyle} className="min-w-[900px]">
        {/* Sticky column header */}
        <div className="sticky top-0 z-20 bg-muted/80 backdrop-blur border-b border-r border-border/40 px-2 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Room
        </div>
        {BUCKET_META.map((b) => (
          <div
            key={b.key}
            className={cn(
              "sticky top-0 z-20 bg-muted/80 backdrop-blur border-b border-border/40 px-2 py-1.5 text-[10px] font-medium uppercase tracking-wide flex items-center justify-between",
              b.tone,
            )}
          >
            <span>{b.label}</span>
            <Badge variant="secondary" className="font-mono tabular-nums">
              {totals[b.key]}
            </Badge>
          </div>
        ))}

        {rows.map((row, idx) => (
          <GridRow
            key={row.roomKey}
            room={row}
            density={density}
            onCardClick={onCardClick}
            isFirst={idx === 0}
          />
        ))}
      </div>
    </div>
  );
}
