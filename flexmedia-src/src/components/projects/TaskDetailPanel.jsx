import React, { useState, useEffect, useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { CalendarIcon, Trash2, AlertTriangle, ClockIcon, MessageCircle, Users, User, Lock } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { format } from "date-fns";
import { wallClockToUTC } from "@/components/lib/deadlinePresets";
import { CountdownTimer, CompletionTimer } from "./TaskManagement";
import TaskTimeLoggerRobust from "@/components/utilization/TaskTimeLoggerRobust";
import TaskEffortSectionVirtualized from "./TaskEffortSectionVirtualized";
import TaskEffortBadge from "./TaskEffortBadge";
import { useEntityList } from "@/components/hooks/useEntityData";
import { useChat } from "@/components/chat/ChatContext";
import { cn } from "@/lib/utils";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import { fixTimestamp } from "@/components/utils/dateUtils";
import { toast } from "sonner";

export default function TaskDetailPanel({
  task,
  canEdit,
  onEdit,
  onDelete,
  onUpdateDeadline,
  thresholds,
  projectId,
  project,
  user,
  onClose
}) {
  const [editingDeadline, setEditingDeadline] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // Convert UTC ISO → local datetime-local string (Australia/Sydney)
  const toLocalInput = (isoStr) => {
    if (!isoStr) return "";
    // Format: "yyyy-MM-ddTHH:mm" in local time using Intl
    const d = new Date(isoStr);
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Australia/Sydney',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    });
    const parts = fmt.formatToParts(d);
    const get = (type) => parts.find(p => p.type === type)?.value ?? '00';
    const hour = get('hour') === '24' ? '00' : get('hour');
    return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
  };

  // Convert datetime-local string (treated as Sydney local) → UTC ISO
  const fromLocalInput = (localStr) => {
    if (!localStr) return null;
    const [datePart, timePart] = (localStr.includes('T') ? localStr : localStr.replace(' ', 'T')).split('T');
    const [year, month, day] = datePart.split('-').map(Number);
    const [hours, minutes] = timePart.split(':').map(Number);
    return wallClockToUTC(year, month - 1, day, hours, minutes, 0, 'Australia/Sydney').toISOString();
  };

  const [deadlineInput, setDeadlineInput] = useState(toLocalInput(task.due_date));
  const { openChat } = useChat();

  // Live time logs for this specific task (real-time actual effort)
  const { data: taskTimeLogs = [] } = useEntityList('TaskTimeLog', null, null, log => log.task_id === task.id);

  // Tick every second when a timer is running so the effort badge stays live
  const [effortTick, setEffortTick] = useState(0);
  const hasRunningLog = taskTimeLogs.some(l => l.is_active && l.status === 'running');
  useEffect(() => {
    if (!hasRunningLog) return;
    const id = setInterval(() => setEffortTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [hasRunningLog]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const actualSeconds = useMemo(() => taskTimeLogs.reduce((sum, log) => {
    if (log.status === 'completed' || !log.is_active) return sum + Math.max(0, log.total_seconds || 0);
    if (log.status === 'paused') return sum + Math.max(0, log.total_seconds || 0);
    if (log.status === 'running' && log.start_time) {
      return sum + Math.max(0, Math.floor((Date.now() - new Date(log.start_time).getTime()) / 1000) - (log.paused_duration || 0));
    }
    return sum + Math.max(0, log.total_seconds || 0);
  }, 0), [taskTimeLogs, effortTick]);

  const lockMutation = useMutation({
    mutationFn: async (isLocked) => {
      await base44.entities.ProjectTask.update(task.id, { is_locked: isLocked });
    },
    onError: (err) => toast.error(err?.message || 'Failed to update task lock'),
  });

  const handleOpenChat = () => {
    if (!user) return;
    openChat({
      type: 'task',
      taskId: task.id,
      taskTitle: task.title,
      projectId,
      projectTitle: project?.title || "Project"
    });
  };

  const handleDeleteDeadline = () => {
    onUpdateDeadline(task.id, { due_date: null });
    setEditingDeadline(false);
  };

  const handleSaveDeadline = () => {
    if (deadlineInput) {
      const newDate = fromLocalInput(deadlineInput);
      if (newDate) {
        onUpdateDeadline(task.id, { due_date: newDate });
        setEditingDeadline(false);
      }
    }
  };

  const isOnsite = task.task_type === "onsite";
  const effectiveCanEdit = canEdit && !isOnsite;

  return (
    <div className="bg-white p-2.5 rounded-lg border border-border/50 space-y-1.5 text-xs">
      {isOnsite && (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-blue-50 border border-blue-200 text-xs text-blue-700">
          <Lock className="h-3 w-3 flex-shrink-0" />
          <span>Onsite task — read only</span>
        </div>
      )}
      {/* Blocking/Status Alert */}
      {(task.is_blocked || task.is_locked) && (
        <div className={`rounded px-2 py-1.5 flex items-start gap-2 ${task.is_locked ? 'bg-red-50 border border-red-200' : 'bg-orange-50 border border-orange-200'}`}>
          {task.is_locked ? (
            <>
              <Lock className="h-3 w-3 text-red-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-red-700">Locked</p>
                <p className="text-red-600">Time logging disabled</p>
              </div>
              {effectiveCanEdit && (
                <Button 
                  size="sm" 
                  variant="ghost" 
                  className="h-4 text-xs text-red-600 hover:text-red-700 ml-auto"
                  onClick={() => lockMutation.mutate(false)}
                >
                  Unlock
                </Button>
              )}
            </>
          ) : (
            <>
              <AlertTriangle className="h-3 w-3 text-orange-600 flex-shrink-0 mt-0.5" />
              <div>
                {task.depends_on_task_ids?.length > 0 ? (
                  <>
                    <p className="font-semibold text-orange-700 mb-1">Waiting for dependencies:</p>
                    <div className="space-y-0.5">
                      {task._depTasks?.map(depTask => (
                        <div key={depTask.id} className={cn("text-xs", depTask.is_completed ? "text-green-600" : "text-orange-600 font-medium")}>
                          {depTask.is_completed ? "✓" : "→"} {depTask.title}
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="text-orange-700">Waiting for <strong>{task.timer_trigger?.replace('project_', '').replace(/_/g, ' ')}</strong></p>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* Header: Title + Assignee + Deadline */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          {task.description && <p className="text-muted-foreground line-clamp-1 mb-1">{task.description}</p>}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1 min-w-fit">
              {task.assigned_to_team_name ? (
                <>
                  <Users className="h-3 w-3 text-muted-foreground" />
                  <span className="text-muted-foreground font-medium">{task.assigned_to_team_name}</span>
                </>
              ) : task.assigned_to_name ? (
                <>
                  <User className="h-3 w-3 text-muted-foreground" />
                  <span className="text-muted-foreground font-medium">{task.assigned_to_name}</span>
                </>
              ) : (
                <>
                  <User className="h-3 w-3 text-muted-foreground/50" />
                  <span className="text-muted-foreground/50 italic">Unassigned</span>
                </>
              )}
            </div>

            {(actualSeconds > 0 || (task.estimated_minutes || 0) > 0) && (
              <TaskEffortBadge
                estimatedMinutes={task.estimated_minutes || 0}
                actualSeconds={actualSeconds}
              />
            )}
          </div>
        </div>

        {/* Deadline on right */}
        {editingDeadline && effectiveCanEdit ? (
          <div className="flex items-center gap-1 flex-shrink-0">
            <Input
              type="datetime-local"
              value={deadlineInput}
              onChange={(e) => setDeadlineInput(e.target.value)}
              className="h-6 text-xs w-40"
            />
            <Button size="icon" className="h-6 w-6" onClick={handleSaveDeadline}>✓</Button>
            <Button size="icon" variant="outline" className="h-6 w-6" onClick={() => setEditingDeadline(false)}>✕</Button>
            {task.due_date && (
              <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive" onClick={handleDeleteDeadline}>
                <Trash2 className="h-3 w-3" />
              </Button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-1 flex-shrink-0 whitespace-nowrap">
            <CalendarIcon className="h-3 w-3 text-muted-foreground" />
            {task.due_date ? (
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground font-medium">{new Date(fixTimestamp(task.due_date)).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                {task.is_completed && task.updated_date ? (
                  <CompletionTimer dueDate={task.due_date} completedDate={task.updated_date} />
                ) : (
                  <CountdownTimer dueDate={task.due_date} compact thresholds={thresholds} />
                )}
              </div>
            ) : (
              <span className="text-muted-foreground">–</span>
            )}
            {effectiveCanEdit && (
              <Button size="icon" variant="ghost" className="h-5 w-5" onClick={() => setEditingDeadline(true)}>
                <CalendarIcon className="h-3 w-3" />
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Dependencies & Triggers (compact) */}
      {(task._depBlockingTasks?.length > 0 || task.depends_on_task_ids?.length > 0 || (task.timer_trigger && task.timer_trigger !== "none")) && (
        <div className="space-y-1 bg-muted/30 rounded px-2 py-1.5">
          {task._depBlockingTasks?.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              <span className="text-red-700 font-semibold">Blocks {task._depBlockingTasks.length}:</span>
              {task._depBlockingTasks.map(blockedTask => (
                <Badge key={blockedTask.id} variant="outline" className="text-xs px-1 py-0 bg-red-50 border-red-200 text-red-700">
                  🔒 {blockedTask.title}
                </Badge>
              ))}
            </div>
          )}
          {task.depends_on_task_ids?.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              <span className="text-blue-700 font-semibold">Depends on:</span>
              {task._depTasks?.map(depTask => (
                <Badge
                  key={depTask.id}
                  className={`text-xs px-1 py-0 ${
                    depTask.is_completed ? "bg-green-100 text-green-700" : depTask.is_blocked ? "bg-orange-100 text-orange-700" : "bg-white border border-border text-muted-foreground"
                  }`}
                >
                  {depTask.is_completed ? "✓" : depTask.is_blocked ? "🔒" : "→"} {depTask.title}
                </Badge>
              ))}
            </div>
          )}
          {task.timer_trigger && task.timer_trigger !== "none" && (
            <div className="flex items-center gap-2 text-blue-600">
              <ClockIcon className="h-3 w-3" />
              <span className="text-xs">Triggered: {task.timer_trigger === "dependencies_cleared" ? "dependencies cleared" : task.timer_trigger.replace("project_", "").replace(/_/g, " ")}</span>
            </div>
          )}
        </div>
      )}

      {/* Time Logger */}
      {user && !task.is_completed && !task.is_locked && (
        <TaskTimeLoggerRobust task={task} project={project} currentUser={user} />
      )}

      {/* Effort History */}
      <div className="border-t pt-1.5">
        <p className="text-xs font-semibold text-muted-foreground mb-1">Effort History</p>
        <TaskEffortSectionVirtualized taskId={task.id} task={task} project={project} user={user} />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 pt-1.5 border-t">
        <Button size="sm" variant="outline" className="h-6 text-xs px-2" onClick={handleOpenChat}>
          <MessageCircle className="h-3 w-3 mr-1" />
          Chat
        </Button>
        {effectiveCanEdit && (
          <>
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-xs px-2"
              onClick={() => onEdit(task)}
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="outline"
              className={`h-6 text-xs px-2 ${task.is_locked ? "text-red-600 bg-red-50" : "text-blue-600"}`}
              onClick={() => {
                // Warn before unlocking auto-generated onsite tasks
                if (task.is_locked && task.task_type === 'onsite' && task.auto_generated) {
                  if (!confirm('⚠️ This onsite task was auto-locked with effort already logged.\n\nUnlocking may allow duplicate time logging.\n\nContinue anyway?')) return;
                }
                lockMutation.mutate(!task.is_locked);
              }}
              disabled={lockMutation.isPending}
              title={task.is_locked ? "Unlock time logging" : "Lock time logging"}
            >
              <Lock className="h-3 w-3 mr-1" />
              {task.is_locked ? "Unlock" : "Lock"}
            </Button>
            {!(task.is_locked || (task.task_type === 'onsite' && task.auto_generated)) && (
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-xs px-2 text-destructive"
                onClick={() => setShowDeleteConfirm(true)}
              >
                <Trash2 className="h-3 w-3 mr-1" />
                Delete
              </Button>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        danger
        title="Delete Task?"
        description="This task will be permanently deleted and cannot be recovered."
        confirmText="Delete"
        onConfirm={() => { setShowDeleteConfirm(false); onDelete(task.id); }}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  );
}