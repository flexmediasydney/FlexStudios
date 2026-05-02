/**
 * ObjectRegistryDiscoveryQueueTab — W12.B pending-review queue for
 * object_registry_candidates. master_admin curation surface.
 *
 * Fetches via the `object-registry-admin` edge fn (subcommand: list_candidates,
 * status='pending_review' / 'pending'). Per-row actions:
 *   • Approve  — POST approve_candidate
 *   • Reject   — POST reject_candidate (requires reason ≥3 chars)
 *   • Merge    — opens MergeCandidateDialog → POST merge_candidates
 *   • Defer    — POST defer_candidate (7 days default)
 *
 * Bulk-action checkboxes select up to 50/batch. Bulk Approve and Reject are
 * gated to keep the audit trail readable; bulk Merge uses the dialog.
 */

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import {
  CheckCircle2,
  XCircle,
  Clock,
  GitMerge,
  Loader2,
  Sparkles,
} from "lucide-react";
import MergeCandidateDialog from "@/components/settings/MergeCandidateDialog";

export const BULK_BATCH_CAP = 50;

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

function fmtSim(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toFixed(3);
}

function HierarchyChain({ row }) {
  const levels = [
    row.proposed_level_0_class,
    row.proposed_level_1_functional,
    row.proposed_level_2_material,
    row.proposed_level_3_specific,
    row.proposed_level_4_detail,
  ].filter(Boolean);
  if (levels.length === 0) {
    return <span className="text-muted-foreground italic text-[11px]">—</span>;
  }
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {levels.map((l, i) => (
        <span key={`${l}_${i}`} className="text-[11px] font-mono">
          {l}
          {i < levels.length - 1 && (
            <span className="text-muted-foreground mx-0.5">/</span>
          )}
        </span>
      ))}
    </div>
  );
}

function NearestSimilarities({ rows }) {
  if (!rows || (Array.isArray(rows) && rows.length === 0)) {
    return <span className="text-muted-foreground italic text-[11px]">—</span>;
  }
  const list = Array.isArray(rows) ? rows.slice(0, 2) : [];
  return (
    <div className="space-y-0.5">
      {list.map((m, i) => (
        <div key={`sim_${i}`} className="text-[11px] flex items-center gap-1.5">
          <span className="font-mono truncate max-w-[140px]">
            {m.canonical_id || m.id}
          </span>
          <span className="text-muted-foreground tabular-nums">
            {fmtSim(m.similarity)}
          </span>
        </div>
      ))}
    </div>
  );
}

function RejectDialog({ open, onOpenChange, candidateIds, onSubmit, busy }) {
  const [reason, setReason] = useState("");
  const count = (candidateIds || []).length;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <XCircle className="h-4 w-4 text-red-600" />
            Reject {count} candidate{count === 1 ? "" : "s"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">
            Reason is stored on each candidate row for audit.
          </p>
          <Label htmlFor="reject_reason" className="text-[10px] uppercase tracking-wide">
            reason (≥3 chars) <span className="text-red-500">*</span>
          </Label>
          <Textarea
            id="reject_reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="duplicates kitchen_island; not distinct enough"
            className="text-xs mt-1 min-h-[60px]"
            rows={3}
            data-testid="reject-reason-input"
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              onSubmit({ reason: reason.trim() });
              setReason("");
            }}
            disabled={busy || reason.trim().length < 3}
            data-testid="reject-submit-button"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
            Reject {count}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function ObjectRegistryDiscoveryQueueTab() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState({
    candidate_type: "object",
    sort: "observed_count_desc",
  });
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [mergeOpen, setMergeOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectingIds, setRejectingIds] = useState([]);

  const queueQuery = useQuery({
    queryKey: ["w12b_queue", filters.candidate_type, filters.sort],
    queryFn: async () => {
      const result = await api.functions.invoke("object-registry-admin", {
        action: "list_candidates",
        status: "pending",
        candidate_type: filters.candidate_type === "all" ? undefined : filters.candidate_type,
        limit: 100,
        offset: 0,
        sort: filters.sort,
      });
      if (result?.error) {
        throw new Error(
          result.error.message || result.error.body?.error || "list failed",
        );
      }
      return result?.data ?? result;
    },
    staleTime: 15_000,
  });

  const rows = queueQuery.data?.candidates || [];
  const total = queueQuery.data?.total ?? rows.length;

  // ── Mutations ────────────────────────────────────────────────────────────
  const approveMutation = useMutation({
    mutationFn: async ({ candidate_id }) => {
      const result = await api.functions.invoke("object-registry-admin", {
        action: "approve_candidate",
        candidate_id,
      });
      if (result?.error) {
        throw new Error(
          result.error.message || result.error.body?.error || "approve failed",
        );
      }
      return result?.data ?? result;
    },
    onSuccess: (data) => {
      toast.success(`Approved as ${data?.canonical_id}`);
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["w12b_queue"] });
      queryClient.invalidateQueries({ queryKey: ["w12b_browse"] });
      queryClient.invalidateQueries({ queryKey: ["w12b_stats"] });
    },
    onError: (err) => toast.error(`Approve failed: ${err?.message || err}`),
  });

  const rejectMutation = useMutation({
    mutationFn: async ({ candidate_ids, reason }) => {
      // Bulk reject runs serially for clearer audit + status tracking.
      const results = [];
      for (const id of candidate_ids) {
        const r = await api.functions.invoke("object-registry-admin", {
          action: "reject_candidate",
          candidate_id: id,
          reason,
        });
        if (r?.error) {
          throw new Error(
            r.error.message || r.error.body?.error || `reject failed for ${id}`,
          );
        }
        results.push(r?.data ?? r);
      }
      return results;
    },
    onSuccess: (results) => {
      toast.success(`Rejected ${results.length} candidate(s)`);
      setSelectedIds(new Set());
      setRejectOpen(false);
      setRejectingIds([]);
      queryClient.invalidateQueries({ queryKey: ["w12b_queue"] });
    },
    onError: (err) => toast.error(`Reject failed: ${err?.message || err}`),
  });

  const mergeMutation = useMutation({
    mutationFn: async ({ candidate_ids, target_canonical_id }) => {
      const result = await api.functions.invoke("object-registry-admin", {
        action: "merge_candidates",
        candidate_ids,
        target_canonical_id,
      });
      if (result?.error) {
        throw new Error(
          result.error.message || result.error.body?.error || "merge failed",
        );
      }
      return result?.data ?? result;
    },
    onSuccess: (data) => {
      toast.success(
        `Merged ${data?.merged_count} into ${data?.target_canonical_id}`,
      );
      setSelectedIds(new Set());
      setMergeOpen(false);
      queryClient.invalidateQueries({ queryKey: ["w12b_queue"] });
      queryClient.invalidateQueries({ queryKey: ["w12b_browse"] });
    },
    onError: (err) => toast.error(`Merge failed: ${err?.message || err}`),
  });

  const deferMutation = useMutation({
    mutationFn: async ({ candidate_id }) => {
      const result = await api.functions.invoke("object-registry-admin", {
        action: "defer_candidate",
        candidate_id,
        days: 7,
      });
      if (result?.error) {
        throw new Error(
          result.error.message || result.error.body?.error || "defer failed",
        );
      }
      return result?.data ?? result;
    },
    onSuccess: () => {
      toast.success("Deferred 7 days");
      queryClient.invalidateQueries({ queryKey: ["w12b_queue"] });
    },
    onError: (err) => toast.error(`Defer failed: ${err?.message || err}`),
  });

  // ── Selection helpers ────────────────────────────────────────────────────
  const allVisibleIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const selectedArray = useMemo(() => Array.from(selectedIds), [selectedIds]);
  const allVisibleSelected =
    allVisibleIds.length > 0 &&
    allVisibleIds.every((id) => selectedIds.has(id));
  const someVisibleSelected =
    !allVisibleSelected && allVisibleIds.some((id) => selectedIds.has(id));

  const toggleAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const id of allVisibleIds) next.delete(id);
      } else {
        // Cap selection at BULK_BATCH_CAP. If adding all visible would exceed,
        // toast a warning and select up to the cap.
        for (const id of allVisibleIds) {
          if (next.size >= BULK_BATCH_CAP) break;
          next.add(id);
        }
        if (allVisibleIds.length > BULK_BATCH_CAP - prev.size) {
          toast.message(`Selection capped at ${BULK_BATCH_CAP} per batch`);
        }
      }
      return next;
    });
  };

  const toggleOne = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        if (next.size >= BULK_BATCH_CAP) {
          toast.message(`Selection capped at ${BULK_BATCH_CAP} per batch`);
          return next;
        }
        next.add(id);
      }
      return next;
    });
  };

  const busy =
    approveMutation.isPending ||
    rejectMutation.isPending ||
    mergeMutation.isPending ||
    deferMutation.isPending;

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-amber-600" />
            Discovery queue — pending review
          </CardTitle>
          <CardDescription className="text-[11px]">
            Candidates from <code className="text-[10px]">object_registry_candidates</code>{" "}
            awaiting human curation. Per-row Approve / Reject / Merge / Defer
            and bulk actions (cap {BULK_BATCH_CAP}/batch).
          </CardDescription>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <Label htmlFor="candidate_type" className="text-[10px] uppercase tracking-wide text-muted-foreground">
                candidate_type
              </Label>
              <Select
                value={filters.candidate_type}
                onValueChange={(v) => setFilters((f) => ({ ...f, candidate_type: v }))}
              >
                <SelectTrigger id="candidate_type" className="h-8 text-xs mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="object" className="text-xs">object</SelectItem>
                  <SelectItem value="attribute_value" className="text-xs">attribute_value</SelectItem>
                  <SelectItem value="all" className="text-xs">all</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="queue_sort" className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Sort
              </Label>
              <Select
                value={filters.sort}
                onValueChange={(v) => setFilters((f) => ({ ...f, sort: v }))}
              >
                <SelectTrigger id="queue_sort" className="h-8 text-xs mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="observed_count_desc" className="text-xs">observation_count DESC</SelectItem>
                  <SelectItem value="last_proposed_desc" className="text-xs">most recent first</SelectItem>
                  <SelectItem value="first_proposed_asc" className="text-xs">oldest first</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Bulk-action toolbar */}
      {selectedArray.length > 0 && (
        <Card className="bg-blue-50/50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-900">
          <CardContent className="p-2 flex items-center justify-between gap-2 flex-wrap">
            <span className="text-xs font-medium tabular-nums" data-testid="bulk-count">
              {selectedArray.length} selected
            </span>
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => setSelectedIds(new Set())}
                disabled={busy}
              >
                Clear
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => setMergeOpen(true)}
                disabled={busy}
                data-testid="bulk-merge-button"
              >
                <GitMerge className="h-3.5 w-3.5 mr-1" />
                Merge into…
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => {
                  setRejectingIds(selectedArray);
                  setRejectOpen(true);
                }}
                disabled={busy}
                data-testid="bulk-reject-button"
              >
                <XCircle className="h-3.5 w-3.5 mr-1" />
                Reject…
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {queueQuery.isLoading && !queueQuery.data ? (
        <Skeleton className="h-32 w-full" />
      ) : queueQuery.isError ? (
        <Card className="border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/20">
          <CardContent className="p-3 text-xs text-red-700 dark:text-red-400">
            Failed to load: {String(queueQuery.error?.message || queueQuery.error)}
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            <Sparkles className="h-6 w-6 mx-auto mb-2 text-muted-foreground" />
            <p className="font-medium text-foreground">No candidates pending review</p>
            <p className="mt-1 text-xs">
              The canonical-rollup edge fn surfaces candidates here when raw
              observations land between the 0.75 and 0.92 cosine thresholds.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table data-testid="queue-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    <Checkbox
                      checked={allVisibleSelected}
                      onCheckedChange={toggleAllVisible}
                      aria-label="Select all visible"
                      data-testid="bulk-select-all"
                      data-indeterminate={someVisibleSelected || undefined}
                    />
                  </TableHead>
                  <TableHead className="text-[10px] uppercase tracking-wide">candidate_id</TableHead>
                  <TableHead className="text-[10px] uppercase tracking-wide">raw_label</TableHead>
                  <TableHead className="text-[10px] uppercase tracking-wide">nearest_canonical</TableHead>
                  <TableHead className="text-[10px] uppercase tracking-wide tabular-nums text-right">obs</TableHead>
                  <TableHead className="text-[10px] uppercase tracking-wide">first_seen</TableHead>
                  <TableHead className="text-[10px] uppercase tracking-wide">hierarchy</TableHead>
                  <TableHead className="text-[10px] uppercase tracking-wide w-[160px]">actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow
                    key={row.id}
                    data-testid="queue-row"
                    data-candidate-id={row.id}
                  >
                    <TableCell className="py-2">
                      <Checkbox
                        checked={selectedIds.has(row.id)}
                        onCheckedChange={() => toggleOne(row.id)}
                        aria-label={`Select ${row.proposed_canonical_label}`}
                        data-testid={`row-checkbox-${row.id}`}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-[10px] py-2">
                      {row.id.slice(0, 8)}
                    </TableCell>
                    <TableCell className="text-xs py-2">
                      <div className="flex flex-col gap-0.5">
                        <span className="font-mono">
                          {row.proposed_canonical_label}
                        </span>
                        {row.proposed_display_name && (
                          <span className="text-muted-foreground text-[11px]">
                            {row.proposed_display_name}
                          </span>
                        )}
                        <Badge className="text-[9px] h-4 px-1 mt-0.5 self-start bg-violet-100 text-violet-800 dark:bg-violet-950/40 dark:text-violet-300">
                          {row.candidate_type}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell className="py-2">
                      <NearestSimilarities
                        rows={
                          row.similarity_to_existing?.matches ??
                          row.similarity_to_existing
                        }
                      />
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-xs py-2">
                      {row.observed_count || 1}
                    </TableCell>
                    <TableCell className="text-[11px] py-2 text-muted-foreground tabular-nums">
                      {fmtTime(row.first_proposed_at)}
                    </TableCell>
                    <TableCell className="py-2">
                      <HierarchyChain row={row} />
                    </TableCell>
                    <TableCell className="py-2">
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="default"
                          className="h-6 px-2 text-[10px]"
                          onClick={() => approveMutation.mutate({ candidate_id: row.id })}
                          disabled={busy}
                          data-testid={`approve-button-${row.id}`}
                          title="Approve as canonical"
                        >
                          <CheckCircle2 className="h-3 w-3" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[10px]"
                          onClick={() => {
                            setRejectingIds([row.id]);
                            setRejectOpen(true);
                          }}
                          disabled={busy}
                          data-testid={`reject-button-${row.id}`}
                          title="Reject"
                        >
                          <XCircle className="h-3 w-3" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[10px]"
                          onClick={() => {
                            setSelectedIds(new Set([row.id]));
                            setMergeOpen(true);
                          }}
                          disabled={busy}
                          data-testid={`merge-button-${row.id}`}
                          title="Merge into existing canonical"
                        >
                          <GitMerge className="h-3 w-3" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[10px]"
                          onClick={() => deferMutation.mutate({ candidate_id: row.id })}
                          disabled={busy}
                          data-testid={`defer-button-${row.id}`}
                          title="Defer 7 days"
                        >
                          <Clock className="h-3 w-3" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {rows.length > 0 && (
        <div className="text-[11px] text-muted-foreground tabular-nums px-1">
          {rows.length} of {total} pending · selection capped at {BULK_BATCH_CAP}/batch
        </div>
      )}

      <MergeCandidateDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        candidateIds={selectedArray}
        busy={mergeMutation.isPending}
        onSubmit={({ target_canonical_id }) =>
          mergeMutation.mutate({
            candidate_ids: selectedArray,
            target_canonical_id,
          })
        }
      />

      <RejectDialog
        open={rejectOpen}
        onOpenChange={(o) => {
          setRejectOpen(o);
          if (!o) setRejectingIds([]);
        }}
        candidateIds={rejectingIds}
        busy={rejectMutation.isPending}
        onSubmit={({ reason }) =>
          rejectMutation.mutate({ candidate_ids: rejectingIds, reason })
        }
      />
    </div>
  );
}
