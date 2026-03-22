import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { api } from "@/api/supabaseClient";
import { useMutation } from "@tanstack/react-query";
import { usePermissions } from "@/components/auth/PermissionGuard";
import { useSmartEntityData, useSmartEntityList } from "@/components/hooks/useSmartEntityData";
import { Link, useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { 
  ArrowLeft, MapPin, Calendar, Clock as ClockIcon, User, Phone, Mail, 
  ExternalLink, Edit, Trash2, CheckCircle, Building,
  Star, Zap, Trophy, XCircle, CreditCard, AlertCircle, Copy, Camera
} from "lucide-react";
import { PROJECT_STAGES, PROJECT_OUTCOMES, PROJECT_PAYMENT_STATUSES, stageConfig, stageLabel } from "@/components/projects/projectStatuses";
import StagePipeline from "@/components/projects/StagePipeline";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { fmtDate } from "@/components/utils/dateUtils";
import { toast } from "sonner";
import Timer from "@/components/ui/timer";
import ProjectStatusBadge from "@/components/dashboard/ProjectStatusBadge";
import ProjectForm from "@/components/projects/ProjectForm";
import AssignUsersDialog from "@/components/projects/AssignUsersDialog";
import TaskManagement from "@/components/projects/TaskManagement";
import ChatPanel from "@/components/chat/ChatPanel";
import MediaDeliveryManager from "@/components/projects/MediaDeliveryManager";
import ProjectProductsPackages from "@/components/projects/ProjectProductsPackages";
import EffortLoggingTab from "@/components/projects/EffortLoggingTab";
import ProjectCalendarEvents from "@/components/projects/ProjectCalendarEvents";
import ProjectActivityHub from "@/components/projects/ProjectActivityHub";
import ProjectStaffBar from "@/components/projects/ProjectStaffBar";
import ProjectPresenceIndicator from "@/components/projects/ProjectPresenceIndicator";
import EmailComposeDialog from "@/components/email/EmailComposeDialog";
import ProjectPricingTable from "@/components/projects/ProjectPricingTable";
import ProjectDurationTimer from "@/components/projects/ProjectDurationTimer";
import ProjectValidationBanner from "@/components/projects/ProjectValidationBanner";
import ConcurrentEditDetector from "@/components/projects/ConcurrentEditDetector";
import ProjectEffortSummaryV2 from "@/components/projects/ProjectEffortSummaryV2";
import ProjectProgressBar from "@/components/projects/ProjectProgressBar";
import TimeTrackingSummaryCard from "@/components/projects/TimeTrackingSummaryCard";
import ProjectHealthIndicator from "@/components/projects/ProjectHealthIndicator";
import QuickActionBar from "@/components/projects/QuickActionBar";
import ProjectRevisionsTab from "@/components/revisions/ProjectRevisionsTab";
import ProjectWeatherCard from "@/components/projects/ProjectWeatherCard";
import ActiveTimersPanel from "@/components/projects/ActiveTimersPanel";
import { scheduleDeadlineSync } from "@/components/projects/taskDeadlineSync";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useQuery } from "@tanstack/react-query";
import TonomoTab from "@/components/tonomo/TonomoTab";
import { createNotification, createNotificationsForUsers, writeFeedEvent } from "@/components/notifications/createNotification";
import ErrorBoundary from "@/components/common/ErrorBoundary";


const statuses = PROJECT_STAGES;

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

export default function ProjectDetails() {
   const urlParams = new URLSearchParams(window.location.search);
   const projectId = urlParams.get("id");
   const navigate = useNavigate();

   useEffect(() => {
     if (!projectId) {
       navigate(createPageUrl("Projects"));
     }
   }, [projectId, navigate]);

   const { canSeePricing, canEditProject, canAccessProject, isMasterAdmin, isEmployee, user: permUser } = usePermissions();
   const [showEditForm, setShowEditForm] = useState(false);
   const [showAssignDialog, setShowAssignDialog] = useState(false);
   const [showAgentSelector, setShowAgentSelector] = useState(false);
   const [showEmailCompose, setShowEmailCompose] = useState(false);
   const [showProjectChat, setShowProjectChat] = useState(false);
   const [errorMessage, setErrorMessage] = useState(null);
   const [dismissedDeliveryPrompt, setDismissedDeliveryPrompt] = useState(false);
   // Backward stage regression confirmation
   const [pendingBackwardStage, setPendingBackwardStage] = useState(null);

   // Tab state — persisted in URL ?tab= param so reload preserves active tab
   const VALID_TABS = new Set(['tasks', 'revisions', 'effort', 'calendar', 'media', 'tonomo']);
   const [activeTab, setActiveTab] = useState(() => {
     const params = new URLSearchParams(window.location.search);
     const tab = params.get('tab');
     return tab && VALID_TABS.has(tab) ? tab : 'tasks';
   });
   // projectRaw loaded below, so initialize without conditional tonomo tab
   const [mountedTabs, setMountedTabs] = useState(new Set([
     (() => { const params = new URLSearchParams(window.location.search); return params.get('tab') || 'tasks'; })()
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
   const { data: projectRaw, loading: isLoading } = useSmartEntityData('Project', projectId, { priority: 10 });
   // Stable ref: once project loads, never revert to null (prevents crash during cache refresh)
   const projectStableRef = useRef(null);
   if (projectRaw) projectStableRef.current = projectRaw;
   const project = projectRaw || projectStableRef.current;

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
   const { data: agency } = useSmartEntityData('Agency', project?.agency_id, { priority: 5 });
   const { data: allAgents = [] } = useSmartEntityList('Agent');
   const { data: productsData = [] } = useSmartEntityList('Product');
   const { data: packagesData = [] } = useSmartEntityList('Package');
   const { data: user = null } = useQuery({
     queryKey: ["current-user"],
     queryFn: () => api.auth.me()
   });

   const filterProjectTasks = useCallback((t) => t.project_id === projectId, [projectId]);
   const filterProjectActivities = useCallback((a) => !!(projectId && a.project_id === projectId), [projectId]);

   const { data: projectTasks = [] } = useSmartEntityList(
      "ProjectTask",
      null,
      null,
      filterProjectTasks
    );

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

   const { data: allProjectActivities = [] } = useSmartEntityList(
     "ProjectActivity",
     "-created_date",
     50,
     filterProjectActivities
   );

   const projectActivities = useMemo(
    () => {
      if (!Array.isArray(allProjectActivities)) return [];
      return allProjectActivities.filter(a => a.action === "status_change");
    },
    [allProjectActivities]
   );

  // One-time sync of blocking state — only fires once per project load, with longer debounce
  const syncedRef = useRef(false);
  const deadlineSyncTimeoutRef = useRef(null);
  useEffect(() => {
    if (!projectId || !project?.id || syncedRef.current) return;
    syncedRef.current = true;
    deadlineSyncTimeoutRef.current = setTimeout(() => {
      scheduleDeadlineSync(projectId, 'initial_sync', 0);
    }, 4000);
    return () => {
      if (deadlineSyncTimeoutRef.current) clearTimeout(deadlineSyncTimeoutRef.current);
    };
  }, [projectId, project?.id]);

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
  }, [project?.client_id, agent?.name]);

  // Memoize canEditProject to prevent unnecessary child re-renders
  const memoizedCanEdit = useMemo(
    () => canEditProject(project),
    [project?.id, project?.status, project?.agent_id]
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
         ...(project.assigned_users || []),
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

     // Trigger onsite effort logging on any transition INTO uploaded-or-later stages
      // (not just "uploaded" — handles skipped stages like onsite → submitted)
      const UPLOADED_OR_LATER = ['uploaded', 'submitted', 'in_progress', 'in_production', 'ready_for_partial', 'in_revision', 'delivered'];
     const PRE_UPLOAD = ['to_be_scheduled', 'scheduled', 'onsite', 'pending_review'];
     if (UPLOADED_OR_LATER.includes(newStatus) && PRE_UPLOAD.includes(oldStatus)) {
       api.functions.invoke('logOnsiteEffortOnUpload', {
         project_id: projectId,
         old_status: oldStatus,
       }).catch(err => console.warn('logOnsiteEffortOnUpload failed:', err?.message));
     }

     // Mark all active tasks as cancelled when project is cancelled
     if (newStatus === 'cancelled') {
       const activeTasks = (projectTasks || []).filter(t => !t.is_deleted && !t.is_completed);
       for (const task of activeTasks) {
         api.entities.ProjectTask.update(task.id, { is_completed: true, completed_at: new Date().toISOString() }).catch(() => {});
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
   onError: (err) => {
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
    onError: (err) => {
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
      onError: (err) => {
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
      logActivity('invoiced_amount_changed',
        `Invoiced amount set to ${amount ? `$${parseFloat(amount).toLocaleString('en-AU')}` : 'cleared'}`
      );
    },
    onError: (err) => setErrorMessage(err.message || 'Failed to update invoiced amount'),
  });

  const updateAgentMutation = useMutation({
    mutationFn: (agentId) => {
      if (!project) throw new Error('Project not loaded');
      const selectedAgent = agentId ? allAgents.find(a => a.id === agentId) : null;
      return api.entities.Project.update(projectId, { 
        agent_id: agentId || null, 
        agency_id: selectedAgent?.current_agency_id || null 
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

      setShowAgentSelector(false);
      setErrorMessage(null);
      toast.success('Agent updated successfully');
      },
      onError: (err) => {
      setErrorMessage(err?.message || "Failed to update agent");
      }
      });

      const deleteMutation = useMutation({
      mutationFn: async () => {
      if (!project) throw new Error('Project not loaded');
      // ── Soft-delete via backend function (batched, efficient) ────────────────────────────
      try {
        api.functions.invoke('cleanupProjectOnDelete', {
          project_id: projectId
        }).catch(err => console.warn('Async cleanup failed (non-fatal):', err?.message));
      } catch { /* non-fatal — proceed with project deletion */ }



      // Audit: log deletion to team feed BEFORE the project is deleted
      await api.entities.TeamActivityFeed.create({
        event_type: 'project_deleted',
        category: 'project',
        severity: 'warning',
        actor_id: user?.id || null,
        actor_name: user?.full_name || null,
        title: `Project deleted: ${project?.title || project?.property_address || 'Unknown'}`,
        description: `${project?.title || project?.property_address} (${project?.status}) was permanently deleted.`,
        project_id: projectId,
        project_name: project?.title || project?.property_address || '',
        project_stage: project?.status || '',
        entity_type: 'project',
        entity_id: projectId,
        created_date: new Date().toISOString(),
      }).catch(() => {});

      return api.entities.Project.delete(projectId);
    },
    onSuccess: () => {
      setErrorMessage(null);
      navigate(createPageUrl("Projects"));
    },
    onError: (err) => {
      setErrorMessage(err?.message || "Failed to delete project");
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
      <div className="p-6 lg:p-8 space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="p-6 lg:p-8">
        <Card className="p-12 text-center">
          <h3 className="text-lg font-medium mb-2">Project not found</h3>
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
        <div className="bg-slate-100 border border-slate-300 rounded-xl p-4 mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-slate-200 flex items-center justify-center text-slate-500 text-lg">📦</div>
            <div>
              <p className="text-sm font-semibold text-slate-700">This project is archived</p>
              <p className="text-xs text-slate-500">Delivered, paid, and all work completed · Archived {project.archived_at ? fmtDate(project.archived_at, 'd MMM yyyy') : ''}</p>
            </div>
          </div>
          {isMasterAdmin && (
            <Button variant="outline" size="sm" className="text-xs"
              onClick={async () => {
                try {
                  await api.entities.Project.update(projectId, { is_archived: false, archived_at: null });
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
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3 animate-in fade-in slide-in-from-top-2 duration-300">
          <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-red-700">Error</p>
            <p className="text-sm text-red-600 mt-0.5">{errorMessage}</p>
          </div>
          <button 
            onClick={() => setErrorMessage(null)}
            className="text-red-600 hover:text-red-700 flex-shrink-0 hover:scale-110 transition-all p-1 rounded hover:bg-red-100"
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
          <h1 className="text-xl lg:text-2xl font-bold tracking-tight leading-tight mb-1" title={project?.title || ''}>{project?.title || 'Loading...'}</h1>
          <div className="flex items-center gap-1.5 text-muted-foreground text-sm">
            <MapPin className="h-3.5 w-3.5 flex-shrink-0" />
            <button
              onClick={() => { try { navigator.clipboard.writeText(project.property_address); } catch {} }}
              title="Copy address"
              className="text-left hover:text-primary transition-colors group truncate"
            >
              {project?.property_address || ''}
              <Copy className="h-3 w-3 inline ml-1 opacity-0 group-hover:opacity-50" />
            </button>
          </div>
          {project.calendar_auto_linked && (
            <div className="flex items-center gap-1 mt-0.5">
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 cursor-help"
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
                             px-2 py-0.5 rounded-full bg-amber-100 text-amber-700
                             border border-amber-200">
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
            } ${!canEditProject(project) || updatePaymentMutation.isPending ? "opacity-50 cursor-not-allowed" : "hover:shadow-md"}`}
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
            } ${!canEditProject(project) || updateOutcomeMutation.isPending ? "opacity-50 cursor-not-allowed" : "hover:shadow-md"}`}
            title={
              !canEditProject(project) ? "You don't have permission to edit" :
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
            } ${!canEditProject(project) || updateOutcomeMutation.isPending ? "opacity-50 cursor-not-allowed" : "hover:shadow-md"}`}
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
          {memoizedCanEdit && (
           <Button variant="outline" size="sm" onClick={() => setShowEditForm(true)} title="Edit project details" className="hover:shadow-md transition-shadow h-9" aria-label="Edit project">
             <Edit className="h-4 w-4" />
             <span className="hidden sm:inline ml-1.5">Edit</span>
           </Button>
          )}
          {memoizedCanEdit && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" className="text-destructive hover:text-destructive hover:bg-destructive/10 px-2.5 transition-colors h-9" title="Delete this project" aria-label="Delete project">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete Project?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete <strong>"{project.title}"</strong> and all associated data (tasks, notes, timers). This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
                  <AlertDialogAction 
                    onClick={() => deleteMutation.mutate()} 
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    disabled={deleteMutation.isPending}
                  >
                    {deleteMutation.isPending ? "Deleting..." : "Delete"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      {/* Delivery prompt */}
      {!dismissedDeliveryPrompt && isDeliverable && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-green-50 border
                        border-green-200 dark:bg-green-950/20 shrink-0 rounded-lg">
          <CheckCircle className="h-4 w-4 text-green-600 flex-shrink-0" />
          <p className="text-sm text-green-700 flex-1 font-medium">
            All tasks complete — ready to deliver?
          </p>
          <Button
            size="sm"
            className="h-8 text-xs bg-green-600 hover:bg-green-700 text-white"
            aria-label="Mark project as delivered"
            onClick={() => {
              if (memoizedCanEdit) {
                updateStatusMutation.mutate('delivered');
              }
            }}
          >
            Mark as Delivered
          </Button>
          <button
            className="text-xs text-green-600 hover:text-green-800"
            onClick={() => setDismissedDeliveryPrompt(true)}
            aria-label="Dismiss delivery prompt"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Staff Assignments */}
      {project && (
        <ErrorBoundary><ProjectStaffBar project={project} canEdit={memoizedCanEdit} /></ErrorBoundary>
      )}

      {/* Quick Action Bar */}
      <ErrorBoundary>
        <QuickActionBar
          project={project}
          canEdit={memoizedCanEdit}
          onStartTimer={() => handleTabChange('effort')}
          onAddNote={() => handleTabChange('notes')}
          onChangeStatus={(newStatus) => {
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
          onOpenChat={user ? () => setShowProjectChat(true) : null}
          onAssign={() => setShowAssignDialog(true)}
          isMasterAdmin={isMasterAdmin}
          isEmployee={isEmployee}
        />
      </ErrorBoundary>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-4 lg:space-y-6">
          {/* Project Progress Bar */}
          <ErrorBoundary><ProjectProgressBar tasks={projectTasks} /></ErrorBoundary>

          {/* Active Timers — live, real-time */}
          <ErrorBoundary><ActiveTimersPanel projectId={projectId} tasks={projectTasks} /></ErrorBoundary>

          {/* Status Pipeline — Pipedrive style */}
          {project && (
            <ErrorBoundary><StagePipeline
              project={project}
              onStatusChange={(newStatus) => {
                if (updateStatusMutation.isPending) return;
                const stages = PROJECT_STAGES.map(s => s.value);
                const currentIdx = stages.indexOf(project.status);
                const newIdx = stages.indexOf(newStatus);
                // Moving backward requires explicit confirmation to prevent accidental regressions
                if (newIdx < currentIdx) {
                  setPendingBackwardStage(newStatus);
                  return;
                }
                updateStatusMutation.mutate(newStatus);
              }}
              canEdit={memoizedCanEdit}
            /></ErrorBoundary>
          )}

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

          {/* Weather Card */}
          {project?.property_address && (
            <ErrorBoundary><ProjectWeatherCard
              project={project}
              products={enrichedWeatherProducts}
            /></ErrorBoundary>
          )}

          {/* Project Details */}
           <Card>
             <CardHeader className="pb-2">
               <div className="flex items-center justify-between">
                 <CardTitle className="text-sm">Project Details</CardTitle>
                 {project.source === 'tonomo' ? (
                   <span className="text-[10px] px-1.5 py-0.5 rounded font-medium
                                    bg-violet-100 text-violet-700 border border-violet-200">
                     ⚡ Tonomo
                   </span>
                 ) : (
                   <span className="text-[10px] px-1.5 py-0.5 rounded font-medium
                                    bg-muted text-muted-foreground border border-border">
                     Manual
                   </span>
                 )}
               </div>
             </CardHeader>
             <CardContent className="space-y-2 pt-0">
               <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">Property Type</p>
                  <p className="text-xs font-medium">{propertyTypeLabels[project.property_type] || project.property_type}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">Priority</p>
                  <Badge variant={project.priority === "urgent" ? "destructive" : "secondary"} className="text-xs h-5">
                    {project.priority}
                  </Badge>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5 flex items-center gap-0.5">
                    <ClockIcon className="h-2.5 w-2.5" /> Duration
                  </p>
                  <p className="font-mono text-xs font-bold">
                    {project && <ErrorBoundary><ProjectDurationTimer project={project} activities={projectActivities} /></ErrorBoundary>}
                  </p>
                </div>
                {project.property_suburb && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-0.5">Suburb</p>
                    <p className="text-xs font-medium">{project.property_suburb}</p>
                  </div>
                )}
                {project.shoot_date && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-0.5">Shoot Date</p>
                    <div className="flex items-center gap-1">
                      <Calendar className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                      <span className="text-xs font-medium">{fmtDate(project.shoot_date)}</span>
                    </div>
                  </div>
                )}
                {project.shoot_time && (
                   <div>
                     <p className="text-xs text-muted-foreground mb-0.5">Shoot Time</p>
                     <div className="flex items-center gap-1 flex-wrap">
                       <ClockIcon className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                      <span className="text-xs font-medium">{project.shoot_time}</span>
                      {project.tonomo_is_twilight && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-medium
                                         px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700
                                         border border-purple-200">
                          🌅 Twilight
                        </span>
                      )}
                    </div>
                  </div>
                )}
                {project.shooting_started_at && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-0.5">Shoot started</p>
                    <div className="flex items-center gap-1">
                      <Camera className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                      <span className="text-xs font-medium">
                        {new Date(project.shooting_started_at).toLocaleTimeString('en-AU', {
                          timeZone: 'Australia/Sydney',
                          hour: '2-digit',
                          minute: '2-digit',
                          hour12: true,
                        })}
                      </span>
                    </div>
                  </div>
                )}
                {project.delivery_date && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-0.5">Delivery Date</p>
                    <span className="text-xs font-medium">{fmtDate(project.delivery_date)}</span>
                  </div>
                )}
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">Tier</p>
                  <span className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-xs font-semibold ${
                    project.pricing_tier === "premium"
                      ? "bg-amber-100 text-amber-700"
                      : "bg-blue-100 text-blue-700"
                  }`}>
                    {project.pricing_tier === "premium" ? <Star className="h-2.5 w-2.5" /> : <Zap className="h-2.5 w-2.5" />}
                    {project.pricing_tier === "premium" ? "Prem" : "Std"}
                  </span>
                </div>
                {canSeePricing && displayPrice > 0 && (
                  <div className="col-span-2 sm:col-span-1">
                    <p className="text-xs text-muted-foreground mb-0.5">Quoted value</p>
                    <span
                      className="text-sm font-bold text-primary"
                      title={`AUD $${Number(displayPrice).toFixed(2)}`}
                    >
                      ${Number(displayPrice).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                    </span>
                    {project.price_matrix_snapshot && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {project.calculated_price !== project.price && "(adjusted)"}
                      </p>
                    )}
                  </div>
                )}

                {canSeePricing && canEditProject(project) && (
                  <div className="col-span-2 sm:col-span-1">
                    <p className="text-xs text-muted-foreground mb-0.5">Invoiced</p>
                    <InvoicedAmountInput
                      value={project.invoiced_amount ?? ""}
                      onSave={(v) => updateInvoicedMutation.mutate(v)}
                      isPending={updateInvoicedMutation.isPending}
                    />
                  </div>
                )}
               </div>



              {project.delivery_link?.trim() && (
                <>
                  <Separator />
                  <div>
                    <p className="text-xs text-muted-foreground mb-2">Delivery Link</p>
                    <a 
                      href={project.delivery_link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 text-primary hover:underline text-sm"
                    >
                      <ExternalLink className="h-4 w-4" />
                      View Deliverables
                    </a>
                  </div>
                </>
              )}

              {canSeePricing && (
                    <>
                      <Separator />
                      {project.price_matrix_snapshot && (
                        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-3">
                          <p className="text-xs text-blue-700 font-semibold">📋 Price locked at calculation</p>
                          <p className="text-xs text-blue-600 mt-0.5">Snapshot captured: {new Date(project.updated_date).toLocaleString()}</p>
                        </div>
                      )}
                      <ErrorBoundary>
                        <ProjectPricingTable 
                          project={project}
                          pricingTier={project.pricing_tier || "standard"}
                          canSeePricing={canSeePricing}
                          canEdit={memoizedCanEdit}
                        />
                      </ErrorBoundary>
                    </>
                  )}

              {project.notes?.trim() && (
                <>
                  <Separator />
                  <div>
                    <p className="text-xs text-muted-foreground mb-2">Notes</p>
                    <p className="text-sm whitespace-pre-wrap">{project.notes}</p>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
            <div className="overflow-x-auto border-b bg-muted/30">
              <TabsList className={`inline-flex w-max min-w-full sm:w-full sm:grid ${project.source === 'tonomo' ? 'sm:grid-cols-6' : 'sm:grid-cols-5'} h-auto bg-transparent`}>
                <TabsTrigger value="tasks"     className="text-xs px-2 py-1.5 whitespace-nowrap data-[state=active]:font-semibold">Tasks</TabsTrigger>
                <TabsTrigger value="revisions" className="text-xs px-2 py-1.5 whitespace-nowrap data-[state=active]:font-semibold">Requests</TabsTrigger>
                <TabsTrigger value="effort"    className="text-xs px-2 py-1.5 whitespace-nowrap data-[state=active]:font-semibold">Effort</TabsTrigger>
                <TabsTrigger value="calendar"  className="text-xs px-2 py-1.5 whitespace-nowrap data-[state=active]:font-semibold">Calendar</TabsTrigger>
                <TabsTrigger value="media"     className="text-xs px-2 py-1.5 whitespace-nowrap data-[state=active]:font-semibold">Media</TabsTrigger>
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
                <ErrorBoundary><MediaDeliveryManager projectId={projectId} project={project} canEdit={memoizedCanEdit} /></ErrorBoundary>
              ) : (
                <div className="space-y-3 animate-pulse"><div className="h-8 bg-muted rounded w-1/4"/><div className="h-40 bg-muted rounded"/></div>
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
        <div className="space-y-4 lg:space-y-6">
          {/* Time Tracking Summary */}
          <ErrorBoundary><TimeTrackingSummaryCard projectId={projectId} project={project} /></ErrorBoundary>

          {/* Project Effort Summary (detailed) */}
           <ErrorBoundary><ProjectEffortSummaryV2 projectId={projectId} project={project} /></ErrorBoundary>

           {/* Agent + Agency combined on mobile */}
           <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-base lg:text-lg">Agent</CardTitle>
              {agent && memoizedCanEdit && (
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setShowAgentSelector(true)} aria-label="Edit agent">
                  <Edit className="h-4 w-4" />
                </Button>
              )}
            </CardHeader>
            <CardContent className="pt-0">
              {agent ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <User className="h-4 w-4 text-primary" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-sm">{agent?.name || 'Unknown'}</p>
                      {agent?.email && (
                        <a href={`mailto:${encodeURIComponent(agent.email)}`} className="text-xs text-muted-foreground hover:text-primary truncate block">
                          {agent.email}
                        </a>
                      )}
                    </div>
                  </div>
                  {agent?.phone && (
                    <a href={`tel:${agent.phone}`} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-primary">
                      <Phone className="h-3.5 w-3.5" />
                      {agent.phone}
                    </a>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-muted-foreground text-sm">No agent assigned</p>
                  {memoizedCanEdit && (
                    <Button variant="outline" size="sm" className="w-full" onClick={() => setShowAgentSelector(true)}>
                      <Edit className="h-4 w-4 mr-2" />
                      Assign Agent
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Agency */}
          {agency && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base lg:text-lg">Agency</CardTitle>
              </CardHeader>
              <CardContent className="pt-0 space-y-2.5">
                <Link 
                  to={createPageUrl("OrgDetails") + `?id=${agency.id}`}
                  className="flex items-center gap-2 hover:text-primary transition-colors"
                >
                  <Building className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <span className="font-medium text-sm">{agency.name}</span>
                </Link>
                {agency.phone && (
                  <a href={`tel:${agency.phone}`} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-primary">
                    <Phone className="h-3.5 w-3.5" />
                    {agency.phone}
                  </a>
                )}
                {agency.address && (
                  <div className="flex items-start gap-2 text-sm text-muted-foreground">
                    <MapPin className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                    <span>{agency.address}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Quick Actions sidebar — email compose + additional actions */}
          <Card className="hidden lg:block">
            <CardHeader className="pb-3">
              <CardTitle className="text-base lg:text-lg">Actions</CardTitle>
            </CardHeader>
            <CardContent className="pt-0 space-y-2">
              {user && (
                <Button
                  onClick={() => setShowProjectChat(true)}
                  className="w-full hover:shadow-md transition-shadow"
                  title="Open chat for this project"
                >
                  💬 Chat
                </Button>
              )}
              {memoizedCanEdit && (
                <Button className="w-full" variant="outline" onClick={() => setShowEmailCompose(true)} title="Send email for this project">
                  📧 Send Email
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <ProjectForm
        project={project}
        open={showEditForm}
        onClose={() => setShowEditForm(false)}
        onSave={() => setShowEditForm(false)}
      />

      <AssignUsersDialog
        project={project}
        open={showAssignDialog}
        onClose={() => setShowAssignDialog(false)}
        onSave={() => setShowAssignDialog(false)}
      />

      {/* Email Composer */}
      {showEmailCompose && (
        <EmailComposeDialog
          onClose={() => setShowEmailCompose(false)}
          defaultProjectId={projectId}
          defaultProjectTitle={project?.title}
        />
      )}

      {/* Agent Selector Dialog */}
       {showAgentSelector && (
         <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 animate-in fade-in duration-200" onClick={() => setShowAgentSelector(false)}>
           <Card 
             className="w-full max-w-md animate-in scale-in-95 duration-200"
             onClick={(e) => e.stopPropagation()}
           >
             <CardHeader className="flex flex-row items-center justify-between">
               <CardTitle>Select Agent</CardTitle>
               <button 
                 onClick={() => setShowAgentSelector(false)}
                 className="text-muted-foreground hover:text-foreground"
                 aria-label="Close"
               >
                 ✕
               </button>
             </CardHeader>
             <CardContent className="space-y-2 max-h-96 overflow-y-auto scrollbar-thin scrollbar-thumb-rounded scrollbar-track-rounded">
               {allAgents.length > 0 ? (
                 <>
                   <Button
                     variant={!project.agent_id ? "default" : "outline"}
                     className="w-full justify-start text-left"
                     onClick={() => {
                       updateAgentMutation.mutate(null);
                     }}
                     disabled={updateAgentMutation.isPending}
                   >
                     <span>{updateAgentMutation.isPending ? "Updating..." : "Remove Agent"}</span>
                   </Button>
                   {allAgents.map(a => (
                     <Button
                       key={a.id}
                       variant={project.agent_id === a.id ? "default" : "outline"}
                       className="w-full justify-start flex-col h-auto py-2.5"
                       onClick={() => {
                         updateAgentMutation.mutate(a.id);
                       }}
                       disabled={updateAgentMutation.isPending}
                     >
                       <span className="font-medium text-sm">{a.name}</span>
                       <span className="text-xs text-muted-foreground">{a.current_agency_name || "No agency"}</span>
                     </Button>
                   ))}
                 </>
               ) : (
                 <p className="text-muted-foreground text-sm py-4 text-center">No agents available</p>
               )}
             </CardContent>
           </Card>
         </div>
       )}
       </ErrorBoundary>

       {/* Project Chat Panel */}
       {showProjectChat && user && (
         <ChatPanel
           openChats={[{ type: 'project', projectId, projectTitle: project?.title }]}
           activeChat={`project:${projectId}`}
           onSetActiveChat={() => {}}
           onClose={() => setShowProjectChat(false)}
           currentUserEmail={user.email}
         />
       )}
       </div>
       );
       }