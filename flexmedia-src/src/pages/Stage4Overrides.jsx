/**
 * Stage4Overrides — Wave 11.7.7 / W11.6 operator UX
 *
 * Spec: docs/design-specs/W11-7-7-master-listing-copy.md §"Stage 4 override
 *       review queue"
 *       docs/design-specs/W11-6-rejection-reasons-dashboard.md §F (Stage 4
 *       self-correction events)
 *
 * URL: /Stage4Overrides[?round=<round_id>][?status=<status>]
 *
 * Lists shortlisting_stage4_overrides rows with the per-row context the
 * reviewer needs:
 *   - stem + composition group preview (Dropbox proxy)
 *   - Stage 1 value (per-image AI label)
 *   - Stage 4 value (visual cross-comparison label)
 *   - reason (Stage 4's prose justification)
 *   - round + project context
 *
 * Per-row actions:
 *   - Approve → calls approve-stage4-override (Agent 2 builds; UI calls)
 *   - Reject → calls update-stage4-override-review with action='reject'
 *   - Defer → calls update-stage4-override-review with action='defer'
 *
 * Status filter sidebar: pending_review (default) | approved | rejected |
 * deferred | all
 *
 * Permission gating: PermissionGuard — master_admin / admin only.
 */

import { useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { PermissionGuard, usePermissions } from "@/components/auth/PermissionGuard";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertCircle,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Filter,
  ImageIcon,
  Inbox,
  Sparkles,
  ThumbsDown,
  Clock,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const STATUS_TONE = {
  pending_review:
    "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  approved:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  rejected: "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300",
  deferred: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
};

const STATUS_LABEL = {
  pending_review: "Pending review",
  approved: "Approved",
  rejected: "Rejected",
  deferred: "Deferred",
  all: "All",
};

const PAGE_SIZE = 25;

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

// ── Single override card ─────────────────────────────────────────────────────
function OverrideCard({ row, onApprove, onReject, onDefer, busy, isMasterAdmin }) {
  const [showReason, setShowReason] = useState(false);
  const [actionDialogOpen, setActionDialogOpen] = useState(null); // 'reject' | 'defer'
  const [actionNote, setActionNote] = useState("");

  const isPending = row.review_status === "pending_review";
  const stage1Display = row.stage_1_value ?? "—";
  const stage4Display = row.stage_4_value ?? "—";

  return (
    <Card
      className={cn(
        row.review_status === "rejected" && "opacity-70",
        row.review_status === "approved" && "border-emerald-200 dark:border-emerald-900",
      )}
    >
      <CardContent className="p-3">
        <div className="flex items-start gap-3">
          {/* Preview thumbnail (best-effort) */}
          <div className="w-20 h-20 flex-shrink-0 rounded border bg-muted/40 overflow-hidden flex items-center justify-center">
            <ImageIcon className="h-6 w-6 text-muted-foreground" />
          </div>

          <div className="flex-1 min-w-0">
            {/* Header line */}
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <Badge
                className={cn(
                  "text-[10px] h-4 px-1.5",
                  STATUS_TONE[row.review_status] || STATUS_TONE.pending_review,
                )}
              >
                {STATUS_LABEL[row.review_status] || row.review_status}
              </Badge>
              <span className="font-mono text-[11px] text-muted-foreground truncate">
                {row.stem}
              </span>
              <span className="text-[11px] text-muted-foreground">·</span>
              <span className="text-[11px] text-muted-foreground">
                field: <span className="font-mono">{row.field}</span>
              </span>
              {row.property_tier && (
                <Badge variant="outline" className="text-[10px] h-4">
                  {row.property_tier}
                </Badge>
              )}
            </div>

            {/* Project context */}
            <div className="text-xs text-muted-foreground mb-2 truncate">
              {row.project_address ? row.project_address : "(no address)"}
              {row.round_number != null ? ` · Round ${row.round_number}` : ""}
              {row.created_at ? ` · ${fmtTime(row.created_at)}` : ""}
            </div>

            {/* Stage 1 → Stage 4 transition */}
            <div className="flex items-center gap-2 text-sm mb-2 flex-wrap">
              <div className="font-mono px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200">
                {stage1Display}
              </div>
              <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
              <div className="font-mono px-2 py-0.5 rounded bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300">
                {stage4Display}
              </div>
            </div>

            {/* Reason */}
            {row.reason && (
              <div className="text-xs">
                <button
                  onClick={() => setShowReason((s) => !s)}
                  className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                >
                  {showReason ? "Hide" : "Show"} Stage 4 reasoning
                  {showReason ? (
                    <ChevronLeft className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                </button>
                {showReason && (
                  <p className="mt-1 italic border-l-2 pl-2 leading-relaxed text-foreground">
                    {row.reason}
                  </p>
                )}
              </div>
            )}

            {/* Reviewed metadata */}
            {row.reviewed_at && (
              <div className="text-[10px] text-muted-foreground mt-1">
                Reviewed {fmtTime(row.reviewed_at)}
                {row.review_notes ? ` — ${row.review_notes}` : ""}
              </div>
            )}

            {/* Actions */}
            {isPending && (
              <div className="flex items-center gap-1 mt-2">
                {isMasterAdmin && (
                  <Button
                    size="sm"
                    variant="default"
                    className="h-7 text-xs"
                    onClick={() => onApprove(row)}
                    disabled={busy}
                  >
                    <Check className="h-3 w-3 mr-1" />
                    Approve
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => {
                    setActionDialogOpen("reject");
                    setActionNote("");
                  }}
                  disabled={busy}
                >
                  <ThumbsDown className="h-3 w-3 mr-1" />
                  Reject
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => {
                    setActionDialogOpen("defer");
                    setActionNote("");
                  }}
                  disabled={busy}
                >
                  <Clock className="h-3 w-3 mr-1" />
                  Defer
                </Button>
                {row.round_id && (
                  <Link
                    to={`/MasterListingReview?round=${row.round_id}`}
                    className="text-[10px] text-blue-700 dark:text-blue-400 hover:underline ml-auto"
                  >
                    Open round →
                  </Link>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Reject / Defer dialog */}
        <Dialog open={actionDialogOpen != null} onOpenChange={(o) => !o && setActionDialogOpen(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>
                {actionDialogOpen === "reject" ? "Reject" : "Defer"} Stage 4 override
              </DialogTitle>
              <DialogDescription>
                {actionDialogOpen === "reject"
                  ? "Stage 4 over-corrected — Stage 1 was actually right. The override stays in the audit trail."
                  : "Skip for now. The row stays in the queue under the deferred filter."}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">
                Notes (optional)
              </label>
              <Textarea
                value={actionNote}
                onChange={(e) => setActionNote(e.target.value)}
                rows={3}
                className="text-sm"
              />
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setActionDialogOpen(null)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  if (actionDialogOpen === "reject") {
                    onReject(row, actionNote.trim() || null);
                  } else if (actionDialogOpen === "defer") {
                    onDefer(row, actionNote.trim() || null);
                  }
                  setActionDialogOpen(null);
                }}
                disabled={busy}
              >
                {actionDialogOpen === "reject" ? "Reject" : "Defer"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────
export default function Stage4Overrides() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const { isMasterAdmin } = usePermissions();
  const roundFilter = searchParams.get("round");
  const projectFilter = searchParams.get("project");
  const status = searchParams.get("status") || "pending_review";
  const offset = Number(searchParams.get("offset")) || 0;

  const setStatus = (next) => {
    const sp = new URLSearchParams(searchParams);
    sp.set("status", next);
    sp.delete("offset");
    setSearchParams(sp);
  };
  const setOffset = (next) => {
    const sp = new URLSearchParams(searchParams);
    if (next > 0) sp.set("offset", String(next));
    else sp.delete("offset");
    setSearchParams(sp);
  };
  const clearRoundFilter = () => {
    const sp = new URLSearchParams(searchParams);
    sp.delete("round");
    setSearchParams(sp);
  };

  const queueQuery = useQuery({
    queryKey: ["stage4_overrides", { status, roundFilter, projectFilter, offset }],
    queryFn: async () => {
      const result = await api.functions.invoke("list-stage4-overrides", {
        status,
        round_id: roundFilter || undefined,
        project_id: projectFilter || undefined,
        limit: PAGE_SIZE,
        offset,
      });
      const data = result?.data ?? result;
      if (!data?.ok) {
        throw new Error(data?.error || "Failed to load Stage 4 override queue");
      }
      return data;
    },
    staleTime: 15_000,
  });

  // Approve (calls approve-stage4-override edge fn, built by Agent 2)
  const approveMutation = useMutation({
    mutationFn: async (row) => {
      const result = await api.functions.invoke("approve-stage4-override", {
        override_id: row.id,
      });
      const data = result?.data ?? result;
      if (data?.error) {
        throw new Error(data.error.message || JSON.stringify(data.error));
      }
      // If the approve-stage4-override edge fn isn't deployed yet, fallback
      // to a direct UPDATE via the lighter update-stage4-override-review fn
      // with a special "force_approve" sentinel — but that doesn't graduate
      // to engine_fewshot_examples. For v1 we surface the error to the user.
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stage4_overrides"] });
      queryClient.invalidateQueries({ queryKey: ["stage4_override_counts"] });
      toast.success("Override approved.");
    },
    onError: (err) => {
      const msg = err?.message || String(err);
      if (msg.includes("404") || msg.includes("not found") || msg.includes("FunctionsHttpError")) {
        toast.error(
          "Approve endpoint not yet deployed (Agent 2 builds approve-stage4-override). Reject + Defer still work.",
        );
      } else {
        toast.error(`Approve failed: ${msg}`);
      }
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async ({ row, note }) => {
      const result = await api.functions.invoke("update-stage4-override-review", {
        override_id: row.id,
        action: "reject",
        review_notes: note,
      });
      const data = result?.data ?? result;
      if (data?.error) {
        throw new Error(data.error.message || JSON.stringify(data.error));
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stage4_overrides"] });
      queryClient.invalidateQueries({ queryKey: ["stage4_override_counts"] });
      toast.success("Override rejected.");
    },
    onError: (err) => toast.error(`Reject failed: ${err?.message || err}`),
  });

  const deferMutation = useMutation({
    mutationFn: async ({ row, note }) => {
      const result = await api.functions.invoke("update-stage4-override-review", {
        override_id: row.id,
        action: "defer",
        review_notes: note,
      });
      const data = result?.data ?? result;
      if (data?.error) {
        throw new Error(data.error.message || JSON.stringify(data.error));
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stage4_overrides"] });
      queryClient.invalidateQueries({ queryKey: ["stage4_override_counts"] });
      toast.success("Override deferred.");
    },
    onError: (err) => toast.error(`Defer failed: ${err?.message || err}`),
  });

  const rows = queueQuery.data?.rows || [];
  const total = queueQuery.data?.total || 0;
  const statusCounts = queueQuery.data?.status_counts || {};

  const busy =
    approveMutation.isPending ||
    rejectMutation.isPending ||
    deferMutation.isPending;

  return (
    <PermissionGuard require={["master_admin", "admin"]}>
      <div className="p-6 space-y-4 max-w-6xl mx-auto">
        {/* Header */}
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-amber-600" />
            <h1 className="text-xl font-bold">Stage 4 override queue</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Stage 4 visually corrects Stage 1's per-image labels. Approve the
            corrections you trust; reject the over-corrections; defer when you
            need more context. Approved corrections feed
            <span className="font-mono mx-1">engine_fewshot_examples</span>
            and become training signal for future Stage 1 prompts.
          </p>
        </div>

        {/* Status filter strip */}
        <div className="flex items-center gap-2 flex-wrap">
          {["pending_review", "approved", "rejected", "deferred", "all"].map((s) => {
            const count = s === "all" ? null : statusCounts[s] ?? null;
            return (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className={cn(
                  "text-xs px-3 py-1 rounded-full border inline-flex items-center gap-1.5 transition",
                  status === s
                    ? "bg-foreground text-background border-foreground"
                    : "bg-background border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                )}
              >
                <span>{STATUS_LABEL[s]}</span>
                {count != null && (
                  <span className="font-mono text-[10px] opacity-70">
                    {count}
                  </span>
                )}
              </button>
            );
          })}
          {(roundFilter || projectFilter) && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={clearRoundFilter}
            >
              <Filter className="h-3 w-3 mr-1" />
              Clear filter
            </Button>
          )}
        </div>

        {roundFilter && (
          <div className="text-xs text-muted-foreground">
            Filtered to round{" "}
            <code className="text-[11px] font-mono">{roundFilter.slice(0, 8)}…</code>
          </div>
        )}

        {/* Loading + error states */}
        {queueQuery.isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}

        {queueQuery.error && (
          <Card className="border-red-200 dark:border-red-900">
            <CardContent className="p-4 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
              <div className="text-sm text-destructive">
                Failed to load queue: {queueQuery.error.message}
              </div>
            </CardContent>
          </Card>
        )}

        {!queueQuery.isLoading && !queueQuery.error && rows.length === 0 && (
          <Card>
            <CardContent className="p-8 text-center">
              <Inbox className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm font-medium">No overrides match this filter</p>
              <p className="text-xs text-muted-foreground mt-1">
                {status === "pending_review"
                  ? "Stage 4 hasn't queued any corrections for review yet, or all pending have been reviewed."
                  : "Try a different status filter."}
              </p>
            </CardContent>
          </Card>
        )}

        {/* Override cards */}
        {rows.length > 0 && (
          <div className="space-y-2">
            {rows.map((row) => (
              <OverrideCard
                key={row.id}
                row={row}
                onApprove={(r) => approveMutation.mutate(r)}
                onReject={(r, note) => rejectMutation.mutate({ row: r, note })}
                onDefer={(r, note) => deferMutation.mutate({ row: r, note })}
                busy={busy}
                isMasterAdmin={isMasterAdmin}
              />
            ))}
          </div>
        )}

        {/* Pagination */}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground">
            <div>
              Showing {offset + 1}-{Math.min(offset + PAGE_SIZE, total)} of {total}
            </div>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                <ChevronLeft className="h-3.5 w-3.5 mr-1" />
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
                <ChevronRight className="h-3.5 w-3.5 ml-1" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </PermissionGuard>
  );
}
