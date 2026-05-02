import React, { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Circle, Lock, CalendarIcon, Trash2, AlertTriangle, ClockIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { CountdownTimer, CompletionTimer, getCountdownState } from "./taskTimers";
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
  revision: { color: "bg-red-50 border-red-200 text-red-700 dark:bg-red-950/30 dark:border-red-800 dark:text-red-300" },
  change_request: { color: "bg-purple-50 border-purple-200 text-purple-700 dark:bg-purple-950/30 dark:border-purple-800 dark:text-purple-300" },
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

const REVISION_KIND_BORDER = {
  revision: "border-l-4 border-l-red-600 border-t border-r border-b border-t-red-200 border-r-red-200 border-b-red-200 bg-red-50/40 dark:border-t-red-900/60 dark:border-r-red-900/60 dark:border-b-red-900/60 dark:bg-red-950/20",
  change_request: "border-l-4 border-l-purple-600 border-t border-r border-b border-t-purple-200 border-r-purple-200 border-b-purple-200 bg-purple-50/40 dark:border-t-purple-900/60 dark:border-r-purple-900/60 dark:border-b-purple-900/60 dark:bg-purple-950/20",
};

const getTaskRowColor = (task, revisionKind) => {
  if (task.is_completed) return "bg-green-50 border-green-200 dark:bg-green-950/30 dark:border-green-800";
  if (revisionKind && !task.is_blocked) return REVISION_KIND_BORDER[revisionKind] || "border-l-4 border-l-red-500 border border-red-200 bg-red-50/40 dark:border-red-800 dark:bg-red-950/20";
  if (task.is_blocked) return "bg-orange-50 border-orange-200 dark:bg-orange-950/30 dark:border-orange-800";
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
  packages = [],
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
    return product?.name || "Product";
  };

  const getProductById = (productId) => {
    return products.find(p => p.id === productId);
  };

  const getPackageName = (packageId) => {
    const pkg = packages.find(p => p.id === packageId);
    return pkg?.name || "Package";
  };

  // Build a map: revision_id -> revision object (for FK-based lookup, post-356)
  const revisionById = {};
  revisions.forEach(r => {
    revisionById[r.id] = r;
  });
  // Legacy: fallback map for any unbackfilled rows that still rely on the
  // [Revision #N] title prefix.
  const revisionByNumber = {};
  revisions.forEach(r => {
    revisionByNumber[r.revision_number] = r;
  });

  // Resolve a task to its revision via FK first, falling back to the legacy
  // title-prefix shape. Returns null when the task is not part of any request.
  const getTaskRevision = (task) => {
    if (task.revision_id && revisionById[task.revision_id]) {
      return revisionById[task.revision_id];
    }
    const match = task.title?.match(/^\[Revision #(\d+)\]/);
    if (match) {
      const num = parseInt(match[1], 10);
      return revisionByNumber[num] || null;
    }
    return null;
  };

  // Group tasks into the four canonical levels: product, package, project, request.
  // Requests get one group PER revision so multiple requests of the same media
  // type don't visually collapse into a single bucket.
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
        const rev = getTaskRevision(task);
        let key;
        if (rev) {
          key = `__request__${rev.id}`;
        } else if (task.product_id) {
          key = `__product__${task.product_id}`;
        } else if (task.package_id) {
          key = `__package__${task.package_id}`;
        } else {
          key = `__project__`;
        }
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(task);
      });

      // Stable display order: products → packages → project → requests
      // (requests sorted by revision_number ascending).
      const sortedEntries = Object.entries(grouped).sort(([a], [b]) => {
        const rank = (k) => {
          if (k.startsWith("__product__")) return 0;
          if (k.startsWith("__package__")) return 1;
          if (k === "__project__") return 2;
          if (k.startsWith("__request__")) return 3;
          return 4;
        };
        const ra = rank(a), rb = rank(b);
        if (ra !== rb) return ra - rb;
        if (a.startsWith("__request__")) {
          const revA = revisionById[a.replace("__request__", "")];
          const revB = revisionById[b.replace("__request__", "")];
          return (revA?.revision_number || 0) - (revB?.revision_number || 0);
        }
        return 0;
      });
      return Object.fromEntries(sortedEntries);
    }
    return { "Tasks": enrichedTasks };
  };

  const grouped = groupTasks();
  const isExpanded = (taskId) => expandedTaskId === taskId;
  const toggleExpanded = (taskId) => setExpandedTaskId(isExpanded(taskId) ? null : taskId);

  return (
    <div className="space-y-3">
      {Object.entries(grouped).map(([groupKey, groupedTasks]) => {
        const isRequestGroup = groupKey.startsWith("__request__");
        const isProductGroup = groupKey.startsWith("__product__");
        const isPackageGroup = groupKey.startsWith("__package__");
        const isProjectGroup = groupKey === "__project__";

        const requestRev = isRequestGroup ? revisionById[groupKey.replace("__request__", "")] : null;
        const productId = isProductGroup ? groupKey.replace("__product__", "") : null;
        const packageId = isPackageGroup ? groupKey.replace("__package__", "") : null;

        const revTypeConfig = requestRev ? REVISION_TYPE_CONFIG[requestRev.revision_type] : null;
        const revKindConfig = requestRev ? REVISION_KIND_CONFIG[requestRev.request_kind || "revision"] : null;
        const isChangeRequest = requestRev?.request_kind === "change_request";
        return (
        <div key={groupKey} className="space-y-1.5">
           {(groupBy === "product" || groupBy === "urgency") && (
             <div className="space-y-1">
               {isRequestGroup ? (
                 <p className={`text-xs font-medium px-2 py-1 rounded border flex items-center gap-1.5 ${revKindConfig?.color || "bg-muted/40 text-muted-foreground"}`}>
                   <span>{revTypeConfig?.icon}</span>
                   {isChangeRequest ? "Change Request" : "Revision"} #{requestRev?.revision_number} — {revTypeConfig?.label}
                   {requestRev?.title && <span className="font-normal opacity-80">· {requestRev.title}</span>}
                 </p>
               ) : isProductGroup ? (
                 <>
                   <p className="text-xs font-medium text-muted-foreground px-1 py-1 bg-muted/40 rounded">
                     {getProductName(productId)}
                   </p>
                   <ProductBrandingSummary product={getProductById(productId)} agency={project?.agency} />
                 </>
               ) : isPackageGroup ? (
                 <p className="text-xs font-medium text-muted-foreground px-1 py-1 bg-indigo-50 dark:bg-indigo-950/30 rounded">
                   📦 {getPackageName(packageId)}
                 </p>
               ) : isProjectGroup ? (
                 <p className="text-xs font-medium text-muted-foreground px-1 py-1 bg-muted/40 rounded">
                   Project-level tasks
                 </p>
               ) : null}
             </div>
           )}
          <div className="space-y-1">
            {groupedTasks.map(task => {
              const rev = getTaskRevision(task);
              // Strip the legacy [Revision #N] prefix when present so old rows
              // display cleanly alongside new ones (which never carry it).
              const cleanTitle = task.title?.replace(/^\[Revision #\d+\]\s*/, "") || task.title;
              const revNum = rev?.revision_number ?? null;
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