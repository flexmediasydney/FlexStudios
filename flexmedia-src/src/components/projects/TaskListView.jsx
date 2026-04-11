import React, { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Circle, Lock, CalendarIcon, Trash2, AlertTriangle, ClockIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { CountdownTimer, CompletionTimer, getCountdownState } from "./TaskManagement";
import TaskDetailPanel from "./TaskDetailPanel";
import ProductBrandingSummary from "./ProductBrandingSummary";
import TaskEffortBadge from "./TaskEffortBadge";
import { useEntityList } from "@/components/hooks/useEntityData";

const REVISION_TYPE_CONFIG = {
  images:    { label: "Images",    icon: "📷" },
  drones:    { label: "Drones",    icon: "🚁" },
  floorplan: { label: "Floorplan", icon: "📐" },
  video:     { label: "Video",     icon: "🎬" },
};

const REVISION_KIND_CONFIG = {
  revision: { color: "bg-red-50 border-red-200 text-red-700" },
  change_request: { color: "bg-purple-50 border-purple-200 text-purple-700" },
};

const getProgressPercentage = (task) => {
  if (!task.due_date) return 0;
  // Use task_start_time (when task unlocked) or created_date as fallback
  const startTime = task.task_start_time || task.created_date;
  if (!startTime) return 0;
  const start = new Date(startTime).getTime();
  const due = new Date(task.due_date).getTime();
  const now = Date.now();
  const total = due - start;
  const elapsed = Math.max(0, now - start);
  return total > 0 ? Math.min(100, (elapsed / total) * 100) : 0;
};

const isRevisionTask = (task) => /^\[Revision #\d+\]/.test(task.title || "");

const REVISION_KIND_BORDER = {
  revision: "border-l-4 border-l-red-600 border-t border-r border-b border-t-red-200 border-r-red-200 border-b-red-200 bg-red-50/40",
  change_request: "border-l-4 border-l-purple-600 border-t border-r border-b border-t-purple-200 border-r-purple-200 border-b-purple-200 bg-purple-50/40",
};

const getTaskRowColor = (task, revisionKind) => {
  if (task.is_completed) return "bg-green-50 border-green-200";
  if (revisionKind && !task.is_blocked) return REVISION_KIND_BORDER[revisionKind] || "border-l-4 border-l-red-500 border border-red-200 bg-red-50/40";
  if (task.is_blocked) return "bg-orange-50 border-orange-200";
  return "bg-card border-border";
};

export default function TaskListView({
  tasks,
  enrichedTasks,
  canEdit,
  onToggle,
  onEdit,
  onDelete,
  onUpdateDeadline,
  thresholds,
  projectId,
  project,
  user,
  products = [],
  groupBy = "product",
  revisions = []
}) {
  const [expandedTaskId, setExpandedTaskId] = useState(null);

  // Live time logs for actual effort per task (real-time subscription via useEntityList)
  const { data: projectTimeLogs = [] } = useEntityList(
    'TaskTimeLog', null, 500,
    projectId ? { project_id: projectId } : null
  );

  // Build a map: task_id -> actual logged seconds
  const actualSecondsByTask = {};
  projectTimeLogs.filter(log => !log.task_deleted).forEach(log => {
    if (!log.task_id) return;
    let secs = 0;
    if (log.status === 'completed' || !log.is_active) {
      secs = Math.max(0, log.total_seconds || 0);
    } else if (log.status === 'paused') {
      secs = Math.max(0, log.total_seconds || 0);
    } else if (log.status === 'running' && log.start_time) {
      secs = Math.max(0, Math.floor((Date.now() - new Date(log.start_time).getTime()) / 1000) - (log.paused_duration || 0));
    }
    actualSecondsByTask[log.task_id] = (actualSecondsByTask[log.task_id] || 0) + secs;
  });

  const getProductName = (productId) => {
    const product = products.find(p => p.id === productId);
    return product?.name || "Other Tasks";
  };

  const getProductById = (productId) => {
    return products.find(p => p.id === productId);
  };

  // Build a map: revision_number -> revision object
  const revisionByNumber = {};
  revisions.forEach(r => {
    revisionByNumber[r.revision_number] = r;
  });

  // Detect if a task belongs to a revision
  const getRevisionNumber = (task) => {
    const match = task.title?.match(/^\[Revision #(\d+)\]/);
    return match ? parseInt(match[1], 10) : null;
  };

  const groupTasks = () => {
    if (groupBy === "urgency") {
      const sorted = [...enrichedTasks].sort((a, b) => {
        const aTime = a.due_date ? new Date(a.due_date).getTime() : Infinity;
        const bTime = b.due_date ? new Date(b.due_date).getTime() : Infinity;
        return aTime - bTime;
      });
      return { "Tasks (by urgency)": sorted };
    }
    if (groupBy === "product") {
      const grouped = {};
      enrichedTasks.forEach(task => {
        const revNum = getRevisionNumber(task);
        if (revNum !== null) {
          const rev = revisionByNumber[revNum];
          const revType = rev?.revision_type || "images";
          const revKind = rev?.request_kind || "revision"; // Get revision or change_request
          const key = `__revision__${revType}__${revKind}`;
          if (!grouped[key]) grouped[key] = [];
          grouped[key].push(task);
        } else {
          const key = task.product_id || "Uncategorized";
          if (!grouped[key]) grouped[key] = [];
          grouped[key].push(task);
        }
      });
      return grouped;
    }
    return { "Tasks": enrichedTasks };
  };

  const grouped = groupTasks();
  const isExpanded = (taskId) => expandedTaskId === taskId;
  const toggleExpanded = (taskId) => setExpandedTaskId(isExpanded(taskId) ? null : taskId);

  return (
    <div className="space-y-3">
      {Object.entries(grouped).map(([groupKey, groupedTasks]) => {
        const isRevisionGroup = groupKey.startsWith("__revision__");
        const [revisionType, revisionKind] = isRevisionGroup ? groupKey.replace("__revision__", "").split("__") : [null, null];
        const revTypeConfig = revisionType ? REVISION_TYPE_CONFIG[revisionType] : null;
        const revKindConfig = revisionKind ? REVISION_KIND_CONFIG[revisionKind] : null;
        return (
        <div key={groupKey} className="space-y-1.5">
           {(groupBy === "product" || groupBy === "urgency") && (
             <div className="space-y-1">
               {isRevisionGroup ? (
                 <p className={`text-xs font-medium px-2 py-1 rounded border flex items-center gap-1.5 ${revKindConfig?.color || "bg-muted/40 text-muted-foreground"}`}>
                   <span>{revTypeConfig?.icon}</span>
                   {revisionKind === "change_request" ? "Change Request" : "Revision"} Tasks — {revTypeConfig?.label}
                 </p>
               ) : (
                 <>
                   <p className="text-xs font-medium text-muted-foreground px-1 py-1 bg-muted/40 rounded">
                     {groupBy === "product" ? getProductName(groupKey) : groupKey}
                   </p>
                   {groupBy === "product" && (
                     <ProductBrandingSummary product={getProductById(groupKey)} agency={project?.agency} />
                   )}
                 </>
               )}
             </div>
           )}
          <div className="space-y-1">
            {groupedTasks.map(task => {
              const revNum = getRevisionNumber(task);
              const cleanTitle = revNum !== null ? task.title.replace(/^\[Revision #\d+\]\s*/, "") : task.title;
              const rev = revNum !== null ? revisionByNumber[revNum] : null;
              const revType = rev?.revision_type || null;
              const revKind = rev?.request_kind || null;
              const revTypeConfig = revType ? REVISION_TYPE_CONFIG[revType] : null;
              return (
              <div key={task.id} className="space-y-0">
                {/* Minimal Task Row */}
                <div
                   onClick={() => toggleExpanded(task.id)}
                   className={cn(
                     "flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-all",
                     getTaskRowColor(task, revKind),
                     isExpanded(task.id) && !revKind && "border-primary"
                   )}
                 >
                  {/* Status Icon */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggle(task);
                    }}
                    disabled={!canEdit || task.is_blocked || task.task_type === "onsite"}
                    className="flex-shrink-0"
                    title={task.is_completed ? "Mark as incomplete" : task.is_blocked ? "Blocked by dependencies" : task.task_type === "onsite" ? "Onsite tasks are auto-completed" : "Mark as complete"}
                    aria-label={task.is_completed ? `Mark "${task.title}" as incomplete` : task.is_blocked ? `Task "${task.title}" is blocked` : `Mark "${task.title}" as complete`}
                  >
                    {task.is_completed ? (
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                    ) : task.is_blocked ? (
                      <Lock className="h-4 w-4 text-orange-400" />
                    ) : (
                      <Circle className="h-4 w-4 text-muted-foreground" />
                    )}
                  </button>

                  {/* Title */}
                   <div className="flex-1 min-w-0">
                     <div className="flex items-center gap-1.5">
                       {revTypeConfig && !task.is_completed && (
                         <span className="text-sm flex-shrink-0" title={`${revKind === "change_request" ? "Change Request" : "Revision"} — ${revTypeConfig.label}`}>{revTypeConfig.icon}</span>
                       )}
                       <p className={cn("text-sm font-medium truncate", task.is_completed && "line-through text-muted-foreground")} title={cleanTitle}>
                         {cleanTitle}
                       </p>
                     </div>
                     {rev && (
                       <p className="text-xs text-muted-foreground truncate" title={`Revision #${revNum}: ${rev.title}`}>Rev #{revNum} · {rev.title}</p>
                     )}
                   </div>

                  {/* Quick Info */}
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {/* Effort badge (compact) - show if task has an estimate */}
                    {(task.estimated_minutes > 0 || actualSecondsByTask[task.id] > 0) && (
                      <TaskEffortBadge
                        estimatedMinutes={task.estimated_minutes || 0}
                        actualSeconds={actualSecondsByTask[task.id] || 0}
                        compact
                      />
                    )}

                    {/* Deadline indicator */}
                    {task.due_date && !task.is_completed && (
                      <CountdownTimer dueDate={task.due_date} compact thresholds={thresholds} />
                    )}

                    {/* Expand arrow */}
                    <span className={cn("text-xs text-muted-foreground transition-transform", isExpanded(task.id) && "rotate-180")}>
                      ▼
                    </span>
                  </div>
                </div>

                {/* Expanded Details */}
                {isExpanded(task.id) && (
                  <TaskDetailPanel
                    task={task}
                    canEdit={canEdit}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onUpdateDeadline={onUpdateDeadline}
                    thresholds={thresholds}
                    projectId={projectId}
                    project={project}
                    user={user}
                    onClose={() => setExpandedTaskId(null)}
                  />
                )}
              </div>
              );
            })}
          </div>
        </div>
        );
      })}
    </div>
  );
                }