/**
 * FieldSourceHistory.jsx — full provenance drawer for one (entity, field).
 *
 * Opened from FieldWithSource ⋮ → "View history". Reads every observation for
 * this field (including dismissed + superseded) via the
 * entity_field_sources table directly — the resolver only returns the
 * currently-active set, so we need the raw ledger here.
 *
 * Shows:
 *   - A one-row-per-observation table sorted newest-first
 *   - Relative time (tooltip = absolute)
 *   - Source chip
 *   - Value (strike-through if dismissed)
 *   - Confidence bar (0..1)
 *   - times_seen counter
 *   - Status pill: active | promoted | dismissed | superseded | locked
 *   - Admin-gated actions: Promote / Dismiss / Unlock
 *   - A compact diff timeline at the top: "Value changed from X → Y on <date>".
 */

import React, { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { format, formatDistanceToNow } from "date-fns";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Lock, ArrowUpCircle, XCircle, CheckCircle2, History, ArrowRight, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import FieldSourceChip from "./FieldSourceChip";
import { useSafrMutations, safrQueryKey } from "./safrHooks";
import { usePermissions } from "@/components/auth/PermissionGuard";
import { useQueryClient } from "@tanstack/react-query";

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtRel(ts) {
  if (!ts) return null;
  try { return formatDistanceToNow(new Date(ts), { addSuffix: true }); }
  catch { return null; }
}
function fmtAbs(ts) {
  if (!ts) return null;
  try { return format(new Date(ts), "PPpp"); } catch { return null; }
}

function statusOf(row) {
  if (row.dismissed_at) return "dismissed";
  if (row.locked_at) return "locked";
  if (row.status === "promoted") return "promoted";
  if (row.status === "superseded") return "superseded";
  return "active";
}

const STATUS_STYLES = {
  promoted:   { variant: "default",   icon: CheckCircle2 },
  locked:     { variant: "secondary", icon: Lock          },
  dismissed:  { variant: "destructive", icon: XCircle    },
  superseded: { variant: "outline",   icon: History       },
  active:     { variant: "outline",   icon: null          },
};

function ConfidenceBar({ value }) {
  const pct = Math.max(0, Math.min(100, Math.round((value ?? 0) * 100)));
  return (
    <div className="w-20 h-1.5 rounded-full bg-muted overflow-hidden">
      <div
        className="h-full bg-emerald-500 dark:bg-emerald-400 transition-[width]"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ── Query: load full observation ledger ──────────────────────────────────

function useFieldHistory(entityType, entityId, fieldName, open) {
  return useQuery({
    queryKey: ["safr", "history", entityType, entityId, fieldName],
    enabled: open && Boolean(entityType && entityId && fieldName),
    queryFn: async () => {
      const client = api._supabase;
      const { data, error } = await client
        .from("entity_field_sources")
        .select("*")
        .eq("entity_type", entityType)
        .eq("entity_id", entityId)
        .eq("field_name", fieldName)
        .order("observed_at", { ascending: false })
        .limit(200);
      if (error) throw new Error(error.message);
      return data || [];
    },
    staleTime: 15 * 1000,
  });
}

// ── Diff timeline ─────────────────────────────────────────────────────────

function buildDiffTimeline(rows) {
  // Walk promoted rows oldest → newest, recording transitions.
  const promoted = [...rows]
    .filter(r => r.status === "promoted" || r.promoted_at)
    .sort((a, b) => new Date(a.promoted_at || a.observed_at) - new Date(b.promoted_at || b.observed_at));

  const diffs = [];
  for (let i = 1; i < promoted.length; i++) {
    const prev = promoted[i - 1];
    const curr = promoted[i];
    if ((prev.value_normalized || prev.value_display) === (curr.value_normalized || curr.value_display)) continue;
    diffs.push({
      from: prev.value_display ?? prev.value_normalized,
      to: curr.value_display ?? curr.value_normalized,
      at: curr.promoted_at || curr.observed_at,
      source: curr.source,
    });
  }
  return diffs.reverse(); // newest first
}

// ── Component ────────────────────────────────────────────────────────────

export default function FieldSourceHistory({
  open,
  onOpenChange,
  entityType,
  entityId,
  fieldName,
  label,
}) {
  const qc = useQueryClient();
  const { isAdminOrAbove } = usePermissions();
  const { promote, dismiss, unlock } = useSafrMutations(entityType, entityId, fieldName);
  const { data: rows = [], isLoading, error } = useFieldHistory(entityType, entityId, fieldName, open);

  const diffs = useMemo(() => buildDiffTimeline(rows), [rows]);

  const handlePromote = async (row) => {
    try {
      await promote.mutateAsync({ sourceId: row.id });
      toast.success("Value promoted");
      qc.invalidateQueries({ queryKey: ["safr", "history", entityType, entityId, fieldName] });
      qc.invalidateQueries({ queryKey: safrQueryKey(entityType, entityId, fieldName) });
    } catch (e) { toast.error(e?.message || "Promote failed"); }
  };
  const handleDismiss = async (row) => {
    const reason = window.prompt("Reason for dismissing this value? (optional)");
    try {
      await dismiss.mutateAsync({ sourceId: row.id, reason: reason || null });
      toast.success("Value dismissed");
      qc.invalidateQueries({ queryKey: ["safr", "history", entityType, entityId, fieldName] });
    } catch (e) { toast.error(e?.message || "Dismiss failed"); }
  };
  const handleUnlock = async () => {
    try {
      await unlock.mutateAsync();
      toast.success("Field unlocked");
      qc.invalidateQueries({ queryKey: ["safr", "history", entityType, entityId, fieldName] });
    } catch (e) { toast.error(e?.message || "Unlock failed"); }
  };

  const anyLocked = rows.some(r => r.locked_at);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto p-0">
        <SheetHeader className="p-5 border-b bg-muted/20">
          <SheetTitle className="text-base font-semibold flex items-center gap-2">
            <History className="h-4 w-4" />
            Field History
          </SheetTitle>
          <SheetDescription className="text-xs">
            Every observation recorded for{" "}
            <span className="font-mono text-foreground">{label || fieldName}</span>{" "}
            on this {entityType}. Newest first.
          </SheetDescription>
          {anyLocked && isAdminOrAbove && (
            <div className="pt-2">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={handleUnlock}
                disabled={unlock.isPending}
              >
                <Lock className="h-3 w-3 mr-1" />
                Unlock field
              </Button>
            </div>
          )}
        </SheetHeader>

        <div className="p-5 space-y-5">
          {/* Diff timeline */}
          {diffs.length > 0 && (
            <div className="rounded-lg border bg-card p-3">
              <div className="text-xs font-semibold text-muted-foreground mb-2">
                Value transitions ({diffs.length})
              </div>
              <div className="space-y-1.5">
                {diffs.slice(0, 6).map((d, idx) => (
                  <div key={idx} className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground line-through truncate max-w-[140px]">{String(d.from ?? "—")}</span>
                    <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="font-medium truncate max-w-[160px]">{String(d.to ?? "—")}</span>
                    <FieldSourceChip source={d.source} size="xs" />
                    <TooltipProvider delayDuration={150}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="ml-auto text-muted-foreground whitespace-nowrap">{fmtRel(d.at)}</span>
                        </TooltipTrigger>
                        <TooltipContent>{fmtAbs(d.at)}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Loading */}
          {isLoading && (
            <div className="space-y-2">
              {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/30 p-3 text-xs text-red-700 dark:text-red-300 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-px shrink-0" />
              <div>
                <div className="font-semibold">Failed to load history</div>
                <div>{error.message || String(error)}</div>
              </div>
            </div>
          )}

          {/* Empty */}
          {!isLoading && !error && rows.length === 0 && (
            <div className="text-sm text-muted-foreground py-8 text-center">
              No observations recorded yet.
            </div>
          )}

          {/* Ledger */}
          {!isLoading && rows.length > 0 && (
            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="text-left px-3 py-2">When</th>
                    <th className="text-left px-3 py-2">Source</th>
                    <th className="text-left px-3 py-2">Value</th>
                    <th className="text-left px-3 py-2">Confidence</th>
                    <th className="text-left px-3 py-2">Seen</th>
                    <th className="text-left px-3 py-2">Status</th>
                    {isAdminOrAbove && <th className="text-right px-3 py-2">Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map(row => {
                    const st = statusOf(row);
                    const stCfg = STATUS_STYLES[st] || STATUS_STYLES.active;
                    const StIcon = stCfg.icon;
                    const displayValue = row.value_display ?? row.value_normalized ?? "—";
                    return (
                      <tr key={row.id} className="hover:bg-muted/30">
                        <td className="px-3 py-2 whitespace-nowrap">
                          <TooltipProvider delayDuration={150}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span>{fmtRel(row.observed_at) || "—"}</span>
                              </TooltipTrigger>
                              <TooltipContent>{fmtAbs(row.observed_at)}</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </td>
                        <td className="px-3 py-2">
                          <FieldSourceChip source={row.source} size="xs" />
                        </td>
                        <td className="px-3 py-2 max-w-[220px]">
                          <span className={row.dismissed_at ? "line-through text-muted-foreground" : ""}>
                            {String(displayValue)}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <ConfidenceBar value={row.confidence} />
                        </td>
                        <td className="px-3 py-2 tabular-nums">{row.times_seen ?? 1}</td>
                        <td className="px-3 py-2">
                          <Badge variant={stCfg.variant} className="text-[10px] capitalize">
                            {StIcon && <StIcon className="h-3 w-3 mr-1" />}
                            {st}
                          </Badge>
                        </td>
                        {isAdminOrAbove && (
                          <td className="px-3 py-2 text-right whitespace-nowrap">
                            {!row.dismissed_at && row.status !== "promoted" && (
                              <Button
                                size="sm" variant="ghost"
                                className="h-6 px-2 text-[10px]"
                                onClick={() => handlePromote(row)}
                                disabled={promote.isPending}
                              >
                                <ArrowUpCircle className="h-3 w-3 mr-1" />
                                Promote
                              </Button>
                            )}
                            {!row.dismissed_at && rows.length > 1 && (
                              <Button
                                size="sm" variant="ghost"
                                className="h-6 px-2 text-[10px] text-red-600 dark:text-red-400"
                                onClick={() => handleDismiss(row)}
                                disabled={dismiss.isPending}
                              >
                                <XCircle className="h-3 w-3 mr-1" />
                                Dismiss
                              </Button>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
