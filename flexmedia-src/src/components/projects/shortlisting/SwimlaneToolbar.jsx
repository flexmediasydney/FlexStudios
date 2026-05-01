/**
 * SwimlaneToolbar — W11.6.1 operator UX above the 3-column swimlane.
 *
 * Renders sort / filter / preview-size / group-by-slot / elapsed-timer
 * controls in a single horizontal strip, with the slot counter banner
 * sitting beneath. Pure presentational — all state lives in the parent
 * (`ShortlistingSwimlane`) so a single source of truth drives the columns.
 *
 * Sub-features wired here:
 *   1. Sort dropdown (P3 #3)            — sort prop + onSortChange callback
 *   2. Filter chips   (P3 #3 cont.)     — slotIds/roomTypes Sets + setFilter
 *   3. Preview size   (P3 #5)           — sm/md/lg toggle
 *   4. Slot counter   (P3 #6)           — SwimlaneSlotCounter named export
 *   5. Group-by-slot  (P3 #9)           — boolean toggle
 *   6. Elapsed timer  (P3 #7)           — useSwimlaneElapsedTimer hook
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import {
  ArrowDownAZ,
  Filter,
  ImageIcon,
  Layers,
  Timer,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  CANONICAL_SLOT_IDS,
  PHASE_OF_SLOT,
  SLOT_DISPLAY_NAMES,
} from "@/lib/swimlaneSlots";
import {
  PREVIEW_SIZES,
  SORT_OPTIONS,
} from "@/hooks/useSwimlaneSettings";

/**
 * Top-level toolbar. Pure presentational — receives state + setters from the
 * swimlane parent. Renders compact left-to-right:
 *   [Sort ▾] [Filter ▾] [sm/md/lg] [Group: on/off] [Stage X · 0:42]
 *
 * The filter chips render as pills BELOW the toolbar row when any are active,
 * so the toolbar itself stays single-row even when the operator has 5 slot
 * filters.
 */
export default function SwimlaneToolbar({
  sort,
  onSortChange,
  filter,
  onFilterChange,
  previewSize,
  onPreviewSizeChange,
  groupBySlot,
  onGroupBySlotChange,
  availableSlotIds = [],
  availableRoomTypes = [],
  timerLabel = null,
}) {
  const slotChips = useMemo(() => {
    return [...filter.slotIds].sort().map((slotId) => ({
      key: `slot:${slotId}`,
      kind: "slot",
      value: slotId,
      label: SLOT_DISPLAY_NAMES[slotId] || slotId,
    }));
  }, [filter.slotIds]);
  const roomChips = useMemo(() => {
    return [...filter.roomTypes].sort().map((rt) => ({
      key: `room:${rt}`,
      kind: "room",
      value: rt,
      label: rt.replace(/_/g, " "),
    }));
  }, [filter.roomTypes]);

  const toggleSlot = (slotId) => {
    const next = new Set(filter.slotIds);
    if (next.has(slotId)) next.delete(slotId);
    else next.add(slotId);
    onFilterChange({ slotIds: next, roomTypes: filter.roomTypes });
  };
  const toggleRoom = (roomType) => {
    const next = new Set(filter.roomTypes);
    if (next.has(roomType)) next.delete(roomType);
    else next.add(roomType);
    onFilterChange({ slotIds: filter.slotIds, roomTypes: next });
  };
  const clearFilters = () => {
    onFilterChange({ slotIds: new Set(), roomTypes: new Set() });
  };

  const activeFilterCount = filter.slotIds.size + filter.roomTypes.size;

  return (
    <div
      className="rounded-md border bg-card px-2 py-2 flex flex-col gap-2"
      data-testid="swimlane-toolbar"
    >
      <div className="flex items-center gap-2 flex-wrap">
        {/* Sort */}
        <div className="flex items-center gap-1">
          <ArrowDownAZ className="h-3.5 w-3.5 text-muted-foreground" />
          <Select value={sort} onValueChange={onSortChange}>
            <SelectTrigger
              className="h-8 w-[180px] text-xs"
              data-testid="swimlane-sort-trigger"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} className="text-xs">
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Filter */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant={activeFilterCount > 0 ? "secondary" : "outline"}
              size="sm"
              className="h-8 text-xs gap-1"
              data-testid="swimlane-filter-trigger"
            >
              <Filter className="h-3.5 w-3.5" />
              Filter
              {activeFilterCount > 0 && (
                <Badge variant="default" className="h-4 px-1 ml-1 text-[10px]">
                  {activeFilterCount}
                </Badge>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-64 max-h-[60vh] overflow-y-auto"
          >
            <DropdownMenuLabel className="text-xs">Slot</DropdownMenuLabel>
            {availableSlotIds.length === 0 ? (
              <div className="px-2 py-1 text-[11px] text-muted-foreground">
                No slots assigned yet
              </div>
            ) : (
              availableSlotIds.map((slotId) => (
                <DropdownMenuCheckboxItem
                  key={slotId}
                  checked={filter.slotIds.has(slotId)}
                  onCheckedChange={() => toggleSlot(slotId)}
                  className="text-xs"
                  onSelect={(e) => e.preventDefault()}
                >
                  {SLOT_DISPLAY_NAMES[slotId] || slotId}
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    P{PHASE_OF_SLOT[slotId] ?? "?"}
                  </span>
                </DropdownMenuCheckboxItem>
              ))
            )}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs">Room type</DropdownMenuLabel>
            {availableRoomTypes.length === 0 ? (
              <div className="px-2 py-1 text-[11px] text-muted-foreground">
                No room classifications yet
              </div>
            ) : (
              availableRoomTypes.map((rt) => (
                <DropdownMenuCheckboxItem
                  key={rt}
                  checked={filter.roomTypes.has(rt)}
                  onCheckedChange={() => toggleRoom(rt)}
                  className="text-xs"
                  onSelect={(e) => e.preventDefault()}
                >
                  {rt.replace(/_/g, " ")}
                </DropdownMenuCheckboxItem>
              ))
            )}
            {activeFilterCount > 0 && (
              <>
                <DropdownMenuSeparator />
                <button
                  type="button"
                  onClick={clearFilters}
                  className="w-full text-left px-2 py-1.5 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-sm"
                >
                  Clear all filters
                </button>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Preview size */}
        <div className="flex items-center gap-1">
          <ImageIcon className="h-3.5 w-3.5 text-muted-foreground" />
          <div
            className="inline-flex rounded-md border bg-background p-0.5"
            role="radiogroup"
            aria-label="Preview size"
          >
            {Object.entries(PREVIEW_SIZES).map(([key, meta]) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={previewSize === key}
                aria-label={`${meta.label} previews (${meta.px}px)`}
                title={`${meta.label} (${meta.px}px)`}
                onClick={() => onPreviewSizeChange(key)}
                data-testid={`swimlane-size-${key}`}
                className={cn(
                  "h-7 px-2 text-[11px] uppercase rounded-sm tracking-wide transition-colors",
                  previewSize === key
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {key}
              </button>
            ))}
          </div>
        </div>

        {/* Group-by-slot */}
        <Button
          variant={groupBySlot ? "secondary" : "outline"}
          size="sm"
          className="h-8 text-xs gap-1"
          onClick={() => onGroupBySlotChange(!groupBySlot)}
          data-testid="swimlane-group-toggle"
          aria-pressed={groupBySlot}
        >
          <Layers className="h-3.5 w-3.5" />
          Group by slot
        </Button>

        {/* Elapsed timer (right-aligned via spacer) */}
        {timerLabel && (
          <>
            <div className="flex-1" />
            <div
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
              data-testid="swimlane-elapsed-timer"
            >
              <Timer className="h-3.5 w-3.5" />
              <span className="tabular-nums">{timerLabel}</span>
            </div>
          </>
        )}
      </div>

      {/* Active-filter chips row — only renders when filters are active so
          the toolbar stays visually quiet at rest. */}
      {activeFilterCount > 0 && (
        <div
          className="flex items-center gap-1 flex-wrap"
          data-testid="swimlane-filter-chips"
        >
          {slotChips.map((chip) => (
            <Badge
              key={chip.key}
              variant="secondary"
              className="text-[10px] gap-1 pr-1"
            >
              <span className="text-muted-foreground">slot:</span>
              {chip.label}
              <button
                type="button"
                onClick={() => toggleSlot(chip.value)}
                className="ml-0.5 hover:text-red-500"
                aria-label={`Remove slot filter ${chip.label}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
          {roomChips.map((chip) => (
            <Badge
              key={chip.key}
              variant="secondary"
              className="text-[10px] gap-1 pr-1"
            >
              <span className="text-muted-foreground">room:</span>
              {chip.label}
              <button
                type="button"
                onClick={() => toggleRoom(chip.value)}
                className="ml-0.5 hover:text-red-500"
                aria-label={`Remove room filter ${chip.label}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Slot counter banner (sub-feature 4, P3 #6).
 *
 * Renders the live "Phase 1: 4/5 · Phase 2: 6/12 · Phase 3: 1/4" strip above
 * the columns. The expected counts are derived from the canonical slot enum;
 * the filled counts are derived from the current set of overrides + AI
 * proposals (reactive to data passed in by the parent).
 *
 * `proposedSlotIds` is the set of slot_ids the operator currently has in
 * the AI PROPOSED + HUMAN APPROVED columns (i.e. anything actively counted
 * as filled). The parent computes this from `columnItems` via
 * `slotByGroupId`.
 */
export function SwimlaneSlotCounter({ proposedSlotIds, packageCeiling }) {
  // Lattice expected counts — per spec, derived from canonical enum.
  // Premium / Standard / Approachable share the same lattice; the difference
  // is the package ceiling (cap on Phase 3 free recommendations).
  const expectedByPhase = useMemo(() => {
    const m = { 1: 0, 2: 0, 3: 0 };
    for (const slotId of CANONICAL_SLOT_IDS) {
      // ai_recommended is a sentinel; not counted as a fixed expected slot.
      if (slotId === "ai_recommended") continue;
      const phase = PHASE_OF_SLOT[slotId];
      if (phase) m[phase] += 1;
    }
    return m;
  }, []);

  // Filled = unique slot_ids in `proposedSlotIds` per phase.
  const filledByPhase = useMemo(() => {
    const m = { 1: 0, 2: 0, 3: 0 };
    if (!proposedSlotIds) return m;
    for (const slotId of proposedSlotIds) {
      if (!slotId) continue;
      // Sentinel always counts as Phase 3 free recommendation.
      if (slotId === "ai_recommended") {
        m[3] += 1;
        continue;
      }
      const phase = PHASE_OF_SLOT[slotId];
      if (phase) m[phase] += 1;
    }
    return m;
  }, [proposedSlotIds]);

  // Cap Phase 3 expected at min(slot_count, ceiling-expected1-expected2) so
  // the displayed denominator reflects the realistic free-rec budget rather
  // than the entire phase-3 slot vocabulary. For premium packages the cap
  // matches the lattice; for approachable it's tighter.
  const phase3Cap = useMemo(() => {
    if (typeof packageCeiling !== "number" || packageCeiling <= 0) {
      return expectedByPhase[3];
    }
    const remaining = Math.max(
      0,
      packageCeiling - expectedByPhase[1] - expectedByPhase[2],
    );
    return Math.min(expectedByPhase[3], remaining);
  }, [expectedByPhase, packageCeiling]);

  return (
    <div
      className="rounded-md border bg-muted/30 px-3 py-2 text-xs flex items-center gap-3 flex-wrap"
      data-testid="swimlane-slot-counter"
    >
      <span className="font-medium uppercase tracking-wide text-muted-foreground">
        Slots filled
      </span>
      <PhaseBadge
        phase={1}
        filled={filledByPhase[1]}
        expected={expectedByPhase[1]}
      />
      <span className="text-muted-foreground">·</span>
      <PhaseBadge
        phase={2}
        filled={filledByPhase[2]}
        expected={expectedByPhase[2]}
      />
      <span className="text-muted-foreground">·</span>
      <PhaseBadge phase={3} filled={filledByPhase[3]} expected={phase3Cap} />
    </div>
  );
}

function PhaseBadge({ phase, filled, expected }) {
  // Tone shifts as the phase fills:
  //   filled === 0     → muted (the operator hasn't started this phase)
  //   filled < expected → amber (in progress)
  //   filled === expected → green (complete)
  //   filled > expected (Phase 3 over-budget) → blue (info, not a problem)
  let tone = "text-muted-foreground";
  if (expected > 0 && filled === expected) {
    tone = "text-emerald-700 dark:text-emerald-300";
  } else if (filled > expected) {
    tone = "text-blue-700 dark:text-blue-300";
  } else if (filled > 0) {
    tone = "text-amber-700 dark:text-amber-300";
  }
  // W11.6.1-hotfix-2 BUG #1: data-testid attributes so smoke tests + Joseph's
  // live verification can read filled/expected without parsing the rendered
  // string.
  return (
    <span
      className={cn("font-medium tabular-nums", tone)}
      data-testid={`slot-counter-phase-${phase}`}
      data-filled={filled}
      data-expected={expected}
    >
      Phase {phase}:{" "}
      <span data-testid={`slot-counter-phase-${phase}-filled`}>{filled}</span>
      /
      <span data-testid={`slot-counter-phase-${phase}-expected`}>{expected}</span>
    </span>
  );
}

/**
 * Live elapsed timer (sub-feature 6, P3 #7).
 *
 * Polls the latest shortlisting_jobs row for the round and renders
 * "Stage X · Mm:Ss" using a 1Hz client tick. The hook returns null while
 * the round isn't actively processing so the parent can decide whether to
 * render the timer slot in the toolbar at all.
 *
 * Re-renders every second WITHOUT re-fetching — we re-fetch the job row at
 * a slower 5s cadence (matches DispatcherPanel's polling). This keeps the
 * elapsed display fluid without hammering the API.
 */
export function useSwimlaneElapsedTimer({ roundId, isActive }) {
  // Latest job for the round — cheap query, ordered desc, limit 1.
  const jobQuery = useQuery({
    queryKey: ["swimlane_latest_job", roundId],
    queryFn: async () => {
      const rows = await api.entities.ShortlistingJob.filter(
        { round_id: roundId },
        "-created_at",
        1,
      );
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    },
    enabled: Boolean(roundId) && Boolean(isActive),
    refetchInterval: isActive ? 5_000 : false,
    staleTime: 1_000,
  });

  // Local 1Hz tick so the seconds counter advances smoothly between fetches.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isActive) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [isActive]);

  if (!isActive) return null;
  const job = jobQuery.data;
  if (!job) return null;

  // Pick the most relevant timestamp for "elapsed":
  //   - started_at (running) preferred; fall back to created_at (pending).
  const startMs = job.started_at
    ? new Date(job.started_at).getTime()
    : job.created_at
      ? new Date(job.created_at).getTime()
      : null;
  if (!startMs || Number.isNaN(startMs)) return null;
  const elapsedSecs = Math.max(0, Math.floor((now - startMs) / 1_000));
  const mins = Math.floor(elapsedSecs / 60);
  const secs = elapsedSecs % 60;
  const stageLabel = STAGE_LABEL[job.kind] || job.kind || "Stage";
  return `${stageLabel} · ${mins}:${String(secs).padStart(2, "0")} elapsed`;
}

const STAGE_LABEL = {
  ingest: "Ingest",
  extract: "Extract",
  pass0: "Pass 0",
  pass1: "Pass 1",
  pass2: "Pass 2",
  pass3: "Pass 3",
  shape_d_stage1: "Stage 1",
  shape_d_stage2: "Stage 2",
  shape_d_stage3: "Stage 3",
  stage4_synthesis: "Stage 4",
};
