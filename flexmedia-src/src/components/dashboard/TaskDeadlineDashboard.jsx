import React, { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, Clock, CheckCircle2 } from "lucide-react";
import { differenceInSeconds, parseISO } from "date-fns";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { useEntityList } from "@/components/hooks/useEntityData";

function useDeadlineColor(secondsLeft, thresholds) {
  if (secondsLeft < 0) return { bg: "bg-red-50", border: "border-red-200", text: "text-red-600", dot: "bg-red-500" };
  const hoursLeft = secondsLeft / 3600;
  if (hoursLeft < thresholds.red_threshold) return { bg: "bg-red-50", border: "border-red-200", text: "text-red-600", dot: "bg-red-500" };
  if (hoursLeft < thresholds.yellow_end) return { bg: "bg-orange-50", border: "border-orange-200", text: "text-orange-600", dot: "bg-orange-500" };
  if (hoursLeft < thresholds.yellow_start) return { bg: "bg-amber-50", border: "border-amber-200", text: "text-amber-600", dot: "bg-amber-500" };
  return { bg: "bg-green-50", border: "border-green-200", text: "text-green-600", dot: "bg-green-500" };
}

function DeadlineRow({ task, project, thresholds }) {
  const [now, setNow] = useState(Date.now());
  
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const due = parseISO(task.due_date);
  const secondsLeft = differenceInSeconds(due, now);
  const isPast = secondsLeft < 0;
  const absSeconds = Math.abs(secondsLeft);
  const days = Math.floor(absSeconds / 86400);
  const hours = Math.floor((absSeconds % 86400) / 3600);
  const minutes = Math.floor((absSeconds % 3600) / 60);
  const seconds = Math.floor(absSeconds % 60);

  const colors = useDeadlineColor(secondsLeft, thresholds);

  const timeText = isPast
    ? `${String(days).padStart(2, '0')} ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')} overdue`
    : `${String(days).padStart(2, '0')} ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')} left`;

  return (
    <Link to={createPageUrl("ProjectDetails") + `?id=${project?.id}`} className="block">
      <div className={`p-3 rounded-lg border transition-colors ${colors.bg} ${colors.border} hover:shadow-md`}>
        <div className="flex items-start gap-3">
          <div className={`flex-shrink-0 w-2 h-2 rounded-full mt-1.5 ${colors.dot}`} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{task.title}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{project?.title}</p>
          </div>
          <div className="flex-shrink-0 text-right">
            <p className={`text-xs font-mono font-semibold ${colors.text}`}>{timeText}</p>
            {task.is_completed && <p className="text-xs text-green-600 mt-0.5">✓ Done</p>}
          </div>
        </div>
      </div>
    </Link>
  );
}

export default function TaskDeadlineDashboard() {
  const { data: settingsList = [] } = useEntityList("DeliverySettings");
  const settings = settingsList?.[0] || {};

  const thresholds = settings.countdown_thresholds || {
    yellow_start: 12,
    yellow_end: 6,
    red_threshold: 6
  };

  const { data: tasks = [] } = useEntityList("ProjectTask", "due_date", 500, (t) => t.due_date && !t.is_completed && !t.is_deleted);
  const { data: projects = [] } = useEntityList("Project", "-created_date", 200);

  const projectMap = new Map(projects.map(p => [p.id, p]));

  // Sort tasks by due date — exclude tasks from archived/cancelled projects
  const sortedTasks = [...tasks]
    .filter(t => {
      const proj = projectMap.get(t.project_id);
      return !proj?.is_archived && proj?.status !== 'cancelled';
    })
    .sort((a, b) => new Date(a.due_date) - new Date(b.due_date));

  // Group by urgency
  const urgentTasks = [];
  const warningTasks = [];
  const normalTasks = [];

  const now = Date.now();
  sortedTasks.forEach(task => {
    const secondsLeft = differenceInSeconds(parseISO(task.due_date), now);
    const hoursLeft = secondsLeft / 3600;

    if (hoursLeft < thresholds.red_threshold || secondsLeft < 0) {
      urgentTasks.push(task);
    } else if (hoursLeft < thresholds.yellow_start) {
      warningTasks.push(task);
    } else {
      normalTasks.push(task);
    }
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight mb-4">Task Deadlines</h2>
        <p className="text-sm text-muted-foreground">
          All upcoming task due dates sorted by urgency.
          Countdown format: <span className="font-mono text-xs">DD HH:MM:SS</span>
        </p>
      </div>

      {/* Urgent Tasks */}
      {urgentTasks.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-red-500" />
            <h3 className="font-semibold text-red-600" title="Tasks overdue or due within the red threshold">Critical — Due Soon</h3>
            <Badge variant="destructive" className="ml-auto">{urgentTasks.length}</Badge>
          </div>
          <div className="space-y-2">
            {urgentTasks.slice(0, 5).map(task => (
              <DeadlineRow key={task.id} task={task} project={projectMap.get(task.project_id)} thresholds={thresholds} />
            ))}
          </div>
          {urgentTasks.length > 5 && (
            <p className="text-xs text-muted-foreground px-3 py-2">+{urgentTasks.length - 5} more critical tasks</p>
          )}
        </div>
      )}

      {/* Warning Tasks */}
      {warningTasks.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-amber-500" />
            <h3 className="font-semibold text-amber-600" title="Tasks due within the next 12 hours">Upcoming — Next 12 Hours</h3>
            <Badge variant="outline" className="bg-amber-50 border-amber-200 text-amber-700 ml-auto">{warningTasks.length}</Badge>
          </div>
          <div className="space-y-2">
            {warningTasks.slice(0, 5).map(task => (
              <DeadlineRow key={task.id} task={task} project={projectMap.get(task.project_id)} thresholds={thresholds} />
            ))}
          </div>
          {warningTasks.length > 5 && (
            <p className="text-xs text-muted-foreground px-3 py-2">+{warningTasks.length - 5} more upcoming tasks</p>
          )}
        </div>
      )}

      {/* Normal Tasks */}
      {normalTasks.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            <h3 className="font-semibold text-green-600" title="Tasks with more than 12 hours remaining">On Track</h3>
            <Badge variant="outline" className="bg-green-50 border-green-200 text-green-700 ml-auto">{normalTasks.length}</Badge>
          </div>
          <div className="space-y-2">
            {normalTasks.slice(0, 3).map(task => (
              <DeadlineRow key={task.id} task={task} project={projectMap.get(task.project_id)} thresholds={thresholds} />
            ))}
          </div>
          {normalTasks.length > 3 && (
            <p className="text-xs text-muted-foreground px-3 py-2">+{normalTasks.length - 3} more scheduled tasks</p>
          )}
        </div>
      )}

      {sortedTasks.length === 0 && (
        <Card className="p-8 text-center border-dashed">
          <Clock className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No task deadlines set yet</p>
        </Card>
      )}
    </div>
  );
}