/**
 * SwimlaneGridView — compact 2D shortlisting view with FULL drag-drop +
 * override capture parity with the lane view.
 *
 * Layout (top → bottom):
 *
 *   ▼ KITCHEN              8 candidates · 2 picked · 0 approved
 *   ┌─ REJECTED  4fr ─────────────────┬─ AI PROPOSED  1fr ──┬─ APPROVED  1fr ─┐
 *   │ Day  ◆ ◆ ◆                       │ Day  ◆              │                 │
 *   │ Golden hour  ◆                   │ Golden hour  ◆      │                 │
 *   │ Dusk  ◆ ◆                        │                     │                 │
 *   └──────────────────────────────────┴─────────────────────┴─────────────────┘
 *
 * Per Joseph 2026-05-04: same codebase as the lane view for movements +
 * override capture.  This component:
 *
 *   - Reuses SwimlaneCardRenderer (the existing draggable wrapper around
 *     ShortlistingCard) so swap, why?, reclassify, alts drawer, and the
 *     IntersectionObserver-driven review-duration capture all work the
 *     same as in lane mode.
 *   - Wraps each (room × instance × bucket) cell in @hello-pangea/dnd
 *     Droppable with a compound id `${bucketKey}__${roomKey}__${instKey}`.
 *     The parent's onDragEnd extracts the bucket prefix so the existing
 *     human_action / training-data logic stays unchanged.
 *   - Sits INSIDE the parent's <DragDropContext>; the parent toggles
 *     between this and the lane view inside the same context.
 *
 * Visual decisions (all kept):
 *   - Lane chrome red / amber / emerald, lane spacers between buckets.
 *   - Lane width ratio 4fr : 1fr : 1fr (Rejected dominant).
 *   - Time-of-day sub-rows inside each cell, ONLY when >1 distinct time.
 *   - Smart collapse defaults: hero rooms with ≥1 candidate expanded;
 *     multi-instance rooms + Unclassified collapsed.
 *   - Density inherits previewSize; recommend operators bump to "sm"
 *     for the densest scan.
 */

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Droppable } from "@hello-pangea/dnd";
import { cn } from "@/lib/utils";
import { SwimlaneCardRenderer } from "./ShortlistingSwimlane";

// ─── Lane chrome (mirrors COLUMNS in ShortlistingSwimlane.jsx) ────────────

const COLUMN_META = [
  {
    key: "rejected",
    label: "REJECTED",
    width: "4fr",
    headerTone:
      "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300",
    cellTone:
      "bg-red-50/40 dark:bg-red-950/15 border-red-200/60 dark:border-red-900/50",
    droppingHighlight: "ring-2 ring-red-400/60",
  },
  {
    key: "proposed",
    label: "AI PROPOSED",
    width: "1fr",
    headerTone:
      "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
    cellTone:
      "bg-amber-50/40 dark:bg-amber-950/15 border-amber-200/60 dark:border-amber-900/50",
    droppingHighlight: "ring-2 ring-amber-400/60",
  },
  {
    key: "approved",
    label: "HUMAN APPROVED",
    width: "1fr",
    headerTone:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
    cellTone:
      "bg-emerald-50/40 dark:bg-emerald-950/15 border-emerald-200/60 dark:border-emerald-900/50",
    droppingHighlight: "ring-2 ring-emerald-400/60",
  },
];

const LANE_GRID_STYLE = {
  display: "grid",
  gridTemplateColumns: COLUMN_META.map((c) => c.width).join(" "),
  columnGap: "0.5rem",
};

// ─── Time-of-day sub-grouping ────────────────────────────────────────────

const TIME_OF_DAY_ORDER = ["day", "golden_hour", "dusk_twilight", "night"];
const TIME_OF_DAY_LABEL = {
  day: "Day",
  golden_hour: "Golden",
  dusk_twilight: "Dusk",
  night: "Night",
};

function timeOfDayKey(item) {
  return item?.classification?.time_of_day || "other";
}

function timeOfDayLabel(key) {
  return TIME_OF_DAY_LABEL[key] || key.replace(/_/g, " ");
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function snakeToTitle(s) {
  if (!s || typeof s !== "string") return s;
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function pickHeadlineScore(item) {
  const slot = item?.slot || null;
  if (slot?.editorial && typeof slot.editorial.editorial_score === "number") {
    return slot.editorial.editorial_score;
  }
  if (typeof slot?.slot_fit_score === "number") return slot.slot_fit_score;
  return item?.classification?.combined_score ?? null;
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

// Compound droppable id: `${bucketKey}__${roomKey}__${instKey}`.  Parent's
// onDragEnd splits on `__` to recover the bucket; the room/instance
// suffix is opaque to the action logic.  Encoding non-alpha chars so a
// space_type with weird chars (e.g. "kitchen/dining") still produces a
// valid droppableId.
function makeDroppableId(bucketKey, roomKey, instKey) {
  const safe = (s) => String(s ?? "").replace(/[^a-zA-Z0-9_-]/g, "-");
  return `${bucketKey}__${safe(roomKey)}__${safe(instKey)}`;
}

// ─── Row builder ──────────────────────────────────────────────────────────

function buildGridRows({ columnItems, spaceInstancesById, heroRoomsOrder }) {
  const byRoom = new Map();
  const heroSet = new Set(heroRoomsOrder.map((r) => r.toLowerCase()));
  const heroIndex = new Map();
  heroRoomsOrder.forEach((r, i) => heroIndex.set(r.toLowerCase(), i));

  const cellSort = (a, b) => {
    const sa = pickHeadlineScore(a) ?? -Infinity;
    const sb = pickHeadlineScore(b) ?? -Infinity;
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
          isHero: heroSet.has(roomKey.toLowerCase()),
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

  for (const room of byRoom.values()) {
    for (const inst of room.instances.values()) {
      inst.rejected.sort(cellSort);
      inst.proposed.sort(cellSort);
      inst.approved.sort(cellSort);
    }
  }

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

  for (const room of rows) {
    room.instancesOrdered = Array.from(room.instances.values()).sort((a, b) => {
      const ai = a.instanceRow?.instance_index;
      const bi = b.instanceRow?.instance_index;
      if (typeof ai === "number" && typeof bi === "number") return ai - bi;
      if (typeof ai === "number") return -1;
      if (typeof bi === "number") return 1;
      return 0;
    });
    room.totals = room.instancesOrdered.reduce(
      (acc, inst) => {
        acc.rejected += inst.rejected.length;
        acc.proposed += inst.proposed.length;
        acc.approved += inst.approved.length;
        return acc;
      },
      { rejected: 0, proposed: 0, approved: 0 },
    );
  }

  return rows;
}

function shouldRoomDefaultOpen(room) {
  if (room.isUnclassified) return false;
  if ((room.instancesOrdered?.length || 0) > 1) return false;
  if (room.isHero) return room.totalCount >= 1;
  return false;
}

// ─── Lane cell — Droppable + time-of-day sub-rows ────────────────────────

function LaneCell({
  inst,
  column,
  roomKey,
  density,
  isLocked,
  onSwapAlternative,
  altsBySlotId,
  classByGroupId,
  registerCardObserver,
  onAltsDrawerOpen,
  onCardImageClick,
}) {
  const rawItems = inst[column.key] || [];
  // CRITICAL — @hello-pangea/dnd requires Draggable indices within a
  // Droppable to be contiguous AND match render order.  We sort the
  // bucket's items by time_of_day priority first, then assign sequential
  // indices, then group for visual rendering.  Because items in the same
  // time bucket are now adjacent in the sorted array, rendering
  // group-by-group preserves the index→DOM-order invariant the library
  // needs.  Reordering the array also doesn't change semantics (the
  // bucket is the same regardless of internal order — sort is purely a
  // visual concern).
  const itemsSorted = useMemo(() => {
    const arr = [...rawItems];
    arr.sort((a, b) => {
      const at = timeOfDayKey(a);
      const bt = timeOfDayKey(b);
      const ai = TIME_OF_DAY_ORDER.indexOf(at);
      const bi = TIME_OF_DAY_ORDER.indexOf(bt);
      const apri = ai === -1 ? 99 : ai;
      const bpri = bi === -1 ? 99 : bi;
      if (apri !== bpri) return apri - bpri;
      // Within same time bucket, fall back to score desc (preserves the
      // existing cellSort tie-break).
      const sa = pickHeadlineScore(a) ?? -Infinity;
      const sb = pickHeadlineScore(b) ?? -Infinity;
      if (sb !== sa) return sb - sa;
      return (a?.group_index ?? 0) - (b?.group_index ?? 0);
    });
    return arr;
  }, [rawItems]);

  // Visually-grouped representation built from itemsSorted so the
  // sequential render index matches each Draggable's index.  Each entry
  // carries the index it'll be assigned during render.
  const grouped = useMemo(() => {
    const m = new Map();
    itemsSorted.forEach((it, idx) => {
      const k = timeOfDayKey(it);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push({ item: it, idx });
    });
    const sortedKeys = Array.from(m.keys()).sort((a, b) => {
      const ai = TIME_OF_DAY_ORDER.indexOf(a);
      const bi = TIME_OF_DAY_ORDER.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b);
    });
    return sortedKeys.map((k) => ({ key: k, entries: m.get(k) }));
  }, [itemsSorted]);

  const items = itemsSorted;

  const showTimeLabels = grouped.length > 1;
  const droppableId = makeDroppableId(column.key, roomKey, inst.instKey);

  return (
    <Droppable droppableId={droppableId} isDropDisabled={isLocked}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.droppableProps}
          className={cn(
            "rounded-md border p-1.5 min-h-[40px] transition",
            column.cellTone,
            snapshot.isDraggingOver && column.droppingHighlight,
          )}
          data-testid={`grid-cell-${column.key}-${roomKey}-${inst.instKey}`}
        >
          {items.length === 0 ? (
            <div className="text-center py-1 text-[10px] text-muted-foreground/60 italic">
              {snapshot.isDraggingOver
                ? "Drop here"
                : column.key === "approved"
                  ? "Drag here to approve"
                  : "—"}
            </div>
          ) : (
            <div className="space-y-1">
              {grouped.map((row) => (
                <div key={row.key} className="flex items-start gap-1.5">
                  {showTimeLabels ? (
                    <div
                      className="text-[8px] uppercase tracking-wide text-muted-foreground/70 font-medium pt-1 shrink-0"
                      style={{ width: 38 }}
                      title={row.key}
                    >
                      {timeOfDayLabel(row.key)}
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-1 flex-1 min-w-0">
                    {row.entries.map(({ item, idx }) => (
                      <div
                        key={item.id}
                        style={{
                          width:
                            density === "sm"
                              ? 110
                              : density === "lg"
                                ? 200
                                : 150,
                        }}
                        data-testid={`grid-card-wrap-${item.id}`}
                      >
                        <SwimlaneCardRenderer
                          item={item}
                          index={idx}
                          column={column}
                          isLocked={isLocked}
                          onSwapAlternative={onSwapAlternative}
                          altsBySlotId={altsBySlotId}
                          classByGroupId={classByGroupId}
                          registerCardObserver={registerCardObserver}
                          onAltsDrawerOpen={onAltsDrawerOpen}
                          previewSize={density}
                          onCardImageClick={
                            onCardImageClick
                              ? () => onCardImageClick(column.key, item)
                              : undefined
                          }
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          {provided.placeholder}
        </div>
      )}
    </Droppable>
  );
}

// ─── Room banner + 3-lane strip ──────────────────────────────────────────

function LaneStrip({ inst, roomKey, ...rest }) {
  return (
    <div style={LANE_GRID_STYLE} className="px-2 pb-2">
      {COLUMN_META.map((col) => (
        <LaneCell
          key={col.key}
          inst={inst}
          column={col}
          roomKey={roomKey}
          {...rest}
        />
      ))}
    </div>
  );
}

function RoomBanner({ room, ...rest }) {
  const [open, setOpen] = useState(() => shouldRoomDefaultOpen(room));
  const hasMultipleInstances = (room.instancesOrdered?.length || 0) > 1;
  const flat = !hasMultipleInstances;
  const flatInst = flat ? room.instancesOrdered[0] : null;
  const roomTitle = room.isUnclassified
    ? "Unclassified"
    : snakeToTitle(room.roomKey);

  return (
    <div
      className="rounded-md border bg-card overflow-hidden"
      data-testid={`grid-room-${room.roomKey}`}
      data-open={open}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/40 transition"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          )}
          <span className="text-sm font-semibold uppercase tracking-wide truncate">
            {roomTitle}
          </span>
          {hasMultipleInstances ? (
            <span className="text-[10px] text-muted-foreground ml-1 shrink-0">
              · {room.instancesOrdered.length} instances
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5 text-[10px] font-mono tabular-nums shrink-0">
          <span className="px-1.5 py-0.5 rounded-full bg-red-100/60 dark:bg-red-950/40 text-red-700 dark:text-red-300">
            {room.totals.rejected}
          </span>
          <span className="px-1.5 py-0.5 rounded-full bg-amber-100/60 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300">
            {room.totals.proposed}
          </span>
          <span className="px-1.5 py-0.5 rounded-full bg-emerald-100/60 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300">
            {room.totals.approved}
          </span>
        </div>
      </button>

      {open ? (
        flat ? (
          <LaneStrip inst={flatInst} roomKey={room.roomKey} {...rest} />
        ) : (
          <div className="space-y-1.5 px-2 pb-2">
            {room.instancesOrdered.map((inst) => (
              <InstanceBanner
                key={inst.instKey}
                inst={inst}
                roomKey={room.roomKey}
                {...rest}
              />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

function InstanceBanner({ inst, roomKey, ...rest }) {
  const [open, setOpen] = useState(true);
  return (
    <div
      className="rounded-md border bg-muted/20"
      data-testid={`grid-instance-${inst.instKey}`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-2 py-1.5 text-left hover:bg-muted/40 transition"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {open ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
          )}
          <span className="text-xs font-medium truncate">
            {instanceLabel(inst.instanceRow)}
          </span>
          {inst.instanceRow?.distinctive_features?.length > 0 ? (
            <span className="text-[10px] text-muted-foreground ml-1 truncate">
              · {inst.instanceRow.distinctive_features.slice(0, 2).join(", ")}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1 text-[9px] font-mono tabular-nums shrink-0">
          <span className="px-1 rounded bg-red-100/60 dark:bg-red-950/40 text-red-700 dark:text-red-300">
            {inst.rejected.length}
          </span>
          <span className="px-1 rounded bg-amber-100/60 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300">
            {inst.proposed.length}
          </span>
          <span className="px-1 rounded bg-emerald-100/60 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300">
            {inst.approved.length}
          </span>
        </div>
      </button>
      {open ? <LaneStrip inst={inst} roomKey={roomKey} {...rest} /> : null}
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────

export default function SwimlaneGridView({
  columnItems,
  spaceInstancesById,
  heroRoomsOrder = [],
  density = "md",
  // SwimlaneCardRenderer passthrough props — same as the lane view's
  // SwimlaneColumn invocation so the card behaviours (drag, swap, why?,
  // alts drawer, IntersectionObserver) are byte-identical here.
  isLocked = false,
  onSwapAlternative,
  altsBySlotId,
  classByGroupId,
  registerCardObserver,
  onAltsDrawerOpen,
  onCardImageClick,
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

  const totals = rows.reduce(
    (acc, room) => {
      acc.rejected += room.totals.rejected;
      acc.proposed += room.totals.proposed;
      acc.approved += room.totals.approved;
      return acc;
    },
    { rejected: 0, proposed: 0, approved: 0 },
  );

  // Common props bag forwarded into every cell.
  const cellProps = {
    density,
    isLocked,
    onSwapAlternative,
    altsBySlotId,
    classByGroupId,
    registerCardObserver,
    onAltsDrawerOpen,
    onCardImageClick,
  };

  return (
    <div className="space-y-2" data-testid="swimlane-grid-view">
      {/* Sticky lane-header rail — same red/amber/emerald tones as the
          legacy lane headers. */}
      <div
        style={LANE_GRID_STYLE}
        className="sticky top-0 z-10 bg-background/95 backdrop-blur px-2 py-1.5 rounded-md"
      >
        {COLUMN_META.map((col) => (
          <div
            key={col.key}
            className={cn(
              "px-2 py-1 text-xs font-semibold flex items-center justify-between rounded-sm",
              col.headerTone,
            )}
          >
            <span className="uppercase tracking-wide">{col.label}</span>
            <span className="tabular-nums">{totals[col.key]}</span>
          </div>
        ))}
      </div>

      {rows.map((room) => (
        <RoomBanner key={room.roomKey} room={room} {...cellProps} />
      ))}
    </div>
  );
}
