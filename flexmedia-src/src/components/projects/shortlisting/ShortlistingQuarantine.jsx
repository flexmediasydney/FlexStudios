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
import { CheckCircle2, Loader2, RotateCcw, Trash2 } from "lucide-react";
import DroneThumbnail from "@/components/drone/DroneThumbnail";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// Burst 19 OO1: align with the actual quarantine.reason values written by
// Pass 0 (out_of_scope is the only one that flows here today; motion_blur /
// severe_underexposure / corrupt_frame go to composition_hard_rejected
// events instead). The previous fictional sub-reasons (agent_headshot etc)
// were never populated, so editors saw the raw "out_of_scope" string.
const REASON_LABEL = {
  out_of_scope: "Out of scope",
  agent_headshot: "Agent headshot",
  test_shot: "Test shot",
  bts: "Behind-the-scenes",
  motion_blur: "Motion blur",
  accidental_trigger: "Accidental trigger",
  severe_underexposure: "Severe underexposure",
  corrupt_frame: "Corrupt frame",
  other: "Other",
};
const REASON_TONE = {
  out_of_scope:
    "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
  agent_headshot:
    "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
  test_shot:
    "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  bts: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  motion_blur:
    "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  accidental_trigger:
    "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  severe_underexposure:
    "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  corrupt_frame:
    "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  other: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

export default function ShortlistingQuarantine({ roundId }) {
  const queryClient = useQueryClient();
  const [showResolved, setShowResolved] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [confirmNote, setConfirmNote] = useState("");
  const [restoreDialog, setRestoreDialog] = useState(null);

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

  const restoreToRound = useCallback(async () => {
    if (!restoreDialog) return;
    setBusyId(restoreDialog.id);
    try {
      // Delete the quarantine row — pass1_ready_compositions RPC will then
      // return this group as eligible for re-classification (it filters
      // out groups with a quarantine row).
      await api.entities.ShortlistingQuarantine.delete(restoreDialog.id);
      // W11.7.10 sunset: previously invoked `shortlisting-pass1` here. The
      // legacy two-pass engine is retired — restore now re-classifies via
      // the Shape D Stage 1 orchestrator. Shape D's idempotency loader
      // skips already-classified groups, so it'll pick up just the restored
      // composition. Direct invoke is best-effort; if it fails the operator
      // can re-fire from the DispatcherPanel.
      try {
        await api.functions.invoke("shortlisting-shape-d", {
          round_id: roundId,
        });
        toast.success("Restored and re-classification triggered.");
      } catch (shapeErr) {
        // The delete succeeded; shape-d invoke is best-effort. Surface but don't fail.
        console.warn(
          "[ShortlistingQuarantine] shortlisting-shape-d invoke failed:",
          shapeErr,
        );
        toast.success(
          "Restored. Re-fire Stage 1 from the Dispatcher panel to re-classify.",
        );
      }
      queryClient.invalidateQueries({
        queryKey: ["shortlisting_quarantine", roundId],
      });
      queryClient.invalidateQueries({
        queryKey: ["composition_classifications", roundId],
      });
      setRestoreDialog(null);
    } catch (err) {
      console.error("[ShortlistingQuarantine] restore failed:", err);
      toast.error(err?.message || "Restore failed");
    } finally {
      setBusyId(null);
    }
  }, [restoreDialog, roundId, queryClient]);

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
                  aspectRatio="aspect-[3/2]"
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
                    <div className="grid grid-cols-2 gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-[10px]"
                        onClick={() => openConfirm(q)}
                        disabled={busyId === q.id}
                      >
                        {busyId === q.id ? (
                          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                        ) : (
                          <CheckCircle2 className="h-3 w-3 mr-1" />
                        )}
                        Confirm OOS
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-[10px]"
                        onClick={() => setRestoreDialog(q)}
                        disabled={busyId === q.id}
                        title="Restore to round and re-classify"
                      >
                        <RotateCcw className="h-3 w-3 mr-1" />
                        Restore
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Restore dialog */}
      <Dialog
        open={!!restoreDialog}
        onOpenChange={(open) => !open && setRestoreDialog(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore to round</DialogTitle>
            <DialogDescription>
              {restoreDialog?.file_stem || "—"} was flagged as{" "}
              <strong>{REASON_LABEL[restoreDialog?.reason] || restoreDialog?.reason}</strong>{" "}
              by Pass 0. Restoring will delete the quarantine flag and
              re-trigger Shape D Stage 1 classification just for this composition.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setRestoreDialog(null)}
              disabled={busyId !== null}
            >
              Cancel
            </Button>
            <Button onClick={restoreToRound} disabled={busyId !== null}>
              {busyId !== null && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              <RotateCcw className="h-4 w-4 mr-2" />
              Restore + re-classify
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
              Confirming acknowledges the AI's call. To bring this composition
              back into the round, use Restore instead.
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
