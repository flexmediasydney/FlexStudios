/**
 * AIRoomTypeSuggestionsTab — Wave 12.7-12.8 room-type proposals queue.
 *
 * Reads shortlisting_room_type_suggestions WHERE status='pending'.
 * Sorted by evidence_count DESC. Per-row Approve / Reject actions.
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { CheckCircle2, XCircle, Sparkles, Loader2 } from "lucide-react";

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

function fmtConfidence(n) {
  if (n == null) return "—";
  return Number(n).toFixed(2);
}

export default function AIRoomTypeSuggestionsTab() {
  const qc = useQueryClient();
  const [rejectTarget, setRejectTarget] = useState(null);
  const [rejectReason, setRejectReason] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["ai-room-type-suggestions", "pending"],
    queryFn: async () => {
      const rows = await api.entities.ShortlistingRoomTypeSuggestion.filter(
        { status: "pending" },
        "-evidence_count",
        200,
      );
      return rows;
    },
  });

  const approve = useMutation({
    mutationFn: async ({ id, proposed_key, proposed_display_name }) => {
      // Inserting into shortlisting_room_types is gated by RLS to admin/master_admin —
      // we do the canonical insert via the same client (RLS allows master_admin).
      const created = await api.entities.ShortlistingRoomType.create({
        key: proposed_key,
        display_name: proposed_display_name || proposed_key,
        category: "auto_proposed",
        is_active: true,
        notes: "Auto-approved from AI suggestion engine",
      });
      return api.entities.ShortlistingRoomTypeSuggestion.update(id, {
        status: "approved",
        reviewed_at: new Date().toISOString(),
        approved_room_type_id: created?.id ?? null,
      });
    },
    onSuccess: () => {
      toast.success("Approved — room_type added to canonical taxonomy");
      qc.invalidateQueries({ queryKey: ["ai-room-type-suggestions"] });
    },
    onError: (err) => toast.error(`Approve failed: ${err?.message || err}`),
  });

  const reject = useMutation({
    mutationFn: async ({ id, reason }) => {
      return api.entities.ShortlistingRoomTypeSuggestion.update(id, {
        status: "rejected",
        reviewed_at: new Date().toISOString(),
        reviewer_notes: reason,
      });
    },
    onSuccess: () => {
      toast.success("Rejected");
      setRejectTarget(null);
      setRejectReason("");
      qc.invalidateQueries({ queryKey: ["ai-room-type-suggestions"] });
    },
    onError: (err) => toast.error(`Reject failed: ${err?.message || err}`),
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
          Failed to load room-type suggestions: {String(error?.message || error)}
        </CardContent>
      </Card>
    );
  }

  const rows = data || [];

  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground" data-testid="empty-state-room-types">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 opacity-60" />
            No pending room-type suggestions. Run the engine to refresh.
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <div className="space-y-2.5" data-testid="room-type-suggestions-list">
        {rows.map((row) => (
          <Card key={row.id} data-testid={`room-type-suggestion-${row.proposed_key}`}>
            <CardHeader className="p-3 pb-1.5">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="space-y-0.5">
                  <CardTitle className="text-sm font-mono flex items-center gap-2">
                    {row.proposed_key}
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
                        proposed_key: row.proposed_key,
                        proposed_display_name: row.proposed_display_name,
                      })
                    }
                    disabled={approve.isPending}
                    data-testid={`approve-${row.proposed_key}`}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setRejectTarget(row)}
                    data-testid={`reject-${row.proposed_key}`}
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
                  Evidence: <strong>{row.evidence_count ?? 0}</strong>
                </span>
                <span className="text-muted-foreground">·</span>
                <span>
                  Avg confidence:{" "}
                  <strong>{fmtConfidence(row.avg_confidence)}</strong>
                </span>
              </div>
              {Array.isArray(row.sample_analysis_excerpts) &&
                row.sample_analysis_excerpts.length > 0 && (
                  <details className="text-[11px]">
                    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                      Sample analysis ({row.sample_analysis_excerpts.length})
                    </summary>
                    <ul className="mt-1 ml-4 list-disc space-y-0.5">
                      {row.sample_analysis_excerpts.slice(0, 5).map((r, i) => (
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
              placeholder="e.g. duplicate of existing room_type kitchen"
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
    </>
  );
}
