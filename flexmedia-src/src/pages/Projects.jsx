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
import ErrorBoundary from "@/components/common/ErrorBoundary";
import CardFieldsCustomizer, { CardFieldsCustomizerButton } from "@/components/projects/CardFieldsCustomizer";
import ProjectFiltersSort from "@/components/projects/ProjectFiltersSort";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { fixTimestamp } from "@/components/utils/dateUtils";
import { useCardFields } from "@/components/projects/useCardFields";
import { ProjectFieldValue } from "@/components/projects/ProjectCardFields";
import EntityDataTable from "@/components/common/EntityDataTable";
import QuickStatsBar from "@/components/common/QuickStatsBar";
import KeyboardShortcutsModal from "@/components/common/KeyboardShortcutsModal";



export default function Projects() {
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
  const [fitToScreen, setFitToScreen] = useState(false);
  const [showFieldCustomizer, setShowFieldCustomizer] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [filters, setFilters] = useState({});
  const [showArchived, setShowArchived] = useState(false);
  const [sortBy, setSortBy] = useState("last_status_change");
  const [shootDateFrom, setShootDateFrom] = useState('');
  const [shootDateTo, setShootDateTo] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('all');
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
   const { data: allProjects = [], loading: projectsLoading } = useEntityList("Project", "-created_date", 200);
   const { data: products = [], loading: productsLoading } = useEntityList("Product", "-created_date", 200);
   const { data: packages = [], loading: packagesLoading } = useEntityList("Package", "-created_date", 200);
   const { data: clients = [], loading: clientsLoading } = useEntityList("Client", null, 100);
   
   // Secondary batch: loaded but not blocking
   const { data: allTasks = [] } = useEntityList("ProjectTask", "-due_date", 300);
   const { data: allTimeLogs = [] } = useEntityList("TaskTimeLog", null, 50);
   const { data: agents = [] } = useEntityList("Agent", null, 50);
   const { data: agencies = [] } = useEntityList("Agency", null, 50);
   const { data: teams = [] } = useEntityList("InternalTeam", null, 30);
   const { data: allUsers = [] } = useEntityList("User", null, 30);
   const { data: allEmployeeRoles = [] } = useEntityList("EmployeeRole", null, 100);

   const isLoading = projectsLoading || clientsLoading || productsLoading || packagesLoading;

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

  // Bug fix: pre-compute task map BEFORE filteredProjects so sort can use it (avoids O(n*m) inside comparator)
  const tasksByProject = useMemo(() => {
    const map = {};
    allTasks.forEach(t => {
      if (!t.parent_task_id) {
        if (!map[t.project_id]) map[t.project_id] = [];
        map[t.project_id].push(t);
      }
    });
    return map;
  }, [allTasks]);

  // Pre-compute ALL tasks (including subtasks) by project for filter assignment checks
  const allTasksByProject = useMemo(() => {
    const map = {};
    allTasks.forEach(t => {
      if (!map[t.project_id]) map[t.project_id] = [];
      map[t.project_id].push(t);
    });
    return map;
  }, [allTasks]);

  // Memoize filtered projects to prevent excessive recalculation (Fix #10)
  const filteredProjects = useMemo(() => {
    return allProjects
    .filter(project => {
      // Hide archived unless toggled on
      if (!showArchived && project.is_archived) return false;

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

      // Task-level assignments for this project (use pre-computed map to avoid O(n*m))
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

      // Shoot date range filter
      if (shootDateFrom) {
        if (!project.shoot_date || project.shoot_date < shootDateFrom) return false;
      }
      if (shootDateTo) {
        if (!project.shoot_date || project.shoot_date > shootDateTo) return false;
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
  }, [allProjects, searchQuery, filters, sortBy, currentUser, myTeamMemberUserIds, myTeamIds, allTasks, tasksByProject, allTasksByProject, shootDateFrom, shootDateTo, priorityFilter, showArchived]);

  // tasksByProject is now computed above filteredProjects (Bug fix #7)

  const timeLogsByProject = useMemo(() => {
    const map = {};
    allTimeLogs.forEach(l => {
      if (!map[l.project_id]) map[l.project_id] = [];
      map[l.project_id].push(l);
    });
    return map;
  }, [allTimeLogs]);

  // Column definitions for EntityDataTable (list view)
  const tableColumns = useMemo(() => {
    const fieldLabels = {
      agency_name: "Agency",
      agent_name: "Agent",
      shoot_date: "Shoot Date",
      shoot_time: "Time",
      delivery_date: "Delivery",
      price: "Price",
      invoiced_amount: "Invoiced",
      priority: "Priority",
      property_type: "Type",
      products: "Products",
      packages: "Packages",
      outcome: "Outcome",
      payment_status: "Payment",
      notes: "Notes",
      delivery_link: "Link",
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
        sortable: ["agency_name", "agent_name", "shoot_date", "delivery_date", "price", "invoiced_amount", "priority", "outcome", "payment_status", "property_type"].includes(fieldId),
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
          if (fieldId === "shoot_date") return r.shoot_date ?? "";
          if (fieldId === "delivery_date") return r.delivery_date ?? "";
          if (fieldId === "price") return r.calculated_price ?? r.price ?? 0;
          if (fieldId === "invoiced_amount") return r.invoiced_amount ?? null;
          return r[fieldId] ?? "";
        },
      });
    });

    return cols;
  }, [enabledFields, canSeePricing, products, packages, tasksByProject, timeLogsByProject]);

  // Memoize the tasks passed to QuickStatsBar to avoid O(tasks*projects) on every render
  const filteredProjectIds = useMemo(() => new Set(filteredProjects.map(p => p.id)), [filteredProjects]);
  const statsBarTasks = useMemo(() =>
    allTasks.filter(t => filteredProjectIds.has(t.project_id) && !t.parent_task_id),
    [allTasks, filteredProjectIds]
  );

  const archivedCount = useMemo(() => allProjects.filter(p => p.is_archived).length, [allProjects]);

  // Memoize callbacks (Fix #13)
  const handleEdit = useCallback((project) => {
    setEditingProject(project);
    setShowProjectForm(true);
  }, []);

  return (
    <div className="p-3 sm:p-6 lg:p-8 space-y-4 sm:space-y-6">
      {/* Quick Stats */}
      <QuickStatsBar projects={filteredProjects} tasks={statsBarTasks} />

      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            Projects
            {isLoading && (
              <div className="h-5 w-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" role="status" aria-label="Loading projects" />
            )}
          </h1>
          {/* Breadcrumb */}
          <nav className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5" aria-label="Breadcrumb">
            <Link to={createPageUrl("Dashboard")} className="hover:text-foreground hover:underline transition-colors focus:ring-1 focus:ring-primary px-1 rounded" title="Back to Dashboard">Dashboard</Link>
            <span aria-hidden="true">›</span>
            <span className="text-foreground font-medium">Projects</span>
          </nav>
          <p className="text-muted-foreground mt-1">
            {isLoading ? (
              <Skeleton className="inline-block w-24 h-4" />
            ) : (
              <>
                {filteredProjects.length} {filteredProjects.length === 1 ? 'project' : 'projects'}
                {searchQuery && ` matching "${searchQuery}"`}
                {(Object.keys(filters).some(k => filters[k]?.length > 0) || shootDateFrom || shootDateTo || priorityFilter !== 'all') && !searchQuery && " with active filters"}
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
            <Button onClick={handleCreateNew} className={cn("gap-2 shadow-sm hover:shadow-md transition-all focus:ring-2 focus:ring-primary focus:ring-offset-2 h-10", filteredProjects.length === 0 && !searchQuery && Object.keys(filters).length === 0 && "ring-2 ring-primary/30")} title="Create a new project (Ctrl+N)" aria-label="New project button - keyboard shortcut Ctrl+N">
             <Plus className="h-4 w-4" />
             <span className="hidden sm:inline">New Project</span>
             <span className="sm:hidden">New</span>
             <kbd className="hidden lg:inline-flex ml-1 text-[9px] bg-primary-foreground/20 px-1.5 py-0.5 rounded">⌘N</kbd>
           </Button>
         </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          placeholder="Search projects, addresses, clients... (Esc to clear)"
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="pl-10 pr-20 h-10 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 transition-all"
          title="Search by project title, address, or client name (Esc to clear)"
          autoComplete="off"
          spellCheck="false"
          aria-label="Search projects by title, address, or client"
        />
        {searchInput && (
         <>
           <span className="absolute right-12 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/60 font-medium tabular-nums">{searchInput.length}</span>
           <button
            onClick={() => { setSearchInput(""); setSearchQuery(""); }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground hover:bg-muted rounded-full p-1.5 transition-colors focus:outline-none focus:ring-2 focus:ring-primary"
            title="Clear search (Esc)"
            aria-label="Clear search"
           >
            <X className="h-4 w-4" />
           </button>
         </>
        )}
      </div>

      {/* Filters & Sort */}
      <div className="space-y-4">
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
        <div className="flex items-center gap-2 flex-wrap overflow-x-auto scrollbar-none pb-1">
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
                className={`text-xs px-2.5 py-1.5 rounded-lg border transition-all h-9 focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:outline-none ${
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
           className="h-10 text-sm border border-border rounded-lg px-3 bg-background focus:ring-2 focus:ring-primary focus:outline-none transition-all"
           title="Shoot date from"
           aria-label="Shoot date from"
          />
          <span className="text-xs text-muted-foreground mx-1">–</span>
          <input
           type="date"
           value={shootDateTo}
           onChange={e => setShootDateTo(e.target.value)}
           className="h-10 text-sm border border-border rounded-lg px-3 bg-background focus:ring-2 focus:ring-primary focus:outline-none transition-all"
           title="Shoot date to"
           aria-label="Shoot date to"
          />

          {/* Priority filter */}
          <Select value={priorityFilter} onValueChange={setPriorityFilter}>
            <SelectTrigger className="h-10 w-[140px] text-sm focus:ring-2 focus:ring-primary">
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

          {/* Clear date filters */}
          {(shootDateFrom || shootDateTo || priorityFilter !== 'all') && (
            <button
              onClick={() => { setShootDateFrom(''); setShootDateTo(''); setPriorityFilter('all'); }}
              className="text-xs text-muted-foreground hover:text-foreground hover:bg-muted px-2.5 h-9 rounded-lg border border-transparent hover:border-border transition-all"
              title="Clear date and priority filters"
            >
              Clear
            </button>
          )}

          {/* Show/Hide Archived */}
          <Button
            variant={showArchived ? "default" : "outline"}
            size="sm"
            className="text-xs gap-1.5"
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
       <div className="flex gap-2 justify-between items-center flex-wrap">
         <div className="flex items-center gap-2">
           <CardFieldsCustomizerButton onClick={() => setShowFieldCustomizer(true)} title="Customize card fields and columns" />
           {(Object.keys(filters).some(k => filters[k]?.length > 0) || shootDateFrom || shootDateTo || priorityFilter !== 'all') && (
             <Button variant="ghost" size="sm" onClick={() => {setSearchQuery(""); setFilters({}); setShootDateFrom(''); setShootDateTo(''); setPriorityFilter('all');}} className="text-xs text-muted-foreground hover:text-foreground h-9 focus:ring-2 focus:ring-primary" title="Clear all active filters">
               <X className="h-4 w-4 mr-1" />Clear All
             </Button>
           )}
         </div>
        <div className="flex gap-2 items-center">
          {viewMode === "kanban" && (
            <Button
              variant={fitToScreen ? "default" : "outline"}
              size="sm"
              onClick={() => setFitToScreen(!fitToScreen)}
              className="hidden sm:flex shadow-sm hover:shadow-md transition-shadow focus:ring-2 focus:ring-primary focus:ring-offset-2 h-9"
              title={fitToScreen ? "Fitted to screen - click to disable" : "Click to fit columns to screen width (Shift+F)"}
              aria-label={fitToScreen ? "Disable fit to screen" : "Enable fit to screen - Shift+F"}
            >
              {fitToScreen ? "📌 Fitted" : "↔ Fit"}
            </Button>
          )}
          <Tabs value={viewMode} onValueChange={setViewModePersisted}>
           <TabsList className="bg-muted/60 hover:bg-muted/80 transition-colors duration-200">
             <TabsTrigger value="kanban" title="Kanban board view (Ctrl+K)" className="gap-1.5 hover:bg-muted/40 transition-colors focus:ring-2 focus:ring-primary focus:ring-offset-2 h-9" aria-label="Kanban view">
               <Columns3 className="h-4 w-4" />
               <span className="hidden lg:inline text-xs">Kanban</span>
               <kbd className="hidden xl:inline-flex ml-1 text-[9px] bg-background/60 px-1 py-0.5 rounded">⌘K</kbd>
             </TabsTrigger>
             <TabsTrigger value="grid" title="Grid card view (Ctrl+G)" className="gap-1.5 hover:bg-muted/40 transition-colors focus:ring-2 focus:ring-primary focus:ring-offset-2 h-9" aria-label="Grid view">
               <LayoutGrid className="h-4 w-4" />
               <span className="hidden lg:inline text-xs">Grid</span>
               <kbd className="hidden xl:inline-flex ml-1 text-[9px] bg-background/60 px-1 py-0.5 rounded">⌘G</kbd>
             </TabsTrigger>
             <TabsTrigger value="list" title="Table list view (Ctrl+L)" className="gap-1.5 hover:bg-muted/40 transition-colors focus:ring-2 focus:ring-primary focus:ring-offset-2 h-9" aria-label="List view">
               <List className="h-4 w-4" />
               <span className="hidden lg:inline text-xs">List</span>
               <kbd className="hidden xl:inline-flex ml-1 text-[9px] bg-background/60 px-1 py-0.5 rounded">⌘L</kbd>
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
            searchQuery || Object.keys(filters).some(k => filters[k]?.length > 0) || shootDateFrom || shootDateTo || priorityFilter !== 'all'
              ? `No projects match your filters — ${allProjects.filter(p => !p.is_archived || showArchived).length} total available`
              : "No projects yet — create your first project above"
          }
        />
      )}

      {/* Kanban + Grid views */}
      {viewMode !== "list" && (
        isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array(9).fill(0).map((_, i) => (
              <Card key={i} className="p-5 space-y-3">
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
        ) : filteredProjects.length === 0 ? (
          <Card className="p-12 text-center border-2 border-dashed bg-muted/30 shadow-sm">
            <div className="max-w-md mx-auto">
              {searchQuery || Object.keys(filters).some(k => filters[k]?.length > 0) || shootDateFrom || shootDateTo || priorityFilter !== 'all' ? (
                <>
                  <Search className="h-10 w-10 mx-auto mb-3 text-muted-foreground/40" />
                  <h3 className="text-lg font-semibold mb-1">No matching projects</h3>
                  <p className="text-muted-foreground mb-1 text-sm">
                    {searchQuery && <>No results for "<span className="font-medium text-foreground">{searchQuery}</span>". </>}
                    {allProjects.length > 0 && (
                      <span className="text-xs">({allProjects.filter(p => !p.is_archived || showArchived).length} total projects available)</span>
                    )}
                  </p>
                  <p className="text-muted-foreground mb-4 text-xs">
                    Try broadening your search or removing some filters.
                  </p>
                  <Button variant="outline" size="sm" onClick={() => { setSearchQuery(""); setSearchInput(""); setFilters({}); setShootDateFrom(''); setShootDateTo(''); setPriorityFilter('all'); }} className="shadow-sm hover:shadow-md transition-shadow focus:ring-2 focus:ring-primary focus:ring-offset-2 h-9">
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
          <div className="animate-in fade-in duration-300">
            <ErrorBoundary fallbackLabel="Kanban Board" compact>
              <KanbanBoard
                projects={filteredProjects}
                clients={clients}
                products={products}
                packages={packages}
                fitToScreen={fitToScreen}
                allTasks={allTasks}
                allTimeLogs={allTimeLogs}
              />
            </ErrorBoundary>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 auto-rows-max animate-in fade-in duration-300">
             {filteredProjects.map(project => {
               const projectTasks = tasksByProject[project.id] || [];
               const projectTimeLogs = timeLogsByProject[project.id] || [];
               return (
                 <div key={project.id} className="cursor-pointer hover:shadow-md hover:-translate-y-0.5 transition-all duration-150" onClick={() => handleEdit(project)}>
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
        onSave={() => {
          setShowProjectForm(false);
          setEditingProject(null);
        }}
      />

      <KeyboardShortcutsModal open={showShortcuts} onOpenChange={setShowShortcuts} />
    </div>
  );
}