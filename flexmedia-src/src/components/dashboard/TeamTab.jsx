import React, { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { api } from "@/api/supabaseClient";
import { createPageUrl } from "@/utils";
import { fixTimestamp } from "@/components/utils/dateUtils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Timer, ChevronRight } from "lucide-react";

const TeamCapacityDash = React.lazy(() => import("@/components/dashboard/TeamCapacityDash"));

function ActiveTimersStrip() {
  // Fetch ALL running timers across the team (not just current user)
  const { data: allTimers = [], dataUpdatedAt } = useQuery({
    queryKey: ["team-active-timers"],
    queryFn: () => api.entities.TaskTimeLog.filter({ is_active: true, status: "running" }, null, 50),
    refetchInterval: 30000,
  });

  const running = useMemo(() => allTimers.filter(t => t.status === "running"), [allTimers]);

  // Batch-fetch task titles for running timers
  const taskIds = useMemo(() => [...new Set(running.map(t => t.task_id).filter(Boolean))], [running]);
  const { data: tasks = [] } = useQuery({
    queryKey: ["team-timer-tasks", taskIds],
    queryFn: async () => {
      if (taskIds.length === 0) return [];
      return api.entities.ProjectTask.filter({ id: { $in: taskIds } }, null, taskIds.length);
    },
    enabled: taskIds.length > 0,
    staleTime: 60000,
  });
  const taskMap = useMemo(() => Object.fromEntries(tasks.map(t => [t.id, t])), [tasks]);

  // Batch-fetch project names for running timers
  const projectIds = useMemo(() => [...new Set(running.map(t => t.project_id).filter(Boolean))], [running]);
  const { data: projects = [] } = useQuery({
    queryKey: ["team-timer-projects", projectIds],
    queryFn: async () => {
      if (projectIds.length === 0) return [];
      return api.entities.Project.filter({ id: { $in: projectIds } }, null, projectIds.length);
    },
    enabled: projectIds.length > 0,
    staleTime: 60000,
  });
  const projectMap = useMemo(() => Object.fromEntries(projects.map(p => [p.id, p])), [projects]);

  if (running.length === 0) return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Timer className="h-4 w-4 text-muted-foreground" />
          Active Timers
        </CardTitle>
      </CardHeader>
      <CardContent className="pb-4">
        <p className="text-sm text-muted-foreground text-center">
          No one is currently tracking time. Timers can be started from any project's task list.
        </p>
      </CardContent>
    </Card>
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Timer className="h-4 w-4 text-primary" />
          Active Timers
          <Badge variant="secondary">{running.length}</Badge>
          {dataUpdatedAt && (
            <span className="text-[10px] text-muted-foreground ml-auto">
              Updated {formatDistanceToNow(dataUpdatedAt, { addSuffix: true })}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {running.map(t => {
          const task = taskMap[t.task_id];
          const project = projectMap[t.project_id];
          const taskTitle = task?.title || "Task";
          const projectLabel = project?.property_address || project?.title || null;
          const elapsed = t.start_time
            ? formatDistanceToNow(new Date(fixTimestamp(t.start_time)), { addSuffix: false })
            : null;

          return (
            <Link
              key={t.id}
              to={t.project_id ? createPageUrl("ProjectDetails") + `?id=${t.project_id}` : "#"}
              className="flex items-center gap-3 p-2.5 rounded-lg bg-muted/50 hover:bg-muted transition-colors group"
            >
              {/* Pulsing green dot */}
              <span className="relative flex h-3 w-3 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500" />
              </span>

              {/* Text block */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">
                  {t.user_name || "Unknown"}{" "}
                  <span className="font-normal text-muted-foreground">is working on</span>{" "}
                  <span className="font-medium">&ldquo;{taskTitle}&rdquo;</span>
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  {projectLabel && <span>{projectLabel}</span>}
                  {projectLabel && elapsed && <span> &middot; </span>}
                  {elapsed && <span>Started {elapsed} ago</span>}
                </p>
              </div>

              {/* Drill-through arrow */}
              {t.project_id && (
                <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
              )}
            </Link>
          );
        })}
      </CardContent>
    </Card>
  );
}

export default function TeamTab() {
  return (
    <div className="space-y-6">
      <ActiveTimersStrip />
      <React.Suspense fallback={<div className="h-96 flex items-center justify-center"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>}>
        <TeamCapacityDash />
      </React.Suspense>
    </div>
  );
}
