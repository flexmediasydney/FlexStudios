import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { usePermissions, useCurrentUser } from "@/components/auth/PermissionGuard";
import { useEntityList } from "@/components/hooks/useEntityData";
import { Plus, Search, LayoutGrid, List, Columns3, X, Camera } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import ProjectCard from "@/components/dashboard/ProjectCard";
import ProjectForm from "@/components/projects/ProjectForm";
import ProjectStatusBadge from "@/components/dashboard/ProjectStatusBadge";
import ProjectStatusTimer from "@/components/projects/ProjectStatusTimer";
import KanbanBoard from "@/components/projects/KanbanBoard";
import { PROJECT_STAGES } from "@/components/projects/projectStatuses";
import ErrorBoundary from "@/components/common/ErrorBoundary";
import CardFieldsCustomizer, { CardFieldsCustomizerButton } from "@/components/projects/CardFieldsCustomizer";
import ProjectFiltersSort from "@/components/projects/ProjectFiltersSort";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Link, useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { fixTimestamp } from "@/components/utils/dateUtils";
import { useCardFields } from "@/components/projects/useCardFields";
import { useScopedProjectTasks } from "@/hooks/useScopedProjectTasks";
import { ProjectFieldValue } from "@/components/projects/ProjectCardFields";
import EntityDataTable from "@/components/common/EntityDataTable";

import KeyboardShortcutsModal from "@/components/common/KeyboardShortcutsModal";

// When rebuilding a project-keyed group map (tasksByProject, timeLogsByProject),
// preserve the prior sub-array reference for any project whose contents haven't
// changed. Without this, every Realtime event for any task creates fresh array
// references for ALL projects' tasks, which busts ProjectCardFields memo on
// every card. With it, only the affected project's array changes reference, so
// unrelated cards skip re-render entirely.
function preserveStableSubArrays(next, prevRef) {
  const prev = prevRef.current || {};
  for (const k of Object.keys(next)) {
    const a = next[k];
    const b = prev[k];
    if (b && b.length === a.length) {
      let same = true;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) { same = false; break; }
      }
      if (same) next[k] = b;
    }
  }
  prevRef.current = next;
  return next;
}

export default function Projects() {
  const navigate = useNavigate();
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [editingProject, setEditingProject] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const searchTimerRef = useRef(null);
  const handleSearchChange = useCallback((value) => {
    setSearchInput(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => setSearchQuery(value), 250);
  }, []);
  // Clean up debounce timer on unmount to prevent setState on unmounted component
  useEffect(() => () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); }, []);
  // Keep searchInput in sync when searchQuery is cleared programmatically (e.g. via Escape key)
  useEffect(() => {
    if (searchQuery === "") setSearchInput("");
  }, [searchQuery]);
  const [viewMode, setViewMode] = useState(() => {
    try { const v = localStorage.getItem('projects_view_mode'); if (['kanban','grid','list'].includes(v)) return v; } catch {}
    return "kanban";
  });
  // Wrap setViewMode to persist to localStorage
  const setViewModePersisted = useCallback((mode) => {
    setViewMode(mode);
    try { localStorage.setItem('projects_view_mode', mode); } catch {}
  }, []);
  const [fitToScreen, setFitToScreen] = useState(true);
  const [showFieldCustomizer, setShowFieldCustomizer] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [filters, setFilters] = useState({});
  const [showArchived, setShowArchived] = useState(false);
  const [sortBy, setSortBy] = useState("shoot_date_asc");
  const [shootDateFrom, setShootDateFrom] = useState('');
  const [shootDateTo, setShootDateTo] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [paymentFilter, setPaymentFilter] = useState('unpaid'); // 'all' | 'paid' | 'unpaid'
  const { canSeePricing } = usePermissions();
  const { enabledFields } = useCardFields();
  const { data: currentUser } = useCurrentUser();

  // Memoize callbacks before useEffect (Fix #13)
  const handleCreateNew = useCallback(() => {
    setEditingProject(null);
    setShowProjectForm(true);
  }, []);

  // Keyboard shortcuts: Esc to clear search, Ctrl+N for new project, Ctrl+K/G/L for view modes, ? for help
  React.useEffect(() => {
    const handler = (e) => {
      // Bug fix: don't fire shortcuts when user is typing in an input/textarea/select
      const tag = document.activeElement?.tagName;
      const isEditable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable;

      if (e.key === 'Escape' && searchQuery) {
        e.preventDefault();
        setSearchQuery('');
        setSearchInput('');
      }
      // Modifier-based shortcuts work even inside inputs
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        handleCreateNew();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setViewModePersisted('kanban');
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'g') {
        e.preventDefault();
        setViewModePersisted('grid');
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault();
        setViewModePersisted('list');
      }
      // Non-modifier shortcuts: skip if user is typing in an input
      if (isEditable) return;
      if ((e.shiftKey) && e.key === 'F') {
        e.preventDefault();
        if (viewMode === 'kanban') setFitToScreen(prev => !prev);
      }
      if (e.key === '?') {
        e.preventDefault();
        setShowShortcuts(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [searchQuery, viewMode, fitToScreen, handleCreateNew, setViewModePersisted]);

  // Load essential entities first batch to avoid rate limiting
   const { data: allProjects = [], loading: projectsLoading, error: projectsError, refetch: refetchProjects } = useEntityList("Project", "-created_date", 200);
   const { data: products = [], loading: productsLoading, error: productsError, refetch: refetchProducts } = useEntityList("Product", "-created_date", 200);
   const { data: packages = [], loading: packagesLoading, error: packagesError, refetch: refetchPackages } = useEntityList("Package", "-created_date", 200);
   const { data: clients = [], loading: clientsLoading, error: clientsError, refetch: refetchClients } = useEntityList("Client", null, 100);
   
   // Secondary batch: loaded but not blocking
   // IMPORTANT: limits must cover all active tasks/logs across visible projects.
   // Previously 300/50 silently truncated — cards showed incomplete counts/effort.
   //
   // Project-scoped task fetch: was useEntityList("ProjectTask", "-due_date", 5000)
   // which loaded every task in the org and invalidated a 5000-row cache on every
   // Realtime event. We now batch-fetch tasks only for projects on screen, via a
   // single `project_id IN (...)` query. Realtime patches the cache surgically.
   const visibleProjectIds = useMemo(() => allProjects.map(p => p.id), [allProjects]);
   const { data: allTasks = [] } = useScopedProjectTasks(visibleProjectIds);
   const { data: allTimeLogs = [] } = useEntityList("TaskTimeLog", null, 5000);
   // Pre-fetched once so the Kanban onDragEnd can check the "shoot must have
   // ended" rule from cache instead of doing a 200-2000ms network roundtrip
   // on every forward drag past Onsite.
   const { data: allCalendarEvents = [] } = useEntityList("CalendarEvent", null, 5000);
   const { data: agents = [] } = useEntityList("Agent", null, 50);
   const { data: agencies = [] } = useEntityList("Agency", null, 50);
   const { data: teams = [] } = useEntityList("InternalTeam", null, 30);
   const { data: allUsers = [] } = useEntityList("User", null, 30);
   const { data: allEmployeeRoles = [] } = useEntityList("EmployeeRole", null, 100);

   const isLoading = projectsLoading || clientsLoading || productsLoading || packagesLoading;
   const loadError = projectsError || productsError || packagesError || clientsError;

  // Current user's internal team memberships (via EmployeeRole) - Memoized (Fix #11)
  const myTeamIds = useMemo(() => {
    if (!currentUser) return [];
    return allEmployeeRoles
      .filter(er => er.user_id === currentUser.id && er.team_id)
      .map(er => er.team_id);
  }, [currentUser?.id, allEmployeeRoles]);

  // All user IDs that share an internal team with the current user - Memoized (Fix #11)
  const myTeamMemberUserIds = useMemo(() => {
    if (!myTeamIds.length) return new Set();
    const ids = new Set();
    allEmployeeRoles.forEach(er => {
      if (er.team_id && myTeamIds.includes(er.team_id) && er.user_id) {
        ids.add(er.user_id);
      }
    });
    return ids;
  }, [myTeamIds, allEmployeeRoles]);

  // Bug fix: pre-compute task map BEFORE filteredProjects so sort can use it
  // (avoids O(n*m) inside comparator). Single pass builds both:
  //   tasksByProject     — non-subtask only (used by card progress / sort)
  //   allTasksByProject  — every task incl. subtasks (used by filter checks)
  // preserveStableSubArrays keeps unchanged projects' arrays at their prior
  // reference so unrelated cards skip re-render on Realtime events.
  const tasksByProjectRef = useRef({});
  const allTasksByProjectRef = useRef({});
  const { tasksByProject, allTasksByProject } = useMemo(() => {
    const tbp = {};
    const allTbp = {};
    for (const t of allTasks) {
      const pid = t.project_id;
      if (!pid) continue;
      if (!allTbp[pid]) allTbp[pid] = [];
      allTbp[pid].push(t);
      if (!t.parent_task_id) {
        if (!tbp[pid]) tbp[pid] = [];
        tbp[pid].push(t);
      }
    }
    return {
      tasksByProject: preserveStableSubArrays(tbp, tasksByProjectRef),
      allTasksByProject: preserveStableSubArrays(allTbp, allTasksByProjectRef),
    };
  }, [allTasks]);

  const timeLogsByProjectRef = useRef({});
  const timeLogsByProject = useMemo(() => {
    const map = {};
    for (const l of allTimeLogs) {
      const pid = l.project_id;
      if (!pid) continue;
      if (!map[pid]) map[pid] = [];
      map[pid].push(l);
    }
    return preserveStableSubArrays(map, timeLogsByProjectRef);
  }, [allTimeLogs]);

  // Memoize filtered projects to prevent excessive recalculation (Fix #10)
  const filteredProjects = useMemo(() => {
    return allProjects
    .filter(project => {
      // Exclude goal-sourced records — they belong to the Goals page
      if (project.source === 'goal') return false;
      // Archived view: toggle ON = show ONLY archived; OFF = hide archived (exclusive)
      if (showArchived ? !project.is_archived : project.is_archived) return false;

      // Payment status filter: 'unpaid' (default) hides paid projects, 'paid' hides
      // unpaid, 'all' shows everything. Treat null/missing payment_status as 'unpaid'.
      if (paymentFilter !== 'all') {
        const ps = project.payment_status === 'paid' ? 'paid' : 'unpaid';
        if (ps !== paymentFilter) return false;
      }

      const sq = searchQuery.toLowerCase();
      const matchesSearch = !sq ||
        project.title?.toLowerCase().includes(sq) ||
        project.property_address?.toLowerCase().includes(sq) ||
        project.client_name?.toLowerCase().includes(sq) ||
        project.agent_name?.toLowerCase().includes(sq);

      if (!matchesSearch) return false;

      // Helper: all user IDs that are nominally assigned to this project at any level
      const projectAssignedUserIds = new Set([
        project.project_owner_id,
        project.onsite_staff_1_id,
        project.onsite_staff_2_id,
        project.image_editor_id,
        project.video_editor_id,
      ].filter(Boolean));

      // Helper: all internal team IDs assigned to this project at any level
      const projectAssignedTeamIds = new Set([
        project.project_owner_type === 'team' ? project.project_owner_id : null,
        project.onsite_staff_1_type === 'team' ? project.onsite_staff_1_id : null,
        project.onsite_staff_2_type === 'team' ? project.onsite_staff_2_id : null,
        project.image_editor_type === 'team' ? project.image_editor_id : null,
        project.video_editor_type === 'team' ? project.video_editor_id : null,
      ].filter(Boolean));

      // Task-level assignments for this project (use pre-computed map to avoid O(N*M))
      const projectTasksForProject = allTasksByProject[project.id] || [];

      // "My Projects": current user is assigned at project-role level OR has a task assigned
      if (filters.assigned_to_me && currentUser) {
        const assignedViaRole = projectAssignedUserIds.has(currentUser.id);
        // Tasks store assigned_to as either user ID or email — check both
        const assignedViaTask = projectTasksForProject.some(
          t => t.assigned_to === currentUser.id ||
               t.assigned_to === currentUser.email ||
               t.assigned_to_name === currentUser.full_name
        );
        if (!assignedViaRole && !assignedViaTask) return false;
      }

      // "My Team": any team member is assigned at project-role level OR has a task assigned
      if (filters.assigned_to_my_team) {
        if (myTeamMemberUserIds.size === 0) return false;
        const teamMemberEmails = new Set(
          allEmployeeRoles
            .filter(er => er.team_id && myTeamIds.includes(er.team_id))
            .map(er => er.user_email)
            .filter(Boolean)
        );
        const teamAssignedViaRole = [...projectAssignedUserIds].some(uid => myTeamMemberUserIds.has(uid));
        const teamAssignedViaTask = projectTasksForProject.some(
          t => myTeamMemberUserIds.has(t.assigned_to) || teamMemberEmails.has(t.assigned_to)
        );
        const teamAssignedViaTeamRole = [...projectAssignedTeamIds].some(tid => myTeamIds.includes(tid));
        if (!teamAssignedViaRole && !teamAssignedViaTask && !teamAssignedViaTeamRole) return false;
      }

      // Product filter
      if (filters.products?.length > 0) {
        const hasProduct = project.products?.some(p => filters.products.includes(p.product_id));
        if (!hasProduct) return false;
      }
      
      // Package filter
      if (filters.packages?.length > 0) {
        const hasPackage = project.packages?.some(p => filters.packages.includes(p.package_id));
        if (!hasPackage) return false;
      }
      
      // Agent filter
      if (filters.agents?.length > 0 && !filters.agents.includes(project.agent_id)) {
        return false;
      }
      
      // Agency filter
      if (filters.agencies?.length > 0 && !filters.agencies.includes(project.agency_id)) {
        return false;
      }
      
      // Internal Users filter: user assigned at any project role level OR has a task assigned
      if (filters.internal_users?.length > 0) {
        const matchesRole = filters.internal_users.some(uid => projectAssignedUserIds.has(uid));
        const matchesTask = projectTasksForProject.some(
          t => filters.internal_users.includes(t.assigned_to)
        );
        if (!matchesRole && !matchesTask) return false;
      }

      // Internal Teams filter: team assigned at any project role level
      if (filters.internal_teams?.length > 0) {
        const matchesTeamRole = filters.internal_teams.some(tid => projectAssignedTeamIds.has(tid));
        if (!matchesTeamRole) return false;
      }

      // Shoot date range filter (normalize to YYYY-MM-DD to avoid string comparison issues)
      if (shootDateFrom && project.shoot_date) {
        const sd = project.shoot_date.slice(0, 10);
        if (sd < shootDateFrom) return false;
      } else if (shootDateFrom && !project.shoot_date) {
        return false;
      }
      if (shootDateTo && project.shoot_date) {
        const sd = project.shoot_date.slice(0, 10);
        if (sd > shootDateTo) return false;
      } else if (shootDateTo && !project.shoot_date) {
        return false;
      }

      // Priority filter
      if (priorityFilter !== 'all') {
        if (project.priority !== priorityFilter) return false;
      }

      return true;
    })
    .sort((a, b) => {
      if (sortBy === "task_deadline") {
        // Bug fix: use pre-computed tasksByProject map instead of O(n) filter per comparison
        const aTask = (tasksByProject[a.id] || []).filter(t => t.due_date).sort((x, y) => new Date(fixTimestamp(x.due_date)) - new Date(fixTimestamp(y.due_date)))[0];
        const bTask = (tasksByProject[b.id] || []).filter(t => t.due_date).sort((x, y) => new Date(fixTimestamp(x.due_date)) - new Date(fixTimestamp(y.due_date)))[0];
        if (!aTask && !bTask) return 0;
        if (!aTask) return 1;
        if (!bTask) return -1;
        return new Date(fixTimestamp(aTask.due_date)) - new Date(fixTimestamp(bTask.due_date));
      } else if (sortBy === "next_activity") {
        // Bug fix: sort by nearest upcoming date (shoot_date or earliest incomplete task due_date)
        const getNextActivity = (project) => {
          const now = new Date();
          const candidates = [];
          if (project.shoot_date) {
            const sd = new Date(project.shoot_date);
            if (sd >= now) candidates.push(sd);
          }
          const pTasks = tasksByProject[project.id] || [];
          pTasks.forEach(t => {
            if (!t.is_completed && t.due_date) {
              const d = new Date(fixTimestamp(t.due_date));
              if (d >= now) candidates.push(d);
            }
          });
          return candidates.length > 0 ? Math.min(...candidates.map(d => d.getTime())) : Infinity;
        };
        return getNextActivity(a) - getNextActivity(b);
      } else if (sortBy === "created_date") {
        return new Date(fixTimestamp(b.created_date)) - new Date(fixTimestamp(a.created_date));
      } else if (sortBy === "shoot_date_asc") {
        return new Date(a.shoot_date || '9999') - new Date(b.shoot_date || '9999');
      } else if (sortBy === "shoot_date_desc") {
        return new Date(b.shoot_date || '0000') - new Date(a.shoot_date || '0000');
      }
      return new Date(fixTimestamp(b.last_status_change) || 0) - new Date(fixTimestamp(a.last_status_change) || 0);
    });
  }, [allProjects, searchQuery, filters, sortBy, currentUser, myTeamMemberUserIds, myTeamIds, allTasks, tasksByProject, allTasksByProject, allEmployeeRoles, shootDateFrom, shootDateTo, priorityFilter, paymentFilter, showArchived]);

  // Column definitions for EntityDataTable (list view)
  const tableColumns = useMemo(() => {
    const fieldLabels = {
      agency_agent: "Agency / Agent",
      shoot: "Shoot",
      price: "Price",
      invoiced_amount: "Invoiced",
      priority: "Priority",
      property_type: "Type",
      products_packages: "Products & Packages",
      payment_status: "Payment",
      effort: "Effort",
    };

    const cols = [
      {
        key: "title",
        label: "Project",
        sortable: true,
        width: "260px",
        render: (project) => (
          <div className="min-w-0">
            <Link
               to={createPageUrl("ProjectDetails") + `?id=${project.id}`}
               className="font-medium text-sm hover:text-primary hover:underline leading-tight block truncate max-w-[240px] transition-colors"
               onClick={(e) => e.stopPropagation()}
               title={project.title}
             >
               {project.title}
             </Link>
             {project.property_address && (
               <TooltipProvider>
                 <Tooltip>
                   <TooltipTrigger asChild>
                     <p className="text-xs text-muted-foreground truncate max-w-[240px] mt-0.5 cursor-help">
                       {project.property_address}
                     </p>
                   </TooltipTrigger>
                   <TooltipContent className="max-w-xs">{project.property_address}</TooltipContent>
                 </Tooltip>
               </TooltipProvider>
             )}
           </div>
         ),
        sortValue: (r) => r.title ?? "",
      },
      {
        key: "status",
        label: "Status",
        sortable: true,
        width: "160px",
        render: (project) => (
          <div className="space-y-0.5">
            <ProjectStatusBadge status={project.status} lastStatusChange={project.last_status_change} />
            {enabledFields.includes("status_timer") && project.last_status_change && (
              <ProjectStatusTimer lastStatusChange={project.last_status_change} />
            )}
          </div>
        ),
        sortValue: (r) => r.status ?? "",
      },
    ];

    // Dynamic columns from card fields config (skip status_timer as it's merged into status col)
    enabledFields.forEach(fieldId => {
      if (fieldId === "status_timer") return;
      if (fieldId === "price" && !canSeePricing) return;
      if (!fieldLabels[fieldId]) return;

      cols.push({
        key: fieldId,
        label: fieldLabels[fieldId],
        sortable: ["agency_agent", "shoot", "price", "invoiced_amount", "priority", "payment_status", "property_type"].includes(fieldId),
        align: ["price", "invoiced_amount"].includes(fieldId) ? "right" : undefined,
        width: fieldId === "price" ? "110px" : (fieldId === "invoiced_amount" ? "110px" : undefined),
        render: (project) => {
          const tasks = tasksByProject[project.id] || [];
          const timeLogs = timeLogsByProject[project.id] || [];
          return (
            <ProjectFieldValue
              fieldId={fieldId}
              project={project}
              products={products}
              packages={packages}
              tasks={tasks}
              timeLogs={timeLogs}
            />
          );
        },
        sortValue: (r) => {
          if (fieldId === "shoot") return r.shoot_date ?? "";
          if (fieldId === "agency_agent") return r.client_name ?? r.agency_name ?? "";
          if (fieldId === "price") return r.calculated_price ?? r.price ?? 0;
          if (fieldId === "invoiced_amount") return r.invoiced_amount ?? null;
          return r[fieldId] ?? "";
        },
      });
    });

    return cols;
  }, [enabledFields, canSeePricing, products, packages, tasksByProject, timeLogsByProject]);

  const archivedCount = useMemo(() => allProjects.filter(p => p.is_archived).length, [allProjects]);

  // Memoize callbacks (Fix #13)
  const handleEdit = useCallback((project) => {
    setEditingProject(project);
    setShowProjectForm(true);
  }, []);

  if (loadError && !isLoading && allProjects.length === 0) {
    return (
      <div className="p-8 text-center text-destructive">
        <p className="font-medium">Failed to load projects. Please try again.</p>
        <button
          onClick={() => { refetchProjects(); refetchProducts(); refetchPackages(); refetchClients(); }}
          className="mt-2 text-sm underline hover:no-underline"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="px-3 pt-2 pb-3 sm:px-4 sm:pt-2 sm:pb-4 lg:px-6 space-y-2">
      {/* Header + Search + New Project — single compact row */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 shrink-0">
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2 select-none">
            Projects
            {isLoading && (
              <div className="h-4 w-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" role="status" aria-label="Loading projects" />
            )}
          </h1>
          <span className="text-xs text-muted-foreground tabular-nums">
            {isLoading ? (
              <Skeleton className="inline-block w-16 h-3.5" />
            ) : (
              <>
                {filteredProjects.length !== allProjects.filter(p => showArchived ? p.is_archived : !p.is_archived).length
                  ? `${filteredProjects.length}/${allProjects.filter(p => showArchived ? p.is_archived : !p.is_archived).length}`
                  : `${filteredProjects.length}`}
                {searchQuery && ` matching "${searchQuery}"`}
                {(Object.keys(filters).some(k => filters[k]?.length > 0) || shootDateFrom || shootDateTo || priorityFilter !== 'all' || paymentFilter !== 'unpaid') && !searchQuery && " filtered"}
              </>
            )}
          </span>
        </div>
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search projects, addresses, clients..."
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="pl-8 pr-16 h-8 text-sm focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 transition-all"
            title="Search by project title, address, or client name (Esc to clear)"
            autoComplete="off"
            spellCheck="false"
            aria-label="Search projects by title, address, or client"
          />
          {searchInput && (
           <>
             <span className="absolute right-10 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/60 font-medium tabular-nums">{searchInput.length}</span>
             <button
              onClick={() => { setSearchInput(""); setSearchQuery(""); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground hover:bg-muted rounded-full p-1 transition-colors focus:outline-none focus:ring-2 focus:ring-primary"
              title="Clear search (Esc)"
              aria-label="Clear search"
             >
              <X className="h-3.5 w-3.5" />
             </button>
           </>
          )}
        </div>
        <Button onClick={handleCreateNew} size="sm" className={cn("gap-1.5 shadow-sm hover:shadow-md transition-all focus:ring-2 focus:ring-primary focus:ring-offset-2 h-8 shrink-0", filteredProjects.length === 0 && !searchQuery && Object.keys(filters).length === 0 && "ring-2 ring-primary/30")} title="Create a new project (Ctrl+N)" aria-label="New project button - keyboard shortcut Ctrl+N">
          <Plus className="h-3.5 w-3.5" />
          <span className="hidden sm:inline text-xs">New Project</span>
          <span className="sm:hidden text-xs">New</span>
          <kbd className="hidden lg:inline-flex ml-0.5 text-[9px] bg-primary-foreground/20 px-1 py-0.5 rounded">⌘N</kbd>
        </Button>
      </div>

      {/* Filters & Sort */}
      <div className="space-y-1.5">
      <ProjectFiltersSort
          products={products}
          packages={packages}
          agents={agents}
          agencies={agencies}
          teams={teams}
          internalUsers={allUsers}
          internalTeams={teams}
          activeFilters={filters}
          activeSort={sortBy}
          onFiltersChange={setFilters}
          onSortChange={setSortBy}
        />

        {/* Date range + Priority filters */}
        <div className="flex items-center gap-1.5 flex-wrap overflow-x-auto scrollbar-none">
          {/* Quick date presets */}
          {[
            { label: 'Today', days: 0 },
            { label: 'Next 7 days', days: 7, future: true },
            { label: 'This month', month: true },
          ].map(preset => {
            const today = new Date().toISOString().slice(0, 10);
            const isActive = (() => {
              if (preset.days === 0) return shootDateFrom === today && shootDateTo === today;
              if (preset.month) {
                const start = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
                const end = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString().slice(0, 10);
                return shootDateFrom === start && shootDateTo === end;
              }
              if (preset.future) {
                const end = new Date(Date.now() + preset.days * 86400000).toISOString().slice(0, 10);
                return shootDateFrom === today && shootDateTo === end;
              }
              const start = new Date(Date.now() - preset.days * 86400000).toISOString().slice(0, 10);
              return shootDateFrom === start && shootDateTo === today;
            })();
            return (
              <button
                key={preset.label}
                onClick={() => {
                  const today = new Date().toISOString().slice(0, 10);
                  if (isActive) {
                    setShootDateFrom(''); setShootDateTo('');
                  } else if (preset.days === 0) {
                    setShootDateFrom(today); setShootDateTo(today);
                  } else if (preset.month) {
                    const start = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
                    const end = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString().slice(0, 10);
                    setShootDateFrom(start); setShootDateTo(end);
                  } else if (preset.future) {
                    const end = new Date(Date.now() + preset.days * 86400000).toISOString().slice(0, 10);
                    setShootDateFrom(today); setShootDateTo(end);
                  }
                }}
                className={`text-xs px-2 py-1 rounded-md border transition-all h-7 focus:ring-2 focus:ring-primary focus:ring-offset-1 focus:outline-none ${
                   isActive
                     ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                     : 'border-border text-muted-foreground hover:bg-muted hover:border-primary/30'
                 }`}
              >
                {preset.label}
              </button>
            );
          })}

          {/* Manual date inputs */}
          <input
           type="date"
           value={shootDateFrom}
           onChange={e => setShootDateFrom(e.target.value)}
           className="h-7 text-xs border border-border rounded-md px-2 bg-background focus:ring-2 focus:ring-primary focus:outline-none transition-all"
           title="Shoot date from"
           aria-label="Shoot date from"
          />
          <span className="text-xs text-muted-foreground">–</span>
          <input
           type="date"
           value={shootDateTo}
           onChange={e => setShootDateTo(e.target.value)}
           className="h-7 text-xs border border-border rounded-md px-2 bg-background focus:ring-2 focus:ring-primary focus:outline-none transition-all"
           title="Shoot date to"
           aria-label="Shoot date to"
          />

          {/* Priority filter */}
          <Select value={priorityFilter} onValueChange={setPriorityFilter}>
            <SelectTrigger className="h-7 w-[120px] text-xs focus:ring-2 focus:ring-primary">
              <SelectValue placeholder="Priority" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All priorities</SelectItem>
              <SelectItem value="urgent">Urgent</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="normal">Normal</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>

          {/* Payment filter — defaults to 'unpaid' so the board hides invoiced/paid work */}
          <Select value={paymentFilter} onValueChange={setPaymentFilter}>
            <SelectTrigger className="h-7 w-[110px] text-xs focus:ring-2 focus:ring-primary">
              <SelectValue placeholder="Payment" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unpaid">Unpaid only</SelectItem>
              <SelectItem value="paid">Paid only</SelectItem>
              <SelectItem value="all">All payments</SelectItem>
            </SelectContent>
          </Select>

          {/* Clear date filters */}
          {(shootDateFrom || shootDateTo || priorityFilter !== 'all' || paymentFilter !== 'unpaid') && (
            <button
              onClick={() => { setShootDateFrom(''); setShootDateTo(''); setPriorityFilter('all'); setPaymentFilter('unpaid'); }}
              className="text-xs text-muted-foreground hover:text-foreground hover:bg-muted px-2 h-7 rounded-md border border-transparent hover:border-border transition-all"
              title="Clear date, priority and payment filters"
            >
              Clear
            </button>
          )}

          {/* Show/Hide Archived */}
          <Button
            variant={showArchived ? "default" : "outline"}
            size="sm"
            className="text-xs gap-1 h-7"
            onClick={() => setShowArchived(v => !v)}
          >
            {showArchived ? "Hide archived" : "Show archived"}
            {archivedCount > 0 && (
              <Badge variant="secondary" className="text-[9px] h-4 px-1">{archivedCount}</Badge>
            )}
          </Button>
          </div>
          </div>

      {/* View Controls */}
       <div className="flex gap-1.5 justify-between items-center flex-wrap">
         <div className="flex items-center gap-1.5">
           <CardFieldsCustomizerButton onClick={() => setShowFieldCustomizer(true)} title="Customize card fields and columns" />
           {(Object.keys(filters).some(k => filters[k]?.length > 0) || shootDateFrom || shootDateTo || priorityFilter !== 'all') && (
             <Button variant="ghost" size="sm" onClick={() => {setSearchQuery(""); setFilters({}); setShootDateFrom(''); setShootDateTo(''); setPriorityFilter('all');}} className="text-xs text-muted-foreground hover:text-foreground h-7 focus:ring-2 focus:ring-primary" title="Clear all active filters">
               <X className="h-3.5 w-3.5 mr-1" />Clear All
             </Button>
           )}
         </div>
        <div className="flex gap-1.5 items-center">
          {viewMode === "kanban" && (
            <Button
              variant={fitToScreen ? "default" : "outline"}
              size="sm"
              onClick={() => setFitToScreen(!fitToScreen)}
              className="hidden sm:flex shadow-sm hover:shadow-md transition-all focus:ring-2 focus:ring-primary focus:ring-offset-1 h-7 text-xs"
              title={fitToScreen ? "Fitted to screen - click to disable" : "Click to fit columns to screen width (Shift+F)"}
              aria-label={fitToScreen ? "Disable fit to screen" : "Enable fit to screen - Shift+F"}
            >
              {fitToScreen ? "Fitted" : "Fit"}
            </Button>
          )}
          <Tabs value={viewMode} onValueChange={setViewModePersisted}>
           <TabsList className="bg-muted/60 hover:bg-muted/80 transition-colors duration-200 h-8">
             <TabsTrigger value="kanban" title="Kanban board view (Ctrl+K)" className="gap-1 hover:bg-muted/40 transition-colors focus:ring-2 focus:ring-primary focus:ring-offset-1 h-7 text-xs px-2" aria-label="Kanban view">
               <Columns3 className="h-3.5 w-3.5" />
               <span className="hidden lg:inline">Kanban</span>
               <kbd className="hidden xl:inline-flex ml-0.5 text-[9px] bg-background/60 px-1 py-0.5 rounded">⌘K</kbd>
             </TabsTrigger>
             <TabsTrigger value="grid" title="Grid card view (Ctrl+G)" className="gap-1 hover:bg-muted/40 transition-colors focus:ring-2 focus:ring-primary focus:ring-offset-1 h-7 text-xs px-2" aria-label="Grid view">
               <LayoutGrid className="h-3.5 w-3.5" />
               <span className="hidden lg:inline">Grid</span>
               <kbd className="hidden xl:inline-flex ml-0.5 text-[9px] bg-background/60 px-1 py-0.5 rounded">⌘G</kbd>
             </TabsTrigger>
             <TabsTrigger value="list" title="Table list view (Ctrl+L)" className="gap-1 hover:bg-muted/40 transition-colors focus:ring-2 focus:ring-primary focus:ring-offset-1 h-7 text-xs px-2" aria-label="List view">
               <List className="h-3.5 w-3.5" />
               <span className="hidden lg:inline">List</span>
               <kbd className="hidden xl:inline-flex ml-0.5 text-[9px] bg-background/60 px-1 py-0.5 rounded">⌘L</kbd>
             </TabsTrigger>
           </TabsList>
          </Tabs>
        </div>
      </div>

      {/* List view — EntityDataTable owns its own loading skeleton, empty state, sorting & pagination */}
      {viewMode === "list" && (
        <EntityDataTable
          columns={tableColumns}
          data={filteredProjects}
          loading={isLoading}
          onRowClick={handleEdit}
          pageSize={75}
          emptyMessage={
            searchQuery || Object.keys(filters).some(k => filters[k]?.length > 0) || shootDateFrom || shootDateTo || priorityFilter !== 'all' || paymentFilter !== 'unpaid'
              ? `No projects match your filters — ${allProjects.filter(p => showArchived ? p.is_archived : !p.is_archived).length} total available`
              : "No projects yet — create your first project above"
          }
        />
      )}

      {/* Kanban + Grid views */}
      {viewMode !== "list" && (
        isLoading ? (
          viewMode === "kanban" ? (
            // Column-shaped skeleton matches the actual layout the user is about to see,
            // so the structural shift on first paint is minimised.
            <div className="grid auto-rows-min gap-2"
                 style={{ gridTemplateColumns: `repeat(${PROJECT_STAGES.filter(s => s.value !== 'pending_review').length}, minmax(220px, 1fr))` }}>
              {PROJECT_STAGES.filter(s => s.value !== 'pending_review').map(stage => (
                <div key={stage.value} className="rounded-md border border-border/40 bg-muted/15">
                  <div className="px-2 py-2 border-b border-border/40 flex items-center justify-between gap-2">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-4 w-6 rounded-full" />
                  </div>
                  <div className="p-2 space-y-2 min-h-[400px]">
                    {Array(3).fill(0).map((_, i) => (
                      <Card key={i} className="p-2 space-y-1.5">
                        <Skeleton className="h-3 w-3/4" />
                        <Skeleton className="h-2.5 w-2/3" />
                        <div className="flex items-center gap-1.5 pt-1">
                          <Skeleton className="h-2.5 w-16" />
                          <Skeleton className="h-2.5 w-2.5 rounded-full ml-auto" />
                        </div>
                      </Card>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {Array(9).fill(0).map((_, i) => (
                <Card key={i} className="p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <Skeleton className="h-5 w-3/5" />
                    <Skeleton className="h-5 w-16 rounded-full" />
                  </div>
                  <Skeleton className="h-3.5 w-2/3" />
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-3 w-20" />
                    <Skeleton className="h-3 w-3 rounded-full" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                  <div className="flex items-center gap-2 pt-2 border-t">
                    <Skeleton className="h-6 w-6 rounded-full" />
                    <Skeleton className="h-3 w-28" />
                    <Skeleton className="h-5 w-14 rounded-full ml-auto" />
                  </div>
                </Card>
              ))}
            </div>
          )
        ) : filteredProjects.length === 0 ? (
          <Card className="p-8 text-center border-2 border-dashed bg-muted/30 shadow-sm">
            <div className="max-w-md mx-auto">
              {searchQuery || Object.keys(filters).some(k => filters[k]?.length > 0) || shootDateFrom || shootDateTo || priorityFilter !== 'all' ? (
                <>
                  <Search className="h-10 w-10 mx-auto mb-3 text-muted-foreground/40" />
                  <h3 className="text-lg font-semibold mb-1">No matching projects</h3>
                  <p className="text-muted-foreground mb-1 text-sm">
                    {searchQuery && <>No results for "<span className="font-medium text-foreground">{searchQuery}</span>". </>}
                    {allProjects.length > 0 && (
                      <span className="text-xs">({allProjects.filter(p => showArchived ? p.is_archived : !p.is_archived).length} total projects available)</span>
                    )}
                  </p>
                  <p className="text-muted-foreground mb-4 text-xs">
                    Try broadening your search or removing some filters.
                  </p>
                  <Button variant="outline" size="sm" onClick={() => { setSearchQuery(""); setSearchInput(""); setFilters({}); setShootDateFrom(''); setShootDateTo(''); setPriorityFilter('all'); }} className="shadow-sm hover:shadow-md transition-all focus:ring-2 focus:ring-primary focus:ring-offset-2 h-9">
                    <X className="h-4 w-4 mr-1.5" />
                    Clear All Filters
                  </Button>
                </>
              ) : (
                <>
                  <Camera className="h-12 w-12 mx-auto mb-3 text-primary/50 animate-pulse" />
                  <h3 className="text-lg font-semibold mb-2">No projects yet</h3>
                  <p className="text-muted-foreground mb-4 text-sm">
                    Create your first project to get started
                  </p>
                  <Button onClick={handleCreateNew} className="shadow-sm hover:shadow-lg ring-2 ring-primary/30 hover:ring-primary/50 transition-all focus:ring-primary focus:ring-offset-2 h-10">
                    <Plus className="h-4 w-4 mr-1.5" />
                    New Project
                  </Button>
                </>
              )}
            </div>
          </Card>
        ) : viewMode === "kanban" ? (
          <div className="animate-in fade-in duration-300" style={{ height: 'calc(100vh - 200px)', minHeight: '400px' }}>
            <ErrorBoundary fallbackLabel="Kanban Board" compact>
              <KanbanBoard
                projects={filteredProjects}
                clients={clients}
                products={products}
                packages={packages}
                fitToScreen={fitToScreen}
                allTasks={allTasks}
                allTimeLogs={allTimeLogs}
                calendarEvents={allCalendarEvents}
              />
            </ErrorBoundary>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 auto-rows-max animate-in fade-in duration-300">
             {filteredProjects.map(project => {
               const projectTasks = tasksByProject[project.id] || [];
               const projectTimeLogs = timeLogsByProject[project.id] || [];
               return (
                 <div key={project.id} className="cursor-pointer hover:shadow-lg hover:-translate-y-0.5 hover:border-primary/30 transition-all duration-200 rounded-lg border border-transparent" onClick={() => handleEdit(project)}>
                   <ProjectCard project={project} products={products} packages={packages} tasks={projectTasks} timeLogs={projectTimeLogs} />
                 </div>
               );
             })}
           </div>
        )
      )}

      <CardFieldsCustomizer open={showFieldCustomizer} onClose={() => setShowFieldCustomizer(false)} />

      <ProjectForm
        project={editingProject}
        open={showProjectForm}
        onClose={() => {
          setShowProjectForm(false);
          setEditingProject(null);
        }}
        onSave={(result) => {
          setShowProjectForm(false);
          setEditingProject(null);
          // Navigate to the newly created project so the user sees it immediately
          if (result?.isNew && result?.id) {
            navigate(createPageUrl("ProjectDetails") + `?id=${result.id}`);
          }
        }}
      />

      <KeyboardShortcutsModal open={showShortcuts} onOpenChange={setShowShortcuts} />
    </div>
  );
}