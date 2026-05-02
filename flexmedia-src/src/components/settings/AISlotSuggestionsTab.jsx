/**
 * AISlotSuggestionsTab — Wave 12.7-12.8 slot proposals queue.
 *
 * Reads shortlisting_slot_suggestions WHERE status='pending' (RLS lets
 * master_admin / admin / manager / employee read; mutations gated to
 * master_admin via RLS). Sorted by evidence_round_count DESC.
 *
 * Per-row actions:
 *   • Approve  — flips status='approved', stamps reviewed_by/at + approved_slot_id.
 *   • Reject   — prompts for reason, flips status='rejected'.
 *   • Merge    — prompts for an existing canonical slot_id, flips status='merged'.
 */

import { useState } from "react";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { CheckCircle2, XCircle, GitMerge, Layers, Loader2 } from "lucide-react";

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

export default function AISlotSuggestionsTab() {
  const qc = useQueryClient();
  const [rejectTarget, setRejectTarget] = useState(null);
  const [rejectReason, setRejectReason] = useState("");
  const [mergeTarget, setMergeTarget] = useState(null);
  const [mergeSlot, setMergeSlot] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["ai-slot-suggestions", "pending"],
    queryFn: async () => {
      const rows = await api.entities.ShortlistingSlotSuggestion.filter(
        { status: "pending" },
        "-evidence_round_count",
        200,
      );
      return rows;
    },
  });

  const approve = useMutation({
    mutationFn: async ({ id, proposed_slot_id }) => {
      return api.entities.ShortlistingSlotSuggestion.update(id, {
        status: "approved",
        reviewed_at: new Date().toISOString(),
        approved_slot_id: proposed_slot_id,
      });
    },
    onSuccess: () => {
      toast.success("Approved");
      qc.invalidateQueries({ queryKey: ["ai-slot-suggestions"] });
    },
    onError: (err) => toast.error(`Approve failed: ${err?.message || err}`),
  });

  const reject = useMutation({
    mutationFn: async ({ id, reason }) => {
      return api.entities.ShortlistingSlotSuggestion.update(id, {
        status: "rejected",
        reviewed_at: new Date().toISOString(),
        reviewer_notes: reason,
      });
    },
    onSuccess: () => {
      toast.success("Rejected");
      setRejectTarget(null);
      setRejectReason("");
      qc.invalidateQueries({ queryKey: ["ai-slot-suggestions"] });
    },
    onError: (err) => toast.error(`Reject failed: ${err?.message || err}`),
  });

  const merge = useMutation({
    mutationFn: async ({ id, into }) => {
      return api.entities.ShortlistingSlotSuggestion.update(id, {
        status: "merged",
        reviewed_at: new Date().toISOString(),
        merged_into_slot_id: into,
      });
    },
    onSuccess: () => {
      toast.success("Merged");
      setMergeTarget(null);
      setMergeSlot("");
      qc.invalidateQueries({ queryKey: ["ai-slot-suggestions"] });
    },
    onError: (err) => toast.error(`Merge failed: ${err?.message || err}`),
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-4 space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-destructive">
          Failed to load slot suggestions: {String(error?.message || error)}
        </CardContent>
      </Card>
    );
  }

  const rows = data || [];

  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground" data-testid="empty-state-slots">
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 opacity-60" />
            No pending slot suggestions. Run the engine to refresh — or check
            back after Stage 4 has emitted more pass2_slot_suggestion events.
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <div className="space-y-2.5" data-testid="slot-suggestions-list">
        {rows.map((row) => (
          <Card key={row.id} data-testid={`slot-suggestion-${row.proposed_slot_id}`}>
            <CardHeader className="p-3 pb-1.5">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="space-y-0.5">
                  <CardTitle className="text-sm font-mono flex items-center gap-2">
                    {row.proposed_slot_id}
                    <Badge variant="outline" className="text-[10px]">
                      {row.trigger_source}
                    </Badge>
                  </CardTitle>
                  <CardDescription className="text-[11px]">
                    {row.proposed_display_name || "—"} · last seen{" "}
                    {fmtTime(row.last_observed_at)}
                  </CardDescription>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="default"
                    onClick={() =>
                      approve.mutate({
                        id: row.id,
                        proposed_slot_id: row.proposed_slot_id,
                      })
                    }
                    disabled={approve.isPending}
                    data-testid={`approve-${row.proposed_slot_id}`}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setMergeTarget(row)}
                    data-testid={`merge-${row.proposed_slot_id}`}
                  >
                    <GitMerge className="h-3.5 w-3.5 mr-1" />
                    Merge
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setRejectTarget(row)}
                    data-testid={`reject-${row.proposed_slot_id}`}
                  >
                    <XCircle className="h-3.5 w-3.5 mr-1" />
                    Reject
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-3 pt-1.5 text-xs space-y-1.5">
              <div className="flex flex-wrap gap-x-3 gap-y-1 tabular-nums">
                <span>
                  Evidence rounds:{" "}
                  <strong>{row.evidence_round_count ?? 0}</strong>
                </span>
                <span className="text-muted-foreground">·</span>
                <span>
                  Total proposals:{" "}
                  <strong>{row.evidence_total_proposals ?? 0}</strong>
                </span>
                {row.source_market_frequency != null && (
                  <>
                    <span className="text-muted-foreground">·</span>
                    <span>
                      Registry market_frequency:{" "}
                      <strong>{row.source_market_frequency}</strong>
                    </span>
                  </>
                )}
              </div>
              {Array.isArray(row.sample_round_ids) &&
                row.sample_round_ids.length > 0 && (
                  <div className="text-muted-foreground">
                    <span className="font-medium">Sample rounds: </span>
                    <span className="font-mono text-[10px]">
                      {row.sample_round_ids.slice(0, 3).join(", ")}
                      {row.sample_round_ids.length > 3 &&
                        ` (+${row.sample_round_ids.length - 3} more)`}
                    </span>
                  </div>
                )}
              {Array.isArray(row.sample_reasoning) &&
                row.sample_reasoning.length > 0 && (
                  <details className="text-[11px]">
                    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                      Sample reasoning ({row.sample_reasoning.length})
                    </summary>
                    <ul className="mt-1 ml-4 list-disc space-y-0.5">
                      {row.sample_reasoning.slice(0, 5).map((r, i) => (
                        <li key={i} className="leading-snug">
                          {r}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog
        open={!!rejectTarget}
        onOpenChange={(o) => !o && setRejectTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject suggestion</DialogTitle>
            <DialogDescription className="text-xs">
              Provide a brief reason; this is stored on{" "}
              <code>reviewer_notes</code>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-xs">Reason</Label>
            <Textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={3}
              placeholder="e.g. duplicate of existing slot kitchen_hero"
              data-testid="reject-reason-input"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={rejectReason.trim().length < 3 || reject.isPending}
              onClick={() =>
                reject.mutate({
                  id: rejectTarget.id,
                  reason: rejectReason.trim(),
                })
              }
              data-testid="reject-confirm"
            >
              {reject.isPending && (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              )}
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!mergeTarget}
        onOpenChange={(o) => !o && setMergeTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Merge into existing slot</DialogTitle>
            <DialogDescription className="text-xs">
              Enter the canonical slot_id this proposal should be merged into.
              The suggestion will be flagged as <code>merged</code>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-xs">Target slot_id</Label>
            <Input
              value={mergeSlot}
              onChange={(e) => setMergeSlot(e.target.value)}
              placeholder="e.g. kitchen_hero"
              data-testid="merge-slot-input"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMergeTarget(null)}>
              Cancel
            </Button>
            <Button
              disabled={mergeSlot.trim().length === 0 || merge.isPending}
              onClick={() =>
                merge.mutate({ id: mergeTarget.id, into: mergeSlot.trim() })
              }
              data-testid="merge-confirm"
            >
              {merge.isPending && (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              )}
              Merge
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
