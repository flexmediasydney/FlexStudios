import React, { useState } from "react";
import { useDashboardStats } from "@/components/hooks/useDashboardStats";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Clock, FileText } from "lucide-react";
import { cn } from "@/lib/utils";

const TaskDeadlineDashboard = React.lazy(() => import("@/components/dashboard/TaskDeadlineDashboard"));
const TaskReportingDashboard = React.lazy(() => import("@/components/dashboard/TaskReportingDashboard"));

export default function TasksTab() {
  const { data: stats } = useDashboardStats();
  const [view, setView] = useState("deadlines");
  const tasks = stats?.tasks || {};

  return (
    <div className="space-y-4">
      {/* Quick stats strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card><CardContent className="p-3 text-center">
          <div className="text-2xl font-bold">{tasks.total_tasks ?? 0}</div>
          <div className="text-xs text-muted-foreground">Total Tasks</div>
        </CardContent></Card>
        <Card><CardContent className="p-3 text-center">
          <div className="text-2xl font-bold text-green-600">{tasks.completed_tasks ?? 0}</div>
          <div className="text-xs text-muted-foreground">Completed</div>
        </CardContent></Card>
        <Card><CardContent className="p-3 text-center">
          <div className="text-2xl font-bold text-red-600">{tasks.overdue_tasks ?? 0}</div>
          <div className="text-xs text-muted-foreground">Overdue</div>
        </CardContent></Card>
        <Card><CardContent className="p-3 text-center">
          <div className="text-2xl font-bold">{tasks.completion_rate_pct ?? 0}%</div>
          <div className="text-xs text-muted-foreground">Completion Rate</div>
        </CardContent></Card>
      </div>

      {/* View toggle */}
      <div className="flex items-center gap-2">
        <Button variant={view === "deadlines" ? "default" : "outline"} size="sm" onClick={() => setView("deadlines")}>
          <Clock className="h-4 w-4 mr-1.5" /> Deadlines
        </Button>
        <Button variant={view === "reports" ? "default" : "outline"} size="sm" onClick={() => setView("reports")}>
          <FileText className="h-4 w-4 mr-1.5" /> Reports
        </Button>
      </div>

      <React.Suspense fallback={<div className="h-96 flex items-center justify-center"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>}>
        {view === "deadlines" ? <TaskDeadlineDashboard /> : <TaskReportingDashboard />}
      </React.Suspense>
    </div>
  );
}
