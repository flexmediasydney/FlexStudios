/**
 * DataFreshnessCard — single-glance enrichment coverage / throughput / ETA.
 *
 * Answers three questions a strategic user asks before trusting any number:
 *   1. How much of my market data is complete? (coverage %)
 *   2. How fast is the backlog shrinking? (throughput, 1h / 24h)
 *   3. When will the current backlog clear? (ETA)
 *
 * Backed by pulse_get_enrichment_health RPC (migration 169).
 */
import React from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Clock, Activity, Zap, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

function fmtInt(n) { return n == null ? "—" : Number(n).toLocaleString(); }
function fmtPct(n) { return n == null ? "—" : `${Number(n).toFixed(1)}%`; }
function fmtDuration(hours) {
  if (hours == null || !isFinite(hours)) return "—";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export default function DataFreshnessCard({ compact = false, className }) {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["pulse_enrichment_health"],
    queryFn: async () => {
      const { data, error } = await api._supabase.rpc("pulse_get_enrichment_health");
      if (error) throw error;
      return data;
    },
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  const h = data || {};
  const coveragePct = h.for_sale_total > 0
    ? (100 * (h.for_sale_enriched || 0) / h.for_sale_total)
    : 0;
  const throughputHour = h.enriched_last_1h || 0;
  const backlog = h.for_sale_pending || 0;
  const etaHours = throughputHour > 0 ? backlog / throughputHour : null;

  if (compact) {
    return (
      <div className={cn("flex items-center gap-2 text-[11px]", className)}>
        <Activity className="h-3 w-3 text-muted-foreground" />
        <span className="tabular-nums">{fmtPct(coveragePct)}</span>
        <span className="text-muted-foreground">enriched</span>
        <span className="text-muted-foreground">·</span>
        <span className="tabular-nums">{fmtInt(backlog)}</span>
        <span className="text-muted-foreground">pending</span>
        <span className="text-muted-foreground">·</span>
        <span className="tabular-nums">{fmtDuration(etaHours)}</span>
        <span className="text-muted-foreground">ETA</span>
      </div>
    );
  }

  return (
    <Card className={cn("p-3", className)}>
      <div className="flex items-center gap-2 mb-2">
        <Activity className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">Data freshness</h3>
        <Badge variant="secondary" className="ml-auto text-[10px]">live</Badge>
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => refetch()} title="Refresh">
          <RefreshCw className={cn("h-3 w-3", isLoading && "animate-spin")} />
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
        <FreshStat icon={CheckCircle2} color="text-emerald-600" bg="bg-emerald-50"
          label="Enriched" value={fmtInt(h.for_sale_enriched)} sub={`of ${fmtInt(h.for_sale_total)} for_sale`} />
        <FreshStat icon={Clock} color="text-amber-600" bg="bg-amber-50"
          label="Pending" value={fmtInt(backlog)} sub={`${fmtPct(coveragePct)} complete`} />
        <FreshStat icon={Zap} color="text-blue-600" bg="bg-blue-50"
          label="Throughput / hr" value={fmtInt(throughputHour)} sub={`${fmtInt(h.enriched_last_24h)} /24h`} />
        <FreshStat icon={Activity} color="text-slate-600" bg="bg-slate-100"
          label="Backlog ETA" value={fmtDuration(etaHours)} sub="at current rate" />
      </div>

      {/* Coverage bar */}
      <div className="space-y-1">
        <div className="flex items-center text-[10px] text-muted-foreground">
          <span>0%</span>
          <span className="flex-1 text-center font-medium text-foreground">{fmtPct(coveragePct)} enriched</span>
          <span>100%</span>
        </div>
        <div className="h-2 bg-muted rounded overflow-hidden">
          <div className="h-full bg-emerald-400 transition-all duration-500" style={{ width: `${coveragePct}%` }} />
        </div>
      </div>

      <div className="mt-2 pt-2 border-t text-[10px] text-muted-foreground flex items-center gap-1.5 flex-wrap">
        <span>pulseDetailEnrich cron runs every 5min @ 12/batch</span>
        <span>·</span>
        <span>{fmtInt(h.enriched_last_5min)} in the last tick</span>
        {h.stale_enriched_gt_14d > 0 && (
          <>
            <span>·</span>
            <span className="text-amber-700">{fmtInt(h.stale_enriched_gt_14d)} stale (>14d)</span>
          </>
        )}
      </div>
    </Card>
  );
}

function FreshStat({ icon: Icon, color, bg, label, value, sub }) {
  return (
    <div className="flex items-start gap-2">
      <div className={cn("w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0", bg)}>
        <Icon className={cn("h-3.5 w-3.5", color)} />
      </div>
      <div className="min-w-0">
        <div className="text-[10px] text-muted-foreground truncate">{label}</div>
        <div className="text-base font-semibold tabular-nums leading-tight">{value}</div>
        {sub && <div className="text-[10px] text-muted-foreground truncate">{sub}</div>}
      </div>
    </div>
  );
}
