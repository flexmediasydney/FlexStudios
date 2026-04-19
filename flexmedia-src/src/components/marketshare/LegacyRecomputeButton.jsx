/**
 * LegacyRecomputeButton - admin-only button that POSTs to the
 * pulseRecomputeLegacy edge function to propagate freshly-imported
 * legacy_projects into pulse_listing_missed_opportunity.
 *
 * Usage (from the Settings/LegacyImport post-import flow — agent 4):
 *
 *   import LegacyRecomputeButton from "@/components/marketshare/LegacyRecomputeButton";
 *   …
 *   <LegacyRecomputeButton defaultMode="all_overlap" />
 *
 * The button is intentionally NOT auto-triggered — this is a heavy operation
 * (one DB RPC call per stale listing, batches of 500, 4-minute wall-clock budget).
 * The nightly cron pulse-legacy-recompute (migration 188) handles drift.
 */
import React, { useState } from "react";
import { api } from "@/api/supabaseClient";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { RefreshCw, CheckCircle2, AlertTriangle, Archive } from "lucide-react";
import { cn } from "@/lib/utils";

export default function LegacyRecomputeButton({
  defaultMode = "stale_only",  // 'stale_only' | 'all_overlap'
  className,
  compact = false,
}) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState(defaultMode);

  const run = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.functions.invoke("pulseRecomputeLegacy", {
        mode,
        max_rows: 50000,
      });
      // Supabase JS client wraps the body under `data` — check both shapes.
      const payload = res?.data ?? res;
      if (payload?.error) throw new Error(payload.error);
      setResult(payload);
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className={cn("p-3 space-y-2", className)}>
      <div className="flex items-center gap-2">
        <Archive className="h-4 w-4 text-slate-600" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold">Recompute Market Share substrate</div>
          {!compact && (
            <div className="text-[11px] text-muted-foreground">
              Propagates newly imported legacy projects to <code>pulse_listing_missed_opportunity</code>.
              Heavy operation — run once after a large import; the nightly cron handles ongoing drift.
            </div>
          )}
        </div>
      </div>

      {!compact && (
        <div className="flex items-center gap-1 rounded-md border bg-card p-0.5 w-fit" title="Scope">
          {[
            { v: "stale_only", l: "Stale only" },
            { v: "all_overlap", l: "All overlapping" },
          ].map(o => (
            <button
              key={o.v}
              onClick={() => setMode(o.v)}
              className={cn(
                "text-[11px] px-2 py-0.5 rounded transition-colors",
                mode === o.v ? "bg-primary text-primary-foreground font-medium" : "text-muted-foreground hover:bg-muted"
              )}
            >{o.l}</button>
          ))}
        </div>
      )}

      <Button onClick={run} disabled={loading} size="sm" className="gap-1">
        <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        {loading ? "Recomputing…" : "Recompute now"}
      </Button>

      {result && (
        <div className="text-xs flex items-start gap-1.5 p-2 rounded bg-emerald-50 border border-emerald-200">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 mt-0.5 flex-shrink-0" />
          <div className="space-y-0.5">
            <div className="font-medium text-emerald-800">
              Recomputed {Number(result.recomputed || 0).toLocaleString()} of {Number(result.stale_rows || 0).toLocaleString()} listings.
            </div>
            <div className="text-emerald-700/80">
              Duration {Math.round(Number(result.duration_ms || 0) / 1000)}s ·
              Errors {Number(result.errors || 0)}
              {result.had_more && " · More stale rows remain — run again or let nightly cron finish"}
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="text-xs flex items-start gap-1.5 p-2 rounded bg-red-50 border border-red-200">
          <AlertTriangle className="h-3.5 w-3.5 text-red-600 mt-0.5 flex-shrink-0" />
          <div className="font-medium text-red-800">Recompute failed: {error}</div>
        </div>
      )}
    </Card>
  );
}
