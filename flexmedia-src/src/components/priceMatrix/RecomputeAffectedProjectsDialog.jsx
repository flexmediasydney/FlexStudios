import { useState, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { refetchEntityList } from "@/components/hooks/useEntityData";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Loader2, RefreshCw, Lock, TrendingDown, TrendingUp, AlertCircle, Info } from "lucide-react";

/**
 * Modal for the admin "Recompute Affected Projects" flow.
 *
 * Lifecycle:
 *   1. opens → immediately fires a dry_run call to
 *      `bulkRecomputeProjectsByMatrix` with the current matrix_id.
 *   2. renders a loading state while the dry-run completes. The backend
 *      iterates every affected project and asks calculateProjectPricing
 *      for a fresh price without writing.
 *   3. on success, renders a table of preview rows + summary (total delta,
 *      counts by status).
 *   4. clicking "Confirm update" fires dry_run=false which delegates to
 *      recalculateProjectPricingServerSide per non-skipped project.
 *
 * Props:
 *   - open, onOpenChange (controlled)
 *   - matrixId, matrixLabel (for title/audit context)
 *
 * SKIP-RULES mirror the backend:
 *   pricing_locked_at set    → "locked — skipped"    (amber badge)
 *   new_price === old_price  → "unchanged"           (muted badge)
 *   calc error               → "error"               (red badge)
 *   otherwise                → "will update"         (blue/green badge)
 */
export default function RecomputeAffectedProjectsDialog({
  open,
  onOpenChange,
  matrixId,
  matrixLabel,
}) {
  const queryClient = useQueryClient();
  const [hasFetched, setHasFetched] = useState(false);

  // Dry-run mutation — runs once on open.
  const dryRun = useMutation({
    mutationFn: async () => {
      const result = await api.functions.invoke("bulkRecomputeProjectsByMatrix", {
        matrix_id: matrixId,
        dry_run: true,
      });
      return result;
    },
    onSuccess: () => setHasFetched(true),
    onError: (err) => {
      console.error("bulkRecompute dry-run error:", err);
      toast.error("Failed to preview affected projects. Please try again.");
      setHasFetched(true); // show the error state instead of hanging
    },
  });

  // Kick off the dry-run exactly once per open. Reset when closed so a
  // subsequent re-open gets fresh data (prices may have moved on the server).
  const handleOpenChange = (isOpen) => {
    onOpenChange?.(isOpen);
    if (isOpen && matrixId && !dryRun.isPending && !hasFetched) {
      dryRun.mutate();
    } else if (!isOpen) {
      dryRun.reset();
      setHasFetched(false);
    }
  };

  const apply = useMutation({
    mutationFn: async () => {
      const result = await api.functions.invoke("bulkRecomputeProjectsByMatrix", {
        matrix_id: matrixId,
        dry_run: false,
      });
      return result;
    },
    onSuccess: async (result) => {
      const applied = result?.summary?.applied ?? 0;
      const failed = result?.summary?.apply_failed ?? 0;
      if (failed > 0) {
        toast.warning(`Recomputed ${applied} of ${applied + failed} projects — ${failed} failed.`, { duration: 6000 });
      } else {
        toast.success(`${applied} project${applied === 1 ? "" : "s"} recomputed.`, { duration: 6000 });
      }
      // Refresh both the project list and the matrix audit log so the UI picks up the new state.
      await Promise.all([
        refetchEntityList("Project"),
        refetchEntityList("PriceMatrixAuditLog"),
      ]);
      queryClient.invalidateQueries({ queryKey: ["price-matrix-audit", matrixId] });
      onOpenChange?.(false);
    },
    onError: (err) => {
      console.error("bulkRecompute apply error:", err);
      toast.error("Failed to apply recompute. Check logs.");
    },
  });

  const result = dryRun.data;
  const rows = result?.results || [];
  const summary = result?.summary;

  // Sort rows: updates first (most-changed on top), then unchanged, then locked, then errors.
  const sortedRows = useMemo(() => {
    const rank = (r) => {
      if (r.error) return 4;
      if (r.skip_reason === "locked") return 3;
      if (r.skip_reason === "unchanged") return 2;
      return 1;
    };
    return [...rows].sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;
      return Math.abs(b.delta) - Math.abs(a.delta);
    });
  }, [rows]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5" />
            Recompute Affected Projects
          </DialogTitle>
          <DialogDescription>
            {matrixLabel ? (
              <>Preview new prices for every project priced against <span className="font-medium text-foreground">{matrixLabel}</span>.</>
            ) : (
              <>Preview new prices for every project priced against this matrix.</>
            )}
            {" "}No changes are written until you confirm.
          </DialogDescription>
        </DialogHeader>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto -mx-6 px-6">
          {dryRun.isPending && (
            <div className="py-16 flex flex-col items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" />
              <span className="text-sm">Computing new prices…</span>
            </div>
          )}

          {!dryRun.isPending && hasFetched && rows.length === 0 && (
            <div className="py-16 flex flex-col items-center justify-center gap-2 text-muted-foreground">
              <Info className="h-6 w-6" />
              <span className="text-sm">No active projects reference this matrix.</span>
            </div>
          )}

          {!dryRun.isPending && rows.length > 0 && (
            <>
              {/* Summary strip */}
              {summary && (
                <div className="grid grid-cols-4 gap-2 mb-3 text-xs">
                  <SummaryTile label="Will update" value={summary.will_update} tone="primary" />
                  <SummaryTile label="Unchanged" value={summary.unchanged} tone="muted" />
                  <SummaryTile label="Locked — skipped" value={summary.locked_skipped} tone="warning" />
                  <SummaryTile label="Net delta" value={formatDelta(summary.total_delta)} tone={summary.total_delta === 0 ? "muted" : summary.total_delta < 0 ? "success" : "danger"} />
                </div>
              )}

              {/* Table */}
              <div className="border rounded-md overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40">
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Project</th>
                      <th className="text-right px-3 py-2 font-medium text-muted-foreground w-24">Current</th>
                      <th className="text-right px-3 py-2 font-medium text-muted-foreground w-24">New</th>
                      <th className="text-right px-3 py-2 font-medium text-muted-foreground w-24">Delta</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground w-32">Status</th>
                      <th className="text-center px-3 py-2 font-medium text-muted-foreground w-10">Lock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map((r) => <PreviewRow key={r.project_id} row={r} />)}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <DialogFooter className="pt-4 border-t">
          <Button variant="outline" onClick={() => onOpenChange?.(false)} disabled={apply.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => apply.mutate()}
            disabled={apply.isPending || dryRun.isPending || !summary || summary.will_update === 0}
          >
            {apply.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {apply.isPending
              ? "Updating…"
              : summary?.will_update
                ? `Confirm update of ${summary.will_update} project${summary.will_update === 1 ? "" : "s"}`
                : "Nothing to update"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SummaryTile({ label, value, tone = "muted" }) {
  const toneCls = {
    primary: "bg-blue-50 text-blue-800 border-blue-200",
    muted: "bg-muted/40 text-muted-foreground border-border",
    warning: "bg-amber-50 text-amber-800 border-amber-200",
    success: "bg-emerald-50 text-emerald-800 border-emerald-200",
    danger: "bg-red-50 text-red-800 border-red-200",
  }[tone];
  return (
    <div className={`rounded-md border px-3 py-2 ${toneCls}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-80">{label}</div>
      <div className="text-sm font-semibold tabular-nums mt-0.5">{value}</div>
    </div>
  );
}

function PreviewRow({ row }) {
  const deltaTone = row.error
    ? "text-red-600"
    : row.skip_reason === "locked" || row.skip_reason === "unchanged" || row.delta === 0
      ? "text-muted-foreground"
      : row.delta < 0 ? "text-emerald-700" : "text-red-700";
  const statusBadge = getStatusBadge(row);

  return (
    <tr className="border-b last:border-b-0 hover:bg-muted/20">
      <td className="px-3 py-2">
        <div className="font-medium truncate max-w-[280px]">{row.title}</div>
        {row.status && (
          <div className="text-xs text-muted-foreground capitalize">{row.status.replace(/_/g, " ")}</div>
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">${Math.round(row.old_price).toLocaleString()}</td>
      <td className="px-3 py-2 text-right tabular-nums">
        {row.error ? <span className="text-muted-foreground">—</span> : `$${Math.round(row.new_price).toLocaleString()}`}
      </td>
      <td className={`px-3 py-2 text-right tabular-nums font-medium ${deltaTone}`}>
        {row.error
          ? "—"
          : row.delta === 0
            ? "$0"
            : `${row.delta < 0 ? "−" : "+"}$${Math.abs(Math.round(row.delta)).toLocaleString()}`}
        {!row.error && row.delta !== 0 && (
          row.delta < 0
            ? <TrendingDown className="h-3 w-3 inline ml-1" />
            : <TrendingUp className="h-3 w-3 inline ml-1" />
        )}
      </td>
      <td className="px-3 py-2">{statusBadge}</td>
      <td className="px-3 py-2 text-center">
        {row.pricing_locked_at ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Lock className="h-3.5 w-3.5 text-amber-600 inline" />
            </TooltipTrigger>
            <TooltipContent>
              Pricing locked at {new Date(row.pricing_locked_at).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </td>
    </tr>
  );
}

function getStatusBadge(row) {
  if (row.error) {
    return (
      <Badge className="text-xs h-5 bg-red-100 text-red-800 border-red-200">
        <AlertCircle className="h-3 w-3 mr-0.5" />
        Error
      </Badge>
    );
  }
  if (row.skip_reason === "locked") {
    return (
      <Badge className="text-xs h-5 bg-amber-100 text-amber-800 border-amber-200">
        <Lock className="h-3 w-3 mr-0.5" />
        Locked — skipped
      </Badge>
    );
  }
  if (row.skip_reason === "unchanged" || row.delta === 0) {
    return (
      <Badge variant="outline" className="text-xs h-5 text-muted-foreground">
        Unchanged
      </Badge>
    );
  }
  if (row.skip_reason === "no_products_or_packages") {
    return (
      <Badge variant="outline" className="text-xs h-5 text-muted-foreground">
        No items
      </Badge>
    );
  }
  return (
    <Badge className="text-xs h-5 bg-blue-100 text-blue-800 border-blue-200">
      Will update
    </Badge>
  );
}

function formatDelta(n) {
  if (n == null || !Number.isFinite(n)) return "$0";
  const sign = n < 0 ? "−" : n > 0 ? "+" : "";
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString()}`;
}
