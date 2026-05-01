/**
 * Stage4CorrectionsLane — W11.6.x in-context review of Stage 4 visual
 * cross-corrections.
 *
 * Renders a full-width strip BELOW the 3-column shortlisting swimlane so
 * Joseph can review Stage 4's per-image corrections IN CONTEXT of the
 * round he's reviewing — instead of bouncing to the standalone
 * /Stage4Overrides cross-round queue.
 *
 * Bug fix in this lane (vs. the standalone page):
 *   - Real Dropbox thumbnails (DroneThumbnail / mediaPerf), not a static
 *     ImageIcon placeholder. The list-stage4-overrides edge fn already
 *     joins composition_groups.dropbox_preview_path; we just have to feed
 *     it through DroneThumbnail like the main swimlane cards do.
 *   - Approve flow rewired against the fixed approve-stage4-override
 *     edge fn (W11.6.x — accepts shortlisting_stage4_overrides.id, not
 *     just composition_classification_overrides.id).
 *
 * Default filter: review_status='pending_review' for THIS round only.
 * "Show all" toggle surfaces previously-resolved corrections inline.
 *
 * Permission gating: master_admin sees Approve + Reject + Defer. Other
 * eligible roles (admin) see Reject + Defer only. Non-master_admin/admin
 * roles don't see the lane (the parent swimlane already gates by route).
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { usePermissions } from "@/components/auth/PermissionGuard";
import { Card, CardContent } from "@/components/ui/card";
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
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  ExternalLink,
  Sparkles,
  ThumbsDown,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import DroneThumbnail from "@/components/drone/DroneThumbnail";
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
};

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

// ── Single override card ────────────────────────────────────────────────────
function CorrectionCard({ row, onApprove, onReject, onDefer, busy, isMasterAdmin }) {
  const [showReason, setShowReason] = useState(false);
  const [actionDialogOpen, setActionDialogOpen] = useState(null); // 'reject' | 'defer'
  const [actionNote, setActionNote] = useState("");

  const isPending = row.review_status === "pending_review";
  const stage1Display = row.stage_1_value ?? "—";
  const stage4Display = row.stage_4_value ?? "—";

  return (
    <Card
      className={cn(
        "transition-colors",
        row.review_status === "rejected" && "opacity-70",
        row.review_status === "approved" && "border-emerald-200 dark:border-emerald-900",
      )}
    >
      <CardContent className="p-3">
        <div className="flex items-start gap-3">
          {/* Real Dropbox thumbnail (W11.6.x bug fix — was static placeholder) */}
          <div className="w-20 h-20 flex-shrink-0 rounded border overflow-hidden">
            {row.preview_path ? (
              <DroneThumbnail
                dropboxPath={row.preview_path}
                mode="thumb"
                alt={row.stem || "preview"}
                aspectRatio="aspect-square"
              />
            ) : (
              <div className="w-full h-full bg-muted/40 flex items-center justify-center text-[9px] text-muted-foreground">
                no preview
              </div>
            )}
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
              <Badge variant="outline" className="text-[10px] h-4 px-1.5 font-mono">
                {row.field}
              </Badge>
              {row.created_at && (
                <span className="text-[10px] text-muted-foreground">
                  {fmtTime(row.created_at)}
                </span>
              )}
            </div>

            {/* Stage 1 → Stage 4 transition */}
            <div className="flex items-center gap-2 text-sm mb-2 flex-wrap">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                was
              </span>
              <div className="font-mono text-xs px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200">
                {stage1Display}
              </div>
              <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                now
              </span>
              <div className="font-mono text-xs px-2 py-0.5 rounded bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300">
                {stage4Display}
              </div>
            </div>

            {/* Reason — collapsible */}
            {row.reason && (
              <div className="text-xs">
                <button
                  type="button"
                  onClick={() => setShowReason((s) => !s)}
                  className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                >
                  {showReason ? "Hide" : "Show"} Stage 4 reasoning
                  {showReason ? (
                    <ChevronUp className="h-3 w-3" />
                  ) : (
                    <ChevronDown className="h-3 w-3" />
                  )}
                </button>
                {showReason && (
                  <p className="mt-1 italic border-l-2 pl-2 leading-relaxed text-foreground">
                    {row.reason}
                  </p>
                )}
              </div>
            )}

            {/* Reviewed metadata (resolved rows) */}
            {row.reviewed_at && (
              <div className="text-[10px] text-muted-foreground mt-1">
                Reviewed {fmtTime(row.reviewed_at)}
                {row.review_notes ? ` — ${row.review_notes}` : ""}
              </div>
            )}

            {/* Inline actions (only for pending) */}
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
              </div>
            )}
          </div>
        </div>

        {/* Reject / Defer dialog */}
        <Dialog
          open={actionDialogOpen != null}
          onOpenChange={(o) => !o && setActionDialogOpen(null)}
        >
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>
                {actionDialogOpen === "reject" ? "Reject" : "Defer"} Stage 4 correction
              </DialogTitle>
              <DialogDescription>
                {actionDialogOpen === "reject"
                  ? "Stage 4 over-corrected — Stage 1 was actually right. The override stays in the audit trail."
                  : "Skip for now. The row stays in the queue under the deferred filter."}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Notes (optional)</label>
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

// ── Main lane component ────────────────────────────────────────────────────
export default function Stage4CorrectionsLane({ roundId }) {
  const queryClient = useQueryClient();
  const { isMasterAdmin, isAdminOrAbove } = usePermissions();
  const [showAll, setShowAll] = useState(false);

  // Status filter — default 'pending_review', toggle surfaces 'all'.
  const status = showAll ? "all" : "pending_review";

  const queryKey = ["stage4_overrides_lane", roundId, status];

  const queueQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const result = await api.functions.invoke("list-stage4-overrides", {
        status,
        round_id: roundId,
        limit: 100,
        offset: 0,
      });
      const data = result?.data ?? result;
      if (!data?.ok) {
        throw new Error(data?.error || "Failed to load Stage 4 corrections");
      }
      return data;
    },
    enabled: Boolean(roundId) && isAdminOrAbove,
    staleTime: 15_000,
  });

  // Approve mutation — calls fixed approve-stage4-override (W11.6.x).
  const approveMutation = useMutation({
    mutationFn: async (row) => {
      const result = await api.functions.invoke("approve-stage4-override", {
        override_id: row.id,
      });
      const data = result?.data ?? result;
      if (data?.error) {
        throw new Error(data.error.message || JSON.stringify(data.error));
      }
      if (data?.ok === false) {
        throw new Error(data?.error || "Approve failed");
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stage4_overrides_lane", roundId] });
      queryClient.invalidateQueries({ queryKey: ["stage4_overrides"] });
      queryClient.invalidateQueries({ queryKey: ["stage4_override_counts"] });
      toast.success("Correction approved — graduated to few-shot library.");
    },
    onError: (err) => {
      const msg = err?.message || String(err);
      toast.error(`Approve failed: ${msg}`);
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
      queryClient.invalidateQueries({ queryKey: ["stage4_overrides_lane", roundId] });
      queryClient.invalidateQueries({ queryKey: ["stage4_overrides"] });
      toast.success("Correction rejected.");
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
      queryClient.invalidateQueries({ queryKey: ["stage4_overrides_lane", roundId] });
      queryClient.invalidateQueries({ queryKey: ["stage4_overrides"] });
      toast.success("Correction deferred.");
    },
    onError: (err) => toast.error(`Defer failed: ${err?.message || err}`),
  });

  // Non-eligible roles: render nothing. The parent shortlisting page already
  // gates by role; this is defence-in-depth so a future viewer-role surface
  // doesn't accidentally see Reject buttons.
  if (!isAdminOrAbove) return null;
  if (!roundId) return null;

  const rows = queueQuery.data?.rows || [];
  const pendingCount = rows.filter((r) => r.review_status === "pending_review").length;
  const totalCount = rows.length;

  const busy =
    approveMutation.isPending ||
    rejectMutation.isPending ||
    deferMutation.isPending;

  return (
    <Card className="border-amber-200/60 dark:border-amber-900/40">
      <CardContent className="p-3 space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-amber-600" />
            <h2 className="text-sm font-semibold">Stage 4 Visual Corrections</h2>
            {!queueQuery.isLoading && (
              <Badge
                variant="outline"
                className={cn(
                  "h-5 text-[10px]",
                  pendingCount > 0
                    ? "border-amber-400 text-amber-700 dark:text-amber-300"
                    : "border-emerald-400 text-emerald-700 dark:text-emerald-300",
                )}
              >
                {pendingCount} pending
                {showAll && totalCount !== pendingCount
                  ? ` · ${totalCount} total`
                  : ""}
              </Badge>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
            >
              {showAll ? "Show pending only" : "Show all"}
            </button>
            <span className="text-[10px] text-muted-foreground">·</span>
            <Link
              to="/Stage4Overrides"
              className="text-[11px] text-blue-700 dark:text-blue-400 hover:underline inline-flex items-center gap-0.5"
            >
              Cross-round queue
              <ExternalLink className="h-2.5 w-2.5" />
            </Link>
          </div>
        </div>

        {/* Description */}
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Stage 4's visual cross-comparison disagreed with Stage 1's per-image
          labels. Approve corrections you trust (graduates them to the
          cross-project few-shot library); reject over-corrections; defer when
          you need more context.
        </p>

        {/* Loading */}
        {queueQuery.isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}

        {/* Error */}
        {queueQuery.error && (
          <div className="rounded-md border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-2 flex items-start gap-2">
            <AlertCircle className="h-3.5 w-3.5 text-destructive flex-shrink-0 mt-0.5" />
            <div className="text-xs text-destructive">
              Failed to load corrections: {queueQuery.error.message}
            </div>
          </div>
        )}

        {/* Empty */}
        {!queueQuery.isLoading && !queueQuery.error && rows.length === 0 && (
          <div className="rounded-md border bg-muted/20 p-4 text-center">
            <CheckCircle2 className="h-5 w-5 text-emerald-600 mx-auto mb-1" />
            <p className="text-xs text-foreground">
              No Stage 4 visual corrections {showAll ? "" : "pending review "}for this round.
            </p>
          </div>
        )}

        {/* Cards */}
        {rows.length > 0 && (
          <div className="space-y-2">
            {rows.map((row) => (
              <CorrectionCard
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
      </CardContent>
    </Card>
  );
}
