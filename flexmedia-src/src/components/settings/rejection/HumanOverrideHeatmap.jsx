/**
 * HumanOverrideHeatmap — W11.6 widget A.
 *
 * Renders the top 20 raw_label values from raw_attribute_observations where
 * source_type='human_override' over the selected time window. Each row =
 * one (label, count) pair from the RPC's human_override_heatmap.top_labels
 * array.
 *
 * Why this widget exists:
 *   W11.5 (mig 408/409) writes a row to raw_attribute_observations every
 *   time an operator corrects a Stage 1/Stage 4 classification or names a
 *   primary_signal_overridden on a swimlane decision. Frequency of
 *   `raw_label` values is the most direct signal of "what is the engine
 *   currently failing on?" — high counts on `room_type:exterior_rear`
 *   means operators are correcting that field repeatedly, which is the
 *   prompt-iteration trigger for the master_admin.
 *
 * Style mirrors the Pulse Missed-Opportunity Command Center heatmap:
 *   slate-tinted cards, tabular-nums for counts, monospace label, hot-row
 *   amber/red borders proportional to count.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Pure helper: compute the visual tone for a label row given its count and
 * the maximum count in the dataset. Top 25% of counts gets red, top 50%
 * amber, rest slate. Exported so tests can assert the thresholds without
 * mounting the component.
 */
export function heatmapRowTone(count, maxCount) {
  if (!Number.isFinite(count) || !Number.isFinite(maxCount) || maxCount <= 0) {
    return "border-slate-200 bg-slate-50 dark:bg-slate-900/40 dark:border-slate-800";
  }
  const ratio = count / maxCount;
  if (ratio >= 0.75) {
    return "border-red-300 bg-red-50 dark:bg-red-950/40 dark:border-red-800";
  }
  if (ratio >= 0.4) {
    return "border-amber-300 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-800";
  }
  return "border-slate-200 bg-slate-50 dark:bg-slate-900/40 dark:border-slate-800";
}

/**
 * Pure helper: shorten a raw_label for display (the underlying labels can
 * be 80+ chars when they include a reason excerpt). Returns at most
 * `max_chars` chars with a unicode ellipsis appended.
 */
export function truncateLabel(label, maxChars = 60) {
  if (!label || typeof label !== "string") return "—";
  if (label.length <= maxChars) return label;
  return label.slice(0, maxChars - 1) + "…";
}

export default function HumanOverrideHeatmap({ data, loading, daysBack }) {
  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Human override heatmap
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  const total = Number(data?.total) || 0;
  const labels = Array.isArray(data?.top_labels) ? data.top_labels : [];
  const maxCount = labels.reduce((m, r) => Math.max(m, Number(r?.count) || 0), 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Human override heatmap
          </span>
          <Badge variant="outline" className="text-[10px]">
            {total} overrides · last {daysBack || 30}d
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 space-y-1">
        {labels.length === 0 ? (
          <div
            className="flex items-center gap-2 text-xs text-muted-foreground py-3 px-2"
            data-testid="heatmap-empty"
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            No human overrides captured in this window. Either W11.5 capture
            triggers haven't fired yet, or operators have agreed with every
            engine decision.
          </div>
        ) : (
          labels.map((row) => {
            const count = Number(row?.count) || 0;
            const label = truncateLabel(String(row?.raw_label || ""));
            return (
              <div
                key={`${row?.raw_label}-${count}`}
                className={cn(
                  "flex items-center justify-between gap-2 px-2 py-1.5 rounded border text-xs",
                  heatmapRowTone(count, maxCount)
                )}
                title={String(row?.raw_label || "")}
              >
                <span className="font-mono truncate" data-testid="heatmap-label">
                  {label}
                </span>
                <span className="tabular-nums font-semibold flex-shrink-0">
                  {count}
                </span>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
