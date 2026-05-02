/**
 * SlotCoverageMatrix — Wave 11.6.23.
 *
 * Heatmap of slot fill state per round (last 30 rounds × N active slots).
 *   green  — slot filled at desired count, all wins
 *   amber  — at least one position came from ai_backfill, OR overfill
 *   red    — mandatory slot empty (gap)
 *   grey   — slot wasn't eligible for that round (engine_roles didn't match)
 *
 * Click a cell to open a Sheet with that round's slot decision detail.
 *
 * Pure helpers exported for unit tests:
 *   - colourClassFor(state) → tailwind classes (bg + ring)
 *   - aggregateStats(matrix) → { pctFilled, redRoundCount, zeroFillSlotCount }
 */
import React, { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

// Pure helpers ─────────────────────────────────────────────────────────────

export function colourClassFor(state) {
  switch (state) {
    case "green":
      return "bg-emerald-500 hover:ring-2 hover:ring-emerald-700";
    case "amber":
      return "bg-amber-400 hover:ring-2 hover:ring-amber-700";
    case "red":
      return "bg-rose-500 hover:ring-2 hover:ring-rose-700";
    case "grey":
    default:
      return "bg-slate-200 dark:bg-slate-700 hover:ring-2 hover:ring-slate-500";
  }
}

/**
 * Compute aggregate stats from a matrix shape:
 *   [{ slot_id, phase, rounds: [{ round_id, fill_state, ... }] }]
 * Mirrors the server-side calc but lets the client recompute when a
 * filter is applied locally.
 */
export function aggregateStats(matrix) {
  const result = {
    totalCells: 0,
    filledCells: 0,
    pctFilled: null,
    redRoundCount: 0,
    zeroFillSlotCount: 0,
  };
  if (!Array.isArray(matrix) || matrix.length === 0) return result;
  const redRounds = new Set();
  for (const slot of matrix) {
    let slotFilled = 0;
    let slotTotal = 0;
    for (const r of slot.rounds || []) {
      result.totalCells += 1;
      slotTotal += 1;
      if (r.fill_state === "green" || r.fill_state === "amber") {
        result.filledCells += 1;
        slotFilled += 1;
      }
      if (r.fill_state === "red" && r.round_id) {
        redRounds.add(r.round_id);
      }
    }
    if (slotTotal > 0 && slotFilled === 0) {
      result.zeroFillSlotCount += 1;
    }
  }
  result.redRoundCount = redRounds.size;
  result.pctFilled = result.totalCells === 0
    ? null
    : Math.round((1000 * result.filledCells) / result.totalCells) / 10;
  return result;
}

export default function SlotCoverageMatrix({ data, loading }) {
  const matrix = Array.isArray(data?.slot_coverage_matrix)
    ? data.slot_coverage_matrix
    : [];
  const aggregate = data?.coverage_aggregate_stats || aggregateStats(matrix);
  const [openCell, setOpenCell] = useState(null);

  // All distinct round ids across the matrix, sorted by recency.
  const roundColumns = (() => {
    const seen = new Map();
    for (const slot of matrix) {
      for (const r of slot.rounds || []) {
        if (r.round_id && !seen.has(r.round_id)) {
          seen.set(r.round_id, r.created_at || "");
        }
      }
    }
    return Array.from(seen.entries())
      .sort((a, b) => (b[1] || "").localeCompare(a[1] || ""))
      .map(([id]) => id);
  })();

  const cellByRound = (slot) =>
    Object.fromEntries((slot.rounds || []).map((r) => [r.round_id, r]));

  return (
    <Card data-testid="slot-coverage-matrix">
      <CardContent className="p-3 space-y-2">
        <div>
          <h3 className="text-sm font-semibold">Slot coverage matrix</h3>
          <p className="text-xs text-muted-foreground">
            {loading ? "Loading…" : ""}
            {!loading && matrix.length === 0 && (
              <span data-testid="coverage-empty">
                No slot data in the window. Run the engine on some rounds and
                this matrix will populate.
              </span>
            )}
            {!loading && matrix.length > 0 && (
              <span>
                Rows = active slots, columns = recent rounds (most recent
                first). Click a cell for the round/slot detail.
              </span>
            )}
          </p>
        </div>

        {matrix.length > 0 && (
          <div
            className="rounded border border-border bg-card p-2 overflow-x-auto"
            data-testid="coverage-grid-wrapper"
          >
            <table
              className="text-[10px] font-mono w-full"
              data-testid="coverage-grid"
            >
              <thead>
                <tr>
                  <th className="text-left pr-2 sticky left-0 bg-card pb-1">
                    slot · phase
                  </th>
                  {roundColumns.map((rid, i) => (
                    <th
                      key={rid}
                      className="text-center px-1 pb-1 text-muted-foreground"
                      title={rid}
                    >
                      r{roundColumns.length - i}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.map((slot) => {
                  const lookup = cellByRound(slot);
                  return (
                    <tr key={slot.slot_id} data-testid={`row-${slot.slot_id}`}>
                      <td className="pr-2 sticky left-0 bg-card whitespace-nowrap">
                        <span className="font-semibold">{slot.slot_id}</span>{" "}
                        <span className="text-muted-foreground">
                          · p{slot.phase}
                        </span>
                      </td>
                      {roundColumns.map((rid) => {
                        const cell = lookup[rid];
                        const state = cell?.fill_state || "grey";
                        return (
                          <td
                            key={rid}
                            className="px-0.5 py-0.5"
                            data-testid={`cell-${slot.slot_id}-${rid}`}
                          >
                            <button
                              type="button"
                              className={`w-5 h-5 rounded ${colourClassFor(
                                state,
                              )} cursor-pointer transition-shadow`}
                              title={`${slot.slot_id} · ${state}${
                                cell?.filled_count !== undefined
                                  ? ` · ${cell.filled_count} filled`
                                  : ""
                              }`}
                              onClick={() =>
                                setOpenCell({ slot, round_id: rid, cell })
                              }
                              data-testid={`cell-button-${slot.slot_id}-${rid}`}
                              aria-label={`${slot.slot_id} ${state}`}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div
          className="text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 items-center"
          data-testid="coverage-legend"
        >
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-3 rounded bg-emerald-500 inline-block" />
            green = filled at desired count
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-3 rounded bg-amber-400 inline-block" />
            amber = ai_backfill / overfill
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-3 rounded bg-rose-500 inline-block" />
            red = mandatory slot empty
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-3 rounded bg-slate-200 dark:bg-slate-700 inline-block" />
            grey = not eligible
          </span>
        </div>

        <div
          className="text-xs text-foreground"
          data-testid="coverage-aggregate-stats"
        >
          <span className="font-semibold">
            {aggregate.pct_filled ?? aggregate.pctFilled ?? "—"}%
          </span>{" "}
          of {aggregate.total_cells ?? aggregate.totalCells ?? 0} mandatory
          cells filled across {roundColumns.length} rounds ·{" "}
          <span className="font-semibold">
            {aggregate.red_round_count ?? aggregate.redRoundCount ?? 0}
          </span>{" "}
          rounds with 1+ red gaps ·{" "}
          <span className="font-semibold">
            {aggregate.zero_fill_slot_count ?? aggregate.zeroFillSlotCount ?? 0}
          </span>{" "}
          slot{(aggregate.zero_fill_slot_count ?? aggregate.zeroFillSlotCount ?? 0) === 1 ? "" : "s"} with 0 fills (deletion candidates).
        </div>
      </CardContent>

      <Sheet
        open={!!openCell}
        onOpenChange={(open) => !open && setOpenCell(null)}
      >
        <SheetContent
          side="right"
          className="w-[420px]"
          data-testid="cell-drawer"
        >
          {openCell && (
            <>
              <SheetHeader>
                <SheetTitle>
                  {openCell.slot.slot_id} · phase {openCell.slot.phase}
                </SheetTitle>
                <SheetDescription>
                  Fill state for round {openCell.round_id}
                </SheetDescription>
              </SheetHeader>
              <div className="mt-4 text-xs space-y-2">
                <div className="rounded border border-border p-2">
                  <div className="text-muted-foreground">Fill state</div>
                  <div className="font-mono uppercase font-semibold">
                    {openCell.cell?.fill_state || "grey"}
                  </div>
                </div>
                {openCell.cell && (
                  <div className="rounded border border-border p-2 space-y-0.5">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">
                        filled_count
                      </span>
                      <span className="font-mono font-semibold">
                        {openCell.cell.filled_count ?? 0}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">
                        min_required
                      </span>
                      <span className="font-mono font-semibold">
                        {openCell.cell.min_required ?? 0}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">
                        backfill_count
                      </span>
                      <span className="font-mono font-semibold">
                        {openCell.cell.backfill_count ?? 0}
                      </span>
                    </div>
                  </div>
                )}
                <p className="text-muted-foreground">
                  Deeper drill-down (the per-position slot_decisions list and
                  the eligibility-resolution log of which compositions almost
                  matched but didn't) is deferred to a follow-up wave — this
                  view shows the rolled-up state from
                  shortlisting_architecture_kpis.
                </p>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </Card>
  );
}
