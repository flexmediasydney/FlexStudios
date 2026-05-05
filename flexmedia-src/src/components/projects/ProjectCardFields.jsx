import { memo, useMemo, useDeferredValue } from "react";
import { Badge } from "@/components/ui/badge";
import { Calendar, Clock, Building, CheckSquare, CreditCard, CheckCircle2, Package } from "lucide-react";
import { usePriceGate } from '@/components/auth/RoleGate';
import { fmtDate, fmtTimestampCustom } from "@/components/utils/dateUtils";
import { CountdownTimer } from "./TaskManagement";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import ProjectCardEffort from "./ProjectCardEffort";

const paymentColors = {
  unpaid: "bg-amber-100 text-amber-700",
  paid: "bg-green-100 text-green-700"
};

// Format an "HH:MM" or "HH:MM:SS" time string as a 12h "9:30 AM" label.
// Handles ISO datetimes too (slices the time portion off). Returns null
// for unparseable input so the shoot field can degrade gracefully.
function formatShootTime(raw) {
  if (!raw) return null;
  const m = String(raw).match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (Number.isNaN(h) || Number.isNaN(min)) return null;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(min).padStart(2, '0')} ${period}`;
}

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

// Card fields whose only meaningful state is "the project's tasks are
// actively being worked on". Hidden when nothing has started yet AND when
// everything's done — see the tasksInFlight gate in the ProjectCardFields
// wrapper below.
const TASK_BASED_FIELDS = new Set([
  'product_category_tasks',
]);

// Map a 0..1 completion ratio to the same red/orange/blue/green palette the
// project-level overall progress bar uses. Pure helper — exported only so
// future callers (other progress visuals) can stay consistent without
// duplicating the threshold table.
const HOUR_MS = 60 * 60 * 1000;
function progressBarColor(completed, total) {
  if (total <= 0) return 'bg-gray-300 dark:bg-gray-600';
  const pct = (completed / total) * 100;
  if (pct === 100) return 'bg-green-500';
  if (pct >= 50) return 'bg-blue-500';
  if (pct > 0) return 'bg-amber-500';
  return 'bg-red-500'; // 0% — flag scopes that haven't started
}

// Mirrors getProjectUrgency in KanbanBoard.jsx, but scoped to a list of tasks
// so each Task Progress row can flag its own area as overdue/urgent/soon/
// ontrack/none. Returns:
//   overdue → any active task past its due date           (red)
//   urgent  → any active task due within 1h               (flashing orange)
//   soon    → any active task due within 4h (>1h)         (orange)
//   ontrack → has tasks with due dates, none of the above (green)
//   none    → no active tasks left, or none have due dates
// Completed/deleted/archived tasks are ignored — finished work doesn't
// pull a row's urgency colour anymore.
function getTasksUrgency(taskList) {
  if (!Array.isArray(taskList) || taskList.length === 0) return 'none';
  const now = Date.now();
  let hasActiveWithDate = false;
  let hasOverdue = false;
  let hasUrgent = false;
  let hasSoon = false;
  for (const t of taskList) {
    if (t.is_completed || t.is_deleted || t.is_archived) continue;
    if (!t.due_date) continue;
    const raw = t.due_date;
    let due;
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      due = new Date(`${raw}T23:59:59`).getTime();
    } else {
      due = new Date(raw).getTime();
    }
    if (Number.isNaN(due)) continue;
    hasActiveWithDate = true;
    const delta = due - now;
    if (delta < 0) { hasOverdue = true; break; }
    if (delta <= HOUR_MS) hasUrgent = true;
    else if (delta <= 4 * HOUR_MS) hasSoon = true;
  }
  if (hasOverdue) return 'overdue';
  if (hasUrgent) return 'urgent';
  if (hasSoon) return 'soon';
  if (hasActiveWithDate) return 'ontrack';
  return 'none';
}

// Tailwind classes for each urgency tier. Matches the project-card chip
// palette so the visual language across the card stays consistent.
const URGENCY_TEXT_CLASS = {
  overdue: 'text-red-600 font-semibold',
  urgent: 'text-orange-600 font-semibold animate-pulse',
  soon: 'text-orange-600 font-medium',
  ontrack: 'text-green-700 dark:text-green-400',
  none: '', // fallback to inherited text color
};

// Bucket a project's tasks into the scope groups the Task Progress field
// shows. Hoisted out of the field render and computed once per card per
// task-set change (memoized in the ProjectCardFields wrapper) so each card
// doesn't re-bucketize on every parent re-render. Returns null when there
// are no active tasks so the field can early-exit before mounting any
// Popover instances.
function computeTaskBuckets(tasks, productById) {
  if (!Array.isArray(tasks) || tasks.length === 0) return null;

  const allActive = [];
  const projectScopeTasks = [];
  const revisionTasks = [];
  const changeRequestTasks = [];
  const productByCategory = new Map();
  let completedAll = 0;
  let productCompleted = 0;

  for (const t of tasks) {
    if (t.is_deleted || t.is_archived) continue;
    allActive.push(t);
    if (t.is_completed) completedAll++;

    const isRevision = Boolean(t.revision_id) || /^\[Revision #\d+\]/.test(t.title || "");
    if (isRevision) {
      if (t.request_kind === 'change_request') changeRequestTasks.push(t);
      else revisionTasks.push(t);
    } else if (t.product_id) {
      const product = productById.get(t.product_id);
      const cat = (product?.category || 'other').toLowerCase();
      if (!productByCategory.has(cat)) productByCategory.set(cat, []);
      productByCategory.get(cat).push(t);
      if (t.is_completed) productCompleted++;
    } else {
      projectScopeTasks.push(t);
    }
  }

  if (allActive.length === 0) return null;

  const productAll = [];
  productByCategory.forEach(list => { for (const t of list) productAll.push(t); });

  const productGroups = [...productByCategory.entries()]
    .map(([cat, list]) => {
      let completed = 0;
      for (const t of list) if (t.is_completed) completed++;
      return {
        cat,
        label: CATEGORY_LABELS[cat] || cat,
        tasks: list,
        total: list.length,
        completed,
      };
    })
    .sort((a, b) => {
      const ai = CATEGORY_ORDER.indexOf(a.cat);
      const bi = CATEGORY_ORDER.indexOf(b.cat);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

  let projectScopeCompleted = 0;
  for (const t of projectScopeTasks) if (t.is_completed) projectScopeCompleted++;
  let revisionCompleted = 0;
  for (const t of revisionTasks) if (t.is_completed) revisionCompleted++;
  let changeRequestCompleted = 0;
  for (const t of changeRequestTasks) if (t.is_completed) changeRequestCompleted++;

  return {
    productAll,
    productTotal: productAll.length,
    productCompleted,
    productGroups,
    projectScopeTasks,
    projectScopeCompleted,
    revisionTasks,
    revisionCompleted,
    changeRequestTasks,
    changeRequestCompleted,
    totalAll: allActive.length,
    completedAll,
  };
}

/**
 * Renders a single field row for a project card.
 * Shared across Kanban, Grid, and List views.
 */
// Memoized so a 1Hz running-timer tick (or any single-card mutation) only
// re-renders the affected card field row, not all 200 × N field rows on the
// Kanban / project list. Pure render — no internal state.
export const ProjectFieldValue = memo(function ProjectFieldValue({ fieldId, project, products = [], packages = [], agencies = [], tasks = [], timeLogs = [], taskBuckets = null }) {
  const { visible: showPricing } = usePriceGate();
  switch (fieldId) {
    case "agency_agent": {
      // Renders the field labelled "Person and Organisation" (ID is the
      // legacy `agency_agent`). Person = agent, Organisation = agency.
      //
      // ProjectForm doesn't denormalise the agency name onto the project row
      // — it only stores project.agency_id. So the canonical lookup is:
      //   organisation = agencies.find(a => a.id === project.agency_id)?.name
      // and we fall back to the rare denormalised project.agency_name for
      // legacy / Tonomo-imported records.
      //
      // project.client_name confusingly stores the *agent name*, not the
      // agency, so we use it as a fallback for project.agent_name only.
      const resolvedAgency = project.agency_id
        ? agencies.find(a => a.id === project.agency_id)
        : null;
      const personName = project.agent_name || project.client_name;
      const organisationName = resolvedAgency?.name || project.agency_name;
      if (!personName && !organisationName) return null;
      return (
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground min-w-0">
          <Building className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="truncate min-w-0" title={[personName, organisationName].filter(Boolean).join(" · ")}>
            {personName && <span>{personName}</span>}
            {personName && organisationName && (
              <span className="mx-1.5 text-muted-foreground/50">·</span>
            )}
            {organisationName && <span>{organisationName}</span>}
          </span>
        </div>
      );
    }
    case "shoot": {
      if (!project.shoot_date) return null;
      // Date-string comparison avoids UTC drift — matches the kanban
      // bottom-of-card logic that this field replaced.
      const shootStr = project.shoot_date.slice(0, 10);
      const todayStr = new Date().toLocaleDateString('en-CA');
      const tmrStr = new Date(Date.now() + 86400000).toLocaleDateString('en-CA');
      const diffDays = Math.round((new Date(shootStr) - new Date(todayStr)) / 86400000);
      let dayLabel;
      if (diffDays === 0) dayLabel = 'Today';
      else if (diffDays === 1) dayLabel = 'Tomorrow';
      else if (diffDays === -1) dayLabel = 'Yesterday';
      else if (diffDays < 0) dayLabel = `${Math.abs(diffDays)}d ago`;
      else if (diffDays < 7) dayLabel = new Date(project.shoot_date).toLocaleDateString('en-AU', { weekday: 'short' });
      else dayLabel = new Date(project.shoot_date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });

      let toneClass = 'text-muted-foreground';
      if (shootStr < todayStr) toneClass = 'text-red-500 font-semibold';
      else if (shootStr === todayStr) toneClass = 'text-amber-600 font-semibold';
      else if (shootStr === tmrStr) toneClass = 'text-blue-600';

      const timeLabel = formatShootTime(project.shoot_time);

      return (
        <div className={`flex items-center gap-1.5 text-xs ${toneClass}`}>
          <Calendar className="h-3.5 w-3.5 flex-shrink-0" />
          <span>{dayLabel}</span>
          {timeLabel && (
            <>
              <span className="opacity-50">·</span>
              <Clock className="h-3 w-3 flex-shrink-0 opacity-70" />
              <span>{timeLabel}</span>
            </>
          )}
          {project.tonomo_is_twilight && (
            <span className="text-purple-500" title="Twilight">🌅</span>
          )}
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
    case "products_packages": {
      const productItems = (project.products || [])
        .map(item => products.find(p => p.id === (item.product_id || item))?.name)
        .filter(Boolean);
      const packageItems = (project.packages || [])
        .map(item => packages.find(p => p.id === (item.package_id || item))?.name)
        .filter(Boolean);
      if (!productItems.length && !packageItems.length) return null;
      // Packages first (more concrete deliverable), then products. Cap each
      // group separately so neither steals the other's badge slots.
      const PKG_LIMIT = 2;
      const PROD_LIMIT = 3;
      return (
        <div className="flex flex-wrap gap-1">
          {packageItems.slice(0, PKG_LIMIT).map((name, i) => (
            <Badge key={`pkg-${i}`} variant="secondary" className="text-xs">📦 {name}</Badge>
          ))}
          {packageItems.length > PKG_LIMIT && (
            <Badge variant="secondary" className="text-xs">+{packageItems.length - PKG_LIMIT}</Badge>
          )}
          {productItems.slice(0, PROD_LIMIT).map((name, i) => (
            <Badge key={`prod-${i}`} variant="outline" className="text-xs">{name}</Badge>
          ))}
          {productItems.length > PROD_LIMIT && (
            <Badge variant="outline" className="text-xs">+{productItems.length - PROD_LIMIT}</Badge>
          )}
        </div>
      );
    }
    case "product_category_tasks": {
      // Scope-first task progress. Bucketing is done once at the wrapper level
      // (computeTaskBuckets in ProjectCardFields) and passed in via prop, so
      // this case is purely render — no per-card iteration over tasks.
      if (!taskBuckets) return null;
      const {
        productAll, productTotal, productCompleted, productGroups,
        projectScopeTasks, projectScopeCompleted,
        revisionTasks, revisionCompleted,
        changeRequestTasks, changeRequestCompleted,
        totalAll, completedAll,
      } = taskBuckets;
      const overallPct = totalAll > 0 ? (completedAll / totalAll) * 100 : 0;
      // Overall row mirrors the kanban's "ontrack/soon/urgent/overdue"
      // urgency colours so the top progress bar text matches the chip
      // shown at the bottom of the card. Bucket urgencies are computed
      // per-row below so each scope can flag itself independently.
      const overallUrgency = getTasksUrgency([
        ...productAll, ...projectScopeTasks, ...revisionTasks, ...changeRequestTasks,
      ]);

      const renderRow = ({ key, label, tasksList, completed, total, indent, popoverTitle, stripRevisionPrefix }) => {
        if (total === 0) return null;
        const pct = total > 0 ? (completed / total) * 100 : 0;
        const barColor = progressBarColor(completed, total);
        const urgency = getTasksUrgency(tasksList);
        const urgencyTextClass = URGENCY_TEXT_CLASS[urgency] || '';
        // Indent rows (per-category sub-rows) keep the muted baseline so
        // the parent scope label still reads as the heading. Top-level
        // labels pick up the urgency tone directly.
        const labelToneClass = indent
          ? (urgencyTextClass || 'text-muted-foreground')
          : (urgencyTextClass || 'font-semibold text-foreground');
        return (
          <Popover key={key}>
            <PopoverTrigger asChild onClick={e => e.stopPropagation()}>
              <div className={`flex items-center gap-2 cursor-pointer hover:bg-muted/50 rounded px-1 py-0.5 transition-colors ${indent ? 'pl-4' : ''}`}>
                <span className={`text-xs ${labelToneClass} truncate min-w-[64px] max-w-[110px]`} title={label}>
                  {label}
                </span>
                <span className={`text-xs tabular-nums flex-shrink-0 ${urgencyTextClass || 'text-muted-foreground'}`}>
                  {completed}/{total}
                </span>
                <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden min-w-[32px]">
                  <div className={`h-full ${barColor} rounded-full transition-all`} style={{ width: `${pct}%` }} />
                </div>
              </div>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-3" side="right" align="start" onClick={e => e.stopPropagation()}>
              <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
                {popoverTitle || label} · {completed}/{total}
              </p>
              <div className="space-y-1 max-h-60 overflow-y-auto">
                {tasksList.map(task => (
                  <div key={task.id} className="flex items-center gap-2 text-xs py-1 border-b border-muted last:border-0">
                    {task.is_completed
                      ? <CheckCircle2 className="h-3 w-3 text-green-500 flex-shrink-0" />
                      : <CheckSquare className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                    }
                    <span className={`flex-1 ${task.is_completed ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                      {stripRevisionPrefix ? (task.title || '').replace(/^\[Revision #\d+\]\s*/, '') : task.title}
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
      };

      const overallToneClass = URGENCY_TEXT_CLASS[overallUrgency] || 'text-muted-foreground';

      return (
        <div className="space-y-1.5">
          {/* Overall — all active tasks (matches ProjectProgressBar on the project detail page) */}
          <div className="flex items-center gap-2">
            <div className={`flex items-center gap-1 text-xs ${overallToneClass}`}>
              <CheckSquare className="h-3 w-3" />
              <span className="font-medium tabular-nums">{completedAll}/{totalAll}</span>
              <span>tasks done</span>
            </div>
            <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className={`h-full ${progressBarColor(completedAll, totalAll)} rounded-full transition-all`}
                style={{ width: `${overallPct}%` }}
              />
            </div>
          </div>

          {/* Product scope — header + per-category sub-rows */}
          {productTotal > 0 && (
            <>
              {renderRow({
                key: 'product',
                label: 'Product',
                tasksList: productAll,
                completed: productCompleted,
                total: productTotal,
              })}
              {productGroups.map(grp => renderRow({
                key: `product:${grp.cat}`,
                label: grp.label,
                tasksList: grp.tasks,
                completed: grp.completed,
                total: grp.total,
                indent: true,
                popoverTitle: `Product · ${grp.label}`,
              }))}
            </>
          )}

          {/* Project scope */}
          {renderRow({
            key: 'project',
            label: 'Project',
            tasksList: projectScopeTasks,
            completed: projectScopeCompleted,
            total: projectScopeTasks.length,
          })}

          {/* Revisions */}
          {renderRow({
            key: 'revisions',
            label: 'Revisions',
            tasksList: revisionTasks,
            completed: revisionCompleted,
            total: revisionTasks.length,
            stripRevisionPrefix: true,
          })}

          {/* Change Requests */}
          {renderRow({
            key: 'change_requests',
            label: 'Change Requests',
            tasksList: changeRequestTasks,
            completed: changeRequestCompleted,
            total: changeRequestTasks.length,
            stripRevisionPrefix: true,
          })}
        </div>
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
export const ProjectCardFields = memo(function ProjectCardFields({ project, enabledFields, products, packages, agencies = [], tasks, timeLogs = [] }) {
  // Sort tasks by their canonical `order` field — same ordering useProjectTasks
  // applies on the project detail page, so card popovers list tasks in the
  // template order they were generated in (rather than the due-date sort that
  // the source useEntityList uses for board / list views).
  const sortedTasks = useMemo(() => {
    if (!Array.isArray(tasks) || tasks.length === 0) return tasks;
    return [...tasks].sort((a, b) => {
      const ao = typeof a.order === 'number' ? a.order : Number.POSITIVE_INFINITY;
      const bo = typeof b.order === 'number' ? b.order : Number.POSITIVE_INFINITY;
      if (ao !== bo) return ao - bo;
      const ac = a.created_date ? new Date(a.created_date).getTime() : 0;
      const bc = b.created_date ? new Date(b.created_date).getTime() : 0;
      return ac - bc;
    });
  }, [tasks]);

  // Build the product-id lookup once per products change. Without this, every
  // card was rebuilding a 200-entry Map inside its Task Progress field render.
  const productById = useMemo(() => {
    const m = new Map();
    for (const p of products) m.set(p.id, p);
    return m;
  }, [products]);

  // Defer the heavier task-bucketing pass: when tasks update, the card paints
  // the cheap fields (price, dates, etc.) first; React schedules the bucketing
  // re-render at lower priority. On the kanban this is the difference between
  // a paint hitch when 100+ cards mount the Task Progress field and a smooth
  // progressive fill-in.
  const deferredTasks = useDeferredValue(sortedTasks);
  const taskBuckets = useMemo(
    () => computeTaskBuckets(deferredTasks, productById),
    [deferredTasks, productById]
  );

  // "Tasks in flight" gate — task-based card fields only show on projects
  // that are actively in progress: at least one task done AND not all done.
  // Drives a clean kanban: pre-work projects (0 done) and finished projects
  // (everything done) hide their task widgets, so what's visible is the
  // actually-working set. This is task-state-driven on purpose; basing it on
  // project.status would lock the rule to a specific stage list and break
  // the moment a project enters "in_progress" before any work happens.
  const tasksInFlight = !!taskBuckets
    && taskBuckets.completedAll > 0
    && taskBuckets.completedAll < taskBuckets.totalAll;

  return (
    <div className="space-y-2">
      {enabledFields.map(fieldId => {
        if (TASK_BASED_FIELDS.has(fieldId) && !tasksInFlight) return null;
        return (
          <ProjectFieldValue
            key={fieldId}
            fieldId={fieldId}
            project={project}
            products={products}
            packages={packages}
            agencies={agencies}
            tasks={sortedTasks}
            timeLogs={timeLogs}
            taskBuckets={taskBuckets}
          />
        );
      })}
    </div>
  );
});