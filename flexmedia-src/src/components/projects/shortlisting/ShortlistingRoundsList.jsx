/**
 * ShortlistingRoundsList — Wave 6 Phase 6 SHORTLIST
 *
 * Tabular list of all shortlisting rounds for a project.
 *
 * Columns: round_number, status, package_type, total_compositions,
 *          total_cost_usd, started_at, completed_at, locked_at
 *
 * Actions per row:
 *   - "View" → switch to Swimlane sub-tab with this round selected
 *   - "Re-run Pass 2" → calls shortlisting-pass2 directly with round_id
 *     (only for status='processing' or 'proposed')
 */
import { useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, Eye, RefreshCw } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const ROUND_STATUS_TONE = {
  pending: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  processing: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  proposed: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  locked: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  delivered: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
};

function formatCost(n) {
  if (n == null) return "—";
  return `$${Number(n).toFixed(4)}`;
}
function formatDate(d) {
  if (!d) return "—";
  try {
    return format(new Date(d), "d MMM, h:mm a");
  } catch {
    return "—";
  }
}

export default function ShortlistingRoundsList({
  rounds,
  projectId,
  onSelectRound,
}) {
  const queryClient = useQueryClient();
  const [busyRoundId, setBusyRoundId] = useState(null);

  const reRunPass2 = useCallback(
    async (roundId) => {
      setBusyRoundId(roundId);
      try {
        const resp = await api.functions.invoke("shortlisting-pass2", {
          round_id: roundId,
        });
        const result = resp?.data ?? resp ?? {};
        if (result?.ok === false || result?.success === false) {
          throw new Error(result?.error || "Re-run failed");
        }
        toast.success("Pass 2 re-running…");
        queryClient.invalidateQueries({
          queryKey: ["shortlisting_rounds", projectId],
        });
      } catch (err) {
        console.error("[ShortlistingRoundsList] reRunPass2 failed:", err);
        toast.error(err?.message || "Re-run failed");
      } finally {
        setBusyRoundId(null);
      }
    },
    [projectId, queryClient],
  );

  if (!rounds || rounds.length === 0) {
    return (
      <div className="rounded-md border bg-card p-6 text-center text-sm text-muted-foreground">
        No rounds yet.
      </div>
    );
  }

  return (
    <div className="rounded-md border bg-card overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">#</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Package</TableHead>
            <TableHead className="text-right">Compositions</TableHead>
            <TableHead className="text-right">Cost (USD)</TableHead>
            <TableHead>Started</TableHead>
            <TableHead>Completed</TableHead>
            <TableHead>Locked</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rounds.map((r) => {
            const canReRunPass2 =
              r.status === "processing" || r.status === "proposed";
            return (
              <TableRow key={r.id}>
                <TableCell className="font-medium">{r.round_number}</TableCell>
                <TableCell>
                  <Badge
                    className={cn(
                      "text-[10px]",
                      ROUND_STATUS_TONE[r.status] || ROUND_STATUS_TONE.pending,
                    )}
                  >
                    {r.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs">
                  {r.package_type || "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums text-xs">
                  {r.total_compositions ?? "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums text-xs">
                  {formatCost(r.total_cost_usd)}
                </TableCell>
                <TableCell className="text-xs whitespace-nowrap">
                  {formatDate(r.started_at)}
                </TableCell>
                <TableCell className="text-xs whitespace-nowrap">
                  {formatDate(r.completed_at)}
                </TableCell>
                <TableCell className="text-xs whitespace-nowrap">
                  {formatDate(r.locked_at)}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onSelectRound && onSelectRound(r.id)}
                      title="View this round in the swimlane"
                    >
                      <Eye className="h-3.5 w-3.5 mr-1" />
                      View
                    </Button>
                    {canReRunPass2 && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => reRunPass2(r.id)}
                        disabled={busyRoundId === r.id}
                        title="Re-run Pass 2 only (cheaper than full re-run)"
                      >
                        {busyRoundId === r.id ? (
                          <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5 mr-1" />
                        )}
                        Re-run Pass 2
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
