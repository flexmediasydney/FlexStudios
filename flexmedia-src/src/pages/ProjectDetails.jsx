import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { api } from "@/api/supabaseClient";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePermissions, useCurrentUser } from "@/components/auth/PermissionGuard";
import { useEntityAccess } from '@/components/auth/useEntityAccess';
import { useSmartEntityData, useSmartEntityList } from "@/components/hooks/useSmartEntityData";
import { refetchEntityList } from "@/components/hooks/useEntityData";
import { invalidateProjectCaches } from "@/lib/invalidateProjectCaches";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { 
  ArrowLeft, MapPin, Calendar, Clock as ClockIcon, User, Users, Phone,
  ExternalLink, Edit, Archive, CheckCircle, Building, Search,
  Star, Zap, Trophy, XCircle, CreditCard, AlertCircle, Camera, AlertTriangle, CheckCircle2
} from "lucide-react";
import { PROJECT_STAGES, stageLabel } from "@/components/projects/projectStatuses";
import StagePipeline from "@/components/projects/StagePipeline";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { fmtDate, fixTimestamp } from "@/components/utils/dateUtils";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import ProjectForm from "@/components/projects/ProjectForm";
import TonomoPendingDeltaBanner from "@/components/projects/TonomoPendingDeltaBanner";
import TaskManagement from "@/components/projects/TaskManagement";
import ProjectMediaGallery from "@/components/projects/ProjectMediaGallery";
import ProjectFilesTab from "@/components/projects/ProjectFilesTab";
import ProjectDronesTab from "@/components/projects/ProjectDronesTab";
import FavoriteButton from "@/components/favorites/FavoriteButton";
import EffortLoggingTab from "@/components/projects/EffortLoggingTab";
import ProjectCalendarEvents from "@/components/projects/ProjectCalendarEvents";
import ProjectActivityHub from "@/components/projects/ProjectActivityHub";
import AgencyBrandingSummary from "@/components/projects/AgencyBrandingSummary";
import PropertyIntelligencePanel from "@/components/property/PropertyIntelligencePanel";
import ProjectStaffBar from "@/components/projects/ProjectStaffBar";
import ProjectPresenceIndicator from "@/components/projects/ProjectPresenceIndicator";
import ProjectPricingTable from "@/components/projects/ProjectPricingTable";
import ProjectDurationTimer from "@/components/projects/ProjectDurationTimer";
import ProjectValidationBanner from "@/components/projects/ProjectValidationBanner";
import ConcurrentEditDetector from "@/components/projects/ConcurrentEditDetector";
import ProjectEffortCard from "@/components/projects/ProjectEffortCard";
import ProjectProgressBar from "@/components/projects/ProjectProgressBar";
import RequestsProgressBar from "@/components/projects/RequestsProgressBar";
import ProjectHealthIndicator from "@/components/projects/ProjectHealthIndicator";
import EmailComposeDialog from "@/components/email/EmailComposeDialog";
import ProjectRevisionsTab from "@/components/revisions/ProjectRevisionsTab";
import ProjectWeatherCard from "@/components/projects/ProjectWeatherCard";
import ActiveTimersPanel from "@/components/projects/ActiveTimersPanel";
import { scheduleDeadlineSync } from "@/components/projects/taskDeadlineSync";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useProjectHasDroneWork } from "@/hooks/useProjectHasDroneWork";
import { useProjectTasks } from "@/hooks/useProjectTasks";
import TonomoTab from "@/components/tonomo/TonomoTab";
import ProjectShortlistingTab from "@/components/projects/ProjectShortlistingTab";
import { createNotification, createNotificationsForUsers, writeFeedEvent } from "@/components/notifications/createNotification";
import ErrorBoundary from "@/components/common/ErrorBoundary";
import AIChat from "@/components/ai/AIChat";


// BUG FIX: moved VALID_TABS to module level — was inside the component body,
// creating a new Set on every render. Since it's a constant, it belongs here.
const statuses = PROJECT_STAGES;
const VALID_TABS = new Set(['tasks', 'revisions', 'effort', 'calendar', 'media', 'files', 'shortlisting', 'drones', 'tonomo']);

const serviceLabels = {
  photography: "📷 Photography",
  video_tour: "🎬 Video Tour",
  drone: "🚁 Drone/Aerial",
  virtual_staging: "🛋️ Virtual Staging",
  floor_plan: "📐 Floor Plan",
  twilight: "🌅 Twilight",
  "3d_tour": "🔲 3D Tour"
};

const propertyTypeLabels = {
  residential: "Residential",
  commercial: "Commercial",
  luxury: "Luxury",
  rental: "Rental",
  land: "Land/Lot"
};

// Valid forward transitions — defines allowed next stages from each stage.
// Not enforced yet (backward confirmation is sufficient for now), but
// available for future gating / UI filtering of the stage pipeline.
const VALID_FORWARD_TRANSITIONS = {
  pending_review: ['to_be_scheduled', 'scheduled', 'cancelled'],
  to_be_scheduled: ['scheduled', 'cancelled'],
  scheduled: ['onsite', 'cancelled'],
  onsite: ['uploaded', 'cancelled'],
  uploaded: ['submitted', 'cancelled'],
  submitted: ['in_progress', 'cancelled'],
  in_progress: ['in_production', 'cancelled'],
  in_production: ['ready_for_partial', 'in_revision', 'delivered', 'cancelled'],
  ready_for_partial: ['in_revision', 'delivered', 'cancelled'],
  in_revision: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: ['pending_review'], // allow reactivation
};

function InvoicedAmountInput({ value, onSave, isPending }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const startEdit = () => {
    setDraft(value !== "" && value !== null ? String(value) : "");
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    if (draft !== String(value ?? "")) onSave(draft);
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <span className="text-sm text-muted-foreground">$</span>
        <input
          autoFocus
          type="number"
          min="0"
          step="0.01"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
          className="w-24 h-6 text-sm font-bold border rounded px-1.5 focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>
    );
  }

  return (
    <button
      onClick={startEdit}
      disabled={isPending}
      className="text-sm font-bold text-left hover:text-primary transition-colors"
      title="Click to edit invoiced amount"
    >
      {value !== "" && value !== null && !isNaN(Number(value))
        ? `$${Number(value).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
        : <span className="text-muted-foreground font-normal text-xs">Click to set</span>
      }
    </button>
  );
}

// ── Agent Selector Dialog ─────────────────────────────────────────────────────
function AgentSelectorDialog({ agents, currentAgentId, isPending, onSelect, onClose }) {
  const [search, setSearch] = useState("");
  const inputRef = React.useRef(null);

  React.useEffect(() => {
    // Auto-focus search on open
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  const filtered = React.useMemo(() => {
    if (!search.trim()) return agents;
    const q = search.toLowerCase();
    return agents.filter(a =>
      a.name?.toLowerCase().includes(q) ||
      a.current_agency_name?.toLowerCase().includes(q) ||
      a.email?.toLowerCase().includes(q)
    );
  }, [agents, search]);

  // Group by agency
  const grouped = React.useMemo(() => {
    const map = new Map();
    for (const a of filtered) {
      const agency = a.current_agency_name || "No Agency";
      if (!map.has(agency)) map.set(agency, []);
      map.get(agency).push(a);
    }
    // Sort agencies alphabetically, "No Agency" last
    return Array.from(map.entries()).sort((a, b) => {
      if (a[0] === "No Agency") return 1;
      if (b[0] === "No Agency") return -1;
      return a[0].localeCompare(b[0]);
    });
  }, [filtered]);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-in fade-in duration-200" onClick={onClose}>
      <Card className="w-full max-w-md max-h-[85vh] flex flex-col animate-in scale-in-95 duration-200" onClick={e => e.stopPropagation()}>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Select Agent</CardTitle>
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="Close">✕</button>
          </div>
          <div className="relative mt-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              ref={inputRef}
              placeholder="Search by name, agency, or email..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 h-9 text-sm"
            />
          </div>
        </CardHeader>
        <CardContent className="flex-1 overflow-y-auto space-y-1 pb-4" style={{ maxHeight: '60vh' }}>
          <button
            className={cn(
              "w-full text-left px-3 py-2 rounded-lg text-sm transition-colors",
              !currentAgentId ? "bg-primary text-primary-foreground" : "hover:bg-muted"
            )}
            onClick={() => onSelect(null)}
            disabled={isPending}
          >
            {isPending ? "Updating..." : "Remove Agent"}
          </button>

          {grouped.length === 0 && search && (
            <p className="text-sm text-muted-foreground text-center py-6">No agents match "{search}"</p>
          )}

          {grouped.map(([agency, agencyAgents]) => (
            <div key={agency}>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-3 pt-3 pb-1">{agency}</div>
              {agencyAgents.map(a => (
                <button
                  key={a.id}
                  className={cn(
                    "w-full text-left px-3 py-2.5 rounded-lg transition-colors flex items-center gap-3",
                    currentAgentId === a.id ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                  )}
                  onClick={() => onSelect(a.id)}
                  disabled={isPending}
                >
                  <div className={cn(
                    "w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0",
                    currentAgentId === a.id ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-muted-foreground"
                  )}>
                    {(a.name || "?")[0]?.toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{a.name}</div>
                    {a.email && (
                      <div className={cn("text-xs truncate", currentAgentId === a.id ? "text-primary-foreground/70" : "text-muted-foreground")}>{a.email}</div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

export default function ProjectDetails() {
   // BUG FIX: use useSearchParams so projectId updates reactively on client-side
   // navigation.  The old useMemo(..., []) never re-ran, so navigating to a
   // different project within the SPA left a stale ID forever.
   const [searchParams] = useSearchParams();
   const projectId = searchParams.get("id");
   const navigate = useNavigate();

   useEffect(() => {
     if (!projectId) {
       navigate(createPageUrl("Projects"));
     }
   }, [projectId, navigate]);

   const queryClient = useQueryClient();
   const { canSeePricing, canEditProject, canAccessProject, isMasterAdmin, isEmployee, isEmployeeOrAbove, user: permUser } = usePermissions();
   const { canEdit: entityCanEdit, canView: entityCanView } = useEntityAccess('projects');
   const [showEditForm, setShowEditForm] = useState(false);
   const [showAgentSelector, setShowAgentSelector] = useState(false);
   const [composeToAgent, setComposeToAgent] = useState(null);
   const [errorMessage, setErrorMessage] = useState(null);
   const [dismissedDeliveryPrompt, setDismissedDeliveryPrompt] = useState(false);
   // Backward stage regression confirmation
   const [pendingBackwardStage, setPendingBackwardStage] = useState(null);

   // Tab state — persisted in URL ?tab= param so reload preserves active tab
   // (VALID_TABS is now at module level to avoid re-creating the Set every render)
   const [activeTab, setActiveTab] = useState(() => {
     const tab = searchParams.get('tab');
     return tab && VALID_TABS.has(tab) ? tab : 'tasks';
   });
   // projectRaw loaded below, so initialize without conditional tonomo tab
   const [mountedTabs, setMountedTabs] = useState(new Set([
     searchParams.get('tab') || 'tasks'
   ]));

   const handleTabChange = (tab) => {
     setActiveTab(tab);
     setMountedTabs(prev => {
       if (prev.has(tab)) return prev;
       return new Set([...prev, tab]);
     });
     // Persist tab in URL without full page reload
     const params = new URLSearchParams(window.location.search);
     params.set('tab', tab);
     window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
   };

   // ── Data fetching — must come BEFORE any hooks that reference project ──
   const { data: projectRaw, loading: isLoading, error: projectError } = useSmartEntityData('Project', projectId, { priority: 10 });
   // Stable ref: once project loads, never revert to null (prevents crash during cache refresh)
   const projectStableRef = useRef(null);
   if (projectRaw) projectStableRef.current = projectRaw;
   const project = projectRaw || projectStableRef.current;

   // Ref to always hold the latest project — used inside mutation closures
   // to avoid stale-closure reads when project updates between mutation start and completion.
   const projectRef = useRef(project);
   projectRef.current = project;

   // Add tonomo tab to mounted once project loads (project must be declared above this)
   useEffect(() => {
     if (project?.source === 'tonomo') {
       setMountedTabs(prev => new Set([...prev, 'tonomo']));
     }
   }, [project?.source]);

   useEffect(() => {
     setMountedTabs(prev => {
       if (prev.has('tasks') && prev.has(activeTab)) return prev;
       return new Set([...prev, 'tasks', activeTab]);
     });
   }, [activeTab]);
   // Use calculated_price (matrix-adjusted) with fallback to stored price
   const displayPrice = project?.calculated_price || project?.price || 0;
   const { data: agent } = useSmartEntityData('Agent', project?.agent_id, { priority: 5 });
   // Dynamic fallback: use agent's current_agency_id when project's own agency_id is null/stale
   const effectiveAgencyId = project?.agency_id || agent?.current_agency_id || null;
   const { data: agency } = useSmartEntityData('Agency', effectiveAgencyId, { priority: 5 });
   const { data: allAgents = [] } = useSmartEntityList('Agent');
   const { data: productsData = [] } = useSmartEntityList('Product');
   const { data: packagesData = [] } = useSmartEntityList('Package');
   const { data: user = null } = useCurrentUser();

   // Drone tab gating — disabled if no drone-category line items in pricing
   // and no existing drone shoots. See useProjectHasDroneWork for signal.
   const { hasDroneWork, isLoading: hasDroneWorkLoading } = useProjectHasDroneWork(projectId, project);

   // Server-side scoped fetch — pulls only this project's tasks (~17 rows
   // typical) instead of pulling the global ProjectTask list (~5,000 rows)
   // and filtering client-side. Realtime keeps it in sync.
   const { tasks: projectTasks } = useProjectTasks(projectId);

   const allTasksDone = useMemo(() => {
     if (!projectTasks || projectTasks.length === 0) return false;
     const activeTasks = projectTasks.filter(t => !t.is_deleted && !t.is_archived);
     if (activeTasks.length === 0) return false;
     return activeTasks.every(t => t.is_completed);
   }, [projectTasks]);

   const isDeliverable = useMemo(() =>
     allTasksDone && project && !['delivered', 'cancelled', 'pending_review'].includes(project.status),
     [allTasksDone, project]
   );

   // ProjectActivity is fetched server-scoped by ProjectActivityHub.
   // The page-level fetch is now narrowed to just the rows the review-state
   // banner needs (manual_approval / flagged) — read once per project, no
   // realtime subscription, refetch on stage change via the same queryKey
   // invalidation as projectTasks.
   const { data: allProjectActivities = [] } = useQuery({
     queryKey: ['project-activities-banner', projectId],
     enabled: Boolean(projectId),
     staleTime: 60 * 1000,
     queryFn: () => api.entities.ProjectActivity.filter(
       { project_id: projectId },
       '-created_at',
       50
     ).then(rows => rows || []),
   });

  // One-time sync of blocking state — only fires once per project load, with longer debounce.
  // Reset syncedRef when projectId changes so navigating to a different project re-syncs.
  const syncedRef = useRef(false);
  const deadlineSyncTimeoutRef = useRef(null);
  const lastSyncedProjectIdRef = useRef(null);
  useEffect(() => {
    if (!projectId || !project?.id) return;
    // Reset the sync gate when switching projects
    if (lastSyncedProjectIdRef.current !== projectId) {
      syncedRef.current = false;
      lastSyncedProjectIdRef.current = projectId;
    }
    if (syncedRef.current) return;
    syncedRef.current = true;
    deadlineSyncTimeoutRef.current = setTimeout(() => {
      scheduleDeadlineSync(projectId, 'initial_sync', 0);
    }, 4000);
    return () => {
      if (deadlineSyncTimeoutRef.current) clearTimeout(deadlineSyncTimeoutRef.current);
    };
  }, [projectId, project?.id]);

  // Real-time sync: invalidate caches when timers complete on this project
  useEffect(() => {
    if (!project?.id) return;
    const unsub = api.entities.TaskTimeLog.subscribe((event) => {
      // Timer completed or updated — refresh effort data
      if (event.data?.project_id === project.id) {
        invalidateProjectCaches(queryClient, { timeLogs: true, effort: true });
      }
    });
    return unsub;
  }, [project?.id, queryClient]);

  // Sync denormalised fields if agent/agency name changes
  useEffect(() => {
    if (!project?.client_id || !agent?.name) return;
    let isMounted = true;
    const syncNames = async () => {
      try {
        if (agent.name !== project.client_name) {
          await api.functions.invoke('syncDenormalisedFieldsOnNameChange', {
            entity_type: 'agent',
            entity_id: project.client_id,
            new_name: agent.name
          });
        }
      } catch (err) {
        if (isMounted) console.error('Failed to sync denormalised fields:', err);
      }
    };
    const timeout = setTimeout(syncNames, 300);
    return () => {
      isMounted = false;
      clearTimeout(timeout);
    };
  }, [project?.client_id, project?.client_name, agent?.name]);

  // Memoize canEditProject to prevent unnecessary child re-renders.
  // Use the full project reference so the memo recomputes if any field
  // checked by canEditProject changes (future-proof against permission
  // logic that inspects is_archived, etc.).
  const memoizedCanEdit = useMemo(
    () => canEditProject(project),
    [canEditProject, project]
  );

  // Memoize enriched products for WeatherCard (O(n) lookup instead of O(n²))
  const enrichedWeatherProducts = useMemo(() => {
    if (!project?.products && !project?.packages) return [];
    const productMap = new Map(productsData.map(p => [p.id, p]));
    const packageMap = new Map(packagesData.map(p => [p.id, p]));
    const result = [];

    (project.products || []).forEach(p => {
      const prod = productMap.get(p.product_id || p);
      if (prod) result.push({ ...p, ...prod });
    });

    (project.packages || []).forEach(pkg => {
      const pkgDef = packageMap.get(pkg.package_id || pkg);
      if (pkgDef?.products) {
        pkgDef.products.forEach(p => {
          const prod = productMap.get(p.product_id || p);
          if (prod) result.push({ ...p, ...prod });
        });
      }
    });

    return result;
  }, [project?.products, project?.packages, productsData, packagesData]);

  const updateStatusMutation = useMutation({
  mutationFn: async (newStatus) => {
    // Snapshot latest project from ref to avoid stale closure data in fire-and-forget calls
    const project = projectRef.current;
    if (!project) throw new Error('Project not loaded');
    if (!newStatus) throw new Error('Status is required');

     const oldStatus = project.status;

     const updateData = {
       status: newStatus,
       last_status_change: new Date().toISOString(),
     };
     // Set shooting_started_at once — on the first transition to onsite
     if (newStatus === 'onsite' && !project.shooting_started_at) {
       updateData.shooting_started_at = new Date().toISOString();
     }

     const result = await api.entities.Project.update(projectId, updateData);
     setErrorMessage(null);

     // ── Fire all side-effects in parallel, fire-and-forget with individual error handling ──
     // trackProjectStageChange is called from the frontend so stage timers are ALWAYS
     // created immediately — not dependent on automation ordering or delay.
     // It is fully idempotent: if automation also fires it, the duplicate is safely skipped.
     api.functions.invoke('trackProjectStageChange', {
       projectId,
       old_data: { status: oldStatus },
       data: { ...project, status: newStatus },
       actor_id: user?.id || null,
       actor_name: user?.full_name || null,
     }).catch(err => console.warn('trackProjectStageChange failed:', err?.message));

     // Recalculate task deadlines + unblock tasks triggered by this stage
     // (e.g., "project_onsite" trigger unblocks Upload Raws when moving to onsite)
     api.functions.invoke('calculateProjectTaskDeadlines', {
       project_id: projectId,
       trigger_event: `status_${newStatus}`,
     }).then(() => {
       queryClient.invalidateQueries({ queryKey: ['project-tasks-scoped', projectId] });
     }).catch(err => console.warn('Task deadline recalc failed:', err?.message));

     logActivity('status_change',
       `Stage changed from ${stageLabel(oldStatus)} to ${stageLabel(newStatus)}`,
       { changed_fields: [{ field: 'status', old_value: oldStatus, new_value: newStatus }] }
     );

     writeFeedEvent({
       eventType: 'project_stage_changed', category: 'project', severity: 'info',
       actorId: user?.id, actorName: user?.full_name,
       title: `Stage → ${stageLabel(newStatus)}`,
       description: `${project.title || project.property_address} moved from ${stageLabel(oldStatus)} to ${stageLabel(newStatus)}`,
       projectId, projectName: project.title || project.property_address,
       projectStage: newStatus,
       entityType: 'project', entityId: projectId,
     }).catch(() => {});

     if (newStatus === 'delivered') {
       writeFeedEvent({
         eventType: 'project_delivered', category: 'project', severity: 'info',
         actorId: user?.id, actorName: user?.full_name,
         title: `Project delivered: ${project.title || project.property_address}`,
         projectId, projectName: project.title || project.property_address,
         projectStage: 'delivered',
         entityType: 'project', entityId: projectId,
       }).catch(() => {});
     }

     // Notify all assigned staff about the stage change (except the person who moved it)
     try {
       const staffIds = [
         project.project_owner_id,
         project.onsite_staff_1_id,
         project.onsite_staff_2_id,
         project.image_editor_id,
         project.video_editor_id,
       ].filter(Boolean);

       const notifParams = {
         type: newStatus === 'delivered' ? 'project_delivered' : 'project_stage_changed',
         title: newStatus === 'delivered'
           ? `Project delivered: ${project.title || project.property_address}`
           : `Stage updated to ${stageLabel(newStatus)}`,
         message: `${project.title || project.property_address} moved from ${stageLabel(oldStatus)} to ${stageLabel(newStatus)}`,
         projectId: projectId,
         projectName: project.title || project.property_address,
         entityType: 'project',
         entityId: projectId,
         ctaUrl: 'ProjectDetails',
         ctaParams: { id: projectId },
         sourceUserId: user?.id,
         idempotencyKey: `stage_change:${projectId}:${oldStatus}:${newStatus}:${Date.now()}`,
       };

       await createNotificationsForUsers(staffIds, notifParams, user?.id);
     } catch { /* non-critical */ }

     // ── Special-case stage notifications ──────────────────────────
     try {
       const projectName = project.title || project.property_address;

       // GAP-1: shoot_moved_to_onsite — targeted photographer alert
       if (newStatus === 'onsite') {
         const photographerId = project.photographer_id || project.onsite_staff_1_id;
         if (photographerId && photographerId !== user?.id) {
           createNotification({
             userId: photographerId,
             type: 'shoot_moved_to_onsite',
             title: `You're going onsite: ${projectName}`,
             message: `${projectName} has moved to onsite stage. Check your schedule.`,
             projectId, projectName,
             entityType: 'project', entityId: projectId,
             ctaUrl: 'ProjectDetails', ctaParams: { id: projectId },
             sourceUserId: user?.id,
             idempotencyKey: `onsite:${projectId}:${photographerId}:${Date.now()}`,
           }).catch(() => {});
         }
       }

       // GAP-2: booking_approved — when pending_review → scheduled (manual approval)
       if (oldStatus === 'pending_review' && (newStatus === 'scheduled' || newStatus === 'to_be_scheduled')) {
         createNotificationsForUsers(
           [project.project_owner_id].filter(Boolean),
           {
             type: 'booking_approved',
             title: `Booking approved: ${projectName}`,
             message: `${projectName} has been manually approved and moved to ${stageLabel(newStatus)}.`,
             projectId, projectName,
             entityType: 'project', entityId: projectId,
             ctaUrl: 'ProjectDetails', ctaParams: { id: projectId },
             sourceUserId: user?.id,
             idempotencyKey: `booking_approved:${projectId}:${Date.now()}`,
           },
           user?.id
         ).catch(() => {});
       }
     } catch { /* non-critical */ }

     const triggerMap = {
       'onsite':     'project_onsite',
       'uploaded':   'project_uploaded',
       'submitted':  'project_submitted',
     };

     if (triggerMap[newStatus]) {
       // Cancel any pending sync before scheduling new one
       if (deadlineSyncTimeoutRef.current) clearTimeout(deadlineSyncTimeoutRef.current);
       deadlineSyncTimeoutRef.current = setTimeout(() => {
         scheduleDeadlineSync(projectId, triggerMap[newStatus], 0);
       }, 500);
     }

     // Trigger onsite effort logging when project reaches uploaded or further.
      // Uses "at or past" logic — fires if new stage >= uploaded index, regardless
      // of what the old stage was. The edge function itself is idempotent (won't
      // double-log if onsite tasks are already completed).
      const STAGE_ORDER = ['pending_review','to_be_scheduled','scheduled','onsite','uploaded','submitted','in_progress','in_production','ready_for_partial','in_revision','delivered'];
      const newIdx = STAGE_ORDER.indexOf(newStatus);
      const uploadedIdx = STAGE_ORDER.indexOf('uploaded');
      const hasIncompleteOnsiteTasks = (projectTasks || []).some(t => t.task_type === 'onsite' && !t.is_completed && !t.is_deleted);
      if (newIdx >= uploadedIdx && hasIncompleteOnsiteTasks) {
       api.functions.invoke('logOnsiteEffortOnUpload', {
         project_id: projectId,
         old_status: oldStatus,
       }).catch(err => console.warn('logOnsiteEffortOnUpload failed:', err?.message));
     }

     // Mark all active tasks as cancelled when project is cancelled
     if (newStatus === 'cancelled') {
       const activeTasks = (projectTasks || []).filter(t => !t.is_deleted && !t.is_completed);
       const cancelResults = await Promise.allSettled(
         activeTasks.map(task =>
           api.entities.ProjectTask.update(task.id, { is_completed: true, completed_at: new Date().toISOString() })
         )
       );
       const failedCount = cancelResults.filter(r => r.status === 'rejected').length;
       if (failedCount > 0) {
         toast.error(`Failed to close ${failedCount} of ${activeTasks.length} tasks — some may need manual cleanup`);
       }
     }

     // Check if project qualifies for auto-archive when delivered
     if (newStatus === 'delivered') {
       setTimeout(() => {
         api.functions.invoke('checkAndArchiveProject', {
           project_id: projectId, triggered_by: 'status_delivered'
         }).catch(() => {});
       }, 3000); // Delay to let other side-effects (stage timer, notifications) settle
     }

     return result;
   },
   onSuccess: (_, newStatus) => {
     // Realtime patches the shared entity caches in place. Only invalidate
     // the project-scoped queries that don't have a realtime channel.
     queryClient.invalidateQueries({ queryKey: ["project", projectId] });
     queryClient.invalidateQueries({ queryKey: ['project-tasks-scoped', projectId] });
     toast.success(`Status updated to ${stageLabel(newStatus) || newStatus}`);
   },
   onError: (err) => {
     toast.error(err?.message || "Failed to update project status");
     setErrorMessage(err?.message || "Failed to update project status");
   },
   });

   const updateOutcomeMutation = useMutation({
    mutationFn: async (outcome) => {
      if (!project) throw new Error('Project not loaded');
      if (!outcome) throw new Error('Outcome is required');
      const oldOutcome = project.outcome;
      const result = await api.entities.Project.update(projectId, { outcome });
      logActivity('outcome_changed',
        `Outcome changed from ${oldOutcome || 'none'} to ${outcome}`,
        { changed_fields: [{ field: 'outcome', old_value: oldOutcome, new_value: outcome }] }
      );

      // Notify project owner when outcome is Won or Lost
      if (outcome === 'won' || outcome === 'lost') {
        try {
          const staffIds = [project.project_owner_id].filter(Boolean);
          const projectName = project.title || project.property_address;
          await createNotificationsForUsers(staffIds, {
            type: outcome === 'won' ? 'project_delivered' : 'stale_project',
            title: outcome === 'won'
              ? `Project marked Won: ${projectName}`
              : `Project marked Lost: ${projectName}`,
            message: outcome === 'won'
              ? `${projectName} has been marked as won.`
              : `${projectName} has been marked as lost.`,
            projectId: projectId,
            projectName,
            entityType: 'project',
            entityId: projectId,
            ctaUrl: 'ProjectDetails',
            ctaParams: { id: projectId },
            sourceUserId: user?.id,
            idempotencyKey: `outcome_${outcome}:${projectId}:${Date.now().toString().slice(0, -4)}`,
          }, user?.id);
        } catch { /* non-critical */ }
      }

      writeFeedEvent({
        eventType: 'outcome_changed', category: 'project', severity: outcome === 'won' ? 'info' : 'warning',
        actorId: user?.id, actorName: user?.full_name,
        title: `Project ${outcome}: ${project.title || project.property_address}`,
        projectId, projectName: project.title || project.property_address,
        entityType: 'project', entityId: projectId,
      }).catch(() => {});

      return result;
    },
    onSuccess: (_, outcome) => {
      refetchEntityList("Project");
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      toast.success(`Outcome set to ${outcome}`);
    },
    onError: (err) => {
      toast.error(err?.message || "Failed to update outcome");
      setErrorMessage(err?.message || "Failed to update outcome");
    }
    });

    const updatePaymentMutation = useMutation({
    mutationFn: async (payment_status) => {
      if (!project) throw new Error('Project not loaded');
      if (!payment_status) throw new Error('Payment status is required');
      const oldStatus = project.payment_status;
      const result = await api.entities.Project.update(projectId, { payment_status });
      logActivity('payment_changed',
        `Payment status changed from ${oldStatus || 'none'} to ${payment_status}`,
        { changed_fields: [{ field: 'payment_status', old_value: oldStatus, new_value: payment_status }] }
      );

      // Notify master admins and project owner when payment is received
      if (payment_status === 'paid' || payment_status === 'partial') {
        try {
          const staffIds = [project.project_owner_id].filter(Boolean);
          await createNotificationsForUsers(staffIds, {
            type: 'payment_received',
            title: `Payment ${payment_status === 'paid' ? 'received' : 'partially received'}`,
            message: `${project.title || project.property_address} payment status: ${payment_status}`,
            projectId: projectId,
            projectName: project.title || project.property_address,
            entityType: 'project',
            entityId: projectId,
            ctaUrl: 'ProjectDetails',
            ctaParams: { id: projectId },
            sourceUserId: user?.id,
          }, user?.id);
        } catch { /* non-critical */ }
      }

      if (payment_status === 'paid' || payment_status === 'partial') {
        writeFeedEvent({
          eventType: 'payment_received', category: 'financial', severity: 'info',
          actorId: user?.id, actorName: user?.full_name,
          title: `Payment ${payment_status}: ${project.title || project.property_address}`,
          projectId, projectName: project.title || project.property_address,
          entityType: 'project', entityId: projectId,
        }).catch(() => {});
      }

      // Check if project qualifies for auto-archive
      if (payment_status === 'paid' && project?.status === 'delivered') {
        api.functions.invoke('checkAndArchiveProject', {
          project_id: projectId, triggered_by: 'payment_paid'
        }).catch(() => {});
      }

      return result;
      },
      onSuccess: (_, payment_status) => {
        refetchEntityList("Project");
        queryClient.invalidateQueries({ queryKey: ["project", projectId] });
        toast.success(`Payment status updated to ${payment_status}`);
      },
      onError: (err) => {
      toast.error(err?.message || "Failed to update payment status");
      setErrorMessage(err?.message || "Failed to update payment status");
      }
      });

      const updateInvoicedMutation = useMutation({
    mutationFn: async (amount) => {
      const parsed = amount === "" || amount === null ? null : parseFloat(amount);
      if (parsed !== null && isNaN(parsed)) throw new Error("Invalid amount");
      return api.entities.Project.update(projectId, { invoiced_amount: parsed });
    },
    onSuccess: (_, amount) => {
      refetchEntityList("Project");
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      logActivity('invoiced_amount_changed',
        `Invoiced amount set to ${amount ? `$${parseFloat(amount).toLocaleString('en-AU')}` : 'cleared'}`
      );
      toast.success(amount ? `Invoiced amount set to $${parseFloat(amount).toLocaleString('en-AU')}` : 'Invoiced amount cleared');
    },
    onError: (err) => {
      toast.error(err.message || 'Failed to update invoiced amount');
      setErrorMessage(err.message || 'Failed to update invoiced amount');
    },
  });

  const updateAgentMutation = useMutation({
    mutationFn: (agentId) => {
      if (!project) throw new Error('Project not loaded');
      const selectedAgent = agentId ? allAgents.find(a => a.id === agentId) : null;
      return api.entities.Project.update(projectId, {
        agent_id: agentId || null,
        agent_name: selectedAgent?.name || null,
        agency_id: selectedAgent?.current_agency_id || null,
      });
    },
    onSuccess: (_, agentId) => {
      const selectedAgent = agentId ? allAgents.find(a => a.id === agentId) : null;
      logActivity('agent_changed',
        selectedAgent
          ? `Agent assigned: ${selectedAgent.name || selectedAgent.email}`
          : 'Agent removed'
      );

      // Notify project owner when agent is assigned or changed (fire-and-forget)
      if (agentId && project?.project_owner_id && project.project_owner_id !== user?.id) {
        const projectName = project.title || project.property_address;
        createNotification({
          userId: project.project_owner_id,
          type: 'project_stage_changed',
          title: `Agent updated on ${projectName}`,
          message: selectedAgent
            ? `Agent changed to ${selectedAgent.name || selectedAgent.email}.`
            : 'Agent was removed from the project.',
          projectId: projectId,
          projectName,
          entityType: 'project',
          entityId: projectId,
          ctaUrl: 'ProjectDetails',
          ctaParams: { id: projectId },
          sourceUserId: user?.id,
          idempotencyKey: `agent_changed:${projectId}:${agentId}`,
        }).catch(() => {});
      }

      // Recalculate pricing — new agent may have different matrix overrides (fire-and-forget)
      if (projectId) {
        api.functions.invoke('recalculateProjectPricingServerSide', {
          project_id: projectId,
        }).catch((err) => console.warn('Pricing recalc after agent change failed:', err?.message));
      }

      refetchEntityList("Project");
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      setShowAgentSelector(false);
      setErrorMessage(null);
      toast.success('Agent updated successfully');
      },
      onError: (err) => {
      toast.error(err?.message || "Failed to update agent");
      setErrorMessage(err?.message || "Failed to update agent");
      }
      });

      // ── Archive warnings state (for safeguard dialog) ──────────────────────
      const [showArchiveDialog, setShowArchiveDialog] = useState(false);
      const [archiveWarnings, setArchiveWarnings] = useState([]);

      // Compute archive warnings when dialog opens
      const computeArchiveWarnings = useCallback(async () => {
        const warnings = [];
        if (project?.payment_status !== 'paid') {
          warnings.push(`Payment status: ${project?.payment_status || 'unpaid'}`);
        }
        // Check incomplete tasks
        const incompleteTasks = (projectTasks || []).filter(t => !t.is_deleted && !t.is_archived && !t.is_completed);
        if (incompleteTasks.length > 0) {
          warnings.push(`${incompleteTasks.length} task${incompleteTasks.length === 1 ? '' : 's'} incomplete`);
        }
        // Check running timers
        try {
          const runningTimers = await api.entities.TaskTimeLog.filter({ project_id: projectId, is_active: true });
          const activeTimers = (runningTimers || []).filter(t => t.is_active && !t.end_time);
          if (activeTimers.length > 0) {
            warnings.push(`${activeTimers.length} running timer${activeTimers.length === 1 ? '' : 's'}`);
          }
        } catch { /* non-fatal */ }
        setArchiveWarnings(warnings);
        setShowArchiveDialog(true);
      }, [project, projectTasks, projectId]);

      const archiveMutation = useMutation({
      mutationFn: async () => {
      if (!project) throw new Error('Project not loaded');

      // Stop any running timers before archiving
      try {
        const runningTimers = await api.entities.TaskTimeLog.filter({ project_id: projectId, is_active: true });
        const activeTimers = (runningTimers || []).filter(t => t.is_active && !t.end_time);
        await Promise.all(activeTimers.map(timer =>
          api.entities.TaskTimeLog.update(timer.id, {
            is_active: false,
            end_time: new Date().toISOString(),
            total_seconds: timer.start_time
              ? Math.floor((Date.now() - new Date(timer.start_time).getTime()) / 1000) + (timer.total_seconds || 0)
              : timer.total_seconds || 0,
          }).catch(() => {})
        ));
      } catch (err) {
        console.warn('Stopping timers before archive failed (proceeding):', err?.message);
      }

      // Audit: log archive to team feed
      await api.entities.TeamActivityFeed.create({
        event_type: 'project_archived',
        category: 'project',
        severity: 'info',
        actor_id: user?.id || null,
        actor_name: user?.full_name || null,
        title: `Project archived: ${project?.title || project?.property_address || 'Unknown'}`,
        description: `${project?.title || project?.property_address} (${project?.status}) was archived by ${user?.full_name || 'Unknown'}.`,
        project_id: projectId,
        project_name: project?.title || project?.property_address || '',
        project_stage: project?.status || '',
        entity_type: 'project',
        entity_id: projectId,
        created_date: new Date().toISOString(),
      }).catch(() => {});

      // Log activity on the project itself
      logActivity('project_archived', `Project archived by ${user?.full_name || 'Unknown'}. Previous status: ${project?.status || 'unknown'}.`);

      // Soft archive instead of hard delete
      return api.entities.Project.update(projectId, {
        is_archived: true,
        archived_at: new Date().toISOString(),
        archived_by: user?.full_name || 'Unknown',
      });
    },
    onSuccess: () => {
      refetchEntityList("Project");
      refetchEntityList("TaskTimeLog");
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      setErrorMessage(null);
      setShowArchiveDialog(false);
      toast.success("Project archived");
      navigate(createPageUrl("Projects"));
    },
    onError: (err) => {
      toast.error(err?.message || "Failed to archive project");
      setErrorMessage(err?.message || "Failed to archive project");
    }
    });

    const logActivity = (action, description, extra = {}) => {
    if (!projectId || !project) return;
    api.entities.ProjectActivity.create({
      project_id: projectId,
      project_title: project.title || project.property_address || '',
      action,
      description,
      user_name: user?.full_name || user?.email || 'Unknown',
      user_email: user?.email || '',
      ...extra,
    }).catch(err => console.warn('[activity]', err?.message));
  };

  if (isLoading) {
    return (
      <div className="p-4 lg:p-8 space-y-4">
        <Skeleton className="h-8 w-48 animate-pulse" />
        <Skeleton className="h-12 w-full animate-pulse" />
        <div className="grid grid-cols-1 lg:grid-cols-[10fr_3fr] gap-4">
          <Skeleton className="h-48 w-full animate-pulse" />
          <Skeleton className="h-48 w-full animate-pulse" />
        </div>
      </div>
    );
  }

  if (projectError || !project) {
    return (
      <div className="p-6 lg:p-8">
        <Card className="p-12 text-center">
          <AlertCircle className="h-10 w-10 text-red-500 mx-auto mb-4" />
          <h3 className="text-lg font-medium mb-2">
            {projectError ? 'Failed to load project' : 'Project not found'}
          </h3>
          <p className="text-sm text-muted-foreground mb-4">
            {projectError?.message || 'This project may have been deleted or you don\'t have access.'}
          </p>
          <Link to={createPageUrl("Projects")}>
            <Button>Back to Projects</Button>
          </Link>
        </Card>
      </div>
    );
  }

  if (!canAccessProject(project)) {
    return (
      <div className="p-6 lg:p-8">
        <Card className="p-12 text-center">
          <h3 className="text-lg font-medium mb-2">Access Denied</h3>
          <p className="text-muted-foreground mb-4">You don't have permission to view this project.</p>
          <Link to={createPageUrl("Projects")}>
            <Button>Back to Projects</Button>
          </Link>
        </Card>
      </div>
    );
  }

  const isArchived = project?.is_archived === true;

  return (
    <div className="p-4 lg:p-8 space-y-4 lg:space-y-6">
      <ErrorBoundary>
      {isArchived && (
        <div className="bg-muted border border-border rounded-xl p-4 mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-muted-foreground/15 flex items-center justify-center text-muted-foreground text-lg">📦</div>
            <div>
              <p className="text-sm font-semibold text-foreground/80">This project is archived</p>
              <p className="text-xs text-muted-foreground">Delivered, paid, and all work completed · Archived {project.archived_at ? fmtDate(project.archived_at, 'd MMM yyyy') : ''}</p>
            </div>
          </div>
          {isMasterAdmin && (
            <Button variant="outline" size="sm" className="text-xs"
              onClick={async () => {
                try {
                  await api.entities.Project.update(projectId, { is_archived: false, archived_at: null });
                  refetchEntityList("Project");
                  queryClient.invalidateQueries({ queryKey: ["project", projectId] });
                  api.entities.ProjectActivity.create({
                    project_id: projectId,
                    action: 'unarchived',
                    description: 'Project unarchived',
                    user_name: user?.full_name,
                    user_email: user?.email,
                  }).catch(() => {});
                  toast.success('Project unarchived');
                } catch (err) {
                  toast.error(err?.message || 'Failed to unarchive');
                }
              }}>
              Unarchive
            </Button>
          )}
        </div>
      )}
      {/* Error Banner */}
      {errorMessage && (
        <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg p-4 flex items-start gap-3 animate-in fade-in slide-in-from-top-2 duration-300">
          <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-red-700 dark:text-red-300">Error</p>
            <p className="text-sm text-red-600 dark:text-red-400 mt-0.5">{errorMessage}</p>
          </div>
          <button
            onClick={() => setErrorMessage(null)}
            className="text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 flex-shrink-0 hover:scale-110 transition-all p-1 rounded hover:bg-red-100 dark:hover:bg-red-900/40"
            aria-label="Close error message"
            title="Dismiss error"
          >
            ✕
          </button>
        </div>
      )}

      {/* Validation Banner */}
      {project && (
        <ErrorBoundary><ProjectValidationBanner 
          project={project} 
          canEdit={memoizedCanEdit}
          onEditClick={() => setShowEditForm(true)}
        /></ErrorBoundary>
      )}

      {/* Concurrent Edit Detector */}
      {project && (
        <ConcurrentEditDetector 
          project={project}
          onRefresh={() => window.location.reload()}
        />
      )}

      {/* Header */}
      <div className="flex items-start gap-3">
        <Link to={createPageUrl("Projects")} className="flex-shrink-0 mt-1" title="Back to Projects">
          <Button variant="ghost" size="icon" className="h-9 w-9 hover:bg-muted/80 transition-colors" title="Back to Projects" aria-label="Back to Projects">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-xl lg:text-2xl font-bold tracking-tight leading-tight" title={project?.title || ''}>{project?.title || 'Loading...'}</h1>
            {project?.id && (
              <FavoriteButton
                projectId={project.id}
                projectTitle={project.title}
                propertyAddress={project.property_address}
                size="md"
              />
            )}
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground text-sm">
            <MapPin className="h-3.5 w-3.5 flex-shrink-0" />
            <button
              onClick={() => { if (project?.property_address) navigator.clipboard.writeText(project.property_address).then(() => toast.success('Address copied'), () => toast.error('Failed to copy address')); }}
              title="Copy address to clipboard"
              className="text-left hover:text-primary transition-colors group truncate"
            >
              {project?.property_address || ''}
              <ExternalLink className="h-3 w-3 inline ml-1 opacity-0 group-hover:opacity-50" />
            </button>
            {project?.id && (
              <Link
                to={createPageUrl('ProjectLocation') + `?id=${project.id}`}
                title={project.confirmed_lat && project.confirmed_lng ? 'View / adjust confirmed location' : 'Set confirmed location pin'}
                className={cn(
                  'inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border transition-colors flex-shrink-0',
                  project.confirmed_lat && project.confirmed_lng
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-800'
                    : 'bg-muted text-muted-foreground border-border hover:bg-muted/70'
                )}
              >
                <MapPin className="h-2.5 w-2.5" />
                {project.confirmed_lat && project.confirmed_lng ? 'Pinned' : 'Set pin'}
              </Link>
            )}
          </div>
          {project.calendar_auto_linked && (
            <div className="flex items-center gap-1 mt-0.5">
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 cursor-help"
                title={`Calendar auto-linked via ${project.calendar_link_source === 'google_event_id_retroactive' ? 'retroactive match' : 'Google Calendar event ID'}`}
              >
                <Zap className="h-3 w-3" />
                Calendar auto-linked
              </span>
            </div>
          )}
          {project.is_first_order && (
            <div className="flex items-center gap-1 mt-0.5">
              <span className="inline-flex items-center gap-1 text-xs font-semibold
                             px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300
                             border border-amber-200 dark:border-amber-800">
                ⭐ First order
              </span>
            </div>
          )}
          {/* Project Health Indicator */}
          <div className="mt-1.5">
            <ErrorBoundary><ProjectHealthIndicator project={project} tasks={projectTasks} /></ErrorBoundary>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
          {/* Live Presence */}
          {project && <ErrorBoundary><ProjectPresenceIndicator projectId={projectId} currentUser={user} /></ErrorBoundary>}
          {/* Payment badge */}
          <button
            onClick={() => {
              if (memoizedCanEdit && !updatePaymentMutation.isPending) {
                updatePaymentMutation.mutate(project.payment_status === "paid" ? "unpaid" : "paid");
              }
            }}
            disabled={!memoizedCanEdit || updatePaymentMutation.isPending}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold border transition-all ${
              project.payment_status === "paid"
                ? "bg-green-500 text-white border-green-600 hover:bg-green-600"
                : "bg-muted text-muted-foreground border-border hover:bg-muted/80"
            } ${!memoizedCanEdit || updatePaymentMutation.isPending ? "opacity-60 cursor-not-allowed grayscale-[30%]" : "hover:shadow-md"}`}
            title={memoizedCanEdit ? `Click to mark ${project.payment_status === "paid" ? "unpaid" : "paid"}` : "You don't have permission to edit"}
            aria-label={`Payment status: ${project.payment_status}. Click to toggle.`}
          >
            <CreditCard className="h-3.5 w-3.5" />
            {project.payment_status === "paid" ? "✓ Paid" : "○ Unpaid"}
          </button>
          {/* Won / Lost outcome toggles — mutually exclusive; click again to revert to Open */}
          <button
            onClick={() => {
              if (memoizedCanEdit && !updateOutcomeMutation.isPending) {
                updateOutcomeMutation.mutate(project.outcome === "won" ? "open" : "won");
              }
            }}
            disabled={!memoizedCanEdit || updateOutcomeMutation.isPending}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold border transition-all ${
              project.outcome === "won"
                ? "bg-green-600 text-white border-green-700 hover:bg-green-700"
                : "bg-muted text-muted-foreground border-border hover:bg-muted/80"
            } ${!memoizedCanEdit || updateOutcomeMutation.isPending ? "opacity-60 cursor-not-allowed grayscale-[30%]" : "hover:shadow-md"}`}
            title={
              !memoizedCanEdit ? "You don't have permission to edit" :
              project.outcome === "won" ? "Currently Won — click to revert to Open" :
              "Mark this project as Won"
            }
            aria-label={`Mark as won. Current outcome: ${project.outcome}`}
          >
            <Trophy className="h-3.5 w-3.5" />
            {project.outcome === "won" ? "✓ Won" : "◯ Won"}
          </button>
          <button
            onClick={() => {
              if (memoizedCanEdit && !updateOutcomeMutation.isPending) {
                updateOutcomeMutation.mutate(project.outcome === "lost" ? "open" : "lost");
              }
            }}
            disabled={!memoizedCanEdit || updateOutcomeMutation.isPending}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold border transition-all ${
              project.outcome === "lost"
                ? "bg-red-600 text-white border-red-700 hover:bg-red-700"
                : "bg-muted text-muted-foreground border-border hover:bg-muted/80"
            } ${!memoizedCanEdit || updateOutcomeMutation.isPending ? "opacity-60 cursor-not-allowed grayscale-[30%]" : "hover:shadow-md"}`}
            title={
              !memoizedCanEdit ? "You don't have permission to edit" :
              project.outcome === "lost" ? "Currently Lost — click to revert to Open" :
              "Mark this project as Lost"
            }
            aria-label={`Mark as lost. Current outcome: ${project.outcome}`}
          >
            <XCircle className="h-3.5 w-3.5" />
            {project.outcome === "lost" ? "✓ Lost" : "◯ Lost"}
          </button>
          {memoizedCanEdit && entityCanEdit && (
           <Button variant="outline" size="sm" onClick={() => setShowEditForm(true)} title="Edit project details" className="hover:shadow-md transition-all h-9" aria-label="Edit project">
             <Edit className="h-4 w-4" />
             <span className="hidden sm:inline ml-1.5">Edit</span>
           </Button>
          )}
          {entityCanView && !entityCanEdit && <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">View only</Badge>}
          {memoizedCanEdit && entityCanEdit && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="text-orange-600 hover:text-orange-700 hover:bg-orange-50 dark:text-orange-400 dark:hover:text-orange-300 dark:hover:bg-orange-950/30 px-2.5 transition-colors h-9"
                title="Archive this project"
                aria-label="Archive project"
                onClick={computeArchiveWarnings}
              >
                <Archive className="h-4 w-4" />
              </Button>
              <AlertDialog open={showArchiveDialog} onOpenChange={setShowArchiveDialog}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Archive "{project.title || project.property_address}"?</AlertDialogTitle>
                    <AlertDialogDescription asChild>
                      <div className="space-y-3">
                        {archiveWarnings.length > 0 && (
                          <div className="space-y-1.5">
                            {archiveWarnings.map((w, i) => (
                              <div key={i} className="flex items-center gap-2 text-amber-600 bg-amber-50 border border-amber-200 dark:text-amber-300 dark:bg-amber-950/30 dark:border-amber-800 rounded-md px-3 py-1.5 text-sm">
                                <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                                <span>{w}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        <p className="text-muted-foreground text-sm">
                          This project will be hidden from active views. You can unarchive it later from the project's detail page.
                        </p>
                      </div>
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={archiveMutation.isPending}>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => archiveMutation.mutate()}
                      className="bg-orange-600 text-white hover:bg-orange-700"
                      disabled={archiveMutation.isPending}
                    >
                      {archiveMutation.isPending ? "Archiving..." : "Archive Anyway"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          )}
        </div>
      </div>

      {/* Delivery prompt */}
      {!dismissedDeliveryPrompt && isDeliverable && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-green-50 border
                        border-green-200 dark:bg-green-950/20 dark:border-green-800 shrink-0 rounded-lg">
          <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400 flex-shrink-0" />
          <p className="text-sm text-green-700 dark:text-green-300 flex-1 font-medium">
            All tasks complete — ready to deliver?
          </p>
          <Button
            size="sm"
            className="h-8 text-xs bg-green-600 hover:bg-green-700 text-white"
            aria-label="Mark project as delivered"
            disabled={!memoizedCanEdit || updateStatusMutation.isPending}
            onClick={() => {
              if (memoizedCanEdit && !updateStatusMutation.isPending) {
                updateStatusMutation.mutate('delivered');
              }
            }}
          >
            {updateStatusMutation.isPending ? "Updating..." : "Mark as Delivered"}
          </Button>
          <button
            className="text-xs text-green-600 dark:text-green-400 hover:text-green-800 dark:hover:text-green-300"
            onClick={() => setDismissedDeliveryPrompt(true)}
            aria-label="Dismiss delivery prompt"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Status Pipeline — full width for maximum stage visibility */}
      {project && (
        <ErrorBoundary><StagePipeline
          project={project}
          onStatusChange={(newStatus) => {
            if (updateStatusMutation.isPending) return;
            const stages = PROJECT_STAGES.map(s => s.value);
            const currentIdx = stages.indexOf(project.status);
            const newIdx = stages.indexOf(newStatus);
            if (newIdx < currentIdx) {
              setPendingBackwardStage(newStatus);
              return;
            }
            updateStatusMutation.mutate(newStatus);
          }}
          canEdit={memoizedCanEdit}
          allTasksDone={allTasksDone}
          projectTasks={projectTasks}
        /></ErrorBoundary>
      )}

      {/* Review State Banner */}
      {(() => {
        // Find the latest booking decision from activity log
        const approvalActivity = allProjectActivities?.find(a => a.activity_type === 'manual_approval');
        const flagActivity = allProjectActivities?.find(a => a.activity_type === 'flagged');

        if (project?.status === 'pending_review') {
          // Prefer pre_revision_stage (where the project came from before the
          // flip) so delivered/submitted/uploaded/onsite projects are restored
          // to their real stage on approval. Fall back to scheduled when
          // shoot_date is known, otherwise to_be_scheduled.
          const fallbackStatus = project.shoot_date ? 'scheduled' : 'to_be_scheduled';
          const approveStatus = project.pre_revision_stage || fallbackStatus;
          const isCancellation = project.pending_review_type === 'cancellation';
          return (
            <div className={cn(
              "rounded-lg border px-4 py-3 flex items-center gap-3",
              project.urgent_review
                ? "bg-red-50 border-red-300 dark:bg-red-950/30 dark:border-red-800"
                : "bg-amber-50 border-amber-300 dark:bg-amber-950/30 dark:border-amber-800"
            )}>
              <AlertCircle className={cn("h-5 w-5 shrink-0", project.urgent_review ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400")} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className={cn("text-[10px] font-bold uppercase border-0", project.urgent_review ? "bg-red-200 text-red-800 dark:bg-red-900/50 dark:text-red-200" : "bg-amber-200 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200")}>
                    {project.urgent_review ? 'Flagged for Review' : 'Pending Review'}
                  </Badge>
                  {project.pending_review_type && (
                    <Badge variant="outline" className="text-[10px] bg-muted border-0">{project.pending_review_type.replace(/_/g, ' ')}</Badge>
                  )}
                  {flagActivity?.user_name && (
                    <span className="text-[10px] text-muted-foreground">Flagged by {flagActivity.user_name}</span>
                  )}
                </div>
                {project.pending_review_reason && (
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{project.pending_review_reason}</p>
                )}
              </div>
              {memoizedCanEdit && (
                <div className="flex items-center gap-2 shrink-0">
                  {!project.urgent_review && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs border-red-300 text-red-700 hover:bg-red-100 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900/40"
                      onClick={async () => {
                        try {
                          await api.entities.Project.update(project.id, {
                            urgent_review: true,
                            pending_review_reason: (project.pending_review_reason || '') + ' [Flagged by admin]',
                          });
                          const u = await api.auth.me();
                          await api.entities.ProjectActivity.create({
                            project_id: project.id, action: 'booking_decision', activity_type: 'flagged',
                            description: `Booking flagged as urgent by ${u?.full_name || 'admin'}.`,
                            user_id: u?.id, user_name: u?.full_name || u?.email,
                          }).catch(() => {});
                          refetchEntityList("Project");
                          refetchEntityList("ProjectActivity");
                          toast.success('Flagged as urgent');
                        } catch { toast.error('Failed to flag'); }
                      }}
                    >
                      <AlertCircle className="h-3.5 w-3.5 mr-1" />
                      Flag
                    </Button>
                  )}
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    onClick={async () => {
                      try {
                        const newStatus = isCancellation ? 'cancelled' : approveStatus;
                        await api.entities.Project.update(project.id, {
                          status: newStatus,
                          pending_review_reason: null,
                          pending_review_type: null,
                          pre_revision_stage: null,
                          urgent_review: false,
                          auto_approved: false,
                        });
                        const u = await api.auth.me();
                        await api.entities.ProjectActivity.create({
                          project_id: project.id, action: 'booking_decision', activity_type: 'manual_approval',
                          description: `Booking manually approved by ${u?.full_name || 'admin'}. Status → ${newStatus}.`,
                          user_id: u?.id, user_name: u?.full_name || u?.email,
                        }).catch(() => {});
                        // Fire role defaults + stage tracking
                        if (newStatus !== 'cancelled') {
                          api.functions.invoke('applyProjectRoleDefaults', { project_id: project.id }).catch(() => {});
                          api.functions.invoke('trackProjectStageChange', { projectId: project.id, old_data: { status: 'pending_review' } }).catch(() => {});
                        }
                        refetchEntityList("Project");
                        refetchEntityList("ProjectActivity");
                        toast.success(isCancellation ? 'Cancellation confirmed' : 'Booking approved');
                      } catch { toast.error('Approval failed'); }
                    }}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                    {isCancellation ? 'Confirm Cancel' : 'Approve'}
                  </Button>
                </div>
              )}
            </div>
          );
        }

        if (project?.auto_approved) {
          return (
            <div className="rounded-lg border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-800 px-4 py-2 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
              <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">Auto-approved by system</span>
            </div>
          );
        }

        // Show approval info even after project has moved past pending_review
        if (approvalActivity && project?.source === 'tonomo') {
          return (
            <div className="rounded-lg border border-blue-200 bg-blue-50 dark:bg-blue-950/20 dark:border-blue-800 px-4 py-2 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-blue-600 shrink-0" />
              <span className="text-xs font-medium text-blue-700 dark:text-blue-400">
                Approved by {approvalActivity.user_name || 'admin'}
              </span>
              {approvalActivity.created_at && (
                <span className="text-[10px] text-blue-500 dark:text-blue-400/70">
                  {new Date(approvalActivity.created_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </div>
          );
        }

        return null;
      })()}

      <div data-testid="project-detail-grid" className="grid grid-cols-1 lg:grid-cols-[10fr_3fr] gap-4 lg:gap-6">
        {/* Main Content */}
        <div className="space-y-4 lg:space-y-6">
          {/* Project Progress Bar */}
          <ErrorBoundary><ProjectProgressBar tasks={projectTasks} /></ErrorBoundary>

          {/* Requests Progress Bar */}
          <ErrorBoundary><RequestsProgressBar projectId={projectId} /></ErrorBoundary>

          {/* Active Timers — live, real-time */}
          <ErrorBoundary><ActiveTimersPanel projectId={projectId} tasks={projectTasks} /></ErrorBoundary>

          {/* Backward stage regression confirmation */}
          <AlertDialog open={!!pendingBackwardStage} onOpenChange={open => { if (!open) setPendingBackwardStage(null); }}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Move Project Backward?</AlertDialogTitle>
                <AlertDialogDescription>
                  You are moving <strong>{project?.title}</strong> from{' '}
                  <strong>{PROJECT_STAGES.find(s => s.value === project?.status)?.label}</strong> back to{' '}
                  <strong>{PROJECT_STAGES.find(s => s.value === pendingBackwardStage)?.label}</strong>.
                  <br /><br />
                  Stage timer history is preserved. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={() => setPendingBackwardStage(null)}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-orange-600 hover:bg-orange-700"
                  onClick={() => {
                    if (pendingBackwardStage) {
                      // Log a distinct activity for backward status regressions
                      api.entities.ProjectActivity.create({
                        project_id: project.id,
                        action: 'status_regressed',
                        description: `Status moved backward from ${stageLabel(project.status)} to ${stageLabel(pendingBackwardStage)}`,
                        user_name: user?.full_name,
                        user_email: user?.email,
                      }).catch(() => {});
                      updateStatusMutation.mutate(pendingBackwardStage);
                    }
                    setPendingBackwardStage(null);
                  }}
                >
                  Move Backward
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {/* Weather + Project Details + Staff + Pricing & Deliverables moved to right sidebar */}

          <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
            <div className="overflow-x-auto border-b bg-muted/30">
              <TabsList className={`inline-flex w-max min-w-full sm:w-full sm:grid ${(() => {
                // 7 base tabs (tasks, revisions, effort, calendar, media, files, drones) + shortlisting (employee+) + tonomo (if source)
                // Tailwind JIT needs static class names — enumerate every possibility.
                const isTonomo = project.source === 'tonomo';
                if (isEmployeeOrAbove && isTonomo) return 'sm:grid-cols-9';
                if (isEmployeeOrAbove) return 'sm:grid-cols-8';
                if (isTonomo) return 'sm:grid-cols-8';
                return 'sm:grid-cols-7';
              })()} h-auto bg-transparent`}>
                <TabsTrigger value="tasks"     className="text-xs px-2 py-1.5 whitespace-nowrap data-[state=active]:font-semibold">Tasks</TabsTrigger>
                <TabsTrigger value="revisions" className="text-xs px-2 py-1.5 whitespace-nowrap data-[state=active]:font-semibold">Requests</TabsTrigger>
                <TabsTrigger value="effort"    className="text-xs px-2 py-1.5 whitespace-nowrap data-[state=active]:font-semibold">Effort</TabsTrigger>
                <TabsTrigger value="calendar"  className="text-xs px-2 py-1.5 whitespace-nowrap data-[state=active]:font-semibold">Calendar</TabsTrigger>
                <TabsTrigger value="media"     className="text-xs px-2 py-1.5 whitespace-nowrap data-[state=active]:font-semibold">Media</TabsTrigger>
                <TabsTrigger value="files"     className="text-xs px-2 py-1.5 whitespace-nowrap data-[state=active]:font-semibold">Files</TabsTrigger>
                {isEmployeeOrAbove && (
                  <TabsTrigger value="shortlisting" className="text-xs px-2 py-1.5 whitespace-nowrap data-[state=active]:font-semibold">Shortlisting</TabsTrigger>
                )}
                {hasDroneWork || hasDroneWorkLoading ? (
                  <TabsTrigger value="drones"    className="text-xs px-2 py-1.5 whitespace-nowrap data-[state=active]:font-semibold">Drones</TabsTrigger>
                ) : (
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        {/* Wrap in span so the tooltip still receives hover events even when the trigger is disabled. */}
                        <span tabIndex={0} className="inline-flex">
                          <TabsTrigger
                            value="drones"
                            disabled
                            aria-disabled="true"
                            className="text-xs px-2 py-1.5 whitespace-nowrap data-[state=active]:font-semibold cursor-not-allowed"
                          >
                            Drones
                          </TabsTrigger>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="max-w-xs">
                        No drone work in this project's price matrix or task list. Add a drone-category product (e.g. Drone Shots) to a price-matrix line item to enable this tab.
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
                {project.source === 'tonomo' && (
                  <TabsTrigger value="tonomo"  className="text-xs px-2 py-1.5 whitespace-nowrap data-[state=active]:font-semibold">Tonomo</TabsTrigger>
                )}
              </TabsList>
            </div>

            {/* Tasks — always mounted (default tab) */}
            <TabsContent value="tasks" className="mt-4">
              <ErrorBoundary>
                  <TaskManagement projectId={projectId} project={project} canEdit={memoizedCanEdit} />
                </ErrorBoundary>
            </TabsContent>

            {/* Lazy-mounted tabs — component renders on first click, skeleton shown while not yet mounted */}
            <TabsContent value="revisions" className="mt-4">
              {mountedTabs.has("revisions") ? (
                <ErrorBoundary>
                  <ProjectRevisionsTab projectId={projectId} project={project} canEdit={memoizedCanEdit} />
                </ErrorBoundary>
              ) : (
                <div className="space-y-3 animate-pulse"><div className="h-8 bg-muted rounded w-1/3"/><div className="h-32 bg-muted rounded"/><div className="h-24 bg-muted rounded"/></div>
              )}
            </TabsContent>

            <TabsContent value="effort" className="mt-4">
              {mountedTabs.has("effort") ? <ErrorBoundary><EffortLoggingTab projectId={projectId} /></ErrorBoundary> : (
                <div className="space-y-3 animate-pulse"><div className="h-8 bg-muted rounded w-1/3"/><div className="h-40 bg-muted rounded"/></div>
              )}
            </TabsContent>

            <TabsContent value="calendar" className="mt-4">
              {mountedTabs.has("calendar") ? <ErrorBoundary><ProjectCalendarEvents projectId={projectId} /></ErrorBoundary> : (
                <div className="space-y-3 animate-pulse"><div className="h-8 bg-muted rounded w-1/3"/><div className="h-48 bg-muted rounded"/></div>
              )}
            </TabsContent>

            <TabsContent value="media" className="mt-4">
              {mountedTabs.has("media") ? (
                <ErrorBoundary><ProjectMediaGallery project={project} /></ErrorBoundary>
              ) : (
                <div className="space-y-3 animate-pulse"><div className="h-8 bg-muted rounded w-1/3"/><div className="h-48 bg-muted rounded"/></div>
              )}
            </TabsContent>

            <TabsContent value="files" className="mt-4">
              {mountedTabs.has("files") ? (
                <ErrorBoundary><ProjectFilesTab project={project} /></ErrorBoundary>
              ) : (
                <div className="space-y-3 animate-pulse"><div className="h-8 bg-muted rounded w-1/3"/><div className="h-48 bg-muted rounded"/></div>
              )}
            </TabsContent>

            {isEmployeeOrAbove && (
              <TabsContent value="shortlisting" className="mt-4">
                {mountedTabs.has("shortlisting") ? (
                  <ErrorBoundary><ProjectShortlistingTab project={project} /></ErrorBoundary>
                ) : (
                  <div className="space-y-3 animate-pulse"><div className="h-8 bg-muted rounded w-1/3"/><div className="h-48 bg-muted rounded"/></div>
                )}
              </TabsContent>
            )}

            <TabsContent value="drones" className="mt-4">
              {mountedTabs.has("drones") ? (
                hasDroneWork || hasDroneWorkLoading ? (
                  <ErrorBoundary><ProjectDronesTab project={project} /></ErrorBoundary>
                ) : (
                  <Card>
                    <CardContent className="py-10 text-center text-sm text-muted-foreground">
                      <p className="font-medium text-foreground mb-1">No drone work in this project</p>
                      <p>Add a drone-category product (e.g. Drone Shots) to the price matrix to enable the Drones tab.</p>
                    </CardContent>
                  </Card>
                )
              ) : (
                <div className="space-y-3 animate-pulse"><div className="h-8 bg-muted rounded w-1/3"/><div className="h-48 bg-muted rounded"/></div>
              )}
            </TabsContent>

            {project.source === 'tonomo' && (
              <TabsContent value="tonomo" className="mt-4">
                {mountedTabs.has("tonomo") && <ErrorBoundary><TonomoTab project={project} /></ErrorBoundary>}
              </TabsContent>
            )}
          </Tabs>

          {/* Activity Hub — Pipedrive-style compose + unified feed */}
          <ErrorBoundary><ProjectActivityHub projectId={projectId} project={project} /></ErrorBoundary>
        </div>

        {/* Sidebar */}
        <div data-testid="project-detail-sidebar" className="space-y-3">
          {/* Pricing & Deliverables — relocated from main column, sits above weather card */}
          <Card data-testid="sidebar-pricing-card">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm">Pricing & Deliverables</CardTitle>
                {project.source === 'tonomo' && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-violet-100 text-violet-700 border border-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:border-violet-700">⚡ Tonomo</span>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-2 pt-0">
              {project.delivery_link?.trim() && (
                <div>
                  <a href={project.delivery_link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-primary hover:underline text-sm">
                    <ExternalLink className="h-4 w-4" /> View Deliverables
                  </a>
                </div>
              )}
              {canSeePricing && project?.tonomo_pending_delta && (
                <TonomoPendingDeltaBanner
                  project={project}
                  canEdit={memoizedCanEdit}
                  onResolved={() => refetchEntityList("Project")}
                />
              )}
              {canSeePricing && (
                <ErrorBoundary>
                  <ProjectPricingTable project={project} pricingTier={project.pricing_tier || "standard"} canSeePricing={canSeePricing} canEdit={memoizedCanEdit} />
                </ErrorBoundary>
              )}
              {canSeePricing && project?.has_pricing_mismatch && (
                <div className="flex items-center gap-2 p-2 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 text-xs">
                  <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
                  <div>
                    <p className="font-medium text-amber-800 dark:text-amber-300">Price Mismatch</p>
                    <p className="text-amber-600 dark:text-amber-400">{project.pricing_mismatch_details}</p>
                  </div>
                </div>
              )}
              {project.notes?.trim() && (
                <>
                  <Separator />
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Notes</p>
                    <p className="text-sm whitespace-pre-wrap">{project.notes}</p>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Weather — compact */}
          {project?.property_address && (
            <div data-testid="sidebar-weather-wrapper">
              <ErrorBoundary><ProjectWeatherCard project={project} products={enrichedWeatherProducts} /></ErrorBoundary>
            </div>
          )}

          {/* Project Info — compact */}
          <Card>
            <CardContent className="p-3 space-y-1.5">
              <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                {project?.shoot_date && (
                  <div className="flex items-center gap-1">
                    <Calendar className="h-3 w-3 text-muted-foreground" />
                    <span className="text-xs">{fmtDate(project.shoot_date)}</span>
                  </div>
                )}
                {project?.shoot_time && (
                  <div className="flex items-center gap-1">
                    <ClockIcon className="h-3 w-3 text-muted-foreground" />
                    <span className="text-xs">{project.shoot_time}</span>
                    {project.tonomo_is_twilight && <span className="text-[9px] px-1 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">twilight</span>}
                  </div>
                )}
                <div className="flex items-center gap-1">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${project?.pricing_tier === 'premium' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' : 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'}`}>
                    {project?.pricing_tier === 'premium' ? 'Premium' : 'Standard'}
                  </span>
                </div>
                <div>
                  <p className="text-xs font-mono font-bold">
                    {project && <ErrorBoundary><ProjectDurationTimer project={project} /></ErrorBoundary>}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Staff Assignments */}
          {project && (
            <ErrorBoundary><ProjectStaffBar project={project} canEdit={memoizedCanEdit} /></ErrorBoundary>
          )}

          {/* Unified Project Effort */}
          <ErrorBoundary><ProjectEffortCard projectId={projectId} project={project} onNavigateToEffort={() => handleTabChange('effort')} /></ErrorBoundary>

           {/* Person (agent) + Organisation (agency) — combined compact card */}
           <Card>
            <CardContent className="p-3 space-y-2.5">
              {/* Person */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Person</p>
                  {agent && memoizedCanEdit && (
                    <button onClick={() => setShowAgentSelector(true)} className="text-muted-foreground hover:text-primary">
                      <Edit className="h-3 w-3" />
                    </button>
                  )}
                </div>
                {agent ? (
                  <div>
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                        <User className="h-3 w-3 text-primary" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-xs truncate" title={agent.name || 'Unknown'}>{agent.name || 'Unknown'}</p>
                        {agent.email && (
                          <button onClick={() => setComposeToAgent(agent.email)} className="text-[10px] text-muted-foreground hover:text-primary truncate block text-left" title={`Email ${agent.email}`}>
                            {agent.email}
                          </button>
                        )}
                      </div>
                    </div>
                    {agent.phone && (
                      <a href={`tel:${agent.phone}`} className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-primary mt-1 ml-8">
                        <Phone className="h-2.5 w-2.5" /> {agent.phone}
                      </a>
                    )}
                    {/* Team sub-widget */}
                    {agent.current_team_name && (
                      <div className="flex items-center gap-1.5 mt-1 ml-8">
                        <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-800">
                          <Users className="h-2.5 w-2.5" />
                          {agent.current_team_name}
                        </span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div>
                    <p className="text-muted-foreground text-xs">No person assigned</p>
                    {memoizedCanEdit && (
                      <Button variant="outline" size="sm" className="w-full mt-1 h-7 text-xs" onClick={() => setShowAgentSelector(true)}>
                        <Edit className="h-3 w-3 mr-1" /> Assign
                      </Button>
                    )}
                  </div>
                )}
              </div>

              {/* Organisation */}
              {agency && (
                <div className="border-t pt-2">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">Organisation</p>
                  <Link to={createPageUrl("OrgDetails") + `?id=${agency.id}`} className="flex items-center gap-2 hover:text-primary transition-colors">
                    <Building className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                    <span className="font-medium text-xs truncate" title={agency.name}>{agency.name}</span>
                  </Link>
                  {agency.phone && (
                    <a href={`tel:${agency.phone}`} className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-primary mt-1 ml-5">
                      <Phone className="h-2.5 w-2.5" /> {agency.phone}
                    </a>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Agency Branding Summary */}
          <AgencyBrandingSummary agency={agency} />

          {/* Property Intelligence — listings + projects at this physical address */}
          {project?.property_key && (
            <PropertyIntelligencePanel propertyKey={project.property_key} />
          )}
        </div>
      </div>

      <ProjectForm
        project={project}
        open={showEditForm}
        onClose={() => setShowEditForm(false)}
        onSave={() => setShowEditForm(false)}
      />

      {/* Agent Selector Dialog */}
       {showAgentSelector && (
         <AgentSelectorDialog
           agents={allAgents}
           currentAgentId={project.agent_id}
           isPending={updateAgentMutation.isPending}
           onSelect={(agentId) => updateAgentMutation.mutate(agentId)}
           onClose={() => setShowAgentSelector(false)}
         />
       )}
       </ErrorBoundary>


       {/* Email compose triggered by clicking agent email */}
       {composeToAgent && (
         <EmailComposeDialog
           open={!!composeToAgent}
           onOpenChange={(open) => { if (!open) setComposeToAgent(null); }}
           defaultTo={composeToAgent}
           defaultProjectId={projectId}
           defaultSubject={project?.title || project?.property_address || ''}
         />
       )}

       {/* AI Assistant */}
       <AIChat projectId={projectId} projectTitle={project?.title || project?.property_address} />
       </div>
       );
       }