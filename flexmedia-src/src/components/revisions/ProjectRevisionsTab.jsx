import React, { useState, useEffect, useMemo, useRef } from "react";
import { api } from "@/api/supabaseClient";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, CheckCircle2, Clock, XCircle, AlertCircle, ChevronDown, ChevronRight, Trash2, DollarSign, Pencil, Paperclip, Lock, Circle } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { fmtDate } from "@/components/utils/dateUtils";
import TaskDetailPanel from "@/components/projects/TaskDetailPanel";
import { CountdownTimer } from "@/components/projects/TaskManagement";
import { cn } from "@/lib/utils";
import CreateRevisionDialog from "./CreateRevisionDialog";
import EditRevisionDialog from "./EditRevisionDialog";
import PricingImpactCard from "./PricingImpactCard";
import { createNotificationsForUsers, writeFeedEvent } from "@/components/notifications/createNotification";
import AttachmentLightbox from "@/components/common/AttachmentLightbox";

const REVISION_TYPES = {
  images: { label: "Images", icon: "📷", color: "bg-blue-50 border-blue-200 text-blue-700 dark:bg-blue-950/30 dark:border-blue-800 dark:text-blue-300" },
  drones: { label: "Drones", icon: "🚁", color: "bg-sky-50 border-sky-200 text-sky-700 dark:bg-sky-950/30 dark:border-sky-800 dark:text-sky-300" },
  floorplan: { label: "Floorplan", icon: "📐", color: "bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-950/30 dark:border-amber-800 dark:text-amber-300" },
  video: { label: "Video", icon: "🎬", color: "bg-purple-50 border-purple-200 text-purple-700 dark:bg-purple-950/30 dark:border-purple-800 dark:text-purple-300" },
};

const REQUEST_KIND_CONFIG = {
  revision: { label: "Revision", color: "bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800" },
  change_request: { label: "Change Request", color: "bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800" },
};

const STATUS_CONFIG = {
  identified: { label: "Identified", icon: Clock, color: "bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800/60 dark:text-slate-300 dark:border-slate-700" },
  in_progress: { label: "In Progress", icon: AlertCircle, color: "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800" },
  completed: { label: "Completed", icon: CheckCircle2, color: "bg-green-100 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-300 dark:border-green-800" },
  delivered: { label: "Delivered", icon: CheckCircle2, color: "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800" },
  cancelled: { label: "Cancelled", icon: XCircle, color: "bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800" },
  stuck: { label: "Stuck", icon: AlertCircle, color: "bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-800" },
};

const PRIORITY_COLORS = {
  low: "text-muted-foreground",
  normal: "text-blue-600 dark:text-blue-400",
  high: "text-orange-600 dark:text-orange-400",
  urgent: "text-red-600 dark:text-red-400 font-semibold",
};

function RevisionCard({ revision, project, canEdit, tasks, allProducts = [], allPackages = [], logActivity, currentUser }) {
   const [expanded, setExpanded] = useState(false);
   const [showCancelDialog, setShowCancelDialog] = useState(false);
   const [showStatusSelect, setShowStatusSelect] = useState(false);
   const statusDropdownRef = useRef(null);
   const [showDeleteDialog, setShowDeleteDialog] = useState(false);
   const [showEditDialog, setShowEditDialog] = useState(false);
   const [showRevertConfirm, setShowRevertConfirm] = useState(false);
   const [revertConfirmStep, setRevertConfirmStep] = useState(0);
   const [pricingImpact, setPricingImpact] = useState(revision.pricing_impact || {});
   const [revisionTasksLocal, setRevisionTasksLocal] = useState([]);
   const [showAddTask, setShowAddTask] = useState(false);
   const [addingTask, setAddingTask] = useState(false);
   const [newTaskTitle, setNewTaskTitle] = useState("");
   const [newTaskAssignRole, setNewTaskAssignRole] = useState("");
   const [newTaskDueDate, setNewTaskDueDate] = useState("");
   const [optimisticCompletions, setOptimisticCompletions] = useState({});
   const [expandedTaskId, setExpandedTaskId] = useState(null);
   const [attLightboxOpen, setAttLightboxOpen] = useState(false);
   const [attLightboxIdx, setAttLightboxIdx] = useState(0);

  // Close status dropdown on click outside
  useEffect(() => {
    if (!showStatusSelect) return;
    const handleClickOutside = (e) => {
      if (statusDropdownRef.current && !statusDropdownRef.current.contains(e.target)) {
        setShowStatusSelect(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showStatusSelect]);

  const typeConfig = REVISION_TYPES[revision.revision_type] || {};
  const kindConfig = REQUEST_KIND_CONFIG[revision.request_kind] || REQUEST_KIND_CONFIG.revision;
  const statusConfig = STATUS_CONFIG[revision.status] || STATUS_CONFIG.identified;
  const StatusIcon = statusConfig.icon;

  // Subscribe to real-time task updates for this revision
  useEffect(() => {
    const filtered = tasks.filter(t =>
      t.title?.startsWith(`[Revision #${revision.revision_number}]`)
    );
    setRevisionTasksLocal(filtered);
  }, [tasks, revision.revision_number]);

  const revisionTasks = revisionTasksLocal;

  const hasPricingImpact = !!revision.pricing_impact?.has_impact;
  const pricingApplied = !!revision.pricing_impact?.applied;
  const nonDeletedTasks = revisionTasks.filter(t => !t.is_deleted);
  const completedTaskCount = nonDeletedTasks.filter(t => t.is_completed).length;

  const updateMutation = useMutation({
     mutationFn: (data) => api.entities.ProjectRevision.update(revision.id, data),
     onSuccess: (responseData) => {
       toast.success("Request updated");
       refetchEntityList("ProjectRevision");
       // Use response data if available, otherwise keep current local state
       if (responseData?.pricing_impact) {
         setPricingImpact(responseData.pricing_impact);
       }
     },
     onError: (e) => {
       toast.error(e.message || "Failed to update");
       // Revert to prop value on error
       setPricingImpact(revision.pricing_impact || {});
     },
   });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      // Clean up tasks and timers before deleting the revision record
      await api.functions.invoke('handleRevisionCancellation', { revision_id: revision.id }).catch(() => {});
      await api.entities.ProjectRevision.delete(revision.id);
    },
    onSuccess: () => {
      toast.success('Request deleted');
      setShowDeleteDialog(false);
      refetchEntityList("ProjectRevision");
      refetchEntityList("ProjectTask");
    },
    onError: (e) => toast.error(e.message || 'Failed to delete'),
  });

  const [applyingPricing, setApplyingPricing] = useState(false);
  const markPricingUpdated = async () => {
    if (applyingPricing) return;
    setApplyingPricing(true);
    try {
      await api.functions.invoke('applyRevisionPricingImpact', {
        revision_id: revision.id,
        project_id: project.id,
      });
      toast.success('Pricing impact applied to project');
      refetchEntityList("ProjectRevision");
    } catch (e) {
      toast.error(e.message || 'Failed to apply pricing impact');
    } finally {
      setApplyingPricing(false);
    }
  };

  const handleCancel = async () => {
    await api.functions.invoke('handleRevisionCancellation', { revision_id: revision.id }).catch(() => {});
    setShowCancelDialog(false);
    updateMutation.mutate({ status: 'cancelled' });
    logActivity?.('request_cancelled',
      `Request #${revision.revision_number} cancelled: "${revision.title}"`
    );
    const projectName = project?.title || project?.property_address || 'Project';
    const staffIds = [project?.project_owner_id, project?.image_editor_id, project?.video_editor_id].filter(Boolean);
    createNotificationsForUsers(staffIds, {
      type: 'revision_cancelled',
      title: `Revision #${revision.revision_number} cancelled`,
      message: `"${revision.title}" on ${projectName} has been cancelled.`,
      projectId: project?.id, projectName,
      entityType: 'revision', entityId: revision.id,
      ctaUrl: 'ProjectDetails', ctaParams: { id: project?.id },
      sourceUserId: currentUser?.id,
      idempotencyKey: `rev_cancel:${revision.id}:${Date.now()}`,
    }, currentUser?.id).catch(() => {});
    writeFeedEvent({
      eventType: 'revision_cancelled', category: 'revision', severity: 'info',
      actorId: currentUser?.id, actorName: currentUser?.full_name,
      title: `Revision #${revision.revision_number} cancelled`,
      description: `"${revision.title}" on ${projectName}`,
      projectId: project?.id, projectName,
      entityType: 'revision', entityId: revision.id,
    }).catch(() => {});
  };

  const MANUAL_STATUS_OPTIONS = [
    { value: 'identified', label: 'Identified' },
    { value: 'in_progress', label: 'In Progress' },
    { value: 'completed', label: 'Completed' },
    { value: 'delivered', label: 'Delivered' },
  ];

  const handleStatusChange = (newStatus) => {
    setShowStatusSelect(false);
    const oldStatus = revision.status;
    updateMutation.mutate({ status: newStatus });
    const projectName = project?.title || project?.property_address || 'Project';
    const staffIds = [project?.project_owner_id, project?.image_editor_id, project?.video_editor_id].filter(Boolean);
    const typeMap = { completed: 'revision_approved', delivered: 'revision_approved' };
    const notifType = typeMap[newStatus] || 'revision_created';
    createNotificationsForUsers(staffIds, {
      type: notifType,
      title: `Revision #${revision.revision_number} → ${STATUS_CONFIG[newStatus]?.label || newStatus}`,
      message: `"${revision.title}" on ${projectName} moved from ${STATUS_CONFIG[oldStatus]?.label || oldStatus} to ${STATUS_CONFIG[newStatus]?.label || newStatus}.`,
      projectId: project?.id, projectName,
      entityType: 'revision', entityId: revision.id,
      ctaUrl: 'ProjectDetails', ctaParams: { id: project?.id },
      sourceUserId: currentUser?.id,
      idempotencyKey: `rev_status:${revision.id}:${newStatus}:${Date.now()}`,
    }, currentUser?.id).catch(() => {});
    if (newStatus === 'completed' || newStatus === 'delivered') {
      writeFeedEvent({
        eventType: 'revision_resolved', category: 'revision', severity: 'info',
        actorId: currentUser?.id, actorName: currentUser?.full_name,
        title: `Revision #${revision.revision_number} ${STATUS_CONFIG[newStatus]?.label || newStatus}`,
        description: `"${revision.title}" on ${projectName}`,
        projectId: project?.id, projectName,
        entityType: 'revision', entityId: revision.id,
      }).catch(() => {});
    }

    // Check if project qualifies for auto-archive after revision resolved
    if ((newStatus === 'completed' || newStatus === 'cancelled') && project?.status === 'delivered' && project?.payment_status === 'paid') {
      api.functions.invoke('checkAndArchiveProject', {
        project_id: project.id, triggered_by: 'revision_resolved'
      }).catch(() => {});
    }
  };

  const handleStuckToggle = async () => {
    const isBecomingStuck = revision.status !== "stuck";
    const data = isBecomingStuck 
      ? { status: "stuck", previous_status: revision.status }
      : { status: revision.previous_status || "in_progress" };

    try {
      await api.functions.invoke('handleRevisionStuckStatus', { 
        revision_id: revision.id, 
        is_stuck: isBecomingStuck 
      });
    } catch (e) {
      console.warn('Stuck toggle function error:', e);
    }

    updateMutation.mutate(data);
    logActivity?.('request_updated',
      isBecomingStuck
        ? `Request #${revision.revision_number} marked stuck: "${revision.title}"`
        : `Request #${revision.revision_number} unstuck: "${revision.title}"`
    );
    const projectName = project?.title || project?.property_address || 'Project';
    const staffIds = [project?.project_owner_id, project?.image_editor_id, project?.video_editor_id].filter(Boolean);
    if (isBecomingStuck) {
      createNotificationsForUsers(staffIds, {
        type: 'revision_urgent',
        title: `Revision #${revision.revision_number} stuck`,
        message: `"${revision.title}" on ${projectName} has been flagged as stuck and needs attention.`,
        projectId: project?.id, projectName,
        entityType: 'revision', entityId: revision.id,
        ctaUrl: 'ProjectDetails', ctaParams: { id: project?.id },
        sourceUserId: currentUser?.id,
        idempotencyKey: `rev_stuck:${revision.id}:${Date.now()}`,
      }, currentUser?.id).catch(() => {});
    }
  };

  const [revertingPricing, setRevertingPricing] = useState(false);
  const handleRevertPricing = async () => {
    if (revertingPricing) return;
    setRevertingPricing(true);
    try {
      await api.functions.invoke('revertRevisionPricingImpact', {
        revision_id: revision.id,
        project_id: project.id,
      });
      toast.success('Pricing impact reverted');
      refetchEntityList("ProjectRevision");
    } catch (e) {
      toast.error(e.message || 'Failed to revert pricing impact');
    } finally {
      setRevertingPricing(false);
    }
    setShowRevertConfirm(false);
    setRevertConfirmStep(0);
  };

  // --- Inline task helpers ---
  const PROJECT_ROLES = [
    { value: "project_owner", label: "Project Owner", idField: "project_owner_id", nameField: "project_owner_name" },
    { value: "photographer", label: "Photographer", idField: "onsite_staff_1_id", nameField: "onsite_staff_1_name" },
    { value: "videographer", label: "Videographer", idField: "onsite_staff_2_id", nameField: "onsite_staff_2_name" },
    { value: "image_editor", label: "Image Editor", idField: "image_editor_id", nameField: "image_editor_name" },
    { value: "video_editor", label: "Video Editor", idField: "video_editor_id", nameField: "video_editor_name" },
    { value: "floorplan_editor", label: "Floorplan Editor", idField: "floorplan_editor_id", nameField: "floorplan_editor_name" },
    { value: "drone_editor", label: "Drone Editor", idField: "drone_editor_id", nameField: "drone_editor_name" },
  ];

  const getTaskWithOptimistic = (task) => {
    const opt = optimisticCompletions[task.id];
    return opt ? { ...task, is_completed: opt.is_completed, completed_at: opt.completed_at } : task;
  };

  const handleToggleTask = async (task) => {
    if (task.is_blocked || task.is_locked) return;
    const wasCompleted = task.is_completed;
    const newCompleted = !wasCompleted;
    const newCompletedAt = newCompleted ? new Date().toISOString() : null;
    setOptimisticCompletions(prev => ({ ...prev, [task.id]: { is_completed: newCompleted, completed_at: newCompletedAt } }));
    try {
      await api.entities.ProjectTask.update(task.id, {
        is_completed: newCompleted,
        completed_at: newCompletedAt,
      });
      refetchEntityList("ProjectTask");
    } catch (e) {
      setOptimisticCompletions(prev => { const n = { ...prev }; delete n[task.id]; return n; });
      toast.error("Failed to update task");
    }
  };

  const handleAddTask = async () => {
    if (!newTaskTitle.trim() || addingTask) return;
    setAddingTask(true);
    try {
      const taskData = {
        title: `[Revision #${revision.revision_number}] ${newTaskTitle.trim()}`,
        project_id: project.id,
        task_type: "back_office",
        due_date: newTaskDueDate || revision.due_date || null,
        is_completed: false,
        is_deleted: false,
      };
      if (newTaskAssignRole) {
        const role = PROJECT_ROLES.find(r => r.value === newTaskAssignRole);
        if (role && project[role.idField]) {
          taskData.assigned_to = project[role.idField];
          taskData.assigned_to_name = project[role.nameField] || "";
        }
      }
      await api.entities.ProjectTask.create(taskData);
      refetchEntityList("ProjectTask");
      setNewTaskTitle("");
      setNewTaskAssignRole("");
      setNewTaskDueDate("");
      setShowAddTask(false);
      toast.success("Task added");
    } catch (e) {
      toast.error(e.message || "Failed to add task");
    } finally {
      setAddingTask(false);
    }
  };

  const getDaysOverdue = (dueDate) => {
    if (!dueDate) return 0;
    const now = new Date();
    const due = new Date(dueDate);
    const diff = Math.floor((now - due) / (1000 * 60 * 60 * 24));
    return diff > 0 ? diff : 0;
  };

  const formatEffort = (minutes) => {
    if (!minutes || minutes <= 0) return null;
    if (minutes < 60) return `${minutes}m`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  };

  // Get kind-specific styling for card border
  const kindBorderStyle = revision.request_kind === 'change_request'
    ? 'border-2 border-purple-400'
    : 'border-2 border-red-400';

  return (
    <div className={cn("rounded-xl overflow-hidden", kindBorderStyle, {
      'bg-gradient-to-br from-purple-50/30 to-transparent dark:from-purple-950/20 dark:to-transparent': revision.request_kind === 'change_request',
      'bg-gradient-to-br from-red-50/30 to-transparent dark:from-red-950/20 dark:to-transparent': revision.request_kind === 'revision'
    })}>
      {/* Header */}
      <div
        className="flex items-start gap-3 p-4 cursor-pointer hover:bg-muted/20 transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        <span className="text-lg mt-0.5">{typeConfig.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm">{revision.title}</span>
            {kindConfig.color && <Badge variant="outline" className={`text-xs ${kindConfig.color}`}>{kindConfig.label}</Badge>}
            {typeConfig.color && <Badge variant="outline" className={`text-xs ${typeConfig.color}`}>{typeConfig.label}</Badge>}
            {statusConfig.icon && (
              <Badge variant="outline" className={`text-xs ${statusConfig.color} flex items-center gap-1`}>
                <StatusIcon className="h-3 w-3" />
                {revision.status === "in_progress" && nonDeletedTasks.length > 0
                  ? `In Progress (${completedTaskCount}/${nonDeletedTasks.length})`
                  : statusConfig.label}
              </Badge>
            )}
            {revision.priority && revision.priority !== "normal" && (
              <span className={`text-xs font-medium ${PRIORITY_COLORS[revision.priority]}`}>
                {(revision.priority || 'normal').charAt(0).toUpperCase() + (revision.priority || 'normal').slice(1)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
            <span>#{revision.revision_number}</span>
            {revision.requested_by_name && <span>by {revision.requested_by_name}</span>}
            {revision.requested_date && <span>{fmtDate(revision.requested_date, 'd MMM yyyy')}</span>}
            {revision.due_date && <span>Due: {fmtDate(revision.due_date, 'd MMM yyyy')}</span>}
            {revision.template_name && <span className="italic">Template: {revision.template_name}</span>}
            {nonDeletedTasks.length > 0 && (
              <span className="font-medium text-primary">{completedTaskCount}/{nonDeletedTasks.length} tasks done</span>
            )}
            {hasPricingImpact && (
              <span className={`flex items-center gap-0.5 font-medium ${pricingApplied ? "text-green-600" : "text-orange-600"}`}>
                <DollarSign className="h-3 w-3" />
                {pricingApplied ? "Price updated" : "Price impact pending"}
              </span>
            )}
          </div>
          {revision.status === "stuck" && (
           <p className="text-xs text-orange-600 mt-1 italic">⏸ Request is paused - all effort timers are stopped</p>
          )}
          {revision.status === "cancelled" && (
           <p className="text-xs text-red-600 mt-1 italic">✕ Request cancelled - all tasks deleted</p>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0 mt-0.5">
          {/* Status select — manual progression */}
          {canEdit && !['cancelled', 'stuck'].includes(revision.status) && (
            <div className="relative" ref={statusDropdownRef}>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs px-2"
                onClick={e => { e.stopPropagation(); setShowStatusSelect(s => !s); }}
              >
                Status ▾
              </Button>
              {showStatusSelect && (
                <div className="absolute right-0 top-8 z-50 bg-popover border rounded-lg shadow-lg py-1 min-w-[140px]">
                  {MANUAL_STATUS_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-muted transition-colors ${
                        revision.status === opt.value ? 'font-semibold text-primary' : ''
                      }`}
                      onClick={e => { e.stopPropagation(); handleStatusChange(opt.value); }}
                    >
                      {opt.value === revision.status ? '✓ ' : ''}{opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Stuck toggle */}
          {canEdit && !['delivered', 'cancelled'].includes(revision.status) && (
            <Button
              variant="outline"
              size="sm"
              className={cn('h-7 text-xs px-2',
                revision.status === 'stuck'
                  ? 'bg-amber-50 border-amber-200 text-amber-600 hover:bg-amber-100 dark:bg-amber-950/30 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-900/40'
                  : 'text-amber-600 hover:bg-amber-50 border-amber-200 dark:text-amber-400 dark:hover:bg-amber-950/30 dark:border-amber-800'
              )}
              onClick={e => { e.stopPropagation(); handleStuckToggle(); }}
              disabled={updateMutation.isPending}
              title={revision.status === 'stuck' ? 'Resume request' : 'Pause request'}
            >
              {revision.status === 'stuck' ? '✓ Stuck' : '⏸ Stuck'}
            </Button>
          )}

          {/* Cancel */}
          {canEdit && !['delivered', 'cancelled'].includes(revision.status) && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs px-2 text-red-600 hover:bg-red-50 border-red-200 dark:text-red-400 dark:hover:bg-red-950/30 dark:border-red-800"
              onClick={e => { e.stopPropagation(); setShowCancelDialog(true); }}
              title="Cancel request"
            >
              Cancel
            </Button>
          )}

          {/* Edit */}
          {canEdit && (
            <Button
              variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
              onClick={e => { e.stopPropagation(); setShowEditDialog(true); }}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}

          {/* Delete */}
          {canEdit && (
            <Button
              variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive hover:text-destructive"
              onClick={e => { e.stopPropagation(); setShowDeleteDialog(true); }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}

          {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </div>
      </div>

      {/* Expanded */}
      {expanded && (
        <div className="border-t bg-muted/10 p-4 space-y-4">
          {revision.description && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Details</p>
              <p className="text-sm whitespace-pre-wrap">{revision.description}</p>
            </div>
          )}

          {/* Pricing Impact Card */}
          {hasPricingImpact && (
            <PricingImpactCard
              pricingImpact={pricingImpact}
              onUpdate={(updated) => {
                setPricingImpact(updated);
                updateMutation.mutate({ pricing_impact: updated });
              }}
              onMarkApplied={markPricingUpdated}
              onRevert={() => setShowRevertConfirm(true)}
              applied={pricingApplied}
              canEdit={canEdit && revision.status !== "delivered" && revision.status !== "cancelled"}
              project={project}
              allProducts={allProducts}
              allPackages={allPackages}
              pricingTier={project?.pricing_tier || 'standard'}
            />
          )}

          {/* Attachments */}
          {(revision.attachments || []).length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
                <Paperclip className="h-3.5 w-3.5" /> Attachments ({revision.attachments.length})
              </p>
              <div className="flex flex-wrap gap-2">
                {revision.attachments.map((att, i) => {
                  const isImage = /\.(jpg|jpeg|png|gif|webp|svg|bmp|tiff?)$/i.test(att.file_name || '');
                  return isImage ? (
                    <button
                      key={i}
                      onClick={() => { setAttLightboxIdx(i); setAttLightboxOpen(true); }}
                      className="block rounded-lg border border-border/60 overflow-hidden hover:ring-2 hover:ring-primary/40 transition-all cursor-pointer"
                    >
                      <img src={att.file_url} alt={att.file_name} className="h-20 w-auto object-cover" draggable={false} />
                    </button>
                  ) : (
                    <button
                      key={i}
                      onClick={() => { setAttLightboxIdx(i); setAttLightboxOpen(true); }}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-lg border bg-muted/30 text-xs hover:bg-muted/60 transition-colors cursor-pointer"
                    >
                      <Paperclip className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                      <span className="flex-1 truncate">{att.file_name}</span>
                    </button>
                  );
                })}
              </div>
              {attLightboxOpen && (
                <AttachmentLightbox
                  files={revision.attachments}
                  initialIndex={attLightboxIdx}
                  onClose={() => setAttLightboxOpen(false)}
                />
              )}
            </div>
          )}

          {/* Inline Task Manager */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-muted-foreground">
                Tasks ({nonDeletedTasks.filter(t => getTaskWithOptimistic(t).is_completed).length}/{nonDeletedTasks.length} completed)
              </p>
              {canEdit && !['cancelled', 'delivered'].includes(revision.status) && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs px-2 gap-1"
                  onClick={() => setShowAddTask(s => !s)}
                >
                  <Plus className="h-3 w-3" /> Add
                </Button>
              )}
            </div>

            {/* Add Task Form */}
            {showAddTask && (
              <div className="mb-3 p-3 rounded-lg border bg-muted/30 space-y-2">
                <Input
                  placeholder="Task title..."
                  value={newTaskTitle}
                  onChange={e => setNewTaskTitle(e.target.value)}
                  className="h-8 text-sm"
                  onKeyDown={e => { if (e.key === 'Enter') handleAddTask(); }}
                  autoFocus
                />
                <div className="flex items-center gap-2">
                  <Select value={newTaskAssignRole} onValueChange={setNewTaskAssignRole}>
                    <SelectTrigger className="h-7 text-xs flex-1">
                      <SelectValue placeholder="Assign to role..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Unassigned</SelectItem>
                      {PROJECT_ROLES.filter(r => project?.[r.idField]).map(r => (
                        <SelectItem key={r.value} value={r.value}>
                          {r.label}{project[r.nameField] ? ` (${project[r.nameField]})` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="date"
                    value={newTaskDueDate}
                    onChange={e => setNewTaskDueDate(e.target.value)}
                    className="h-7 text-xs w-36"
                    placeholder="Due date"
                  />
                </div>
                <div className="flex items-center gap-2 justify-end">
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setShowAddTask(false); setNewTaskTitle(""); setNewTaskAssignRole(""); setNewTaskDueDate(""); }}>
                    Cancel
                  </Button>
                  <Button size="sm" className="h-7 text-xs" disabled={!newTaskTitle.trim() || addingTask} onClick={handleAddTask}>
                    {addingTask ? "Adding..." : "Add Task"}
                  </Button>
                </div>
              </div>
            )}

            {/* Task List */}
            {nonDeletedTasks.length > 0 && (
              <div className="space-y-1">
                {nonDeletedTasks.map(rawTask => {
                  const task = getTaskWithOptimistic(rawTask);
                  const cleanTitle = task.title.replace(/^\[Revision #\d+\]\s*/, "");
                  const assignee = task.assigned_to_team_name || task.assigned_to_name;
                  const daysOverdue = !task.is_completed ? getDaysOverdue(task.due_date) : 0;
                  const isBlocked = task.is_blocked || task.is_locked;
                  const estEffort = formatEffort(task.estimated_minutes);
                  const actEffort = formatEffort(task.total_effort_logged);

                  const isTaskExpanded = expandedTaskId === task.id;

                  return (
                    <div key={task.id} className="space-y-0">
                      <div
                        className={cn(
                          "flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm group cursor-pointer transition-colors",
                          task.is_completed
                            ? "bg-green-50 border-green-200 dark:bg-green-950/30 dark:border-green-800 hover:bg-green-100/60 dark:hover:bg-green-900/40"
                            : isBlocked
                              ? "bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-800 hover:bg-amber-100/60 dark:hover:bg-amber-900/40"
                              : "bg-background border-border hover:bg-muted/40",
                          isTaskExpanded && "rounded-b-none border-b-0"
                        )}
                        onClick={() => setExpandedTaskId(isTaskExpanded ? null : task.id)}
                      >
                        {/* Checkbox / Status Icon */}
                        {isBlocked ? (
                          <Lock className="h-3.5 w-3.5 text-amber-600 flex-shrink-0" title="Blocked - complete dependencies first" />
                        ) : (
                          <Checkbox
                            checked={task.is_completed}
                            onCheckedChange={() => handleToggleTask(rawTask)}
                            onClick={(e) => e.stopPropagation()}
                            className={cn(
                              "h-4 w-4 flex-shrink-0 rounded-sm",
                              task.is_completed && "data-[state=checked]:bg-green-600 data-[state=checked]:border-green-600"
                            )}
                          />
                        )}

                        {/* Title */}
                        <span className={cn(
                          "flex-1 min-w-0 truncate",
                          task.is_completed && "line-through text-muted-foreground"
                        )}>
                          {cleanTitle}
                        </span>

                        {/* Effort display */}
                        {(estEffort || actEffort) && (
                          <span className="text-[10px] text-muted-foreground flex-shrink-0 tabular-nums" title={`Est: ${estEffort || '-'} / Actual: ${actEffort || '-'}`}>
                            {actEffort || '0m'}/{estEffort || '-'}
                          </span>
                        )}

                        {/* Blocked badge */}
                        {isBlocked && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700 flex-shrink-0">
                            blocked
                          </Badge>
                        )}

                        {/* Due date / overdue */}
                        {task.due_date && !task.is_completed && (
                          daysOverdue > 0 ? (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 bg-red-100 text-red-700 border-red-300 dark:bg-red-900/40 dark:text-red-300 dark:border-red-700 flex-shrink-0">
                              {daysOverdue}d overdue
                            </Badge>
                          ) : (
                            <span className="text-[10px] text-muted-foreground flex-shrink-0">
                              {fmtDate(task.due_date, 'd MMM')}
                            </span>
                          )
                        )}

                        {/* Assignee */}
                        {assignee && (
                          <span className="text-[10px] text-muted-foreground flex-shrink-0 truncate max-w-[80px]">{assignee}</span>
                        )}

                        {/* Expand arrow */}
                        <ChevronDown className={cn("h-3 w-3 text-muted-foreground/50 flex-shrink-0 transition-transform", isTaskExpanded && "rotate-180")} />
                      </div>

                      {/* Expanded: full TaskDetailPanel — identical to Tasks subtab */}
                      {isTaskExpanded && (
                        <div className="border border-t-0 rounded-b-lg overflow-hidden">
                          <TaskDetailPanel
                            task={rawTask}
                            canEdit={canEdit}
                            onEdit={() => {}}
                            onDelete={() => {}}
                            onUpdateDeadline={(id, data) => {
                              api.entities.ProjectTask.update(id, data).then(() => refetchEntityList("ProjectTask")).catch(() => toast.error("Failed to update deadline"));
                            }}
                            thresholds={{ warn: 4, danger: 1 }}
                            projectId={project?.id}
                            project={project}
                            user={currentUser}
                            onClose={() => setExpandedTaskId(null)}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {nonDeletedTasks.length === 0 && !showAddTask && (
              <p className="text-xs text-muted-foreground italic">No tasks for this revision</p>
            )}
          </div>
        </div>
      )}

      <EditRevisionDialog
        open={showEditDialog}
        onClose={() => setShowEditDialog(false)}
        revision={revision}
        project={project}
      />

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this request?</AlertDialogTitle>
            <AlertDialogDescription>This will delete the request record. Associated tasks will remain unless deleted manually.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground" disabled={deleteMutation.isPending} onClick={() => deleteMutation.mutate()}>
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this request?</AlertDialogTitle>
            <AlertDialogDescription>
              <p className="mb-2">
                Cancelling <strong>"{revision.title}"</strong> will permanently delete all
                associated tasks and stop any running timers. This cannot be undone.
              </p>
              <p className="text-xs text-muted-foreground">
                The request record will be kept for audit purposes and marked as Cancelled.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Request</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={updateMutation.isPending}
              onClick={() => handleCancel()}
            >
              {updateMutation.isPending ? "Cancelling..." : "Cancel Request & Delete Tasks"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showRevertConfirm} onOpenChange={setShowRevertConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {revertConfirmStep === 0 ? "Revert pricing changes?" : "Are you absolutely sure?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {revertConfirmStep === 0 ? (
                 <div className="space-y-2">
                   <p>Mark this pricing impact as pending again?</p>
                   {revision.pricing_impact && (
                     <div className="text-xs space-y-1 bg-orange-50 p-2 rounded border border-orange-200 dark:bg-orange-950/30 dark:border-orange-800">
                       {(revision.pricing_impact.products_added || []).filter(p => p.product_id).map((p, i) => (
                         <p key={i} className="text-orange-700 dark:text-orange-300">+ {p.product_name} (qty {p.quantity})</p>
                       ))}
                       {(revision.pricing_impact.quantity_changes || []).filter(p => p.product_id).map((p, i) => (
                         <p key={i} className="text-orange-700 dark:text-orange-300">~ {p.product_name}: {p.old_quantity}→{p.new_quantity}</p>
                       ))}
                       {(revision.pricing_impact.products_removed || []).filter(p => p.product_id).map((p, i) => (
                         <p key={i} className="text-orange-700 dark:text-orange-300">- {p.product_name}</p>
                       ))}
                     </div>
                   )}
                 </div>
               ) : (
                 "Confirm marking pricing impact as pending again?"
               )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setRevertConfirmStep(0)}>Cancel</AlertDialogCancel>
            {revertConfirmStep === 0 ? (
              <Button className="bg-orange-600 hover:bg-orange-700" onClick={() => setRevertConfirmStep(1)}>
                Yes, Revert
              </Button>
            ) : (
              <Button variant="destructive" disabled={revertingPricing} onClick={() => handleRevertPricing()}>
                {revertingPricing ? "Reverting..." : "Confirm Revert"}
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      </div>
      );
      }

export default function ProjectRevisionsTab({ projectId, project, canEdit }) {
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [filterKind, setFilterKind] = useState("all");
  const [filterType, setFilterType] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const { data: currentUser } = useQuery({
    queryKey: ["currentUser"],
    queryFn: () => api.auth.me(),
  });

  const logActivity = (action, description) => {
    if (!projectId || !project) return;
    api.entities.ProjectActivity.create({
      project_id: projectId,
      project_title: project.title || project.property_address || '',
      action,
      description,
      user_name: currentUser?.full_name || currentUser?.email || 'Unknown',
      user_email: currentUser?.email || '',
    }).catch(err => console.warn('[activity]', err?.message));
  };

  // Trigger refresh on tab focus
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        setRefreshTrigger(t => t + 1);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  const { data: revisions = [], loading } = useEntityList(
    "ProjectRevision", "-created_date", 200,
    r => r.project_id === projectId
  );
  const { data: tasks = [] } = useEntityList(
    "ProjectTask", "order", 500,
    t => t.project_id === projectId
  );
  const { data: products = [] } = useEntityList("Product", null, 500);
  const { data: packages = [] } = useEntityList("Package", null, 500);

  const filtered = useMemo(() => revisions.filter(r => {
    const kindMatch = filterKind === 'all' || r.request_kind === filterKind;
    const typeMatch = filterType === 'all' || r.revision_type === filterType;
    const statusMatch = filterStatus === 'all' || r.status === filterStatus;
    return kindMatch && typeMatch && statusMatch;
  }), [revisions, filterKind, filterType, filterStatus]);

  const statusCounts = useMemo(() => revisions.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {}), [revisions]);

  return (
    <div className="space-y-4">
      {/* Summary badges */}
      {revisions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(STATUS_CONFIG).map(([key, cfg]) => {
            const count = statusCounts[key] || 0;
            if (count === 0) return null;
            const Icon = cfg.icon;
            if (!Icon) return null;
            return (
              <Badge key={key} variant="outline" className={`text-xs ${cfg.color} gap-1`}>
                <Icon className="h-3 w-3" />
                {count} {cfg.label}
              </Badge>
            );
          })}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={filterKind} onValueChange={setFilterKind}>
          <SelectTrigger className="h-8 w-40 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Kinds</SelectItem>
            {Object.entries(REQUEST_KIND_CONFIG).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filterType} onValueChange={setFilterType}>
          <SelectTrigger className="h-8 w-36 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            {Object.entries(REVISION_TYPES).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v.icon} {v.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="h-8 w-36 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            {Object.entries(STATUS_CONFIG).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto">
          {canEdit && (
            <Button size="sm" onClick={() => setShowCreateDialog(true)}>
              <Plus className="h-4 w-4 mr-1.5" /> New Request
            </Button>
          )}
        </div>
      </div>

      {/* List */}
      {loading && (
        <div className="flex items-center justify-center py-10">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="text-center py-14 text-muted-foreground border rounded-xl border-dashed">
          <p className="font-medium">No requests {filterKind !== "all" || filterType !== "all" || filterStatus !== "all" ? "matching filters" : "yet"}</p>
          {canEdit && filterKind === "all" && filterType === "all" && filterStatus === "all" && (
            <Button className="mt-4" size="sm" onClick={() => setShowCreateDialog(true)}>
              <Plus className="h-4 w-4 mr-1.5" /> Create First Request
            </Button>
          )}
        </div>
      )}

      <div className="space-y-3">
        {filtered.map(revision => (
          <RevisionCard
            key={revision.id}
            revision={revision}
            project={project}
            canEdit={canEdit}
            tasks={tasks}
            allProducts={products}
            allPackages={packages}
            logActivity={logActivity}
            currentUser={currentUser}
          />
        ))}
      </div>

      <CreateRevisionDialog
        open={showCreateDialog}
        onClose={(created) => {
          setShowCreateDialog(false);
          if (created) {
            api.functions.invoke('syncProjectRevisionStatus', { project_id: projectId })
              .catch(err => console.warn('[revisionSync]', err?.message));
          }
        }}
        project={project}
        existingRevisions={revisions}
        logActivity={logActivity}
      />
    </div>
  );
}