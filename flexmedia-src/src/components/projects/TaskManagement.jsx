import React, { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Plus, CalendarIcon } from "lucide-react";
import { scheduleDeadlineSync } from "./taskDeadlineSync";
import { format, differenceInSeconds } from "date-fns";
import { wallClockToUTC } from "@/components/lib/deadlinePresets";
import { useEntityList } from "@/components/hooks/useEntityData";
import TaskListView from "./TaskListView";
import { toast } from "sonner";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import { createNotification, writeFeedEvent } from "@/components/notifications/createNotification";

export function getCountdownState({ dueDate, thresholds }) {
  if (!dueDate) return "normal";
  
  const defaults = { yellow_start: 12, yellow_end: 6, red_threshold: 6 };
  const t = thresholds || defaults;

  let due;
  try {
    due = new Date(dueDate);
    if (isNaN(due.getTime())) return "normal";
  } catch {
    return "normal";
  }

  const secondsLeft = differenceInSeconds(due, new Date());
  const isPast = secondsLeft < 0;
  const absSeconds = Math.abs(secondsLeft);
  const hours = Math.floor((absSeconds % 86400) / 3600);

  if (isPast) {
    return "overdue"; // red
  } else if (hours < t.red_threshold) {
    return "critical"; // red
  } else if (hours < t.yellow_end) {
    return "warning"; // orange
  } else if (hours < t.yellow_start) {
    return "caution"; // amber
  }
  return "normal"; // neutral
}

export function CountdownTimer({ dueDate, compact = false, thresholds }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let mounted = true;
    const id = setInterval(() => {
      if (mounted) setNow(Date.now());
    }, 1000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  if (!dueDate) return <span className="text-xs text-muted-foreground">No deadline</span>;

  const defaults = { yellow_start: 12, yellow_end: 6, red_threshold: 6 };
  const t = thresholds || defaults;

  let due;
  try {
    due = new Date(dueDate);
    if (isNaN(due.getTime())) throw new Error('Invalid date');
  } catch {
    return <span className="text-xs text-destructive">Invalid date</span>;
  }

  const secondsLeft = differenceInSeconds(due, new Date(now));
  const isPast = secondsLeft < 0;
  const absSeconds = Math.abs(secondsLeft);
  const days = Math.floor(absSeconds / 86400);
  const hours = Math.floor((absSeconds % 86400) / 3600);
  const minutes = Math.floor((absSeconds % 3600) / 60);
  const secs = absSeconds % 60;

  // Always show all components: xD XXh XXm XXs
  let text, color;
  if (isPast) {
    text = `${days}d ${hours}h ${minutes}m overdue`;
    color = "text-red-600";
  } else if (hours < t.red_threshold) {
    text = `${days}d ${hours}h ${minutes}m`;
    color = "text-red-500";
  } else if (hours < t.yellow_end) {
    text = `${days}d ${hours}h ${minutes}m`;
    color = "text-orange-500";
  } else if (hours < t.yellow_start) {
    text = `${days}d ${hours}h ${minutes}m`;
    color = "text-amber-500";
  } else {
    text = `${days}d ${hours}h ${minutes}m`;
    color = "text-muted-foreground";
  }

  return <span className={`text-xs font-mono flex-shrink-0 ${color}`}>{text}</span>;
}

export function CompletionTimer({ dueDate, completedDate }) {
  const due = new Date(dueDate);
  const completed = new Date(completedDate);
  const absSeconds = Math.abs(differenceInSeconds(completed, due));
  const days = Math.floor(absSeconds / 86400);
  const hours = Math.floor((absSeconds % 86400) / 3600);
  const minutes = Math.floor((absSeconds % 3600) / 60);

  const text = `completed in ${days}d ${hours}h ${minutes}m`;
  const color = differenceInSeconds(completed, due) <= 0 ? "text-green-600" : "text-orange-500";

  return <span className={`text-xs font-mono flex-shrink-0 ${color}`}>{text}</span>;
}

export const ROLE_LABELS = {
  none: "No auto-assign",
  project_owner: "Project Owner",
  photographer: "Photographer",
  videographer: "Videographer",
  image_editor: "Image Editor",
  video_editor: "Video Editor",
  floorplan_editor: "Floorplan Editor",
  drone_editor: "Drone Editor",
};

export const TASK_TYPE_LABELS = {
  onsite: "Onsite",
  back_office: "Back Office",
};

export const TASK_TYPE_DESCRIPTIONS = {
  onsite: "Task performed at shoot location or with client",
  back_office: "Task performed remotely or in office",
};

export default function TaskManagement({ projectId, project, canEdit }) {
   const queryClient = useQueryClient();
   const [showAddDialog, setShowAddDialog] = useState(false);
   const [editingTask, setEditingTask] = useState(null);
   const [newTask, setNewTask] = useState({ title: "", description: "", task_type: "back_office", assigned_to: "", assigned_to_name: "", due_date: null });
   const [sortBy, setSortBy] = useState("workflow");
   const [deleteConfirm, setDeleteConfirm] = useState(null);
   const { data: user = null } = useQuery({
     queryKey: ["currentUser"],
     queryFn: () => api.auth.me()
   });

   const logActivity = (action, description) => {
     if (!projectId || !project) return;
     api.entities.ProjectActivity.create({
       project_id: projectId,
       project_title: project.title || project.property_address || '',
       action,
       description,
       user_name: user?.full_name || user?.email || 'Unknown',
       user_email: user?.email || '',
     }).catch(err => console.warn('[activity]', err?.message));
   };

   const { data: settings = {} } = useQuery({
    queryKey: ["deliverySettings"],
    queryFn: async () => {
      const data = await api.entities.DeliverySettings.filter({}, null, 1);
      return data?.[0] || {};
    },
    staleTime: 5 * 60 * 1000, // 5 min cache
  });

  const thresholds = settings.countdown_thresholds || {
    yellow_start: 12,
    yellow_end: 6,
    red_threshold: 6
  };

  const { data: allTasksRaw = [], loading: isLoading } = useEntityList(
    projectId ? "ProjectTask" : null,
    "order",
    500,
    projectId ? (t) => t.project_id === projectId && !t.is_deleted : null
  );
  const tasks = allTasksRaw;

  const { data: revisions = [] } = useEntityList(
    projectId ? "ProjectRevision" : null,
    null, 200,
    projectId ? { project_id: projectId } : null
  );

  const { data: products = [] } = useEntityList("Product", null, 500, { is_active: true });
  const { data: users = [] } = useEntityList("User", null, 500);
  const { data: teams = [] } = useEntityList("InternalTeam", null, 200, { is_active: true });

  useEffect(() => {
    if (!projectId) return;
    let mounted = true;
    const unsubscribe = api.entities.TaskChat.subscribe((event) => {
      if (mounted && event?.data?.project_id === projectId) {
        queryClient.invalidateQueries({ queryKey: ["taskChatCounts", projectId] });
      }
    });
    return () => {
      mounted = false;
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [projectId, queryClient]);

  const { data: taskChatCounts = {} } = useQuery({
    queryKey: ["taskChatCounts", projectId],
    queryFn: async () => {
      if (!projectId) return {};
      try {
        const chats = await api.entities.TaskChat.filter({ project_id: projectId }, null, 1000);
        const counts = {};
        if (Array.isArray(chats)) {
          chats.forEach(chat => {
            if (chat?.task_id) {
              counts[chat.task_id] = (counts[chat.task_id] || 0) + 1;
            }
          });
        }
        return counts;
      } catch {
        return {};
      }
    },
    enabled: !!projectId
  });

  // Sync task assignee denormalized fields when users/teams change
  useEffect(() => {
    let mounted = true;
    const syncTasks = async () => {
      if (!projectId || !Array.isArray(tasks) || tasks.length === 0) return;
      
      const tasksToUpdate = tasks.filter(task => {
        if (!task?.id) return false;
        const userChanged = task.assigned_to && !task.assigned_to_name;
        const teamChanged = task.assigned_to_team_id && !task.assigned_to_team_name;
        return userChanged || teamChanged;
      });

      for (const task of tasksToUpdate) {
        if (!mounted) break;
        const updates = {};
        
        if (task.assigned_to && Array.isArray(users)) {
          const user = users.find(u => u?.id === task.assigned_to);
          if (user?.full_name) updates.assigned_to_name = user.full_name;
        }
        
        if (task.assigned_to_team_id && Array.isArray(teams)) {
          const team = teams.find(t => t?.id === task.assigned_to_team_id);
          if (team?.name) updates.assigned_to_team_name = team.name;
        }

        if (Object.keys(updates).length > 0) {
          try {
            await api.entities.ProjectTask.update(task.id, updates);
          } catch (err) {
            if (mounted) console.warn('Failed to sync task assignee names:', err);
          }
        }
      }
    };

    syncTasks();
    return () => { mounted = false; };
  }, [projectId, tasks, users, teams]);

  const UPLOADED_STAGES_FOR_CREATE = ['uploaded', 'submitted', 'in_progress', 'in_production', 'ready_for_partial', 'in_revision', 'delivered'];

  const createMutation = useMutation({
    mutationFn: (data) => {
      const cleaned = { ...data, project_id: projectId, order: Date.now() };
      // Remove empty string fields that would fail as UUIDs in PostgREST
      if (!cleaned.assigned_to) delete cleaned.assigned_to;
      if (!cleaned.assigned_to_name) delete cleaned.assigned_to_name;
      if (!cleaned.due_date) delete cleaned.due_date;
      return api.entities.ProjectTask.create(cleaned);
    },
    onSuccess: (created, variables) => {
      queryClient.invalidateQueries({ queryKey: ['project-tasks', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setShowAddDialog(false);
      setNewTask({ title: "", description: "", task_type: "back_office", assigned_to: "", assigned_to_name: "", due_date: null });
      logActivity('task_added', `Task added: "${variables.title}"`);

      // Notify the assignee if it's a specific user (not the person creating the task)
      const assigneeId = variables.assigned_to;
      if (assigneeId && assigneeId !== user?.id) {
        createNotification({
          userId: assigneeId,
          type: 'task_assigned',
          title: `New task assigned: "${variables.title}"`,
          message: `You have been assigned a task on ${project?.title || project?.property_address || 'a project'}`,
          projectId: projectId,
          projectName: project?.title || project?.property_address,
          entityType: 'task',
          entityId: created?.id,
          ctaUrl: 'ProjectDetails',
          ctaParams: { id: projectId },
          sourceUserId: user?.id,
          idempotencyKey: `task_assigned:${created?.id}`,
        }).catch(() => { /* non-critical */ });
      }

      // Log task creation to Team Pulse feed
      writeFeedEvent({
        eventType: 'task_created',
        category: 'task',
        severity: 'info',
        actorId: user?.id || null,
        actorName: user?.full_name || user?.email || null,
        title: `Task created: "${variables.title}"`,
        description: variables.assigned_to
          ? `Assigned to ${variables.assigned_to_name || 'a team member'}`
          : null,
        projectId: projectId,
        projectName: project?.title || project?.property_address,
        projectAddress: project?.property_address,
        projectStage: project?.status,
        entityType: 'task',
        entityId: created?.id,
      }).catch(() => {});

      // Info toast for onsite tasks created after upload
      if (variables.task_type === 'onsite' && UPLOADED_STAGES_FOR_CREATE.includes(project?.status)) {
        toast.info("Onsite task created after upload — remember to log effort manually", { duration: 4000 });
      } else {
        toast.success("Task added");
      }
    },
    onError: (err) => toast.error(err?.message || "Failed to create task"),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }) => {
      // Fix 3a — validate circular dependencies before saving
      if (data.depends_on_task_ids && data.depends_on_task_ids.length > 0) {
        try {
          const validation = await api.functions.invoke('validateTaskDependencies', {
            action: 'validate_add',
            task_id: id,
            project_id: projectId,
            depends_on_task_ids: data.depends_on_task_ids,
          });
          if (!validation.data?.valid) {
            throw new Error(validation.data?.error || 'Circular dependency detected — this would create a loop.');
          }
        } catch (err) {
          if (err.message?.includes('ircular') || err.message?.includes('loop')) throw err;
          // Validation service transient failure — don't block the save
        }
      }
      return api.entities.ProjectTask.update(id, data);
    },
    onSuccess: async (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['project-tasks', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      scheduleDeadlineSync(projectId, 'task_update');
      setEditingTask(null);
      toast.success("Task saved");

      // Notify new assignee if the assigned_to field was changed
      const newAssigneeId = variables?.data?.assigned_to;
      if (newAssigneeId && newAssigneeId !== user?.id) {
        createNotification({
          userId: newAssigneeId,
          type: 'task_assigned',
          title: `Task assigned to you: "${editingTask?.title || 'Task'}"`,
          message: `You've been assigned to a task on ${project?.title || project?.property_address || 'a project'}`,
          projectId: projectId,
          projectName: project?.title || project?.property_address,
          entityType: 'task',
          entityId: variables?.id,
          ctaUrl: 'ProjectDetails',
          ctaParams: { id: projectId },
          sourceUserId: user?.id,
        }).catch(() => { /* non-critical */ });
      }

      // If task was just completed, check if project qualifies for auto-archive
      if (variables?.data?.is_completed === true && project?.status === 'delivered' && project?.payment_status === 'paid') {
        api.functions.invoke('checkAndArchiveProject', {
          project_id: projectId, triggered_by: 'last_task_completed'
        }).catch(() => {});
      }
    },
    onError: (err) => {
      if (err?.message?.includes('ircular') || err?.message?.includes('loop')) {
        toast.error(err.message);
      } else {
        toast.error(err?.message || "Failed to update task");
      }
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id) => {
      // Preserve time logs but mark them as orphaned so they're excluded from active utilisation
      try {
        const timeLogs = await api.entities.TaskTimeLog.filter({ task_id: id }, null, 100);
        await Promise.all(timeLogs.map(log =>
          api.entities.TaskTimeLog.update(log.id, { task_deleted: true }).catch(() => {})
        ));
      } catch { /* non-fatal */ }
      await api.entities.ProjectTask.update(id, { is_deleted: true });
    },
    onSuccess: async (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['project-tasks', projectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      logActivity('task_deleted', `Task deleted: "${deleteConfirm?.title || ''}"`);

      // Clean up dependency references: remove deleted task ID from all dependents
      // and unblock them if they have no other incomplete dependencies
      const dependentTasks = Array.isArray(tasks)
        ? tasks.filter(t =>
            Array.isArray(t.depends_on_task_ids) &&
            t.depends_on_task_ids.includes(id)
          )
        : [];

      for (const t of dependentTasks) {
        const cleanedDeps = t.depends_on_task_ids.filter(depId => depId !== id);
        try {
          await api.entities.ProjectTask.update(t.id, {
            depends_on_task_ids: cleanedDeps,
          });
        } catch { /* non-fatal */ }

        // Notify assignee that their task is unblocked
        if (t.assigned_to && t.assigned_to !== user?.id && !t.is_completed) {
          createNotification({
            userId: t.assigned_to,
            type: 'task_dependency_unblocked',
            title: `Task unlocked: "${t.title || 'Task'}"`,
            message: `A dependency was removed. Your task on ${project?.title || project?.property_address || 'a project'} is now ready to start.`,
            projectId: projectId,
            projectName: project?.title || project?.property_address,
            entityType: 'task',
            entityId: t.id,
            ctaUrl: 'ProjectDetails',
            ctaParams: { id: projectId },
            sourceUserId: user?.id,
            idempotencyKey: `task_unblocked_by_delete:${t.id}:${id}`,
          }).catch(() => {});
        }
      }

      // Notify project owner when a task is deleted
      if (project?.project_owner_id && project.project_owner_id !== user?.id) {
        createNotification({
          userId: project.project_owner_id,
          type: 'task_completed',
          title: `Task removed: "${deleteConfirm?.title || 'Task'}"`,
          message: `A task was deleted from ${project?.title || project?.property_address || 'a project'}.`,
          projectId: projectId,
          projectName: project?.title || project?.property_address,
          entityType: 'task',
          ctaUrl: 'ProjectDetails',
          ctaParams: { id: projectId },
          sourceUserId: user?.id,
          idempotencyKey: `task_deleted:${id}:${user?.id}`,
        }).catch(() => {});
      }

      // Recalculate deadlines and blocking state for remaining tasks
      scheduleDeadlineSync(projectId, 'task_deleted');

      setDeleteConfirm(null);
      toast.success("Task deleted");
    },
    onError: (err) => { setDeleteConfirm(null); toast.error(err?.message || "Failed to delete task"); },
  });

  const UPLOADED_STAGES = ['uploaded', 'submitted', 'in_progress', 'in_production', 'ready_for_partial', 'in_revision', 'delivered'];

  const toggleComplete = async (task) => {
    if (!canEdit) return;
    if (isBlocked(task)) return;

    // Locked tasks cannot be toggled (e.g. onsite tasks auto-completed on upload)
    if (task.is_locked) {
      toast.info('This task is locked. Unlock it first to make changes.');
      return;
    }

    // Onsite tasks should be completed automatically by logOnsiteEffortOnUpload
    // when the project reaches 'uploaded'. Warn before manual override.
    if (task.task_type === 'onsite' && !task.is_completed) {
      if (!UPLOADED_STAGES.includes(project?.status)) {
        const confirmed = confirm("⚠️ This onsite task is normally auto-completed when the project reaches Uploaded.\n\nManual completion now will skip automatic time logging.\n\nContinue anyway?");
        if (!confirmed) return;
      }
    }

    try {
      await api.entities.ProjectTask.update(task.id, { is_completed: !task.is_completed });
      logActivity(
        task.is_completed ? 'task_added' : 'task_completed',
        task.is_completed
          ? `Task re-opened: "${task.title}"`
          : `Task completed: "${task.title}"`
      );

      if (!task.is_completed) {
        // task is now being marked complete (was false, now true)
        writeFeedEvent({
          eventType: 'task_completed',
          category: 'task',
          severity: 'info',
          actorId: user?.id || null,
          actorName: user?.full_name || user?.email || null,
          title: `Task completed: "${task.title}"`,
          projectId: projectId,
          projectName: project?.title || project?.property_address,
          projectAddress: project?.property_address,
          projectStage: project?.status,
          entityType: 'task',
          entityId: task.id,
        }).catch(() => {});

        // Notify project owner (but not the person who just completed it)
        if (project?.project_owner_id && project.project_owner_id !== user?.id) {
          createNotification({
            userId: project.project_owner_id,
            type: 'task_completed',
            title: `Task completed: "${task.title || 'Task'}"`,
            message: `${user?.full_name || 'Someone'} completed a task on ${project?.title || project?.property_address || 'a project'}.`,
            projectId: projectId,
            projectName: project?.title || project?.property_address,
            entityType: 'task',
            entityId: task.id,
            ctaUrl: 'ProjectDetails',
            ctaParams: { id: projectId },
            sourceUserId: user?.id,
            idempotencyKey: `task_completed:${task.id}:${user?.id}`,
          }).catch(() => {});
        }
      }

      scheduleDeadlineSync(projectId, 'task_completed');
    } catch (err) {
      toast.error(err.message || "Failed to update task");
    }
  };

  const requestDelete = (id) => {
    if (!Array.isArray(tasks)) return;
    const task = tasks.find(t => t?.id === id);
    const dependents = tasks.filter(t => Array.isArray(t?.depends_on_task_ids) && t.depends_on_task_ids.includes(id));
    setDeleteConfirm({ id, title: task?.title || '', dependentNames: dependents.map(t => t?.title || 'Untitled').filter(Boolean) });
  };



  const completedCount = tasks.filter(t => t.is_completed).length;
  const progress = tasks.length > 0 ? Math.round((completedCount / tasks.length) * 100) : 0;

  const isBlocked = (task) => {
    // Use is_blocked flag from database which is synced via deadline calculation
    return task.is_blocked === true;
  };

  if (isLoading) return <div className="py-8 text-center text-sm text-muted-foreground">Loading tasks...</div>;

  // Enrich all tasks
  const enrichedTasks = Array.isArray(tasks) ? tasks.map(task => ({
    ...task,
    _depTasks: Array.isArray(task?.depends_on_task_ids) 
      ? task.depends_on_task_ids.map(depId => tasks.find(t => t?.id === depId)).filter(Boolean)
      : [],
    _depBlockingTasks: tasks.filter(t => Array.isArray(t?.depends_on_task_ids) && t.depends_on_task_ids.includes(task?.id) && !t?.is_completed)
  })) : [];

  return (
    <div className="space-y-4">
      {tasks.length > 0 && (
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex-1 min-w-32">
            <div className="bg-muted rounded-full h-2 overflow-hidden">
              <div className="h-2 bg-primary rounded-full transition-all" style={{ width: `${progress}%` }} />
            </div>
            <span className="text-xs text-muted-foreground font-medium mt-1 block">
              {completedCount}/{tasks.length} done
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Select value={sortBy} onValueChange={setSortBy}>
              <SelectTrigger className="h-8 w-32 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="workflow">Workflow</SelectItem>
                <SelectItem value="urgency">Urgency</SelectItem>
              </SelectContent>
            </Select>
            
          </div>
        </div>
      )}

      {/* Task View */}
      {tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">No tasks yet.</p>
      ) : (
        <TaskListView
          tasks={tasks}
          enrichedTasks={enrichedTasks}
          canEdit={canEdit}
          onToggle={toggleComplete}
          onEdit={setEditingTask}
          onDelete={requestDelete}
          onUpdateDeadline={(id, data) => updateMutation.mutate({ id, data })}
          thresholds={thresholds}
          taskChatCounts={taskChatCounts}
          projectId={projectId}
          project={project}
          user={user}
          products={products}
          groupBy={sortBy === "urgency" ? "urgency" : "product"}
          revisions={revisions}
        />
      )}

      {canEdit && (
        <Button variant="outline" size="sm" className="w-full" onClick={() => setShowAddDialog(true)}>
          <Plus className="h-4 w-4 mr-1" /> Add Task
        </Button>
      )}

      {/* Add Task Dialog */}
      <Dialog open={showAddDialog} onOpenChange={(open) => {
        setShowAddDialog(open);
        if (!open) setNewTask({ title: "", description: "", task_type: "back_office", assigned_to: "", assigned_to_name: "", due_date: null });
      }}>
        <DialogContent className="max-w-md" onKeyDown={(e) => {
          if (e.key === 'Escape') setShowAddDialog(false);
          if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (newTask.title?.trim()) createMutation.mutate({ ...newTask, task_type: newTask.task_type || "back_office" }); }
        }}>
          <DialogHeader><DialogTitle>Add Task</DialogTitle></DialogHeader>
          <div className="space-y-3">
             <Input placeholder="Task title *" value={newTask.title} onChange={e => setNewTask(p => ({ ...p, title: e.target.value }))} autoFocus />
             <Textarea placeholder="Description (optional)" value={newTask.description || ""} onChange={e => setNewTask(p => ({ ...p, description: e.target.value }))} rows={2} maxLength={500} />
             <p className="text-xs text-muted-foreground text-right">{(newTask.description || "").length}/500</p>
             <div>
               <label className="text-xs font-medium block mb-1.5">Task Type</label>
               <Select value={newTask.task_type || "back_office"} onValueChange={v => setNewTask(p => ({ ...p, task_type: v }))}>
                 <SelectTrigger className="h-8 text-sm">
                   <SelectValue />
                 </SelectTrigger>
                 <SelectContent>
                   <SelectItem value="onsite">Onsite</SelectItem>
                   <SelectItem value="back_office">Back Office</SelectItem>
                 </SelectContent>
               </Select>
             </div>
             <AssigneeSelector value={{ id: newTask.assigned_to, name: newTask.assigned_to_name, teamId: newTask.assigned_to_team_id, teamName: newTask.assigned_to_team_name }} users={users} teams={teams} onChange={v => setNewTask(p => ({ ...p, assigned_to: v.id || "", assigned_to_name: v.name || "", assigned_to_team_id: v.teamId || "", assigned_to_team_name: v.teamName || "" }))} />
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="w-full justify-start text-left">
                  <CalendarIcon className="h-4 w-4 mr-2" />
                  {newTask.due_date ? new Date(newTask.due_date).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', month: 'short', day: 'numeric', year: 'numeric' }) : "Set due date (optional)"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={newTask.due_date ? new Date(newTask.due_date) : undefined}
                  onSelect={(date) => {
                    if (!date) { setNewTask(p => ({ ...p, due_date: null })); return; }
                    // Set deadline to 11:59 PM Sydney on selected day
                    const utc = wallClockToUTC(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 0, 'Australia/Sydney');
                    setNewTask(p => ({ ...p, due_date: utc.toISOString() }));
                  }}
                />
              </PopoverContent>
            </Popover>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddDialog(false)} disabled={createMutation.isPending}>Cancel</Button>
            <Button 
              disabled={!newTask.title?.trim() || createMutation.isPending} 
              onClick={() => createMutation.mutate({ ...newTask, task_type: newTask.task_type || "back_office" })} 
              title="Ctrl+S to save"
              className="shadow-sm hover:shadow-md transition-shadow"
            >
              {createMutation.isPending ? "Adding..." : "Add Task"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Task Dialog */}
      {editingTask && (
        <Dialog open={!!editingTask} onOpenChange={(open) => { if (!open) setEditingTask(null); }}>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>Edit Task</DialogTitle></DialogHeader>
            <div className="space-y-3">
               <Input value={editingTask.title || ""} onChange={e => setEditingTask(p => ({ ...p, title: e.target.value }))} />
               <Textarea value={editingTask.description || ""} onChange={e => setEditingTask(p => ({ ...p, description: e.target.value }))} rows={2} maxLength={500} />
               <p className="text-xs text-muted-foreground text-right">{(editingTask.description || "").length}/500</p>
               <div>
                 <label className="text-xs font-medium block mb-1.5">Task Type</label>
                 <Select value={editingTask.task_type || "back_office"} onValueChange={v => setEditingTask(p => p ? { ...p, task_type: v } : null)}>
                   <SelectTrigger className="h-8 text-sm">
                     <SelectValue />
                   </SelectTrigger>
                   <SelectContent>
                     <SelectItem value="onsite">Onsite</SelectItem>
                     <SelectItem value="back_office">Back Office</SelectItem>
                   </SelectContent>
                 </Select>
               </div>
               <AssigneeSelector value={{ id: editingTask.assigned_to || "", name: editingTask.assigned_to_name || "", teamId: editingTask.assigned_to_team_id || "", teamName: editingTask.assigned_to_team_name || "" }} users={users} teams={teams} onChange={v => setEditingTask(p => p ? { ...p, assigned_to: v.id || "", assigned_to_name: v.name || "", assigned_to_team_id: v.teamId || "", assigned_to_team_name: v.teamName || "" } : null)} />
              <div>
                <label className="text-xs font-medium block mb-1.5">
                  Depends on
                  {(editingTask.depends_on_task_ids?.length ?? 0) > 0 && (
                    <button
                      className="ml-2 text-[10px] text-muted-foreground underline hover:text-foreground"
                      onClick={() => setEditingTask(p => ({ ...p, depends_on_task_ids: [] }))}
                    >
                      clear all
                    </button>
                  )}
                </label>
                <div className="border rounded-md max-h-32 overflow-y-auto divide-y">
                  {tasks.filter(t => t.id !== editingTask.id).length === 0 ? (
                    <p className="text-xs text-muted-foreground px-3 py-2">No other tasks</p>
                  ) : (
                    tasks
                      .filter(t => t.id !== editingTask.id)
                      .map(t => {
                        const checked = editingTask.depends_on_task_ids?.includes(t.id) ?? false;
                        return (
                          <label
                            key={t.id}
                            className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-muted/40 transition-colors"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => {
                                setEditingTask(p => {
                                  const current = p.depends_on_task_ids || [];
                                  return {
                                    ...p,
                                    depends_on_task_ids: checked
                                      ? current.filter(id => id !== t.id)
                                      : [...current, t.id],
                                  };
                                });
                              }}
                              className="accent-primary w-3.5 h-3.5"
                            />
                            <span className="flex-1 truncate" title={t.title}>{t.title}</span>
                            <span className="shrink-0 text-muted-foreground">
                              {t.is_completed ? "✓" : t.is_blocked ? "🔒" : ""}
                            </span>
                          </label>
                        );
                      })
                  )}
                </div>
              </div>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-start text-left">
                    <CalendarIcon className="h-4 w-4 mr-2" />
                    {editingTask.due_date ? new Date(editingTask.due_date).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : "Set due date (optional)"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={editingTask?.due_date ? new Date(editingTask.due_date) : undefined}
                    onSelect={(date) => {
                      if (!date) { setEditingTask(p => p ? { ...p, due_date: null } : null); return; }
                      const utc = wallClockToUTC(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 0, 'Australia/Sydney');
                      setEditingTask(p => p ? { ...p, due_date: utc.toISOString() } : null);
                    }}
                  />
                </PopoverContent>
              </Popover>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditingTask(null)}>Cancel</Button>
              <Button 
                disabled={!editingTask?.title?.trim() || updateMutation.isPending} 
                onClick={() => editingTask && updateMutation.mutate({ id: editingTask.id, data: { title: editingTask.title, description: editingTask.description, task_type: editingTask.task_type || "back_office", assigned_to: editingTask.assigned_to, assigned_to_name: editingTask.assigned_to_name, assigned_to_team_id: editingTask.assigned_to_team_id, assigned_to_team_name: editingTask.assigned_to_team_name, due_date: editingTask.due_date, depends_on_task_ids: editingTask.depends_on_task_ids || [], is_manually_set_due_date: !!editingTask.due_date } })}
                className="shadow-sm hover:shadow-md transition-shadow"
              >
                {updateMutation.isPending ? "Saving..." : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      <ConfirmDialog
        open={!!deleteConfirm}
        danger
        title="Delete Task?"
        description={
          deleteConfirm?.dependentNames?.length > 0
            ? `This task is a dependency for ${deleteConfirm.dependentNames.length} other task(s):\n${deleteConfirm.dependentNames.map(n => `• ${n}`).join('\n')}\n\nDeleting it will unblock those tasks immediately. Continue?`
            : "This task will be permanently deleted."
        }
        confirmText={deleteMutation.isPending ? "Deleting…" : "Delete"}
        onConfirm={() => deleteConfirm && deleteMutation.mutate(deleteConfirm.id)}
        onCancel={() => setDeleteConfirm(null)}
      />
    </div>
  );
}



function AssigneeSelector({ value, users, teams, onChange }) {
  return (
    <Select
      value={value?.teamId ? `team:${value.teamId}` : value?.id ? `user:${value.id}` : "none"}
      onValueChange={v => {
        if (v === "none") { onChange({ id: "", name: "", teamId: "", teamName: "" }); return; }
        const [type, id] = v.split(":");
        if (type === "user") {
          const u = users.find(u => u.id === id);
          onChange({ id, name: u?.full_name || "", teamId: "", teamName: "" });
        } else {
          const t = teams.find(t => t.id === id);
          onChange({ id: "", name: "", teamId: id, teamName: t?.name || "" });
        }
      }}
    >
      <SelectTrigger className="h-8 text-sm">
        <SelectValue placeholder="Assign to..." />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">Unassigned</SelectItem>
        {users.length > 0 && (
          <>
            <div className="px-2 py-1 text-xs font-semibold text-muted-foreground">Users</div>
            {users.map(u => <SelectItem key={u.id} value={`user:${u.id}`}>{u.full_name}</SelectItem>)}
          </>
        )}
        {teams.length > 0 && (
          <>
            <div className="px-2 py-1 text-xs font-semibold text-muted-foreground">Teams</div>
            {teams.map(t => <SelectItem key={t.id} value={`team:${t.id}`}>{t.name}</SelectItem>)}
          </>
        )}
      </SelectContent>
    </Select>
  );
}