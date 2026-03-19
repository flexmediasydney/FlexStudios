import React, { useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { CheckCircle2, Circle, ListTodo } from "lucide-react";
import { cn } from "@/lib/utils";

export default function ProjectProgressBar({ tasks = [] }) {
  const { total, completed, percentage } = useMemo(() => {
    const activeTasks = tasks.filter(t => !t.is_deleted && !t.is_archived);
    const done = activeTasks.filter(t => t.is_completed);
    const pct = activeTasks.length > 0
      ? Math.round((done.length / activeTasks.length) * 100)
      : 0;
    return { total: activeTasks.length, completed: done.length, percentage: pct };
  }, [tasks]);

  if (total === 0) return null;

  const getColor = () => {
    if (percentage === 100) return "bg-green-500";
    if (percentage >= 75) return "bg-emerald-500";
    if (percentage >= 50) return "bg-blue-500";
    if (percentage >= 25) return "bg-amber-500";
    return "bg-orange-500";
  };

  const getTextColor = () => {
    if (percentage === 100) return "text-green-600";
    if (percentage >= 75) return "text-emerald-600";
    if (percentage >= 50) return "text-blue-600";
    if (percentage >= 25) return "text-amber-600";
    return "text-orange-600";
  };

  return (
    <Card className="border-0 shadow-sm bg-gradient-to-r from-background to-muted/30">
      <CardContent className="py-3 px-4">
        <div className="flex items-center gap-3">
          <div className={cn(
            "flex items-center justify-center w-10 h-10 rounded-full flex-shrink-0",
            percentage === 100 ? "bg-green-100" : "bg-muted"
          )}>
            {percentage === 100 ? (
              <CheckCircle2 className="h-5 w-5 text-green-600" />
            ) : (
              <ListTodo className="h-5 w-5 text-muted-foreground" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-sm font-semibold">
                Task Progress
              </p>
              <span className={cn("text-sm font-bold tabular-nums", getTextColor())}>
                {percentage}%
              </span>
            </div>
            <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-500 ease-out",
                  getColor()
                )}
                style={{ width: `${percentage}%` }}
              />
            </div>
            <div className="flex items-center gap-3 mt-1.5">
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <CheckCircle2 className="h-3 w-3 text-green-500" />
                {completed} done
              </span>
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Circle className="h-3 w-3" />
                {total - completed} remaining
              </span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
