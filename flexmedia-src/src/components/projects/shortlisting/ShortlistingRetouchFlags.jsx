/**
 * ShortlistingRetouchFlags — Wave 6 Phase 6 SHORTLIST
 *                            + W11.6.1-hotfix BUG #3 (Shape D plumbing)
 *
 * List of retouch flags surfaced for this round.
 *
 * Data source — Shape D plumbing fix (W11.6.1-hotfix):
 *   PRIMARY:   composition_classifications rows where flag_for_retouching=
 *              TRUE. Shape D writes the retouch signal directly onto the
 *              classification row (clutter_severity + clutter_detail +
 *              flag_for_retouching). The legacy shortlisting_retouch_flags
 *              table is empty on every Shape D round, so reading from it
 *              produced an empty Retouch sub-tab.
 *
 *   Resolved-state — also a Shape D plumbing fix. The legacy table had a
 *   `resolved` boolean that the operator's "Resolve" button flipped.
 *   composition_classifications has no equivalent column, so migration
 *   389_composition_classifications_retouch_resolved.sql adds two:
 *     - retouch_resolved_at  TIMESTAMPTZ NULL
 *     - retouch_resolved_by  UUID NULL
 *   The Resolve action sets both. The query filters
 *   `WHERE retouch_resolved_at IS NULL` (default) or includes resolved rows
 *   under the "Show resolved" toggle.
 *
 *   The legacy `shortlisting_retouch_flags` table is NOT deleted —
 *   historical pre-Shape-D rounds may still have rows there. We don't read
 *   from it anymore (every Shape D engine_run_audit row classifies via
 *   composition_classifications), but the table survives for audit /
 *   historical replay purposes.
 *
 * Each retouch entry derives:
 *   stem        from joining composition_groups on group_id
 *   severity    from classification.clutter_severity
 *   detail      from classification.clutter_detail
 *   flagged_at  from classification.classified_at
 *   thumbnail   from composition_groups.dropbox_preview_path
 *
 * Resolve dialog: optional resolution note (kept in clutter_detail
 * append-only since composition_classifications doesn't have a separate
 * resolution_note column — keeps the migration small).
 */
import { useMemo, useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
import { formatDistanceToNow } from "date-fns";
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

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

export default function ShortlistingRetouchFlags({ roundId }) {
  const queryClient = useQueryClient();
  const [showResolved, setShowResolved] = useState(false);
  const [resolveDialog, setResolveDialog] = useState(null); // classification row
  const [resolveNote, setResolveNote] = useState("");

  // Shape D data source — composition_classifications with
  // flag_for_retouching=TRUE for this round. The "show resolved" toggle
  // flips between unresolved-only (the default operator queue) and the
  // full historical set. We can't add an `is null` filter to the shim's
  // filter() helper, so we always pull the full flagged set + filter
  // client-side. Volumes are small (≤ a few hundred per round).
  const queryKey = useMemo(
    () => ["shortlisting_retouch_flags_v2", roundId, showResolved],
    [roundId, showResolved],
  );
  const flagsQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const rows = await api.entities.CompositionClassification.filter(
        { round_id: roundId, flag_for_retouching: true },
        "-classified_at",
        2000,
      );
      return rows || [];
    },
    enabled: Boolean(roundId),
    staleTime: 0,
    refetchOnMount: "always",
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

  const allFlags = flagsQuery.data || [];
  const groups = groupsQuery.data || [];
  const groupById = useMemo(() => {
    const m = new Map();
    for (const g of groups) m.set(g.id, g);
    return m;
  }, [groups]);

  // Decorate each classification row into the legacy "flag" shape the
  // render path expects (stem, dropboxPath, severity, detail, flagged_at,
  // resolved). This keeps the JSX simple and isolates the data-source
  // change to the query above.
  const decorated = useMemo(() => {
    return allFlags.map((c) => {
      const g = c.group_id ? groupById.get(c.group_id) : null;
      const stem = g?.delivery_reference_stem || g?.best_bracket_stem || null;
      return {
        id: c.id,
        group_id: c.group_id,
        file_stem: stem,
        clutter_severity: c.clutter_severity || "none",
        clutter_detail: c.clutter_detail || null,
        flagged_at: c.classified_at,
        resolved: c.retouch_resolved_at != null,
        resolved_at: c.retouch_resolved_at,
        resolved_by: c.retouch_resolved_by,
        dropboxPath: g?.dropbox_preview_path || null,
        // is_shortlisted is a Wave 6 concept that doesn't map cleanly onto
        // Shape D classifications — we keep the badge for legacy shape but
        // default to false on Shape D rows.
        is_shortlisted: false,
      };
    });
  }, [allFlags, groupById]);

  const visible = useMemo(() => {
    if (showResolved) return decorated;
    return decorated.filter((f) => !f.resolved);
  }, [decorated, showResolved]);

  // Resolve mutation with optimistic UI — disappears the row from the
  // active queue immediately on click; rolls back on error.
  const resolveMutation = useMutation({
    mutationFn: async ({ id, note }) => {
      const me = await api.auth.me().catch(() => null);
      const updated = await api.entities.CompositionClassification.update(id, {
        retouch_resolved_at: new Date().toISOString(),
        retouch_resolved_by: me?.id || null,
        // Append the resolution note onto clutter_detail so the audit
        // trail survives without a new column. Format keeps existing
        // detail untouched + adds a "[resolved: …]" suffix.
        clutter_detail: note
          ? `${(allFlags.find((c) => c.id === id)?.clutter_detail || "").trim()}\n[resolved: ${note}]`.trim()
          : undefined,
      });
      return updated;
    },
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey });
      const snapshot = queryClient.getQueryData(queryKey) || [];
      const next = snapshot.map((c) =>
        c.id === id
          ? {
              ...c,
              retouch_resolved_at: new Date().toISOString(),
              retouch_resolved_by: c.retouch_resolved_by || null,
            }
          : c,
      );
      queryClient.setQueryData(queryKey, next);
      return { snapshot };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.snapshot) queryClient.setQueryData(queryKey, ctx.snapshot);
      console.error("[ShortlistingRetouchFlags] resolve failed:", err);
      toast.error(err?.message || "Resolve failed");
    },
    onSuccess: () => {
      toast.success("Retouch flag resolved.");
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: ["shortlisting_retouch_flags_v2", roundId],
      });
    },
  });

  const openResolve = useCallback((flag) => {
    setResolveDialog(flag);
    setResolveNote("");
  }, []);

  const confirmResolve = useCallback(() => {
    if (!resolveDialog) return;
    resolveMutation.mutate({ id: resolveDialog.id, note: resolveNote || null });
    setResolveDialog(null);
  }, [resolveDialog, resolveNote, resolveMutation]);

  if (flagsQuery.isLoading || groupsQuery.isLoading) {
    return (
      <div className="space-y-3 animate-pulse">
        <div className="h-12 bg-muted rounded" />
        <div className="h-48 bg-muted rounded" />
      </div>
    );
  }

  if (decorated.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          No retouch flags for this round. Shape D classifications surface
          flags only when clutter_severity is minor_photoshoppable,
          moderate_retouch, or major_reject.
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
            {visible.filter((f) => !f.resolved).length} unresolved ·{" "}
            {decorated.length} total
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
          {visible.map((flag) => (
            <Card
              key={flag.id}
              className={cn(
                "overflow-hidden",
                flag.resolved && "opacity-60",
              )}
            >
              <DroneThumbnail
                dropboxPath={flag.dropboxPath}
                mode="thumb"
                aspectRatio="aspect-[4/3]"
                alt={flag.file_stem || "retouch flag"}
              />
              <CardContent className="p-2 space-y-1.5">
                <div
                  className="text-[11px] font-mono truncate"
                  title={flag.file_stem}
                >
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
                    {SEVERITY_LABEL[flag.clutter_severity] ||
                      flag.clutter_severity}
                  </Badge>
                  <Badge
                    variant="outline"
                    className="text-[9px] text-muted-foreground"
                  >
                    {fmtTime(flag.flagged_at)}
                  </Badge>
                </div>
                {flag.clutter_detail && (
                  <p className="text-[10px] text-muted-foreground leading-snug line-clamp-3">
                    {flag.clutter_detail}
                  </p>
                )}
                {flag.resolved ? (
                  <div className="flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="h-3 w-3" />
                    Resolved {fmtTime(flag.resolved_at)}
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full h-7 text-[10px]"
                    onClick={() => openResolve(flag)}
                    disabled={resolveMutation.isPending}
                  >
                    {resolveMutation.isPending &&
                    resolveMutation.variables?.id === flag.id ? (
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-3 w-3 mr-1" />
                    )}
                    Resolve
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
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
              disabled={resolveMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={confirmResolve}
              disabled={resolveMutation.isPending}
            >
              {resolveMutation.isPending && (
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
