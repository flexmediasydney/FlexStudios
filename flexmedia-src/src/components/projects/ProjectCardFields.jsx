import { memo } from "react";
import { Badge } from "@/components/ui/badge";
import { Calendar, Clock, User, Building, DollarSign, Flag, CheckSquare, ExternalLink, FileText, CreditCard, CheckCircle2, Package } from "lucide-react";
import { usePriceGate } from '@/components/auth/RoleGate';
import { fmtDate, fmtTimestampCustom } from "@/components/utils/dateUtils";
import { CountdownTimer } from "./TaskManagement";
import ProjectStatusTimer from "./ProjectStatusTimer";
import { stageConfig } from "./projectStatuses";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import ProjectCardEffort from "./ProjectCardEffort";

const priorityColors = {
  low: "bg-slate-100 text-slate-600",
  normal: "bg-blue-100 text-blue-600",
  high: "bg-amber-100 text-amber-700",
  urgent: "bg-red-100 text-red-600"
};

const outcomeColors = {
  open: "bg-blue-100 text-blue-700",
  won: "bg-green-100 text-green-700",
  lost: "bg-red-100 text-red-700"
};

const paymentColors = {
  unpaid: "bg-amber-100 text-amber-700",
  paid: "bg-green-100 text-green-700"
};

// Mirrors src/components/settings/RoleTaskMatrix.jsx — kept inline so the
// card field stays self-contained.
const CATEGORY_LABELS = {
  photography: "Photography",
  video: "Video",
  drone: "Drone",
  floorplan: "Floorplan",
  editing: "Editing",
  virtual_staging: "Virtual Staging",
  other: "Other",
};

const CATEGORY_ORDER = ["photography", "video", "drone", "floorplan", "virtual_staging", "editing", "other"];

const CATEGORY_BAR_COLORS = {
  photography: "bg-blue-500",
  video: "bg-rose-500",
  drone: "bg-indigo-500",
  floorplan: "bg-cyan-500",
  virtual_staging: "bg-purple-500",
  editing: "bg-emerald-500",
  other: "bg-slate-400",
};

/**
 * Renders a single field row for a project card.
 * Shared across Kanban, Grid, and List views.
 */
// Memoized so a 1Hz running-timer tick (or any single-card mutation) only
// re-renders the affected card field row, not all 200 × N field rows on the
// Kanban / project list. Pure render — no internal state.
export const ProjectFieldValue = memo(function ProjectFieldValue({ fieldId, project, products = [], packages = [], tasks = [], timeLogs = [] }) {
  const { visible: showPricing } = usePriceGate();
  switch (fieldId) {
    case "agency_name": {
      const name = project.client_name || project.agency_name;
      if (!name) return null;
      return (
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground min-w-0">
          <Building className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="truncate max-w-[160px]" title={name}>{name}</span>
        </div>
      );
    }
    case "agent_name": {
      if (!project.agent_id && !project.agent_name) return null;
      const agentName = project.agent_name;
      if (!agentName) return null;
      return (
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground min-w-0">
          <User className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="truncate max-w-[140px]" title={agentName}>{agentName}</span>
        </div>
      );
    }
    case "shoot_date": {
      if (!project.shoot_date) return null;
      return (
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Calendar className="h-3.5 w-3.5 flex-shrink-0" />
          <span>{fmtDate(project.shoot_date, 'MMM d, yyyy')}</span>
        </div>
      );
    }
    case "shoot_time": {
      if (!project.shoot_time) return null;
      return (
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Clock className="h-3.5 w-3.5 flex-shrink-0" />
          <span>{project.shoot_time}</span>
        </div>
      );
    }
    case "delivery_date": {
      if (!project.delivery_date) return null;
      return (
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Calendar className="h-3.5 w-3.5 flex-shrink-0" />
          <span>Delivery: {fmtDate(project.delivery_date, 'MMM d, yyyy')}</span>
        </div>
      );
    }
    case "price": {
      if (!showPricing) return null;
      const displayPrice = project.calculated_price || project.price;
      if (!displayPrice) return null;
      return (
        <div className="flex items-center gap-1.5 text-sm font-semibold tabular-nums justify-end">
          <span className="text-muted-foreground font-normal">$</span>
          <span>{Number(displayPrice).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
      );
    }
    case "priority": {
      if (!project.priority || project.priority === "normal") return null;
      return (
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium capitalize ${priorityColors[project.priority] || priorityColors.normal}`}>
          <Flag className="h-3 w-3" aria-hidden="true" />
          {project.priority}
        </span>
      );
    }
    case "property_type": {
      if (!project.property_type) return null;
      return (
        <Badge variant="outline" className="text-xs capitalize">
          {project.property_type.replaceAll("_", " ")}
        </Badge>
      );
    }
    case "products": {
      const items = (project.products || [])
        .map(item => products.find(p => p.id === (item.product_id || item))?.name)
        .filter(Boolean);
      if (!items.length) return null;
      return (
        <div className="flex flex-wrap gap-1">
          {items.slice(0, 3).map((name, i) => (
            <Badge key={i} variant="outline" className="text-xs">{name}</Badge>
          ))}
          {items.length > 3 && <Badge variant="outline" className="text-xs">+{items.length - 3}</Badge>}
        </div>
      );
    }
    case "packages": {
      const items = (project.packages || [])
        .map(item => packages.find(p => p.id === (item.package_id || item))?.name)
        .filter(Boolean);
      if (!items.length) return null;
      return (
        <div className="flex flex-wrap gap-1">
          {items.slice(0, 2).map((name, i) => (
            <Badge key={i} variant="secondary" className="text-xs">📦 {name}</Badge>
          ))}
          {items.length > 2 && <Badge variant="secondary" className="text-xs">+{items.length - 2}</Badge>}
        </div>
      );
    }
    case "status_timer": {
      if (!project.last_status_change) return null;
      return <ProjectStatusTimer lastStatusChange={project.last_status_change} />;
    }
    case "tasks": {
       const allRegularTasks = tasks.filter(t => !t.is_deleted && !t.is_archived && !t.revision_id && !/^\[Revision #\d+\]/.test(t.title || ""));
       const activeTasks = allRegularTasks.filter(t => !t.is_completed);
       const completedTasks = allRegularTasks.filter(t => t.is_completed);
       const total = allRegularTasks.length;
       if (total === 0) return null;

       return (
         <div className="space-y-1.5">
           {/* Progress summary row */}
           <div className="flex items-center gap-2">
             <div className="flex items-center gap-1 text-xs text-muted-foreground">
               <CheckSquare className="h-3 w-3" />
               <span className="font-medium">{completedTasks.length}/{total}</span>
               <span>tasks done</span>
             </div>
             {total > 0 && (
               <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                 <div
                   className="h-full bg-green-500 rounded-full transition-all"
                   style={{ width: `${(completedTasks.length / total) * 100}%` }}
                 />
               </div>
             )}
           </div>

           {/* Active tasks with timers */}
           {activeTasks.length > 0 && (
             <div className="space-y-1">
               {activeTasks.slice(0, 3).map(task => (
                 <div key={task.id} className="bg-muted/50 rounded px-2 py-1 text-xs flex items-center justify-between gap-2">
                   <span className="truncate flex-1">{task.title}</span>
                   {task.due_date
                     ? <CountdownTimer dueDate={task.due_date} compact />
                     : <span className="text-muted-foreground italic flex-shrink-0">no due date</span>
                   }
                 </div>
               ))}
               {activeTasks.length > 3 && (
                 <Popover>
                   <PopoverTrigger asChild onClick={e => e.stopPropagation()}>
                     <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground px-2 cursor-pointer hover:text-blue-600 transition-colors group/at">
                       <Clock className="h-3 w-3 text-blue-500 group-hover/at:text-blue-600" />
                       <span className="underline decoration-dotted underline-offset-2">
                         +{activeTasks.length - 3} more active
                       </span>
                     </div>
                   </PopoverTrigger>
                   <PopoverContent className="w-72 p-3" side="right" align="start" onClick={e => e.stopPropagation()}>
                     <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">Active Tasks</p>
                     <div className="space-y-1 max-h-48 overflow-y-auto">
                       {activeTasks.slice(3).map(task => (
                         <div key={task.id} className="flex items-center gap-2 text-xs py-1 border-b border-muted last:border-0">
                           <span className="flex-1 text-foreground">{task.title}</span>
                           {task.due_date
                             ? <CountdownTimer dueDate={task.due_date} compact />
                             : <span className="text-muted-foreground italic flex-shrink-0">no due date</span>
                           }
                         </div>
                         ))}
                         </div>
                         </PopoverContent>
                         </Popover>
                         )}
                         </div>
                         )}

                         {/* Completed tasks */}
           {completedTasks.length > 0 && (
             <Popover>
               <PopoverTrigger asChild onClick={e => e.stopPropagation()}>
                 <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer hover:text-green-600 transition-colors group/ct">
                   <CheckCircle2 className="h-3 w-3 text-green-500 group-hover/ct:text-green-600" />
                   <span className="underline decoration-dotted underline-offset-2">
                     {completedTasks.length} completed
                   </span>
                 </div>
               </PopoverTrigger>
               <PopoverContent className="w-72 p-3" side="right" align="start" onClick={e => e.stopPropagation()}>
                 <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">Completed Tasks</p>
                 <div className="space-y-1 max-h-48 overflow-y-auto">
                   {completedTasks.map(task => (
                     <div key={task.id} className="flex items-center gap-2 text-xs py-1 border-b border-muted last:border-0">
                       <CheckCircle2 className="h-3 w-3 text-green-500 flex-shrink-0" />
                       <span className="flex-1 text-foreground">{task.title}</span>
                       {task.due_date && (
                         <span className="text-muted-foreground text-xs flex-shrink-0">
                           {fmtDate(task.due_date, 'MMM d')}
                         </span>
                       )}
                     </div>
                   ))}
                 </div>
               </PopoverContent>
             </Popover>
           )}
         </div>
       );
     }
    case "product_category_tasks": {
      // Aggregate non-revision tasks by their source product's category.
      // task.product_id → product.category lookup; tasks not tied to a product
      // (or whose product was removed) bucket as "other".
      const allRegularTasks = tasks.filter(t => !t.is_deleted && !t.is_archived && !t.revision_id && !/^\[Revision #\d+\]/.test(t.title || ""));
      if (allRegularTasks.length === 0) return null;

      const productById = new Map(products.map(p => [p.id, p]));
      const groupsMap = new Map();
      for (const t of allRegularTasks) {
        const product = t.product_id ? productById.get(t.product_id) : null;
        const cat = (product?.category || "other").toLowerCase();
        if (!groupsMap.has(cat)) groupsMap.set(cat, []);
        groupsMap.get(cat).push(t);
      }
      if (groupsMap.size === 0) return null;

      const groups = [...groupsMap.entries()]
        .map(([cat, list]) => {
          const completed = list.filter(t => t.is_completed).length;
          return {
            cat,
            label: CATEGORY_LABELS[cat] || cat,
            tasks: list,
            total: list.length,
            completed,
            barColor: CATEGORY_BAR_COLORS[cat] || CATEGORY_BAR_COLORS.other,
          };
        })
        .sort((a, b) => {
          const ai = CATEGORY_ORDER.indexOf(a.cat);
          const bi = CATEGORY_ORDER.indexOf(b.cat);
          return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        });

      return (
        <div className="space-y-1">
          {groups.map(grp => {
            const pct = grp.total > 0 ? (grp.completed / grp.total) * 100 : 0;
            return (
              <Popover key={grp.cat}>
                <PopoverTrigger asChild onClick={e => e.stopPropagation()}>
                  <div className="flex items-center gap-2 cursor-pointer hover:bg-muted/50 rounded px-1 py-0.5 transition-colors">
                    <Package className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                    <span className="text-xs font-medium text-foreground truncate min-w-[72px] max-w-[100px]" title={grp.label}>
                      {grp.label}
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums flex-shrink-0">
                      {grp.completed}/{grp.total}
                    </span>
                    <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden min-w-[32px]">
                      <div
                        className={`h-full ${grp.barColor} rounded-full transition-all`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                </PopoverTrigger>
                <PopoverContent className="w-72 p-3" side="right" align="start" onClick={e => e.stopPropagation()}>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                      {grp.label} · {grp.completed}/{grp.total}
                    </p>
                  </div>
                  <div className="space-y-1 max-h-60 overflow-y-auto">
                    {grp.tasks.map(task => (
                      <div key={task.id} className="flex items-center gap-2 text-xs py-1 border-b border-muted last:border-0">
                        {task.is_completed
                          ? <CheckCircle2 className="h-3 w-3 text-green-500 flex-shrink-0" />
                          : <CheckSquare className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                        }
                        <span className={`flex-1 ${task.is_completed ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                          {task.title}
                        </span>
                        {task.due_date && !task.is_completed
                          ? <CountdownTimer dueDate={task.due_date} compact />
                          : task.due_date
                            ? <span className="text-muted-foreground text-xs flex-shrink-0">{fmtDate(task.due_date, 'MMM d')}</span>
                            : null
                        }
                      </div>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            );
          })}
        </div>
      );
    }
    case "requests": {
       const allRevisionTasks = tasks.filter(t => !t.is_deleted && !t.is_archived && (t.revision_id || /^\[Revision #\d+\]/.test(t.title || "")));
       const activeTasks = allRevisionTasks.filter(t => !t.is_completed);
       const completedTasks = allRevisionTasks.filter(t => t.is_completed);
       const total = allRevisionTasks.length;
       if (total === 0) return null;

       // Separate by request_kind (revision vs change_request)
       const revisions = activeTasks.filter(t => t.request_kind === 'revision' || !t.request_kind);
       const changeRequests = activeTasks.filter(t => t.request_kind === 'change_request');
       const completedRevisions = completedTasks.filter(t => t.request_kind === 'revision' || !t.request_kind);
       const completedChangeRequests = completedTasks.filter(t => t.request_kind === 'change_request');

       const revisionColor = "border-l-3 border-l-red-500 bg-red-50/40";
       const changeRequestColor = "border-l-3 border-l-purple-500 bg-purple-50/40";

       return (
         <div className="space-y-1.5">
           {/* Progress summary row */}
           <div className="flex items-center gap-2">
             <div className="flex items-center gap-1 text-xs text-muted-foreground">
               <CheckSquare className="h-3 w-3" />
               <span className="font-medium">{completedTasks.length}/{total}</span>
               <span>requests done</span>
             </div>
             {total > 0 && (
               <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                 <div
                   className="h-full bg-indigo-500 rounded-full transition-all"
                   style={{ width: `${(completedTasks.length / total) * 100}%` }}
                 />
               </div>
             )}
           </div>

           {/* Revisions */}
           {revisions.length > 0 && (
             <div className="space-y-1">
               {revisions.slice(0, 2).map(task => (
                 <div key={task.id} className={`${revisionColor} rounded px-2 py-1 text-xs flex items-center justify-between gap-2`}>
                   <span className="truncate flex-1 text-red-900">{task.title.replace(/^\[Revision #\d+\]\s*/, "")}</span>
                   {task.due_date
                     ? <CountdownTimer dueDate={task.due_date} compact />
                     : <span className="text-muted-foreground italic flex-shrink-0 text-xs">no due</span>
                   }
                 </div>
               ))}
               {revisions.length > 2 && (
                 <Popover>
                   <PopoverTrigger asChild onClick={e => e.stopPropagation()}>
                     <div className="inline-flex items-center gap-1 text-xs text-red-600 cursor-pointer hover:text-red-700 transition-colors">
                       <span className="underline decoration-dotted underline-offset-1 text-xs">
                         +{revisions.length - 2} revisions
                       </span>
                     </div>
                   </PopoverTrigger>
                   <PopoverContent className="w-64 p-2" side="right" align="start" onClick={e => e.stopPropagation()}>
                     <p className="text-xs font-semibold text-red-600 mb-1 uppercase tracking-wide">Revisions</p>
                     <div className="space-y-0.5 max-h-40 overflow-y-auto">
                       {revisions.slice(2).map(task => (
                         <div key={task.id} className="flex items-center gap-1.5 text-xs py-0.5 border-b border-red-100 last:border-0">
                           <span className="flex-1 text-foreground text-xs">{task.title.replace(/^\[Revision #\d+\]\s*/, "")}</span>
                           {task.due_date && <span className="text-muted-foreground text-xs flex-shrink-0">{fmtDate(task.due_date, 'MMM d')}</span>}
                             </div>
                           ))}
                           </div>
                           </PopoverContent>
                           </Popover>
                           )}
                           </div>
                           )}

                           {/* Change Requests */}
           {changeRequests.length > 0 && (
             <div className="space-y-1">
               {changeRequests.slice(0, 2).map(task => (
                 <div key={task.id} className={`${changeRequestColor} rounded px-2 py-1 text-xs flex items-center justify-between gap-2`}>
                   <span className="truncate flex-1 text-purple-900">{task.title.replace(/^\[Revision #\d+\]\s*/, "")}</span>
                   {task.due_date
                     ? <CountdownTimer dueDate={task.due_date} compact />
                     : <span className="text-muted-foreground italic flex-shrink-0 text-xs">no due</span>
                   }
                 </div>
               ))}
               {changeRequests.length > 2 && (
                 <Popover>
                   <PopoverTrigger asChild onClick={e => e.stopPropagation()}>
                     <div className="inline-flex items-center gap-1 text-xs text-purple-600 cursor-pointer hover:text-purple-700 transition-colors">
                       <span className="underline decoration-dotted underline-offset-1 text-xs">
                         +{changeRequests.length - 2} change requests
                       </span>
                     </div>
                   </PopoverTrigger>
                   <PopoverContent className="w-64 p-2" side="right" align="start" onClick={e => e.stopPropagation()}>
                     <p className="text-xs font-semibold text-purple-600 mb-1 uppercase tracking-wide">Change Requests</p>
                     <div className="space-y-0.5 max-h-40 overflow-y-auto">
                       {changeRequests.slice(2).map(task => (
                         <div key={task.id} className="flex items-center gap-1.5 text-xs py-0.5 border-b border-purple-100 last:border-0">
                           <span className="flex-1 text-foreground text-xs">{task.title.replace(/^\[Revision #\d+\]\s*/, "")}</span>
                           {task.due_date && <span className="text-muted-foreground text-xs flex-shrink-0">{fmtDate(task.due_date, 'MMM d')}</span>}
                             </div>
                           ))}
                           </div>
                           </PopoverContent>
                           </Popover>
                           )}
                           </div>
                           )}

                           {/* Completed requests - aggregate */}
           {completedTasks.length > 0 && (
             <Popover>
               <PopoverTrigger asChild onClick={e => e.stopPropagation()}>
                 <div className="inline-flex items-center gap-1 text-xs text-indigo-600 cursor-pointer hover:text-indigo-700 transition-colors">
                   <CheckCircle2 className="h-3 w-3 text-indigo-500" />
                   <span className="underline decoration-dotted underline-offset-1 text-xs">
                     {completedTasks.length} completed
                   </span>
                 </div>
               </PopoverTrigger>
               <PopoverContent className="w-64 p-2" side="right" align="start" onClick={e => e.stopPropagation()}>
                 <p className="text-xs font-semibold text-indigo-600 mb-1 uppercase tracking-wide">Completed Requests</p>
                 <div className="space-y-0.5 max-h-40 overflow-y-auto">
                   {completedTasks.map(task => (
                     <div key={task.id} className="flex items-center gap-1.5 text-xs py-0.5 border-b border-indigo-100 last:border-0">
                       <CheckCircle2 className="h-3 w-3 text-indigo-500 flex-shrink-0" />
                       <span className="flex-1 text-foreground text-xs">{task.title.replace(/^\[Revision #\d+\]\s*/, "")}</span>
                       {task.due_date && <span className="text-muted-foreground text-xs flex-shrink-0">{fmtDate(task.due_date, 'MMM d')}</span>}
                     </div>
                   ))}
                 </div>
               </PopoverContent>
             </Popover>
           )}
         </div>
       );
     }
    case "outcome": {
      if (!project.outcome || project.outcome === "open") return null;
      return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${outcomeColors[project.outcome]}`}>
          {project.outcome === "won" ? "✓ Won" : "✗ Lost"}
        </span>
      );
    }
    case "payment_status": {
      const status = project.payment_status || "unpaid";
      return (
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium capitalize ${paymentColors[status]}`}>
          <CreditCard className="h-3 w-3" aria-hidden="true" />
          {status}
        </span>
      );
    }
    case "partially_delivered": {
      if (!project.partially_delivered) return null;
      const ts = project.partially_delivered_at
        ? fmtTimestampCustom(project.partially_delivered_at, {
            day: 'numeric', month: 'short', year: 'numeric',
            hour: 'numeric', minute: '2-digit', hour12: true,
          })
        : null;
      const operator = project.partially_delivered_by;
      const tooltip = (operator || ts)
        ? `${operator ? `Set by ${operator}` : ''}${operator && ts ? ' · ' : ''}${ts || ''}`
        : 'Partially delivered';
      return (
        <span
          title={tooltip}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-700 dark:bg-indigo-950/30 dark:text-indigo-400"
        >
          <Package className="h-3 w-3" aria-hidden="true" />
          Partially Delivered
        </span>
      );
    }
    case "notes": {
      if (!project.notes) return null;
      return (
        <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <FileText className="h-3 w-3 mt-0.5 flex-shrink-0" />
          <span className="line-clamp-2">{project.notes}</span>
        </div>
      );
    }
    case "delivery_link": {
      if (!project.delivery_link) return null;
      return (
        <a
          href={project.delivery_link}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          onClick={e => e.stopPropagation()}
        >
          <ExternalLink className="h-3 w-3" />
          View Deliverables
        </a>
      );
    }
    case "effort": {
      return <ProjectCardEffort projectId={project.id} tasks={tasks} timeLogs={timeLogs} />;
    }
    default:
      return null;
  }
});

/**
 * Renders all enabled fields for a project card in order.
 * Memoized so card re-renders are scoped to whichever card actually changed
 * (vs. the whole board re-rendering whenever any one card's data shifts).
 */
export const ProjectCardFields = memo(function ProjectCardFields({ project, enabledFields, products, packages, tasks, timeLogs = [] }) {
  return (
    <div className="space-y-2">
      {enabledFields.map(fieldId => (
        <ProjectFieldValue
          key={fieldId}
          fieldId={fieldId}
          project={project}
          products={products}
          packages={packages}
          tasks={tasks}
          timeLogs={timeLogs}
        />
      ))}
    </div>
  );
});