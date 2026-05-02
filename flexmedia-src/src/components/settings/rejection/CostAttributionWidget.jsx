/**
 * CostAttributionWidget — W11.6 widget F.
 *
 * Renders cost-per-stage attribution from `engine_run_audit` over the last
 * 7 days (window fixed in the RPC per spec — short window catches vendor
 * drift, longer windows mask it).
 *
 * Why this widget exists:
 *   The Shape D engine has a target cost of ~$3.84 per 200-angle shoot
 *   (Stage 1 batch enrichment + Stage 4 master synthesis). When a prompt
 *   bloats or a vendor change inflates Stage 4 token usage, the average
 *   total drifts upward before any single round looks "wrong". This widget
 *   is the canary.
 *
 * RPC payload shape:
 *   {
 *     window_days: 7,
 *     sample_size,
 *     avg_stage1_cost_usd, avg_stage4_cost_usd, avg_total_cost_usd,
 *     sum_total_cost_usd,
 *     rounds_completed,
 *     failover_rate_pct
 *   }
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { DollarSign, TrendingUp, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Pure helper: format a USD amount. Sub-cent values get 4 decimals so
 * micro-costs like Pass 0 Haiku calls remain legible. Exported for tests.
 */
export function fmtUsdCost(n) {
  if (n == null || !Number.isFinite(Number(n))) return "$0.00";
  const v = Number(n);
  if (v < 0.01 && v > 0) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

/**
 * Pure helper: tone for the avg-total-cost headline. Above $5 is amber,
 * above $8 is red — these are heuristic targets per the W11.7 §"v1 cost"
 * design doc that puts the budget at $3.84 per 200-image shoot.
 */
export function totalCostTone(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n)) return "text-slate-500";
  if (n >= 8) return "text-red-600 dark:text-red-400";
  if (n >= 5) return "text-amber-600 dark:text-amber-400";
  return "text-emerald-600 dark:text-emerald-400";
}

export default function CostAttributionWidget({ data, loading }) {
  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <DollarSign className="h-4 w-4" />
            Cost-per-stage attribution
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  const c = data || {};
  const windowDays = Number(c?.window_days) || 7;
  const sampleSize = Number(c?.sample_size) || 0;
  const avgStage1 = Number(c?.avg_stage1_cost_usd) || 0;
  const avgStage4 = Number(c?.avg_stage4_cost_usd) || 0;
  const avgTotal = Number(c?.avg_total_cost_usd) || 0;
  const sumTotal = Number(c?.sum_total_cost_usd) || 0;
  const rounds = Number(c?.rounds_completed) || 0;
  const failoverPct = Number(c?.failover_rate_pct) || 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <DollarSign className="h-4 w-4" />
            Cost-per-stage attribution
          </span>
          <Badge variant="outline" className="text-[10px]">
            n={sampleSize} rounds · last {windowDays}d
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3">
        {sampleSize === 0 ? (
          <div className="text-xs text-muted-foreground py-3" data-testid="cost-empty">
            <AlertTriangle className="h-3.5 w-3.5 inline mr-1" />
            No engine_run_audit rows in the last 7 days. Either no rounds ran,
            or the audit table hasn't been populated.
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <div className="rounded border border-border/40 bg-muted/20 p-2.5">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                Avg Stage 1
              </p>
              <p className="text-lg font-bold tabular-nums leading-tight mt-0.5">
                {fmtUsdCost(avgStage1)}
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                batch enrichment
              </p>
            </div>
            <div className="rounded border border-border/40 bg-muted/20 p-2.5">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                Avg Stage 4
              </p>
              <p className="text-lg font-bold tabular-nums leading-tight mt-0.5">
                {fmtUsdCost(avgStage4)}
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                master synthesis
              </p>
            </div>
            <div className="rounded border border-border/40 bg-muted/20 p-2.5">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                Avg total / round
              </p>
              <p className={cn("text-lg font-bold tabular-nums leading-tight mt-0.5", totalCostTone(avgTotal))}>
                {fmtUsdCost(avgTotal)}
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                target ~$3.84
              </p>
            </div>
            <div className="rounded border border-border/40 bg-muted/20 p-2.5">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                7d total spend
              </p>
              <p className="text-lg font-bold tabular-nums leading-tight mt-0.5">
                {fmtUsdCost(sumTotal)}
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                rolling
              </p>
            </div>
            <div className="rounded border border-border/40 bg-muted/20 p-2.5">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                Rounds done
              </p>
              <p className="text-lg font-bold tabular-nums leading-tight mt-0.5">
                {rounds}
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                completed_at not null
              </p>
            </div>
            <div className="rounded border border-border/40 bg-muted/20 p-2.5">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                Failover rate
              </p>
              <p
                className={cn(
                  "text-lg font-bold tabular-nums leading-tight mt-0.5",
                  failoverPct >= 5 ? "text-red-600 dark:text-red-400" : ""
                )}
              >
                {failoverPct.toFixed(1)}%
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Anthropic A/B kicked
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
