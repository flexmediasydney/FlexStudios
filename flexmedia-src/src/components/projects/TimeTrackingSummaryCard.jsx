import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Clock, TrendingUp, TrendingDown, Minus, Timer } from "lucide-react";
import { cn } from "@/lib/utils";
import { useProjectEffortSummary } from "./ProjectEffortSummaryV2";

function formatHours(seconds) {
  if (!seconds || seconds <= 0) return "0h 0m";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function TimeTrackingSummaryCard({ projectId, project }) {
  const effort = useProjectEffortSummary(projectId, project);

  const totalLogged = effort.totalActual;
  const totalEstimated = effort.totalEstimated;
  const variance = totalEstimated > 0 ? totalLogged - totalEstimated : 0;
  const utilPct = effort.totalUtilization;

  const getUtilColor = () => {
    if (utilPct === 0) return "text-muted-foreground";
    if (utilPct <= 80) return "text-green-600";
    if (utilPct <= 100) return "text-amber-600";
    return "text-red-600";
  };

  const getUtilBg = () => {
    if (utilPct === 0) return "bg-muted";
    if (utilPct <= 80) return "bg-green-100";
    if (utilPct <= 100) return "bg-amber-100";
    return "bg-red-100";
  };

  const getVarianceIcon = () => {
    if (variance === 0 || totalEstimated === 0) return <Minus className="h-3.5 w-3.5" />;
    if (variance > 0) return <TrendingUp className="h-3.5 w-3.5" />;
    return <TrendingDown className="h-3.5 w-3.5" />;
  };

  return (
    <Card>
      <CardContent className="py-4 px-4">
        <div className="flex items-center gap-2 mb-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-blue-100">
            <Clock className="h-4 w-4 text-blue-600" />
          </div>
          <div>
            <p className="text-sm font-semibold">Time Tracking</p>
          </div>
          {effort.hasRunning && (
            <span className="ml-auto flex items-center gap-1 text-xs text-green-600 font-medium">
              <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
              Live
            </span>
          )}
        </div>

        <div className="grid grid-cols-3 gap-3">
          {/* Logged */}
          <div className="text-center p-2 rounded-lg bg-muted/50">
            <div className="flex items-center justify-center gap-1 mb-1">
              <Timer className="h-3 w-3 text-muted-foreground" />
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Logged</p>
            </div>
            <p className="text-base font-bold tabular-nums">{formatHours(totalLogged)}</p>
          </div>

          {/* Estimated */}
          <div className="text-center p-2 rounded-lg bg-muted/50">
            <div className="flex items-center justify-center gap-1 mb-1">
              <Clock className="h-3 w-3 text-muted-foreground" />
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Estimated</p>
            </div>
            <p className="text-base font-bold tabular-nums">
              {totalEstimated > 0 ? formatHours(totalEstimated) : "--"}
            </p>
          </div>

          {/* Utilization */}
          <div className={cn("text-center p-2 rounded-lg", getUtilBg())}>
            <div className="flex items-center justify-center gap-1 mb-1">
              {getVarianceIcon()}
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Util</p>
            </div>
            <p className={cn("text-base font-bold tabular-nums", getUtilColor())}>
              {totalEstimated > 0 ? `${utilPct}%` : "--"}
            </p>
          </div>
        </div>

        {/* Progress bar */}
        {totalEstimated > 0 && (
          <div className="mt-3">
            <div className="relative h-2 w-full overflow-hidden rounded-full bg-gray-200">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-500",
                  utilPct <= 80 ? "bg-green-500" : utilPct <= 100 ? "bg-amber-500" : "bg-red-500"
                )}
                style={{ width: `${Math.min(utilPct, 100)}%` }}
              />
            </div>
            {variance !== 0 && (
              <p className={cn("text-xs mt-1.5", variance > 0 ? "text-red-600" : "text-green-600")}>
                {variance > 0 ? "+" : ""}{formatHours(Math.abs(variance))} {variance > 0 ? "over" : "under"} estimate
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
