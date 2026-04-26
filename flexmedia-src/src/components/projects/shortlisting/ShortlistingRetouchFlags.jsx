/**
 * ShortlistingRetouchFlags — Wave 6 Phase 6 SHORTLIST
 *
 * List of retouch flags surfaced by Pass 3 for this round.
 *
 * Each row: thumbnail, file_stem, clutter_severity badge, clutter_detail,
 *          is_shortlisted indicator, Resolve button.
 *
 * Resolve action: marks resolved=TRUE, resolved_by=auth.uid(), resolved_at=NOW(),
 *                 captures resolution_note via inline textarea + confirm.
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
import { CheckCircle2, Loader2, Sparkles } from "lucide-react";
import DroneThumbnail from "@/components/drone/DroneThumbnail";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const SEVERITY_TONE = {
  none: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  minor_photoshoppable:
    "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  moderate_retouch:
    "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  major_reject:
    "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
};

const SEVERITY_LABEL = {
  none: "None",
  minor_photoshoppable: "Minor",
  moderate_retouch: "Moderate",
  major_reject: "Major",
};

export default function ShortlistingRetouchFlags({ roundId }) {
  const queryClient = useQueryClient();
  const [showResolved, setShowResolved] = useState(false);
  const [resolvingId, setResolvingId] = useState(null);
  const [resolveDialog, setResolveDialog] = useState(null); // flag row
  const [resolveNote, setResolveNote] = useState("");

  const flagsQuery = useQuery({
    queryKey: ["shortlisting_retouch_flags", roundId],
    queryFn: async () => {
      const rows = await api.entities.ShortlistingRetouchFlag.filter(
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

  const flags = flagsQuery.data || [];
  const groups = groupsQuery.data || [];
  const groupById = useMemo(() => {
    const m = new Map();
    for (const g of groups) m.set(g.id, g);
    return m;
  }, [groups]);

  const visible = useMemo(() => {
    if (showResolved) return flags;
    return flags.filter((f) => !f.resolved);
  }, [flags, showResolved]);

  const openResolve = useCallback((flag) => {
    setResolveDialog(flag);
    setResolveNote("");
  }, []);

  const confirmResolve = useCallback(async () => {
    if (!resolveDialog) return;
    setResolvingId(resolveDialog.id);
    try {
      await api.entities.ShortlistingRetouchFlag.update(resolveDialog.id, {
        resolved: true,
        resolved_at: new Date().toISOString(),
        resolution_note: resolveNote || null,
      });
      toast.success("Retouch flag resolved.");
      queryClient.invalidateQueries({
        queryKey: ["shortlisting_retouch_flags", roundId],
      });
      setResolveDialog(null);
    } catch (err) {
      console.error("[ShortlistingRetouchFlags] resolve failed:", err);
      toast.error(err?.message || "Resolve failed");
    } finally {
      setResolvingId(null);
    }
  }, [resolveDialog, resolveNote, roundId, queryClient]);

  if (flagsQuery.isLoading || groupsQuery.isLoading) {
    return (
      <div className="space-y-3 animate-pulse">
        <div className="h-12 bg-muted rounded" />
        <div className="h-48 bg-muted rounded" />
      </div>
    );
  }

  if (flags.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          No retouch flags for this round. Pass 3 surfaces flags only when
          clutter_severity is minor_photoshoppable or moderate_retouch.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5" />
          <span>
            {visible.length} unresolved · {flags.length} total
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
            All retouch flags resolved.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {visible.map((flag) => {
            const g = flag.group_id ? groupById.get(flag.group_id) : null;
            const dropboxPath = g?.dropbox_preview_path || null;
            return (
              <Card
                key={flag.id}
                className={cn(
                  "overflow-hidden",
                  flag.resolved && "opacity-60",
                )}
              >
                <DroneThumbnail
                  dropboxPath={dropboxPath}
                  mode="thumb"
                  aspectRatio="aspect-[4/3]"
                  alt={flag.file_stem || "retouch flag"}
                />
                <CardContent className="p-2 space-y-1.5">
                  <div className="text-[11px] font-mono truncate" title={flag.file_stem}>
                    {flag.file_stem || "—"}
                  </div>
                  <div className="flex items-center gap-1 flex-wrap">
                    <Badge
                      className={cn(
                        "text-[9px]",
                        SEVERITY_TONE[flag.clutter_severity] ||
                          SEVERITY_TONE.none,
                      )}
                    >
                      {SEVERITY_LABEL[flag.clutter_severity] || flag.clutter_severity}
                    </Badge>
                    {flag.is_shortlisted && (
                      <Badge variant="outline" className="text-[9px] border-emerald-400 text-emerald-700 dark:text-emerald-300">
                        Shortlisted
                      </Badge>
                    )}
                  </div>
                  {flag.clutter_detail && (
                    <p className="text-[10px] text-muted-foreground leading-snug line-clamp-3">
                      {flag.clutter_detail}
                    </p>
                  )}
                  {flag.resolved ? (
                    <div className="flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="h-3 w-3" />
                      Resolved
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full h-7 text-[10px]"
                      onClick={() => openResolve(flag)}
                      disabled={resolvingId === flag.id}
                    >
                      {resolvingId === flag.id ? (
                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      ) : (
                        <CheckCircle2 className="h-3 w-3 mr-1" />
                      )}
                      Resolve
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Resolve dialog */}
      <Dialog
        open={!!resolveDialog}
        onOpenChange={(open) => !open && setResolveDialog(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resolve retouch flag</DialogTitle>
            <DialogDescription>
              {resolveDialog?.file_stem || "—"}
              {resolveDialog?.clutter_detail ? (
                <span className="block mt-1 text-xs text-muted-foreground">
                  {resolveDialog.clutter_detail}
                </span>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={resolveNote}
            onChange={(e) => setResolveNote(e.target.value)}
            placeholder="Optional resolution note (e.g. 'fixed in retouching pass')"
            className="text-xs"
            rows={3}
          />
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setResolveDialog(null)}
              disabled={resolvingId !== null}
            >
              Cancel
            </Button>
            <Button onClick={confirmResolve} disabled={resolvingId !== null}>
              {resolvingId !== null && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Mark resolved
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
