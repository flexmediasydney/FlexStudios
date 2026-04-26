/**
 * ShortlistingQuarantine — Wave 6 Phase 6 SHORTLIST
 *
 * Read + confirm UI for shortlisting_quarantine rows on this round.
 *
 * Each row: thumbnail (if group has preview), file_stem, reason badge,
 *          reason_detail, confidence, confirm button.
 *
 * Restore-to-round is a Phase 7 follow-up — for v1 we only show + confirm.
 */
import { useMemo, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CheckCircle2, Loader2, Trash2 } from "lucide-react";
import DroneThumbnail from "@/components/drone/DroneThumbnail";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const REASON_LABEL = {
  agent_headshot: "Agent headshot",
  test_shot: "Test shot",
  bts: "Behind-the-scenes",
  other: "Other",
};
const REASON_TONE = {
  agent_headshot:
    "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
  test_shot:
    "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  bts: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  other: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

export default function ShortlistingQuarantine({ roundId }) {
  const queryClient = useQueryClient();
  const [showResolved, setShowResolved] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [confirmNote, setConfirmNote] = useState("");

  const qQuery = useQuery({
    queryKey: ["shortlisting_quarantine", roundId],
    queryFn: async () => {
      const rows = await api.entities.ShortlistingQuarantine.filter(
        { round_id: roundId },
        "-created_at",
        2000,
      );
      return rows || [];
    },
    enabled: Boolean(roundId),
    staleTime: 15_000,
  });
  const groupsQuery = useQuery({
    queryKey: ["composition_groups", roundId],
    queryFn: async () => {
      const rows = await api.entities.CompositionGroup.filter(
        { round_id: roundId },
        "group_index",
        2000,
      );
      return rows || [];
    },
    enabled: Boolean(roundId),
    staleTime: 15_000,
  });

  const items = qQuery.data || [];
  const groups = groupsQuery.data || [];
  const groupById = useMemo(() => {
    const m = new Map();
    for (const g of groups) m.set(g.id, g);
    return m;
  }, [groups]);

  const visible = useMemo(() => {
    if (showResolved) return items;
    return items.filter((q) => !q.resolved);
  }, [items, showResolved]);

  const openConfirm = useCallback((row) => {
    setConfirmDialog(row);
    setConfirmNote("");
  }, []);

  const confirmOutOfScope = useCallback(async () => {
    if (!confirmDialog) return;
    setBusyId(confirmDialog.id);
    try {
      await api.entities.ShortlistingQuarantine.update(confirmDialog.id, {
        resolved: true,
        resolved_at: new Date().toISOString(),
        resolution_note: confirmNote || null,
      });
      toast.success("Marked out-of-scope.");
      queryClient.invalidateQueries({
        queryKey: ["shortlisting_quarantine", roundId],
      });
      setConfirmDialog(null);
    } catch (err) {
      console.error("[ShortlistingQuarantine] confirm failed:", err);
      toast.error(err?.message || "Confirm failed");
    } finally {
      setBusyId(null);
    }
  }, [confirmDialog, confirmNote, roundId, queryClient]);

  if (qQuery.isLoading || groupsQuery.isLoading) {
    return (
      <div className="space-y-3 animate-pulse">
        <div className="h-12 bg-muted rounded" />
        <div className="h-48 bg-muted rounded" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          No quarantined items for this round. Out-of-scope photos (agent
          headshots, test shots, BTS) appear here when Pass 0 detects them.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Trash2 className="h-3.5 w-3.5" />
          <span>
            {visible.length} pending review · {items.length} total
          </span>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowResolved((v) => !v)}
        >
          {showResolved ? "Hide resolved" : "Show resolved"}
        </Button>
      </div>

      {visible.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            All quarantine items reviewed.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {visible.map((q) => {
            const g = q.group_id ? groupById.get(q.group_id) : null;
            const dropboxPath = g?.dropbox_preview_path || null;
            return (
              <Card
                key={q.id}
                className={cn("overflow-hidden", q.resolved && "opacity-60")}
              >
                <DroneThumbnail
                  dropboxPath={dropboxPath}
                  mode="thumb"
                  aspectRatio="aspect-[4/3]"
                  alt={q.file_stem || "quarantined"}
                />
                <CardContent className="p-2 space-y-1.5">
                  <div
                    className="text-[11px] font-mono truncate"
                    title={q.file_stem}
                  >
                    {q.file_stem || "—"}
                  </div>
                  <div className="flex items-center gap-1 flex-wrap">
                    <Badge
                      className={cn(
                        "text-[9px]",
                        REASON_TONE[q.reason] || REASON_TONE.other,
                      )}
                    >
                      {REASON_LABEL[q.reason] || q.reason}
                    </Badge>
                    {q.confidence != null && (
                      <span className="text-[9px] text-muted-foreground">
                        conf {Number(q.confidence).toFixed(2)}
                      </span>
                    )}
                  </div>
                  {q.reason_detail && (
                    <p className="text-[10px] text-muted-foreground leading-snug line-clamp-3">
                      {q.reason_detail}
                    </p>
                  )}
                  {q.resolved ? (
                    <div className="flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="h-3 w-3" />
                      Resolved
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full h-7 text-[10px]"
                      onClick={() => openConfirm(q)}
                      disabled={busyId === q.id}
                    >
                      {busyId === q.id ? (
                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      ) : (
                        <CheckCircle2 className="h-3 w-3 mr-1" />
                      )}
                      Confirm out-of-scope
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Confirm dialog */}
      <Dialog
        open={!!confirmDialog}
        onOpenChange={(open) => !open && setConfirmDialog(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm out-of-scope</DialogTitle>
            <DialogDescription>
              {confirmDialog?.file_stem || "—"} · marked as{" "}
              <strong>{REASON_LABEL[confirmDialog?.reason] || confirmDialog?.reason}</strong>.
              Confirming acknowledges the AI's call. (Restoring to the round
              is a Phase 7 follow-up.)
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={confirmNote}
            onChange={(e) => setConfirmNote(e.target.value)}
            placeholder="Optional note"
            className="text-xs"
            rows={3}
          />
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setConfirmDialog(null)}
              disabled={busyId !== null}
            >
              Cancel
            </Button>
            <Button onClick={confirmOutOfScope} disabled={busyId !== null}>
              {busyId !== null && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
