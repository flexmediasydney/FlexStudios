/**
 * Stage4SelfCorrectionPanel — W11.6 widget B.
 *
 * Renders Stage 4 visual master synthesis events that visually corrected a
 * Stage 1 classification (different room_type / different composition_type
 * / different score) without operator intervention. Grouped by `field`
 * (the column on `shortlisting_stage4_overrides`) with sample rows.
 *
 * Why this widget exists:
 *   When Stage 4's cross-image visual reasoning overrides Stage 1's
 *   per-image classification, that's the engine learning at runtime —
 *   "Stage 1 said exterior_front but with all 200 images visible Stage 4
 *   sees the hills hoist + hot water unit and corrects to exterior_rear."
 *   High-confidence corrections that operators don't override become
 *   few-shot library candidates; low-confidence patterns are a tuning
 *   signal for the Stage 4 synthesis prompt.
 *
 * RPC payload shape:
 *   data.total — int, count of stage4_overrides rows in window
 *   data.by_field[] — array of { field, count, samples: [...] }
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Layers, ArrowRight } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

/**
 * Pure helper: format a stage1 → stage4 transition as a single string for
 * display. Exported so tests can assert the formatting without DOM mounts.
 */
export function formatStageTransition(stage1Value, stage4Value) {
  const s1 = stage1Value ?? "(null)";
  const s4 = stage4Value ?? "(null)";
  return `${s1} → ${s4}`;
}

export default function Stage4SelfCorrectionPanel({ data, loading, daysBack }) {
  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Layers className="h-4 w-4" />
            Stage 4 self-corrections
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  const total = Number(data?.total) || 0;
  const byField = Array.isArray(data?.by_field) ? data.by_field : [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Layers className="h-4 w-4" />
            Stage 4 self-corrections
          </span>
          <Badge variant="outline" className="text-[10px]">
            {total} events · last {daysBack || 30}d
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 space-y-3">
        {byField.length === 0 ? (
          <div className="text-xs text-muted-foreground py-3 px-2" data-testid="stage4-empty">
            No cross-stage corrections recorded in this window. Either no
            Shape D rounds completed, or Stage 4 fully agreed with Stage 1
            on every image.
          </div>
        ) : (
          byField.map((field) => {
            const samples = Array.isArray(field?.samples) ? field.samples : [];
            return (
              <div key={field?.field || "unknown"} className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-mono font-semibold">
                    {field?.field || "unknown"}
                  </span>
                  <Badge className="text-[10px] bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300">
                    {Number(field?.count) || 0}
                  </Badge>
                </div>
                <div className="space-y-1">
                  {samples.slice(0, 3).map((s, idx) => (
                    <div
                      key={`${field?.field}-${idx}`}
                      className="rounded border border-border/40 bg-muted/30 px-2 py-1.5 text-[11px]"
                      data-testid="stage4-sample"
                    >
                      <div className="flex items-center gap-1 font-mono">
                        <span className="text-muted-foreground truncate" title={s?.stage_1_value}>
                          {s?.stage_1_value ?? "(null)"}
                        </span>
                        <ArrowRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                        <span className="font-semibold truncate" title={s?.stage_4_value}>
                          {s?.stage_4_value ?? "(null)"}
                        </span>
                      </div>
                      {s?.reason ? (
                        <p
                          className="text-[10px] text-muted-foreground italic mt-0.5 line-clamp-2"
                          title={s.reason}
                        >
                          {s.reason}
                        </p>
                      ) : null}
                      {s?.created_at ? (
                        <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                          {(() => {
                            try {
                              return formatDistanceToNow(new Date(s.created_at), {
                                addSuffix: true,
                              });
                            } catch {
                              return s.created_at;
                            }
                          })()}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
