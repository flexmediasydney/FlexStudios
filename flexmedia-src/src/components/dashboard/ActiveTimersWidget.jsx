import { useMemo, useState, useEffect } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Timer, Play, Pause, Clock } from "lucide-react";
import { fixTimestamp } from "@/components/utils/dateUtils";

export default function ActiveTimersWidget({ timeLogs = [], tasks = [] }) {
  const [tick, setTick] = useState(0);

  // Refresh every 30s to update elapsed times
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(interval);
  }, []);

  const activeTimers = useMemo(() => {
    const now = new Date();
    return timeLogs
      .filter(log => log.is_running || (log.start_time && !log.end_time && !log.total_seconds))
      .map(log => {
        const startTime = log.start_time ? new Date(fixTimestamp(log.start_time)) : null;
        const elapsedSec = startTime ? Math.floor((now - startTime) / 1000) : 0;
        const task = tasks.find(t => t.id === log.task_id);
        return {
          id: log.id,
          userName: log.user_name || log.created_by || "Unknown",
          taskName: task?.title || log.description || "Untitled Task",
          projectName: task?.project_name || "",
          elapsedSec: Math.max(0, elapsedSec),
          startTime,
        };
      })
      .sort((a, b) => b.elapsedSec - a.elapsedSec);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeLogs, tasks, tick]);

  // Also show recently stopped timers (last 2 hours) as context
  const recentTimers = useMemo(() => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    return timeLogs
      .filter(log => {
        if (log.is_running || (log.start_time && !log.end_time && !log.total_seconds)) return false;
        if (!log.end_time) return false;
        try {
          return new Date(fixTimestamp(log.end_time)) >= twoHoursAgo;
        } catch { return false; }
      })
      .slice(0, 3)
      .map(log => {
        const task = tasks.find(t => t.id === log.task_id);
        return {
          id: log.id,
          userName: log.user_name || log.created_by || "Unknown",
          taskName: task?.title || log.description || "Untitled Task",
          totalSec: log.total_seconds || 0,
        };
      });
  }, [timeLogs, tasks]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Timer className="h-4 w-4 text-green-500" />
            Active Timers
          </CardTitle>
          {activeTimers.length > 0 && (
            <Badge className="bg-green-500/10 text-green-600 border-green-200 text-xs animate-pulse">
              {activeTimers.length} running
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {activeTimers.length === 0 && recentTimers.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground text-sm">
            <Timer className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p>No active timers</p>
          </div>
        ) : (
          <div className="space-y-2">
            {/* Active timers */}
            {activeTimers.map(timer => (
              <div
                key={timer.id}
                className="flex items-center gap-3 p-2.5 rounded-lg border border-green-200 bg-green-50/50"
              >
                <div className="w-8 h-8 rounded-lg bg-green-100 text-green-600 flex items-center justify-center shrink-0">
                  <Play className="h-4 w-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{timer.taskName}</p>
                  <p className="text-xs text-muted-foreground truncate">{timer.userName}</p>
                </div>
                <span className="text-sm font-mono font-semibold text-green-600 shrink-0">
                  {formatDuration(timer.elapsedSec)}
                </span>
              </div>
            ))}

            {/* Recent stopped timers */}
            {recentTimers.length > 0 && activeTimers.length > 0 && (
              <div className="border-t pt-2 mt-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 font-medium">
                  Recently Stopped
                </p>
              </div>
            )}
            {recentTimers.map(timer => (
              <div
                key={timer.id}
                className="flex items-center gap-3 p-2 rounded-lg bg-muted/30"
              >
                <div className="w-7 h-7 rounded-md bg-muted text-muted-foreground flex items-center justify-center shrink-0">
                  <Pause className="h-3.5 w-3.5" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{timer.taskName}</p>
                  <p className="text-[11px] text-muted-foreground">{timer.userName}</p>
                </div>
                <span className="text-xs font-mono text-muted-foreground shrink-0">
                  {formatDuration(timer.totalSec)}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}
