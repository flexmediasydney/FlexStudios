import React, { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEntityList } from "@/components/hooks/useEntityData";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Plus, CheckCircle2, Clock, XCircle, AlertCircle, ChevronDown, ChevronRight, Trash2, DollarSign, Pencil, Paperclip } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { fmtDate } from "@/components/utils/dateUtils";
import { cn } from "@/lib/utils";
import CreateRevisionDialog from "./CreateRevisionDialog";
import EditRevisionDialog from "./EditRevisionDialog";
import PricingImpactCard from "./PricingImpactCard";
import { createNotificationsForUsers, writeFeedEvent } from "@/components/notifications/createNotification";

const REVISION_TYPES = {
  images: { label: "Images", icon: "📷", color: "bg-blue-50 border-blue-200 text-blue-700" },
  drones: { label: "Drones", icon: "🚁", color: "bg-sky-50 border-sky-200 text-sky-700" },
  floorplan: { label: "Floorplan", icon: "📐", color: "bg-amber-50 border-amber-200 text-amber-700" },
  video: { label: "Video", icon: "🎬", color: "bg-purple-50 border-purple-200 text-purple-700" },
};

const REQUEST_KIND_CONFIG = {
  revision: { label: "Revision", color: "bg-red-100 text-red-700 border-red-200" },
  change_request: { label: "Change Request", color: "bg-purple-100 text-purple-700 border-purple-200" },
};

const STATUS_CONFIG = {
  identified: { label: "Identified", icon: Clock, color: "bg-slate-100 text-slate-700 border-slate-200" },
  in_progress: { label: "In Progress", icon: AlertCircle, color: "bg-blue-100 text-blue-700 border-blue-200" },
  completed: { label: "Completed", icon: CheckCircle2, color: "bg-green-100 text-green-700 border-green-200" },
  delivered: { label: "Delivered", icon: CheckCircle2, color: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  cancelled: { label: "Cancelled", icon: XCircle, color: "bg-red-100 text-red-700 border-red-200" },
  stuck: { label: "Stuck", icon: AlertCircle, color: "bg-orange-100 text-orange-700 border-orange-200" },
};

const PRIORITY_COLORS = {
  low: "text-muted-foreground",
  normal: "text-blue-600",
  high: "text-orange-600",
  urgent: "text-red-600 font-semibold",
};

function RevisionCard({ revision, project, canEdit, tasks, allProducts = [], logActivity, currentUser }) {
   const [expanded, setExpanded] = useState(false);
   const [showCancelDialog, setShowCancelDialog] = useState(false);
   const [showStatusSelect, setShowStatusSelect] = useState(false);
   const [showDeleteDialog, setShowDeleteDialog] = useState(false);
   const [showEditDialog, setShowEditDialog] = useState(false);
   const [showRevertConfirm, setShowRevertConfirm] = useState(false);
   const [revertConfirmStep, setRevertConfirmStep] = useState(0);
   const [pricingImpact, setPricingImpact] = useState(revision.pricing_impact || {});
   const [revisionTasksLocal, setRevisionTasksLocal] = useState([]);

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

  const updateMutation = useMutation({
     mutationFn: (data) => base44.entities.ProjectRevision.update(revision.id, data),
     onSuccess: () => {
       toast.success("Request updated");
       setPricingImpact(revision.pricing_impact || {});
     },
     onError: (e) => {
       toast.error(e.message || "Failed to update");
       setPricingImpact(revision.pricing_impact || {});
     },
   });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      // Clean up tasks and timers before deleting the revision record
      await base44.functions.invoke('handleRevisionCancellation', { revision_id: revision.id }).catch(() => {});
      await base44.entities.ProjectRevision.delete(revision.id);
    },
    onSuccess: () => toast.success('Request deleted'),
    onError: (e) => toast.error(e.message || 'Failed to delete'),
  });

  const markPricingUpdated = async () => {
    try {
      await base44.functions.invoke('applyRevisionPricingImpact', {
        revision_id: revision.id,
        project_id: project.id,
      });
      toast.success('Pricing impact applied to project');
    } catch (e) {
      toast.error(e.message || 'Failed to apply pricing impact');
    }
  };

  const handleCancel = async () => {
    await base44.functions.invoke('handleRevisionCancellation', { revision_id: revision.id }).catch(() => {});
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
      base44.functions.invoke('checkAndArchiveProject', {
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
      await base44.functions.invoke('handleRevisionStuckStatus', { 
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

  const handleRevertPricing = async () => {
    try {
      await base44.functions.invoke('revertRevisionPricingImpact', {
        revision_id: revision.id,
        project_id: project.id,
      });
      toast.success('Pricing impact reverted');
    } catch (e) {
      toast.error(e.message || 'Failed to revert pricing impact');
    }
    setShowRevertConfirm(false);
    setRevertConfirmStep(0);
  };

  const completedTaskCount = revisionTasks.filter(t => t.is_completed).length;

  // Get kind-specific styling for card border
  const kindBorderStyle = revision.request_kind === 'change_request' 
    ? 'border-2 border-purple-400' 
    : 'border-2 border-red-400';

  return (
    <div className={cn("rounded-xl overflow-hidden", kindBorderStyle, {
      'bg-gradient-to-br from-purple-50/30 to-transparent': revision.request_kind === 'change_request',
      'bg-gradient-to-br from-red-50/30 to-transparent': revision.request_kind === 'revision'
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
                {revision.status === "in_progress" && revisionTasks.length > 0 
                  ? `In Progress (${completedTaskCount}/${revisionTasks.length})`
                  : statusConfig.label}
              </Badge>
            )}
            {revision.priority !== "normal" && (
              <span className={`text-xs font-medium ${PRIORITY_COLORS[revision.priority]}`}>
                {revision.priority.charAt(0).toUpperCase() + revision.priority.slice(1)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
            <span>#{revision.revision_number}</span>
            {revision.requested_by_name && <span>by {revision.requested_by_name}</span>}
            {revision.requested_date && <span>{fmtDate(revision.requested_date, 'd MMM yyyy')}</span>}
            {revision.due_date && <span>Due: {fmtDate(revision.due_date, 'd MMM yyyy')}</span>}
            {revision.template_name && <span className="italic">Template: {revision.template_name}</span>}
            {revisionTasks.length > 0 && (
              <span className="font-medium text-primary">{completedTaskCount}/{revisionTasks.length} tasks done</span>
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
            <div className="relative">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs px-2"
                onClick={e => { e.stopPropagation(); setShowStatusSelect(s => !s); }}
              >
                Status ▾
              </Button>
              {showStatusSelect && (
                <div className="absolute right-0 top-8 z-50 bg-white border rounded-lg shadow-lg py-1 min-w-[140px]">
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
                  ? 'bg-amber-50 border-amber-200 text-amber-600 hover:bg-amber-100'
                  : 'text-amber-600 hover:bg-amber-50 border-amber-200'
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
              className="h-7 text-xs px-2 text-red-600 hover:bg-red-50 border-red-200"
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
              allProducts={allProducts}
              pricingTier={project?.pricing_tier || 'standard'}
            />
          )}

          {/* Attachments */}
          {(revision.attachments || []).length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5 flex items-center gap-1">
                <Paperclip className="h-3.5 w-3.5" /> Attachments ({revision.attachments.length})
              </p>
              <div className="space-y-1">
                {revision.attachments.map((att, i) => (
                  <a key={i} href={att.file_url} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-2 px-2 py-1.5 rounded-lg border bg-muted/30 text-xs hover:bg-muted/60 transition-colors">
                    <Paperclip className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                    <span className="flex-1 truncate">{att.file_name}</span>
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Revision Tasks — read-only summary; manage in Tasks tab */}
          {nonDeletedTasks.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">
              Tasks ({nonDeletedTasks.filter(t => t.is_completed).length}/{nonDeletedTasks.length} done) · manage in Tasks tab
            </p>
              <div className="space-y-1">
                {nonDeletedTasks.map(task => {
                  const cleanTitle = task.title.replace(/^\[Revision #\d+\]\s*/, "");
                  const assignee = task.assigned_to_team_name || task.assigned_to_name;
                  return (
                    <div key={task.id} className={cn(
                      "flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm group",
                      task.is_completed ? "bg-green-50 border-green-200" : task.is_blocked ? "bg-amber-50 border-amber-200" : "bg-white border-border"
                    )} title={cleanTitle}>
                      {task.is_completed
                        ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500 flex-shrink-0" />
                        : task.is_blocked 
                          ? <AlertCircle className="h-3.5 w-3.5 text-amber-600 flex-shrink-0" title="Blocked - complete dependencies first" />
                          : <Clock className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />}
                      <span className={cn("flex-1 min-w-0 truncate group-hover:whitespace-normal group-hover:break-words", task.is_completed && "line-through text-muted-foreground")}>
                        {cleanTitle}
                      </span>
                      {task.is_blocked && (
                        <span className="text-xs text-amber-600 font-medium flex-shrink-0">blocked</span>
                      )}
                      {assignee && (
                        <span className="text-xs text-muted-foreground flex-shrink-0 truncate">{assignee}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
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
              onClick={() => handleCancel()}
            >
              Cancel Request & Delete Tasks
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
                     <div className="text-xs space-y-1 bg-orange-50 p-2 rounded border border-orange-200">
                       {(revision.pricing_impact.products_added || []).filter(p => p.product_id).map((p, i) => (
                         <p key={i} className="text-orange-700">+ {p.product_name} (qty {p.quantity})</p>
                       ))}
                       {(revision.pricing_impact.quantity_changes || []).filter(p => p.product_id).map((p, i) => (
                         <p key={i} className="text-orange-700">~ {p.product_name}: {p.old_quantity}→{p.new_quantity}</p>
                       ))}
                       {(revision.pricing_impact.products_removed || []).filter(p => p.product_id).map((p, i) => (
                         <p key={i} className="text-orange-700">- {p.product_name}</p>
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
              <Button variant="destructive" onClick={() => handleRevertPricing()}>
                Confirm Revert
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
    queryFn: () => base44.auth.me(),
  });

  const logActivity = (action, description) => {
    if (!projectId || !project) return;
    base44.entities.ProjectActivity.create({
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
            base44.functions.invoke('syncProjectRevisionStatus', { project_id: projectId })
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