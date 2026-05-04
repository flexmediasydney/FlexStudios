/**
 * SwimlaneGridView — 2D shortlisting swimlane.
 *
 * Visual chrome inherited from the legacy 3-lane layout:
 *   - Same red / amber / emerald lane header tones (COLUMN_META)
 *   - Same ShortlistingCard render (full card, not a stripped-down tile)
 *   - Same previewSize density (sm/md/lg)
 *   - Spacer columns between the 3 bucket lanes (gap-3 on the wrapper)
 *
 * What's new vs the legacy lanes:
 *   - Rows = composition_classifications.space_type (room_type fallback,
 *     "Unclassified" bucket for missing).
 *   - Sub-rows = composition_groups.space_instance_id (only when >1
 *     instance for the same space_type — single-instance rooms render
 *     flat).
 *   - Sticky row label on the left, sticky lane headers on top.
 *   - Per-row rollup count "X candidates · Y picked · Z approved".
 *
 * Out of scope (per Joseph): drag-and-drop, inline approve/reject.  The
 * grid is read-only-with-click-to-lightbox; operators use the lane view
 * for action interactions.
 */

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import ShortlistingCard from "./ShortlistingCard";
import { PREVIEW_SIZES } from "@/hooks/useSwimlaneSettings";

// Inlined to avoid a circular import with ShortlistingSwimlane (which
// itself imports SwimlaneGridView).  Mirrors `previewGridStyle` exactly
// so the cell density matches the legacy lane density 1:1.
function previewGridStyle(previewSize) {
  const minPx = PREVIEW_SIZES[previewSize]?.gridMinPx ?? PREVIEW_SIZES.md.gridMinPx;
  return {
    display: "grid",
    gridTemplateColumns: `repeat(auto-fill, minmax(${minPx}px, 1fr))`,
  };
}

// ─── Lane chrome (mirrors COLUMNS in ShortlistingSwimlane.jsx) ────────────

const COLUMN_META = [
  {
    key: "rejected",
    label: "REJECTED",
    headerTone:
      "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300",
    cellTone:
      "bg-red-50/40 dark:bg-red-950/15",
    border:
      "border-red-200/60 dark:border-red-900/50",
  },
  {
    key: "proposed",
    label: "AI PROPOSED",
    headerTone:
      "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
    cellTone:
      "bg-amber-50/40 dark:bg-amber-950/15",
    border:
      "border-amber-200/60 dark:border-amber-900/50",
  },
  {
    key: "approved",
    label: "HUMAN APPROVED",
    headerTone:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
    cellTone:
      "bg-emerald-50/40 dark:bg-emerald-950/15",
    border:
      "border-emerald-200/60 dark:border-emerald-900/50",
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────

function snakeToTitle(s) {
  if (!s || typeof s !== "string") return s;
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function pickEditorialScore(item) {
  const slot = item?.slot || null;
  if (slot?.editorial && typeof slot.editorial.editorial_score === "number") {
    return slot.editorial.editorial_score;
  }
  if (typeof slot?.slot_fit_score === "number") return slot.slot_fit_score;
  return null;
}

function instanceLabel(instance) {
  if (!instance) return "Instance —";
  if (instance.display_label && instance.display_label.trim()) {
    return instance.display_label.trim();
  }
  if (typeof instance.instance_index === "number") {
    return `Instance ${instance.instance_index}`;
  }
  return "Instance —";
}

// ─── Row builder ──────────────────────────────────────────────────────────

function buildGridRows({ columnItems, spaceInstancesById, heroRoomsOrder }) {
  const byRoom = new Map();
  const heroIndex = new Map();
  heroRoomsOrder.forEach((r, i) => heroIndex.set(r.toLowerCase(), i));

  const cellSort = (a, b) => {
    const sa = pickEditorialScore(a) ?? a?.classification?.combined_score ?? -Infinity;
    const sb = pickEditorialScore(b) ?? b?.classification?.combined_score ?? -Infinity;
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
        const instRow = instanceId
          ? spaceInstancesById?.[instanceId] || null
          : null;
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

  // Sort cells.
  for (const room of byRoom.values()) {
    for (const inst of room.instances.values()) {
      inst.rejected.sort(cellSort);
      inst.proposed.sort(cellSort);
      inst.approved.sort(cellSort);
    }
  }

  // Stable row ordering: hero rooms (in policy order) → totalCount desc →
  // alphabetical → "Unclassified" pinned last.
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

  // Sub-rows: sort instances by instance_index asc.
  for (const room of rows) {
    room.instancesOrdered = Array.from(room.instances.values()).sort((a, b) => {
      const ai = a.instanceRow?.instance_index;
      const bi = b.instanceRow?.instance_index;
      if (typeof ai === "number" && typeof bi === "number") return ai - bi;
      if (typeof ai === "number") return -1;
      if (typeof bi === "number") return 1;
      return 0;
    });
  }

  return rows;
}

// ─── Cell ─────────────────────────────────────────────────────────────────

function GridCell({ items, column, previewSize, onCardClick, columnItems }) {
  if (!items || items.length === 0) {
    return (
      <div
        className={cn(
          "rounded-md border min-h-[120px] flex items-center justify-center",
          column.cellTone,
          column.border,
        )}
        data-testid={`grid-cell-empty-${column.key}`}
      >
        <span className="text-[11px] text-muted-foreground/60 italic">
          —
        </span>
      </div>
    );
  }
  // Use the same density-grid style as the legacy lane bucket so card
  // sizing + spacing matches exactly.
  const gridStyle = { ...previewGridStyle(previewSize), gap: "0.5rem" };
  return (
    <div
      className={cn(
        "rounded-md border p-2",
        column.cellTone,
        column.border,
      )}
      style={gridStyle}
      data-testid={`grid-cell-${column.key}`}
      data-preview-size={previewSize}
    >
      {items.map((item) => {
        // The grid view doesn't carry the alts tray (no per-slot
        // alternatives sidebar in this layout), so we pass an empty
        // alternatives array and skip onSwapAlternative.  Drag is also
        // disabled — operators use the Lane view for those interactions.
        const masterListBucket = columnItems?.[column.key] || [];
        const indexInBucket = masterListBucket.findIndex(
          (x) => x.id === item.id,
        );
        return (
          <ShortlistingCard
            key={item.id}
            composition={item}
            column={column.key}
            alternatives={[]}
            isDragging={false}
            previewSize={previewSize}
            onImageClick={() => onCardClick?.(item, column.key, indexInBucket)}
          />
        );
      })}
    </div>
  );
}

// ─── Row label (sticky left) ─────────────────────────────────────────────

function RowHeaderLabel({ title, subtitle, counts, indented, topBorder }) {
  return (
    <div
      className={cn(
        "sticky left-0 z-10 bg-background/95 backdrop-blur-sm px-3 py-2 text-xs flex flex-col justify-center",
        indented && "pl-7",
        topBorder && "border-t border-border/40",
      )}
      style={{ minHeight: 80 }}
    >
      <div
        className={cn(
          "font-medium",
          indented && "text-muted-foreground font-normal",
        )}
      >
        {title}
      </div>
      {subtitle ? (
        <div className="text-[10px] text-muted-foreground truncate">
          {subtitle}
        </div>
      ) : null}
      {counts ? (
        <div className="text-[9px] font-mono tabular-nums text-muted-foreground mt-0.5">
          {counts}
        </div>
      ) : null}
    </div>
  );
}

// ─── Row + sub-row renderers ─────────────────────────────────────────────

function GridRow({
  room,
  previewSize,
  onCardClick,
  columnItems,
  isFirst,
}) {
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
  const counts = `${totals.rejected} R · ${totals.proposed} P · ${totals.approved} A`;

  return (
    <>
      <RowHeaderLabel
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
        counts={counts}
        topBorder={!isFirst}
      />
      {flat
        ? COLUMN_META.map((col) => (
            <div
              key={col.key}
              className={cn("p-1.5", !isFirst && "border-t border-border/40")}
            >
              <GridCell
                items={flatInst?.[col.key] || []}
                column={col}
                previewSize={previewSize}
                onCardClick={onCardClick}
                columnItems={columnItems}
              />
            </div>
          ))
        : COLUMN_META.map((col) => (
            <div
              key={col.key}
              className={cn(
                "p-1.5 flex items-center justify-center text-[10px] text-muted-foreground italic",
                !isFirst && "border-t border-border/40",
              )}
            >
              {expanded ? "↓ split by instance" : `${totals[col.key]} (collapsed)`}
            </div>
          ))}

      {hasMultipleInstances && expanded
        ? room.instancesOrdered.map((inst) => (
            <SubRow
              key={inst.instKey}
              inst={inst}
              previewSize={previewSize}
              onCardClick={onCardClick}
              columnItems={columnItems}
            />
          ))
        : null}
    </>
  );
}

function SubRow({ inst, previewSize, onCardClick, columnItems }) {
  return (
    <>
      <RowHeaderLabel
        title={instanceLabel(inst.instanceRow)}
        subtitle={
          inst.instanceRow?.distinctive_features?.length > 0
            ? inst.instanceRow.distinctive_features.slice(0, 2).join(", ")
            : null
        }
        counts={`${inst.rejected.length} R · ${inst.proposed.length} P · ${inst.approved.length} A`}
        indented
        topBorder
      />
      {COLUMN_META.map((col) => (
        <div
          key={col.key}
          className="p-1.5 border-t border-border/40"
          data-testid={`grid-subrow-${inst.instKey}-bucket-${col.key}`}
        >
          <GridCell
            items={inst[col.key]}
            column={col}
            previewSize={previewSize}
            onCardClick={onCardClick}
            columnItems={columnItems}
          />
        </div>
      ))}
    </>
  );
}

// ─── Main component ─────────────────────────────────────────────────────

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

  // Roll-up totals for the column headers.
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

  // CSS Grid: 240px sticky room label + 3 lane columns, separated by
  // gap-3 (matches the legacy lane spacing exactly).
  const gridStyle = {
    display: "grid",
    gridTemplateColumns: "240px repeat(3, minmax(0, 1fr))",
    columnGap: "0.75rem",
    rowGap: "0",
  };

  return (
    <div
      className="rounded-md border-2 bg-card overflow-x-auto"
      data-testid="swimlane-grid-view"
    >
      <div style={gridStyle} className="min-w-[1024px] p-1.5">
        {/* Sticky header row — same chrome as the legacy lane headers
            (red/amber/emerald tones, uppercase label, count badge). */}
        <div className="sticky top-0 z-20 bg-background/95 backdrop-blur px-2 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground border-b border-border/40">
          Room
        </div>
        {COLUMN_META.map((col) => (
          <div
            key={col.key}
            className={cn(
              "sticky top-0 z-20 px-2 py-1.5 text-xs font-semibold flex items-center justify-between rounded-t-sm",
              col.headerTone,
            )}
          >
            <span className="uppercase tracking-wide">{col.label}</span>
            <span className="tabular-nums">{totals[col.key]}</span>
          </div>
        ))}

        {rows.map((row, idx) => (
          <GridRow
            key={row.roomKey}
            room={row}
            previewSize={density}
            onCardClick={onCardClick}
            columnItems={columnItems}
            isFirst={idx === 0}
          />
        ))}
      </div>
    </div>
  );
}
