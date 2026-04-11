import React, { useState } from "react";
import { useDashboardStats } from "@/components/hooks/useDashboardStats";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Clock, FileText } from "lucide-react";
import { cn } from "@/lib/utils";

const TaskDeadlineDashboard = React.lazy(() => import("@/components/dashboard/TaskDeadlineDashboard"));
const TaskReportingDashboard = React.lazy(() => import("@/components/dashboard/TaskReportingDashboard"));

export default function TasksTab() {
  const { data: stats, isLoading } = useDashboardStats();
  const [view, setView] = useState(() => localStorage.getItem('tasksTab_view') || 'deadlines');
  const changeView = (v) => { setView(v); localStorage.setItem('tasksTab_view', v); };
  const tasks = stats?.tasks || {};

  return (
    <div className="space-y-4">
      {/* Quick stats strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {isLoading ? (
          [...Array(4)].map((_, i) => (
            <Card key={i}><CardContent className="p-3 text-center space-y-1.5">
              <Skeleton className="h-7 w-12 mx-auto" />
              <Skeleton className="h-3 w-16 mx-auto" />
            </CardContent></Card>
          ))
        ) : (<>
          <Card><CardContent className="p-3 text-center" role="status">
            <div className="text-2xl font-bold">{tasks.total_tasks ?? 0}</div>
            <div className="text-xs text-muted-foreground">Total Tasks</div>
          </CardContent></Card>
          <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => changeView("reports")}>
            <CardContent className="p-3 text-center" role="status">
              <div className="text-2xl font-bold text-green-600">{tasks.completed_tasks ?? 0}</div>
              <div className="text-xs text-muted-foreground">Completed</div>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => changeView("deadlines")}>
            <CardContent className="p-3 text-center" role="status">
              <div className="text-2xl font-bold text-red-600">{tasks.overdue_tasks ?? 0}</div>
              <div className="text-xs text-muted-foreground">Overdue</div>
            </CardContent>
          </Card>
          <Card><CardContent className="p-3 text-center" role="status">
            <div className={cn("text-2xl font-bold", (tasks.completion_rate_pct ?? 0) >= 80 ? "text-green-600" : (tasks.completion_rate_pct ?? 0) >= 50 ? "text-amber-600" : "text-red-600")}>
              {tasks.completion_rate_pct ?? 0}%
            </div>
            <div className="text-xs text-muted-foreground">Completion Rate</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">Target: 85%</div>
          </CardContent></Card>
        </>)}
      </div>

      {/* View toggle */}
      <div className="flex items-center gap-2">
        <Button variant={view === "deadlines" ? "default" : "outline"} size="sm" aria-pressed={view === "deadlines"} onClick={() => changeView("deadlines")}>
          <Clock className="h-4 w-4 mr-1.5" /> Deadlines
        </Button>
        <Button variant={view === "reports" ? "default" : "outline"} size="sm" aria-pressed={view === "reports"} onClick={() => changeView("reports")}>
          <FileText className="h-4 w-4 mr-1.5" /> Reports
        </Button>
      </div>

      <React.Suspense fallback={<div className="h-96 flex items-center justify-center" role="status" aria-label="Loading content"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /><span className="sr-only">Loading...</span></div>}>
        {view === "deadlines" ? <TaskDeadlineDashboard /> : <TaskReportingDashboard />}
      </React.Suspense>
    </div>
  );
}
