/**
 * KpiStrip — Shortlisting Command Center Overview KPI tiles.
 *
 * Wave 11.6.21. Renders the seven engine-wide KPIs returned by RPC
 * shortlisting_command_center_kpis(p_days). Loading state shows skeletons;
 * empty data renders zeroes/dashes (defensive for fresh-deploy environments
 * where some underlying tables may not yet have rows).
 *
 * Style mirrors PulseMissedOpportunityCommandCenter / KpiCard from W15b.9.
 */
import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  DollarSign,
  Activity,
  Eye,
  TrendingDown,
  Gauge,
  ListChecks,
  Database,
} from "lucide-react";

// ── Pure formatters (exported for tests) ───────────────────────────────────
export function fmtUsd(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "$0.00";
  const v = Number(n);
  if (v < 0.01 && v > 0) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

export function fmtPct(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  return `${Number(n).toFixed(1)}%`;
}

export function fmtCount(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "0";
  return new Intl.NumberFormat("en-US").format(Math.trunc(Number(n)));
}

/**
 * Summarise calibration_session_by_status JSON into a compact subline.
 * Pure helper so it's testable independently of the component.
 */
export function summariseCalibrationStatuses(byStatus) {
  if (!byStatus || typeof byStatus !== "object") return "";
  const entries = Object.entries(byStatus).filter(([, n]) => Number(n) > 0);
  if (entries.length === 0) return "";
  return entries
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 3)
    .map(([status, n]) => `${n} ${status}`)
    .join(" · ");
}

// ── KPI tile ────────────────────────────────────────────────────────────────
function KpiCard({ icon: Icon, label, value, sub, tone, hint, testId }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-start gap-2">
          <div className={cn(
            "h-8 w-8 rounded-md flex items-center justify-center flex-shrink-0",
            tone || "bg-muted"
          )}>
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground truncate">
              {label}
            </p>
            <p
              className="text-lg font-semibold tabular-nums leading-tight mt-0.5"
              data-testid={testId ? `${testId}-value` : undefined}
            >
              {value}
            </p>
            {sub && (
              <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{sub}</p>
            )}
            {hint && (
              <p className="text-[10px] text-muted-foreground mt-0.5 italic truncate">
                {hint}
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── KPI strip ───────────────────────────────────────────────────────────────
export default function KpiStrip({ data, loading }) {
  if (loading) {
    return (
      <div
        className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2"
        data-testid="kpi-strip-loading"
      >
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <Card key={i} className="animate-pulse">
            <CardContent className="p-3 h-[80px]" />
          </Card>
        ))}
      </div>
    );
  }

  const k = data || {};
  const overrideRate = Number(k.override_rate_7d_pct);
  const overrideTone = !Number.isFinite(overrideRate)
    ? "bg-slate-100 text-slate-700"
    : overrideRate > 30
    ? "bg-red-100 text-red-700"
    : overrideRate > 15
    ? "bg-amber-100 text-amber-700"
    : "bg-emerald-100 text-emerald-700";
  const v2Pct = Number(k.v2_vision_rollout_pct);

  return (
    <div
      className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2"
      data-testid="kpi-strip"
    >
      <KpiCard
        icon={DollarSign}
        label="Today's spend"
        value={fmtUsd(k.todays_spend_usd)}
        sub="engine_run_audit"
        tone="bg-emerald-100 text-emerald-700"
        testId="kpi-todays-spend"
      />
      <KpiCard
        icon={Activity}
        label="Rounds today"
        value={fmtCount(k.rounds_today)}
        sub="shortlisting_rounds"
        tone="bg-blue-100 text-blue-700"
        testId="kpi-rounds-today"
      />
      <KpiCard
        icon={Gauge}
        label="Avg round cost (7d)"
        value={k.avg_round_cost_usd_7d != null ? fmtUsd(k.avg_round_cost_usd_7d) : "—"}
        sub={`${k.window_days || 7}d window`}
        tone="bg-slate-100 text-slate-700"
        testId="kpi-avg-round-cost"
      />
      <KpiCard
        icon={Eye}
        label="V2 vision rollout"
        value={Number.isFinite(v2Pct) ? fmtPct(v2Pct) : "—"}
        sub={`${fmtCount(k.v2_vision_match)} / ${fmtCount(k.v2_vision_total)} listings`}
        hint="cross-track signal"
        tone="bg-purple-100 text-purple-700"
        testId="kpi-v2-rollout"
      />
      <KpiCard
        icon={TrendingDown}
        label="Override rate (7d)"
        value={Number.isFinite(overrideRate) ? fmtPct(overrideRate) : "—"}
        sub={`${fmtCount(k.override_count_7d)} of ${fmtCount(k.slot_decision_count_7d)} decisions`}
        tone={overrideTone}
        testId="kpi-override-rate"
      />
      <KpiCard
        icon={ListChecks}
        label="Calibration sessions"
        value={fmtCount(k.calibration_session_total)}
        sub={summariseCalibrationStatuses(k.calibration_session_by_status) || "no sessions yet"}
        tone="bg-indigo-100 text-indigo-700"
        testId="kpi-calibration-sessions"
      />
      <KpiCard
        icon={Database}
        label="Object registry"
        value={fmtCount(k.object_registry_size)}
        sub={`${fmtCount(k.object_queue_pending)} pending in queue`}
        tone="bg-cyan-100 text-cyan-700"
        testId="kpi-object-registry"
      />
    </div>
  );
}
