import React, { useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle2, Circle, MessageSquareWarning } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEntityList } from "@/components/hooks/useEntityData";

export default function RequestsProgressBar({ projectId }) {
  const { data: revisions = [] } = useEntityList(
    "ProjectRevision", "-created_date", 200,
    r => r.project_id === projectId
  );

  const { total, resolved, percentage } = useMemo(() => {
    // Exclude cancelled from the count entirely
    const active = revisions.filter(r => r.status !== 'cancelled');
    const done = active.filter(r => r.status === 'completed' || r.status === 'delivered');
    const pct = active.length > 0
      ? Math.round((done.length / active.length) * 100)
      : 0;
    return { total: active.length, resolved: done.length, percentage: pct };
  }, [revisions]);

  if (total === 0) return null;

  const getColor = () => {
    if (percentage === 100) return "bg-green-500";
    if (percentage >= 75) return "bg-emerald-500";
    if (percentage >= 50) return "bg-blue-500";
    if (percentage >= 25) return "bg-amber-500";
    return "bg-orange-500";
  };

  const getTextColor = () => {
    if (percentage === 100) return "text-green-600 dark:text-green-400";
    if (percentage >= 75) return "text-emerald-600 dark:text-emerald-400";
    if (percentage >= 50) return "text-blue-600 dark:text-blue-400";
    if (percentage >= 25) return "text-amber-600 dark:text-amber-400";
    return "text-orange-600 dark:text-orange-400";
  };

  const stuckCount = revisions.filter(r => r.status === 'stuck').length;

  return (
    <Card className="border-0 shadow-sm bg-gradient-to-r from-background to-muted/30">
      <CardContent className="py-3 px-4">
        <div className="flex items-center gap-3">
          <div className={cn(
            "flex items-center justify-center w-10 h-10 rounded-full flex-shrink-0",
            percentage === 100 ? "bg-green-100 dark:bg-green-900/40" : "bg-muted"
          )}>
            {percentage === 100 ? (
              <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
            ) : (
              <MessageSquareWarning className="h-5 w-5 text-muted-foreground" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-sm font-semibold">
                Requests Progress
              </p>
              <span className={cn("text-sm font-bold tabular-nums", getTextColor())}>
                {percentage}%
              </span>
            </div>
            <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-700 ease-out",
                  getColor()
                )}
                style={{ width: `${percentage}%` }}
              />
            </div>
            <div className="flex items-center gap-3 mt-1.5">
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <CheckCircle2 className="h-3 w-3 text-green-500" aria-hidden="true" />
                <span className="tabular-nums">{resolved}</span> resolved
              </span>
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Circle className="h-3 w-3" aria-hidden="true" />
                <span className="tabular-nums">{total - resolved}</span> open
              </span>
              {stuckCount > 0 && (
                <span className="flex items-center gap-1 text-xs text-orange-600 dark:text-orange-400">
                  <MessageSquareWarning className="h-3 w-3" aria-hidden="true" />
                  <span className="tabular-nums">{stuckCount}</span> stuck
                </span>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
