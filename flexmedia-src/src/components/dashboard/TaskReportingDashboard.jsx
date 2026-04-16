import { useState } from "react";
import { useEntityList } from "@/components/hooks/useEntityData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { 
  CheckSquare, User, AlertCircle, Clock, 
  TrendingUp, Calendar
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { fixTimestamp } from "@/components/utils/dateUtils";
import TaskBreakdownDialog from "./TaskBreakdownDialog";

const calculateCriticality = (dueDate, workingHours, thresholds) => {
  if (!dueDate) return { level: 'grey', label: 'No deadline' };
  
  const now = new Date();
  const due = new Date(dueDate);
  
  if (due < now) return { level: 'late', label: 'Overdue' };
  
  const diffMs = due - now;
  const diffHours = diffMs / (1000 * 60 * 60);
  
  if (diffHours < (thresholds?.red_threshold || 6)) {
    return { level: 'red', label: 'Critical' };
  } else if (diffHours < (thresholds?.yellow_end || 6)) {
    return { level: 'orange', label: 'Urgent' };
  } else if (diffHours < (thresholds?.yellow_start || 12)) {
    return { level: 'yellow', label: 'Soon' };
  }
  
  return { level: 'grey', label: 'On track' };
};

const criticalityColors = {
  grey: 'bg-slate-100 text-slate-700',
  yellow: 'bg-yellow-100 text-yellow-700',
  orange: 'bg-orange-100 text-orange-700',
  red: 'bg-red-100 text-red-700',
  late: 'bg-red-600 text-white'
};

export default function TaskReportingDashboard() {
  const [breakdownDialog, setBreakdownDialog] = useState({ open: false, title: '', tasks: [] });

  const { data: allTasks = [], loading: tasksLoading } = useEntityList("ProjectTask", "-created_date", 500);
  const { data: projects = [] } = useEntityList("Project");
  const { data: deliverySettingsList = [] } = useEntityList("DeliverySettings");
  const deliverySettings = deliverySettingsList[0] || null;
  const { data: activities = [], loading: activitiesLoading } = useEntityList("ProjectActivity", "-created_date", 50);

  // Exclude tasks from archived/cancelled projects + deleted tasks
  const projectMap = new Map(projects.map(p => [p.id, p]));
  const tasks = allTasks.filter(t => {
    if (t.is_deleted) return false;
    const proj = projectMap.get(t.project_id);
    return !proj?.is_archived && proj?.status !== 'cancelled';
  });

  if (tasksLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  // Calculate stats
  const incompleteTasks = tasks.filter(t => !t.is_completed);
  const totalTasks = tasks.length;
  const completedTasks = tasks.filter(t => t.is_completed).length;

  // Tasks by owner
  const tasksByOwner = incompleteTasks.reduce((acc, task) => {
    const owner = task.assigned_to_name || 'Unassigned';
    acc[owner] = (acc[owner] || 0) + 1;
    return acc;
  }, {});

  // Completed tasks by owner
  const completedTasksByOwner = tasks.filter(t => t.is_completed).reduce((acc, task) => {
    const owner = task.assigned_to_name || 'Unassigned';
    acc[owner] = (acc[owner] || 0) + 1;
    return acc;
  }, {});

  // Tasks by criticality
  const thresholds = deliverySettings?.countdown_thresholds;
  const tasksByCriticality = incompleteTasks.reduce((acc, task) => {
    const crit = calculateCriticality(task.due_date, deliverySettings?.working_hours, thresholds);
    acc[crit.level] = (acc[crit.level] || 0) + 1;
    return acc;
  }, {});

  // Enrich tasks with project titles and criticality
  const enrichedTasks = tasks.map(task => ({
    ...task,
    project_title: projects.find(p => p.id === task.project_id)?.title || 'Unknown Project',
    criticality: task.is_completed ? null : calculateCriticality(task.due_date, deliverySettings?.working_hours, thresholds)
  }));

  // Recent task activities
  const taskActivities = activities.filter(a => 
    a.action === 'task_added' || a.action === 'task_completed'
  ).slice(0, 10);

  return (
    <div className="space-y-6">
      {/* Overview Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card
          className="cursor-pointer hover:shadow-lg transition-shadow"
          title="Click to view all tasks"
          onClick={() => setBreakdownDialog({
            open: true,
            title: `All Tasks (${totalTasks})`,
            tasks: enrichedTasks
          })}
        >
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground mb-1">Total Tasks</p>
                <p className="text-3xl font-bold">{totalTasks}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {incompleteTasks.length} active
                </p>
              </div>
              <CheckSquare className="h-10 w-10 text-primary opacity-20" />
            </div>
          </CardContent>
        </Card>

        <Card
          className="cursor-pointer hover:shadow-lg transition-shadow"
          title="Click to view completed tasks"
          onClick={() => setBreakdownDialog({
            open: true,
            title: `Completed Tasks (${completedTasks})`,
            tasks: enrichedTasks.filter(t => t.is_completed)
          })}
        >
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground mb-1">Completed</p>
                <p className="text-3xl font-bold">{completedTasks}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0}% completion rate
                </p>
              </div>
              <TrendingUp className="h-10 w-10 text-green-600 opacity-20" />
            </div>
          </CardContent>
        </Card>

        <Card
          className="cursor-pointer hover:shadow-lg transition-shadow"
          title="Click to view critical and overdue tasks"
          onClick={() => setBreakdownDialog({
            open: true,
            title: `Critical Tasks (${(tasksByCriticality.red || 0) + (tasksByCriticality.late || 0)})`,
            tasks: enrichedTasks.filter(t => !t.is_completed && (t.criticality?.level === 'red' || t.criticality?.level === 'late'))
          })}
        >
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground mb-1">Critical</p>
                <p className="text-3xl font-bold text-red-600">
                  {(tasksByCriticality.red || 0) + (tasksByCriticality.late || 0)}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  need immediate attention
                </p>
              </div>
              <AlertCircle className="h-10 w-10 text-red-600 opacity-20" />
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Active Tasks by Owner */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="h-5 w-5" />
              Active Tasks by Owner
            </CardTitle>
          </CardHeader>
          <CardContent>
            {Object.keys(tasksByOwner).length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No active tasks assigned
              </p>
            ) : (
              <div className="space-y-3">
                {Object.entries(tasksByOwner)
                  .sort((a, b) => b[1] - a[1])
                  .map(([owner, count]) => (
                    <div 
                      key={owner} 
                      className="flex items-center justify-between p-2 rounded-lg hover:bg-muted cursor-pointer transition-colors"
                      onClick={() => setBreakdownDialog({
                        open: true,
                        title: `Active Tasks - ${owner} (${count})`,
                        tasks: enrichedTasks.filter(t => !t.is_completed && (t.assigned_to_name || 'Unassigned') === owner)
                      })}
                    >
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                          <User className="h-4 w-4 text-primary" />
                        </div>
                        <span className="font-medium">{owner}</span>
                      </div>
                      <Badge variant="secondary">{count} tasks</Badge>
                    </div>
                  ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Completed Tasks by Owner */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckSquare className="h-5 w-5" />
              Completed Tasks by Owner
            </CardTitle>
          </CardHeader>
          <CardContent>
            {Object.keys(completedTasksByOwner).length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No completed tasks yet
              </p>
            ) : (
              <div className="space-y-3">
                {Object.entries(completedTasksByOwner)
                  .sort((a, b) => b[1] - a[1])
                  .map(([owner, count]) => (
                    <div 
                      key={owner} 
                      className="flex items-center justify-between p-2 rounded-lg hover:bg-muted cursor-pointer transition-colors"
                      onClick={() => setBreakdownDialog({
                        open: true,
                        title: `Completed Tasks - ${owner} (${count})`,
                        tasks: enrichedTasks.filter(t => t.is_completed && (t.assigned_to_name || 'Unassigned') === owner)
                      })}
                    >
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center">
                          <CheckSquare className="h-4 w-4 text-green-700" />
                        </div>
                        <span className="font-medium">{owner}</span>
                      </div>
                      <Badge className="bg-green-100 text-green-700">{count} completed</Badge>
                    </div>
                  ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Tasks by Criticality */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              Tasks by Criticality
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {[
                { level: 'late', label: 'Overdue', icon: AlertCircle },
                { level: 'red', label: 'Critical (<6h)', icon: AlertCircle },
                { level: 'orange', label: 'Urgent (6-12h)', icon: Clock },
                { level: 'yellow', label: 'Soon (12-24h)', icon: Clock },
                { level: 'grey', label: 'On Track', icon: CheckSquare }
              ].map(({ level, label, icon: Icon }) => {
                const count = tasksByCriticality[level] || 0;
                return (
                  <div 
                    key={level} 
                    className="flex items-center justify-between p-2 rounded-lg hover:bg-muted cursor-pointer transition-colors"
                    onClick={() => setBreakdownDialog({
                      open: true,
                      title: `${label} Tasks (${count})`,
                      tasks: enrichedTasks.filter(t => !t.is_completed && t.criticality?.level === level)
                    })}
                  >
                    <div className="flex items-center gap-2">
                      <Icon className={`h-4 w-4 ${level === 'late' || level === 'red' ? 'text-red-600' : level === 'orange' ? 'text-orange-600' : level === 'yellow' ? 'text-yellow-600' : 'text-muted-foreground'}`} />
                      <span className="text-sm">{label}</span>
                    </div>
                    <Badge className={criticalityColors[level]}>{count}</Badge>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Global Activity Feed */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5" />
            Recent Task Activity
          </CardTitle>
        </CardHeader>
        <CardContent>
          {activitiesLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : taskActivities.length === 0 ? (
            <div className="text-center py-8">
              <Calendar className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                No recent task activity
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {taskActivities.map((activity, idx) => (
                <div 
                  key={activity.id || idx} 
                  className="flex items-start gap-3 p-3 rounded-lg hover:bg-muted/50 transition-colors"
                >
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                    activity.action === 'task_completed' 
                      ? 'bg-green-100' 
                      : 'bg-blue-100'
                  }`}>
                    {activity.action === 'task_completed' ? (
                      <CheckSquare className="h-4 w-4 text-green-700" />
                    ) : (
                      <Clock className="h-4 w-4 text-blue-700" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm">
                      <span className="font-medium">{activity.user_name || 'Someone'}</span>
                      {' '}
                      {activity.action === 'task_completed' ? 'completed' : 'added'} a task
                      {' '}
                      {activity.project_title && (
                        <span className="text-muted-foreground">
                          in {activity.project_title}
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {formatDistanceToNow(new Date(fixTimestamp(activity.created_date)), { addSuffix: true })}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <TaskBreakdownDialog
        open={breakdownDialog.open}
        onClose={() => setBreakdownDialog({ open: false, title: '', tasks: [] })}
        title={breakdownDialog.title}
        tasks={breakdownDialog.tasks}
      />
    </div>
  );
}