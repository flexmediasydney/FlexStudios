/**
 * Stage4CorrectionsLane — W11.6.x in-context review of Stage 4 visual
 *                         cross-corrections.
 *                         + W11.6.1-hotfix BUG #1 (group + optimistic UX)
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
 * W11.6.1-hotfix BUG #1 — operator perception fixes:
 *   1. "Doubles" — when an image has 2 valid corrections (e.g. one for
 *      `field='clutter'`, one for `field='room_type'`) the per-row card
 *      layout looked like dupes because the unique index is
 *      (round_id, stem, field) — two valid rows for the same stem render
 *      two visually-similar cards. We now GROUP BY stem and render ONE
 *      card per stem with all field corrections nested inside. The
 *      Approve / Reject / Defer buttons act on ALL pending corrections
 *      for that stem in parallel (Promise.all). Operator's mental model
 *      becomes "I trust this image's Stage 4 corrections" / "I don't" —
 *      which matches how operators actually think about retouch.
 *
 *   2. "Approve / Reject not reactive in real time" — the previous
 *      mutations called `invalidateQueries` only, which kicks off a
 *      ~200-800ms refetch round-trip. During that window the card stays
 *      on screen and the operator clicks again, thinking nothing
 *      happened. We now run OPTIMISTIC UI: onMutate removes the targeted
 *      stem rows from the cache immediately and snapshots the prior
 *      data; onError restores the snapshot. Card vanishes the instant
 *      the button is pressed, success toast lands ~ms later.
 *
 *   3. Fresh data on mount — staleTime is now 0 + refetchOnMount:
 *      'always'. Re-entering the swimlane after a regen always sees the
 *      latest pending set; the previous 15s stale window left stale data
 *      visible after a backend run.
 *
 * Default filter: review_status='pending_review' for THIS round only.
 * "Show all" toggle surfaces previously-resolved corrections inline.
 *
 * Permission gating: master_admin sees Approve + Reject + Defer. Other
 * eligible roles (admin) see Reject + Defer only. Non-master_admin/admin
 * roles don't see the lane (the parent swimlane already gates by route).
 */

import { useCallback, useMemo, useState } from "react";
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

// ── Per-stem grouped card ────────────────────────────────────────────────
// W11.6.1-hotfix BUG #1: ONE card per stem, all field corrections nested.
// onApprove / onReject / onDefer act on the full pending-rows array for the
// stem so the parent mutation can parallelise via Promise.all.
function GroupedCorrectionCard({
  stem,
  rows,
  onApprove,
  onReject,
  onDefer,
  busy,
  isMasterAdmin,
}) {
  const [expanded, setExpanded] = useState(false);
  const [actionDialogOpen, setActionDialogOpen] = useState(null); // 'reject' | 'defer'
  const [actionNote, setActionNote] = useState("");

  const pendingRows = rows.filter((r) => r.review_status === "pending_review");
  const anyPending = pendingRows.length > 0;
  // Pull a representative thumbnail path. Every row for the same stem points
  // at the same composition group, so any preview_path is fine.
  const previewPath = rows.find((r) => r.preview_path)?.preview_path || null;
  const fieldCount = rows.length;
  // Most-recent timestamp for the header chip.
  const latestCreatedAt = rows.reduce((acc, r) => {
    if (!r.created_at) return acc;
    if (!acc) return r.created_at;
    return r.created_at > acc ? r.created_at : acc;
  }, null);

  return (
    <Card className="transition-colors">
      <CardContent className="p-3">
        <div className="flex items-start gap-3">
          {/* Real Dropbox thumbnail (single per stem).
              W11.6.1-hotfix-2 BUG #5: drop the fixed h-20 so the inner
              DroneThumbnail's aspect-square drives height from wrapper
              width. The `w-20 h-20` parent forced the inner flex/aspect
              layout into a degenerate state where the spinner stuck.
              Width-only sizing → 80px wide + derived 80px from aspect. */}
          <div
            className="w-20 flex-shrink-0 rounded border overflow-hidden"
            data-testid="stage4-correction-thumb"
          >
            {previewPath ? (
              <DroneThumbnail
                dropboxPath={previewPath}
                mode="thumb"
                alt={stem || "preview"}
                aspectRatio="aspect-square"
              />
            ) : (
              <div className="aspect-square w-full bg-muted/40 flex items-center justify-center text-[9px] text-muted-foreground">
                no preview
              </div>
            )}
          </div>

          <div className="flex-1 min-w-0">
            {/* Header */}
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="font-mono text-[12px] text-foreground truncate">
                {stem}
              </span>
              <Badge variant="outline" className="text-[10px] h-4 px-1.5">
                {fieldCount} correction{fieldCount === 1 ? "" : "s"}
              </Badge>
              {pendingRows.length > 0 && (
                <Badge
                  className={cn(
                    "text-[10px] h-4 px-1.5",
                    STATUS_TONE.pending_review,
                  )}
                >
                  {pendingRows.length} pending
                </Badge>
              )}
              {!anyPending && (
                <Badge
                  variant="outline"
                  className="text-[10px] h-4 px-1.5 text-muted-foreground"
                >
                  resolved
                </Badge>
              )}
              {latestCreatedAt && (
                <span className="text-[10px] text-muted-foreground">
                  {fmtTime(latestCreatedAt)}
                </span>
              )}
            </div>

            {/* Per-field summary — compact vertical list of "field: was → now" */}
            <div className="space-y-1 mb-2">
              {rows.map((row) => (
                <div
                  key={row.id}
                  className="flex items-center gap-2 text-sm flex-wrap"
                >
                  <Badge
                    className={cn(
                      "text-[9px] h-4 px-1",
                      STATUS_TONE[row.review_status] ||
                        STATUS_TONE.pending_review,
                    )}
                    title={STATUS_LABEL[row.review_status] || row.review_status}
                  >
                    {STATUS_LABEL[row.review_status] || row.review_status}
                  </Badge>
                  <Badge
                    variant="outline"
                    className="text-[10px] h-4 px-1.5 font-mono"
                  >
                    {row.field}
                  </Badge>
                  <div className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200">
                    {row.stage_1_value ?? "—"}
                  </div>
                  <ArrowRight className="h-3 w-3 text-muted-foreground" />
                  <div className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300">
                    {row.stage_4_value ?? "—"}
                  </div>
                </div>
              ))}
            </div>

            {/* Expand for per-field reasons */}
            {rows.some((r) => r.reason) && (
              <div className="text-xs">
                <button
                  type="button"
                  onClick={() => setExpanded((s) => !s)}
                  className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                >
                  {expanded ? "Hide" : "Show"} Stage 4 reasoning
                  {expanded ? (
                    <ChevronUp className="h-3 w-3" />
                  ) : (
                    <ChevronDown className="h-3 w-3" />
                  )}
                </button>
                {expanded && (
                  <div className="mt-1 space-y-1.5">
                    {rows
                      .filter((r) => r.reason)
                      .map((row) => (
                        <div key={row.id} className="space-y-0.5">
                          <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-mono">
                            {row.field}
                          </div>
                          <p className="italic border-l-2 pl-2 leading-relaxed text-foreground">
                            {row.reason}
                          </p>
                          {row.reviewed_at && (
                            <div className="text-[10px] text-muted-foreground">
                              Reviewed {fmtTime(row.reviewed_at)}
                              {row.review_notes
                                ? ` — ${row.review_notes}`
                                : ""}
                            </div>
                          )}
                        </div>
                      ))}
                  </div>
                )}
              </div>
            )}

            {/* Stem-level actions — apply to ALL pending rows for this stem */}
            {anyPending && (
              <div className="flex items-center gap-1 mt-2">
                {isMasterAdmin && (
                  <Button
                    size="sm"
                    variant="default"
                    className="h-7 text-xs"
                    onClick={() => onApprove(stem, pendingRows)}
                    disabled={busy}
                  >
                    <Check className="h-3 w-3 mr-1" />
                    Approve
                    {pendingRows.length > 1 ? ` ×${pendingRows.length}` : ""}
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
                  {pendingRows.length > 1 ? ` ×${pendingRows.length}` : ""}
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

        {/* Reject / Defer dialog (acts on every pending row for this stem) */}
        <Dialog
          open={actionDialogOpen != null}
          onOpenChange={(o) => !o && setActionDialogOpen(null)}
        >
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>
                {actionDialogOpen === "reject" ? "Reject" : "Defer"} Stage 4
                corrections
              </DialogTitle>
              <DialogDescription>
                {actionDialogOpen === "reject"
                  ? "Stage 4 over-corrected this image — Stage 1 was actually right. The overrides stay in the audit trail."
                  : "Skip for now. The rows stay in the queue under the deferred filter."}
                {pendingRows.length > 1 && (
                  <span className="block mt-1 text-xs">
                    {pendingRows.length} corrections will be{" "}
                    {actionDialogOpen === "reject" ? "rejected" : "deferred"}.
                  </span>
                )}
                <span className="block mt-1 text-xs font-mono">{stem}</span>
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
              <Button
                variant="ghost"
                onClick={() => setActionDialogOpen(null)}
              >
                Cancel
              </Button>
              <Button
                onClick={() => {
                  const note = actionNote.trim() || null;
                  if (actionDialogOpen === "reject") {
                    onReject(stem, pendingRows, note);
                  } else if (actionDialogOpen === "defer") {
                    onDefer(stem, pendingRows, note);
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

// Parallel-call helper for stem-level actions: fires all per-row edge fn
// invocations and surfaces the first failure so the UI rollback (onError)
// reflects the worst case. Promise.allSettled lets us still await every
// call before deciding rollback (vs. Promise.all bailing on first reject).
async function invokeAll(calls) {
  const results = await Promise.allSettled(calls);
  const firstFailure = results.find((r) => r.status === "rejected");
  if (firstFailure) {
    throw firstFailure.reason || new Error("Stage 4 override action failed");
  }
  return results.map((r) => r.value);
}

// ── Main lane component ────────────────────────────────────────────────────
export default function Stage4CorrectionsLane({ roundId }) {
  const queryClient = useQueryClient();
  const { isMasterAdmin, isAdminOrAbove } = usePermissions();
  const [showAll, setShowAll] = useState(false);

  // Status filter — default 'pending_review', toggle surfaces 'all'.
  const status = showAll ? "all" : "pending_review";

  const queryKey = useMemo(
    () => ["stage4_overrides_lane", roundId, status],
    [roundId, status],
  );

  // W11.6.1-hotfix BUG #1 fix #3: staleTime: 0 + refetchOnMount: 'always'
  // so re-entering the swimlane after a regen always sees the latest
  // pending set.
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
    staleTime: 0,
    refetchOnMount: "always",
  });

  const rows = queueQuery.data?.rows || [];

  // W11.6.1-hotfix BUG #1 fix #1: GROUP BY stem so doubles (same image, two
  // valid field corrections) render as ONE card with both corrections nested.
  const groupedByStem = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      // W11.6.1-hotfix-2 BUG #4: be defensive about rows with missing
      // stem. The unique index is (round_id, stem, field) so stem is
      // non-null at the DB level — but a malformed row from a partial
      // migration shouldn't silently disappear. Bucket stem-less rows
      // under a fallback key derived from row id so they still render.
      let key = r.stem;
      if (!key) {
        key = `__missing_stem__:${r.id || Math.random().toString(36).slice(2, 8)}`;
      }
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(r);
    }
    const out = [];
    for (const [stem, list] of m.entries()) {
      list.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
      out.push({ stem, rows: list });
    }
    out.sort((a, b) => {
      const aT = a.rows[0]?.created_at || "";
      const bT = b.rows[0]?.created_at || "";
      return aT < bT ? -1 : 1;
    });
    return out;
  }, [rows]);

  // ── Optimistic UI helpers ──────────────────────────────────────────────
  // W11.6.1-hotfix BUG #1 fix #2: every mutation removes the targeted rows
  // from cache on mutate, snapshots prior data, and rolls back onError.
  // The `data` shape here is { rows, total, status_counts } from the
  // list-stage4-overrides edge fn — we strip targeted ids out of `rows`
  // and adjust the counts so the header chip is correct mid-flight.
  const stripIdsFromCache = useCallback(
    (ids) => {
      const prior = queryClient.getQueryData(queryKey);
      if (!prior) return null;
      const idSet = new Set(ids);
      const nextRows = (prior.rows || []).filter((r) => !idSet.has(r.id));
      const next = {
        ...prior,
        rows: nextRows,
        total: Math.max(0, (prior.total || 0) - ids.length),
      };
      queryClient.setQueryData(queryKey, next);
      return prior;
    },
    [queryClient, queryKey],
  );

  const restoreCache = useCallback(
    (snapshot) => {
      if (snapshot) queryClient.setQueryData(queryKey, snapshot);
    },
    [queryClient, queryKey],
  );

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: ["stage4_overrides_lane", roundId],
    });
    // Also bust the master listing page's queue counts so the nav badge
    // in /Stage4Overrides reflects the action without a hard refresh.
    queryClient.invalidateQueries({ queryKey: ["stage4_overrides"] });
    queryClient.invalidateQueries({ queryKey: ["stage4_override_counts"] });
  }, [queryClient, roundId]);

  // Approve — parallel calls to approve-stage4-override (one per row).
  const approveMutation = useMutation({
    mutationFn: async ({ applicableRows }) => {
      const calls = applicableRows.map((row) =>
        api.functions
          .invoke("approve-stage4-override", { override_id: row.id })
          .then((result) => {
            const data = result?.data ?? result;
            if (data?.error) {
              throw new Error(
                data.error.message || JSON.stringify(data.error),
              );
            }
            if (data?.ok === false) {
              throw new Error(data?.error || "Approve failed");
            }
            return data;
          }),
      );
      return invokeAll(calls);
    },
    onMutate: async ({ applicableRows }) => {
      await queryClient.cancelQueries({ queryKey });
      const ids = applicableRows.map((r) => r.id);
      const snapshot = stripIdsFromCache(ids);
      return { snapshot };
    },
    onError: (err, _vars, ctx) => {
      restoreCache(ctx?.snapshot);
      const msg = err?.message || String(err);
      toast.error(`Approve failed: ${msg}`);
    },
    onSuccess: (_data, vars) => {
      const n = vars.applicableRows.length;
      toast.success(
        n === 1
          ? "Correction approved — graduated to few-shot library."
          : `Approved ${n} corrections — graduated to few-shot library.`,
      );
    },
    onSettled: invalidateAll,
  });

  const rejectMutation = useMutation({
    mutationFn: async ({ applicableRows, note }) => {
      const calls = applicableRows.map((row) =>
        api.functions
          .invoke("update-stage4-override-review", {
            override_id: row.id,
            action: "reject",
            review_notes: note,
          })
          .then((result) => {
            const data = result?.data ?? result;
            if (data?.error) {
              throw new Error(
                data.error.message || JSON.stringify(data.error),
              );
            }
            return data;
          }),
      );
      return invokeAll(calls);
    },
    onMutate: async ({ applicableRows }) => {
      await queryClient.cancelQueries({ queryKey });
      const ids = applicableRows.map((r) => r.id);
      const snapshot = stripIdsFromCache(ids);
      return { snapshot };
    },
    onError: (err, _vars, ctx) => {
      restoreCache(ctx?.snapshot);
      toast.error(`Reject failed: ${err?.message || err}`);
    },
    onSuccess: (_data, vars) => {
      const n = vars.applicableRows.length;
      toast.success(
        n === 1 ? "Correction rejected." : `Rejected ${n} corrections.`,
      );
    },
    onSettled: invalidateAll,
  });

  const deferMutation = useMutation({
    mutationFn: async ({ applicableRows, note }) => {
      const calls = applicableRows.map((row) =>
        api.functions
          .invoke("update-stage4-override-review", {
            override_id: row.id,
            action: "defer",
            review_notes: note,
          })
          .then((result) => {
            const data = result?.data ?? result;
            if (data?.error) {
              throw new Error(
                data.error.message || JSON.stringify(data.error),
              );
            }
            return data;
          }),
      );
      return invokeAll(calls);
    },
    onMutate: async ({ applicableRows }) => {
      await queryClient.cancelQueries({ queryKey });
      const ids = applicableRows.map((r) => r.id);
      const snapshot = stripIdsFromCache(ids);
      return { snapshot };
    },
    onError: (err, _vars, ctx) => {
      restoreCache(ctx?.snapshot);
      toast.error(`Defer failed: ${err?.message || err}`);
    },
    onSuccess: (_data, vars) => {
      const n = vars.applicableRows.length;
      toast.success(
        n === 1 ? "Correction deferred." : `Deferred ${n} corrections.`,
      );
    },
    onSettled: invalidateAll,
  });

  // Non-eligible roles: render nothing. The parent shortlisting page already
  // gates by role; this is defence-in-depth so a future viewer-role surface
  // doesn't accidentally see Reject buttons.
  if (!isAdminOrAbove) return null;
  if (!roundId) return null;

  const pendingCount = rows.filter(
    (r) => r.review_status === "pending_review",
  ).length;
  const totalCount = rows.length;

  const busy =
    approveMutation.isPending ||
    rejectMutation.isPending ||
    deferMutation.isPending;

  // Stem-level handlers — bind closures the GroupedCorrectionCard can fire.
  const handleApprove = (_stem, applicableRows) =>
    approveMutation.mutate({ applicableRows });
  const handleReject = (_stem, applicableRows, note) =>
    rejectMutation.mutate({ applicableRows, note });
  const handleDefer = (_stem, applicableRows, note) =>
    deferMutation.mutate({ applicableRows, note });

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
                {" · "}
                {groupedByStem.length} image
                {groupedByStem.length === 1 ? "" : "s"}
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
          you need more context. One card per image — each card shows every
          field correction Stage 4 emitted for that stem.
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
        {!queueQuery.isLoading &&
          !queueQuery.error &&
          groupedByStem.length === 0 && (
            <div className="rounded-md border bg-muted/20 p-4 text-center">
              <CheckCircle2 className="h-5 w-5 text-emerald-600 mx-auto mb-1" />
              <p className="text-xs text-foreground">
                No Stage 4 visual corrections{" "}
                {showAll ? "" : "pending review "}for this round.
              </p>
            </div>
          )}

        {/* Per-stem cards (W11.6.1-hotfix grouping).
            W11.6.20 density-grid: lay out the per-stem cards as a CSS
            grid (auto-fill ~360px floor) so the lane fills horizontally
            on wide viewports instead of a wasted vertical scroll of
            single-card rows. Each card retains its internal flex layout
            (thumbnail + body); we only re-arrange the OUTER stack. The
            360px floor is intentionally larger than the swimlane MD
            floor (240px) because each card embeds a thumbnail + diff
            rows + 3 action buttons, so it needs more horizontal room
            to render readably. */}
        {groupedByStem.length > 0 && (
          <div
            data-testid="stage4-corrections-grid"
            className="grid gap-2"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))" }}
          >
            {groupedByStem.map(({ stem, rows: stemRows }) => (
              <GroupedCorrectionCard
                key={stem}
                stem={stem}
                rows={stemRows}
                onApprove={handleApprove}
                onReject={handleReject}
                onDefer={handleDefer}
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
