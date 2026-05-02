/**
 * MasterListingMetrics — W11.6 widget D.
 *
 * Renders avg + p50 + p95 word_count and avg + p50 reading_grade_level
 * across master_listings in the selected time window. Single grid of
 * stat tiles.
 *
 * Why this widget exists:
 *   Tier-S Premium copy that's averaging 250 words and grade level 14
 *   when the rubric expects 120 words and grade level 10 is the kind of
 *   drift only visible in aggregate. Per-listing this looks fine; in
 *   aggregate it tells the master_admin that the synthesis prompt has
 *   started over-explaining. This is the watchdog metric.
 *
 * RPC payload shape:
 *   {
 *     avg_word_count, p50_word_count, p95_word_count,
 *     avg_reading_grade_level, p50_reading_grade,
 *     sample_size
 *   }
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Type, BarChart3 } from "lucide-react";

/**
 * Pure helper: format a numeric metric for display. NaN/null becomes em-dash.
 * One decimal for non-integer metrics; zero decimals for word counts.
 */
export function formatMetric(value, opts = {}) {
  // Reject null/undefined/empty-string up-front because Number() coerces
  // them to 0/NaN unhelpfully — we want a real em-dash placeholder for
  // genuinely-missing metrics, not silent zeroes.
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const decimals = opts.decimals != null ? opts.decimals : (Number.isInteger(n) ? 0 : 1);
  return n.toFixed(decimals);
}

function StatTile({ label, value, hint, tone }) {
  return (
    <div className="rounded border border-border/40 bg-muted/20 p-2.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
        {label}
      </p>
      <p className={`text-lg font-bold tabular-nums leading-tight mt-0.5 ${tone || ""}`}>
        {value}
      </p>
      {hint ? <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p> : null}
    </div>
  );
}

export default function MasterListingMetrics({ data, loading, daysBack }) {
  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Type className="h-4 w-4" />
            Master listing copy metrics
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

  const m = data || {};
  const sampleSize = Number(m?.sample_size) || 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Type className="h-4 w-4" />
            Master listing copy metrics
          </span>
          <Badge variant="outline" className="text-[10px]">
            n={sampleSize} · last {daysBack || 30}d
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3">
        {sampleSize === 0 ? (
          <div className="text-xs text-muted-foreground py-3" data-testid="copy-empty">
            <BarChart3 className="h-3.5 w-3.5 inline mr-1" />
            No master_listings with computed metrics in this window.
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <StatTile
              label="Avg word count"
              value={formatMetric(m.avg_word_count, { decimals: 0 })}
              hint="all listings"
            />
            <StatTile
              label="p50 word count"
              value={formatMetric(m.p50_word_count, { decimals: 0 })}
              hint="median"
            />
            <StatTile
              label="p95 word count"
              value={formatMetric(m.p95_word_count, { decimals: 0 })}
              hint="long-tail outlier"
              tone={Number(m.p95_word_count) > 220 ? "text-amber-600" : ""}
            />
            <StatTile
              label="Avg grade level"
              value={formatMetric(m.avg_reading_grade_level, { decimals: 1 })}
              hint="reading-grade target ~10"
            />
            <StatTile
              label="p50 grade level"
              value={formatMetric(m.p50_reading_grade, { decimals: 1 })}
              hint="median"
            />
            <StatTile
              label="Sample size"
              value={formatMetric(sampleSize, { decimals: 0 })}
              hint="listings analysed"
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
