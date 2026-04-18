/**
 * EntitySyncHistoryDialog — Tier 4 payload-visibility UI.
 *
 * Renders a list of sync events from `pulse_entity_sync_history` for a given
 * pulse entity (agent / agency / listing). Each row links through to the
 * DrillDialog for that specific sync run (via /IndustryPulse?tab=sources&sync_log_id=...).
 *
 * Backed by migration 100 (pulse_entity_sync_history). Query filters by
 * entity_type + entity_id, ordered by seen_at DESC, limit 50.
 */
import React, { useEffect, useState, useMemo } from "react";
import { api } from "@/api/supabaseClient";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  History,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  AlertCircle,
} from "lucide-react";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTs(d) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function fmtRelativeTs(d) {
  if (!d) return "—";
  try {
    const diff = Date.now() - new Date(d).getTime();
    if (diff < 0) return fmtTs(d);
    const mins = Math.round(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    if (days < 14) return `${days}d ago`;
    return fmtTs(d);
  } catch {
    return "—";
  }
}

// Action → badge styling (matches the audit vocab in migration 100).
const ACTION_STYLE = {
  created: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  updated: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  cross_enriched: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400",
  reconciled: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  flagged: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

function ActionBadge({ action }) {
  const cls = ACTION_STYLE[action] || "bg-muted text-muted-foreground";
  return (
    <Badge className={cn("text-[10px] px-1.5 py-0 capitalize", cls)}>
      {(action || "—").replace(/_/g, " ")}
    </Badge>
  );
}

// ── Row ───────────────────────────────────────────────────────────────────────

function HistoryRow({ row }) {
  const [expanded, setExpanded] = useState(false);
  const hasChanges =
    row.changes_summary &&
    typeof row.changes_summary === "object" &&
    Object.keys(row.changes_summary).length > 0;

  return (
    <div className="border-b last:border-0 px-3 py-2 hover:bg-muted/30 transition-colors">
      <div className="flex items-center gap-2 text-xs">
        {/* Timestamp */}
        <div className="shrink-0 min-w-[90px]">
          <p className="font-medium tabular-nums" title={fmtTs(row.seen_at)}>
            {fmtRelativeTs(row.seen_at)}
          </p>
          <p className="text-[9px] text-muted-foreground/70 tabular-nums">
            {fmtTs(row.seen_at)}
          </p>
        </div>

        {/* Action badge */}
        <div className="shrink-0">
          <ActionBadge action={row.action} />
        </div>

        {/* Source label */}
        <div className="flex-1 min-w-0">
          {row.source ? (
            <span className="text-[11px] font-mono text-foreground/80 truncate block">
              {row.source}
            </span>
          ) : (
            <span className="text-[11px] text-muted-foreground italic">no source</span>
          )}
        </div>

        {/* Drill-through link (opens DrillDialog via URL pattern) */}
        {row.sync_log_id && (
          <a
            href={`/IndustryPulse?tab=sources&sync_log_id=${row.sync_log_id}`}
            className="shrink-0 inline-flex items-center gap-0.5 text-[10px] text-primary hover:underline"
            title="Open source payload"
            onClick={(e) => e.stopPropagation()}
          >
            payload
            <ExternalLink className="h-2.5 w-2.5" />
          </a>
        )}

        {/* Expand toggle (only when changes_summary has content) */}
        {hasChanges && (
          <button
            onClick={() => setExpanded((s) => !s)}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            title={expanded ? "Collapse" : "Expand changes"}
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>

      {/* Collapsible changes_summary JSON */}
      {hasChanges && expanded && (
        <pre className="mt-2 text-[10px] bg-muted/40 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
          {JSON.stringify(row.changes_summary, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ── Main Dialog ───────────────────────────────────────────────────────────────

export default function EntitySyncHistoryDialog({
  entityType,
  entityId,
  entityLabel,
  onClose,
}) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!entityType || !entityId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api._supabase
      .from("pulse_entity_sync_history")
      .select("*")
      .eq("entity_type", entityType)
      .eq("entity_id", entityId)
      .order("seen_at", { ascending: false })
      .limit(50)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setError(error.message || "Failed to load history");
        } else {
          setRows(data || []);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entityType, entityId]);

  const header = useMemo(() => entityLabel || `${entityType} ${entityId}`, [entityType, entityId, entityLabel]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose?.()}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            Sync history — <span className="font-normal text-muted-foreground truncate">{header}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto -mx-6 px-0 border-t mt-2">
          {loading && (
            <div className="flex items-center justify-center py-12 text-muted-foreground text-xs gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading history…
            </div>
          )}

          {!loading && error && (
            <div className="flex flex-col items-center justify-center py-12 px-6 text-red-600 text-xs gap-2 text-center">
              <AlertCircle className="h-5 w-5" />
              <p>Could not load sync history.</p>
              <p className="text-[10px] text-muted-foreground font-mono">{error}</p>
            </div>
          )}

          {!loading && !error && rows.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground text-xs gap-2 text-center px-6">
              <History className="h-6 w-6 opacity-40" />
              <p>No sync history recorded for this {entityType} yet.</p>
              <p className="text-[10px] opacity-70">
                Events will appear after the next sync run that touches this record.
              </p>
            </div>
          )}

          {!loading && !error && rows.length > 0 && (
            <>
              <div className="px-3 py-1.5 bg-muted/40 text-[10px] text-muted-foreground">
                Showing {rows.length} most recent event{rows.length === 1 ? "" : "s"}
                {rows.length === 50 && " (capped at 50)"}
              </div>
              {rows.map((row) => (
                <HistoryRow key={row.id} row={row} />
              ))}
            </>
          )}
        </div>

        <div className="flex justify-end pt-2 border-t">
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
