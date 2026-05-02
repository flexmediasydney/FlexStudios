/**
 * RegistryCoverageWidget — W11.6 widget E.
 *
 * Renders the % of `composition_classifications.observed_objects[]` entries
 * over the selected window where `proposed_canonical_id` is non-null.
 * Higher = canonical registry coverage is good. Lower = lots of free-form
 * labels that haven't been promoted to canonicals yet.
 *
 * Why this widget exists:
 *   W12 object registry maps free-form vision labels (e.g. "designer
 *   Caesarstone island bench") to canonical IDs (`bench:island_caesarstone`).
 *   When coverage drops, either Stage 1/Stage 4 are naming a new
 *   architectural pattern for the first time, or there's a registry
 *   regression. Either way it's a signal worth seeing on the dashboard
 *   instead of buried in audit queries.
 *
 * RPC payload shape:
 *   {
 *     total_objects, resolved_count, resolved_pct,
 *     top_unresolved: [{ raw_label, count }, ...]
 *   }
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Database, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Pure helper: tone for the resolved_pct headline value. ≥80% green,
 * 50-80% amber, <50% red. Exported for tests.
 */
export function coverageTone(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return "text-slate-500";
  if (n >= 80) return "text-emerald-600 dark:text-emerald-400";
  if (n >= 50) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

export default function RegistryCoverageWidget({ data, loading, daysBack }) {
  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Database className="h-4 w-4" />
            Canonical registry coverage
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-24 w-full mt-2" />
        </CardContent>
      </Card>
    );
  }

  const total = Number(data?.total_objects) || 0;
  const resolved = Number(data?.resolved_count) || 0;
  const pct = Number(data?.resolved_pct) || 0;
  const unresolved = Array.isArray(data?.top_unresolved) ? data.top_unresolved : [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Database className="h-4 w-4" />
            Canonical registry coverage
          </span>
          <Badge variant="outline" className="text-[10px]">
            {total.toLocaleString()} objects · last {daysBack || 30}d
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 space-y-3">
        {total === 0 ? (
          <div className="text-xs text-muted-foreground py-3" data-testid="coverage-empty">
            <AlertCircle className="h-3.5 w-3.5 inline mr-1" />
            No observed_objects rows in this window.
          </div>
        ) : (
          <>
            <div className="text-center">
              <p className={cn("text-3xl font-bold tabular-nums", coverageTone(pct))}>
                {pct.toFixed(1)}%
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {resolved.toLocaleString()} of {total.toLocaleString()} resolved
              </p>
              <div className="h-1.5 w-full rounded-full bg-muted mt-2 overflow-hidden">
                <div
                  className={cn(
                    "h-full transition-all",
                    pct >= 80
                      ? "bg-emerald-500"
                      : pct >= 50
                        ? "bg-amber-500"
                        : "bg-red-500"
                  )}
                  style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                  data-testid="coverage-bar"
                />
              </div>
            </div>
            {unresolved.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground mb-1">
                  Top unresolved free-form labels
                </p>
                <div className="space-y-0.5">
                  {unresolved.slice(0, 6).map((row, idx) => (
                    <div
                      key={`${row?.raw_label || idx}-${idx}`}
                      className="flex items-center justify-between gap-2 text-[11px] px-1.5 py-1 rounded bg-muted/30"
                      data-testid="coverage-unresolved"
                    >
                      <span className="font-mono truncate" title={row?.raw_label}>
                        {row?.raw_label || "(empty)"}
                      </span>
                      <span className="tabular-nums text-muted-foreground flex-shrink-0">
                        {Number(row?.count) || 0}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
