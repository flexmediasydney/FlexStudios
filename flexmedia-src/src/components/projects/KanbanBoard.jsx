import { useState } from "react";
import React from "react";
import { base44 } from "@/api/base44Client";
import { useMutation } from "@tanstack/react-query";
import { useEntityList } from "@/components/hooks/useEntityData";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { toast } from "sonner";
import { scheduleDeadlineSync } from "@/components/projects/taskDeadlineSync";
import { PROJECT_STAGES } from "./projectStatuses";
import { ProjectCardFields } from "./ProjectCardFields";
import { useCardFields } from "./useCardFields";
import { DollarSign, CheckCircle2, Clock, AlertCircle, Mail, Calendar } from "lucide-react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { useQuery } from "@tanstack/react-query";
import { fixTimestamp, fmtTimestampCustom } from "@/components/utils/dateUtils";

const statusColumns = PROJECT_STAGES.map(s => ({ id: s.value, label: s.label, color: s.color }));

// Email indicator now receives pre-fetched emails passed from KanbanBoard
// (no per-card API call — the board fetches all emails in one batch query)
function ProjectEmailIndicator({ emails = [] }) {

  if (emails.length === 0) return null;

  const unreadCount = emails.filter(e => e.is_unread).length;
  const hasUnread = unreadCount > 0;

  return (
    <HoverCard openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>
        <button
          className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
            hasUnread
              ? "bg-purple-100 text-purple-700 hover:bg-purple-200"
              : "bg-gray-100 text-gray-500 hover:bg-gray-200"
          }`}
          onClick={(e) => e.stopPropagation()} // prevent card click when hovering
          title={hasUnread ? `${unreadCount} unread email${unreadCount > 1 ? "s" : ""}` : `${emails.length} linked email${emails.length > 1 ? "s" : ""}`}
        >
          <Mail className={`h-2.5 w-2.5 ${hasUnread ? "text-purple-600" : "text-gray-400"}`} />
          <span>{emails.length}</span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        className="w-80 p-0 overflow-hidden"
        side="right"
        align="start"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Popover header */}
        <div className="px-3 py-2 bg-muted/50 border-b flex items-center gap-2">
          <Mail className="h-3.5 w-3.5 text-purple-600" />
          <span className="text-xs font-semibold">Recent Emails</span>
          {hasUnread && (
            <span className="ml-auto text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded-full font-medium">
              {unreadCount} unread
            </span>
          )}
        </div>

        {/* Email rows */}
        <div className="divide-y max-h-56 overflow-y-auto">
          {emails.map(email => (
            <div
              key={email.id}
              className={`px-3 py-2 text-xs ${email.is_unread ? "bg-purple-50/40" : ""}`}
            >
              <div className="flex items-start justify-between gap-2">
                <p className={`truncate flex-1 ${email.is_unread ? "font-semibold text-gray-900" : "font-medium text-gray-700"}`}>
                  {email.subject || "(no subject)"}
                </p>
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {fmtTimestampCustom(email.received_at, { dateStyle: "short" })}
                </span>
              </div>
              <p className="text-muted-foreground truncate mt-0.5">
                {email.from_name || email.from}
              </p>
              {email.body && (
                <p className="text-muted-foreground truncate mt-0.5 line-clamp-1 text-[10px]">
                  {email.body.replace(/<[^>]*>/g, "").trim().substring(0, 80)}
                </p>
              )}
            </div>
          ))}
        </div>

        {/* Footer — click navigates to project history emails tab */}
        <div className="px-3 py-2 border-t bg-muted/30 text-[10px] text-muted-foreground text-center">
          Click the card to open project • go to History → Emails
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

export default function KanbanBoard({ projects, products, packages, fitToScreen = false }) {
  const navigate = useNavigate();
  const { enabledFields } = useCardFields();
  const { data: allTasks = [] } = useEntityList("ProjectTask", "-due_date", 500);
  const { data: allTimeLogs = [] } = useEntityList("TaskTimeLog");

  // Filter out archived projects
  const activeProjects = projects.filter(p => !p.is_archived);

  // Batch fetch all shared emails for all visible projects in one query.
  // useEntityList caches this — navigating away and back is instant.
  const projectIds = activeProjects.map(p => p.id);
  const { data: allProjectEmails = [] } = useEntityList(
    "EmailMessage",
    "-received_at",
    2000,
    (e) => e.visibility === "shared" && !e.is_deleted && projectIds.includes(e.project_id)
  );

  const updateStatusMutation = useMutation({
    mutationFn: async ({ projectId, newStatus, project }) => {
      const user = await base44.auth.me();
      const oldStatus = project.status;

      const updateData = {
        status: newStatus,
        last_status_change: new Date().toISOString(),
      };
      // Set shooting_started_at once on first transition to onsite
      if (newStatus === 'onsite' && !project.shooting_started_at) {
        updateData.shooting_started_at = new Date().toISOString();
      }

      await base44.entities.Project.update(projectId, updateData);

      // Activity log — fire-and-forget
      base44.entities.ProjectActivity.create({
        project_id: projectId,
        project_title: project.title,
        action: 'status_change',
        description: `Status changed from ${oldStatus} to ${newStatus}`,
        changed_fields: [{ field: 'status', old_value: oldStatus, new_value: newStatus }],
        previous_state: project,
        new_state: { ...project, ...updateData },
        user_name: user.full_name,
        user_email: user.email,
      }).catch(err => console.warn('Activity log failed:', err?.message));

      // Stage timer — idempotent, safe to call from both frontend and automation
      base44.functions.invoke('trackProjectStageChange', {
        projectId,
        old_data: { status: oldStatus },
        data: { ...project, status: newStatus },
      }).catch(err => console.warn('trackProjectStageChange failed:', err?.message));

      // Deadline sync for trigger stages
      const triggerMap = {
        'onsite':    'project_onsite',
        'uploaded':  'project_uploaded',
        'submitted': 'project_submitted',
      };
      if (triggerMap[newStatus]) {
        scheduleDeadlineSync(projectId, triggerMap[newStatus], 500);
      }

      // Trigger onsite effort logging on any transition INTO uploaded-or-later stages
      const UPLOADED_OR_LATER = ['uploaded', 'submitted', 'in_progress', 'in_production', 'ready_for_partial', 'in_revision', 'delivered'];
      const PRE_UPLOAD = ['to_be_scheduled', 'scheduled', 'onsite', 'pending_review'];
      if (UPLOADED_OR_LATER.includes(newStatus) && PRE_UPLOAD.includes(oldStatus)) {
        base44.functions.invoke('logOnsiteEffortOnUpload', {
          project_id: projectId,
          old_status: oldStatus,
        }).catch(err => console.warn('logOnsiteEffortOnUpload failed:', err?.message));
      }
    },
    onSuccess: () => toast.success('Project status updated'),
    onError: (err) => toast.error(err?.message || "Failed to update project status"),
  });

  const [pendingDrag, setPendingDrag] = useState(null);

  const onDragEnd = (result) => {
    if (!result.destination) return;
    const projectId = result.draggableId;
    const newStatus = result.destination.droppableId;
    const project = activeProjects.find(p => p.id === projectId);
    if (!project || project.status === newStatus) return;

    const stages = PROJECT_STAGES.map(s => s.value);
    const currentIdx = stages.indexOf(project.status);
    const newIdx = stages.indexOf(newStatus);

    // Block: cannot drag OUT of pending_review (must use TonomoTab approve/reject)
    if (project.status === 'pending_review') {
      toast.error('Projects in Pending Review must be approved or rejected from the project detail page.');
      return;
    }

    // Block: cannot drag INTO pending_review
    if (newStatus === 'pending_review') {
      toast.error('Projects cannot be manually moved to Pending Review.');
      return;
    }

    // Block: cannot drag out of delivered (use "Reopen" flow instead)
    if (project.status === 'delivered') {
      toast.error('Delivered projects cannot be moved. Use the Reopen flow from the project detail page.');
      return;
    }

    // Backward moves require confirmation
    if (newIdx < currentIdx) {
      setPendingDrag({ projectId, newStatus, project });
      return;
    }

    updateStatusMutation.mutate({ projectId, newStatus, project });
  };

  const confirmBackwardDrag = () => {
    if (pendingDrag) {
      updateStatusMutation.mutate(pendingDrag);
      setPendingDrag(null);
    }
  };

  return (
    <DragDropContext onDragEnd={onDragEnd}>
      <div className={`flex gap-2 pb-2 ${fitToScreen ? "overflow-x-hidden" : "overflow-x-auto"}`}>
        {statusColumns.map(column => {
          const columnProjects = activeProjects.filter(p => p.status === column.id);
          
          // Calculate column metrics
          const columnRevenue = columnProjects.reduce((sum, p) => sum + (p.calculated_price || p.price || 0), 0);
          const columnTasks = allTasks.filter(t => 
            columnProjects.some(p => p.id === t.project_id) && !t.parent_task_id && !t.is_deleted
          );
          const tasksDone = columnTasks.filter(t => t.is_completed).length;
          const tasksInProgress = columnTasks.filter(t => !t.is_completed && !t.is_blocked).length;
          const tasksOverdue = columnTasks.filter(t => {
            if (t.is_completed || !t.due_date) return false;
            return new Date(t.due_date) < new Date();
          }).length;

          return (
            <div key={column.id} className={fitToScreen ? "flex-1 min-w-0" : "flex-shrink-0 w-80"}>
              {/* Column Header */}
              <div className={`${column.color} px-3 py-2.5 rounded-t-md shadow-sm`}>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold text-sm truncate" title={`${column.label} (${columnProjects.length} projects)`}>{column.label}</h3>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    columnProjects.length > 10
                      ? 'bg-red-100 text-red-700'
                      : columnProjects.length > 6
                      ? 'bg-amber-100 text-amber-700'
                      : 'bg-white/40 text-foreground'
                  }`}>
                    {columnProjects.length}
                  </span>
                </div>
                <div className="text-[10px] text-white/60 font-medium">
                  Last synced {new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}
                </div>
                
                {/* Column Metrics */}
                <div className="grid grid-cols-2 gap-1.5 mt-2">
                  {/* Revenue */}
                  <HoverCard openDelay={200}>
                    <HoverCardTrigger asChild>
                      <div className="flex items-center gap-1 text-xs bg-white/30 backdrop-blur-sm rounded px-2 py-1 cursor-help hover:bg-white/40 transition-colors shadow-sm">
                        <DollarSign className="h-3 w-3 flex-shrink-0" />
                        <span className="font-bold tabular-nums">
                          {columnRevenue >= 1000000 
                            ? `$${(columnRevenue / 1000000).toFixed(1)}M`
                            : columnRevenue >= 1000
                            ? `$${(columnRevenue / 1000).toFixed(1)}k`
                            : `$${columnRevenue.toFixed(0)}`
                          }
                        </span>
                      </div>
                    </HoverCardTrigger>
                    <HoverCardContent className="w-80 p-3" side="bottom" align="start">
                      <div className="space-y-2">
                        <h4 className="font-semibold text-xs flex items-center gap-1">
                          <DollarSign className="h-3 w-3" />
                          Revenue Breakdown
                        </h4>
                        <div className="max-h-60 overflow-y-auto space-y-1">
                          {columnProjects
                            .filter(p => (p.calculated_price || p.price || 0) > 0)
                            .sort((a, b) => (b.calculated_price || b.price || 0) - (a.calculated_price || a.price || 0))
                            .map(p => (
                              <button
                                key={p.id}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigate(createPageUrl("ProjectDetails") + "?id=" + p.id);
                                }}
                                className="flex items-center justify-between text-xs py-1 border-b border-border/50 last:border-0 w-full hover:bg-muted/50 transition-colors rounded px-1"
                              >
                                <span className="truncate flex-1 mr-2 text-left" title={p.title}>{p.title}</span>
                                <span className="font-medium text-green-700">${(p.calculated_price || p.price || 0).toLocaleString()}</span>
                              </button>
                            ))}
                        </div>
                        <div className="pt-2 border-t flex items-center justify-between font-semibold text-xs">
                          <span>Total</span>
                          <span className="text-green-700">${columnRevenue.toLocaleString()}</span>
                        </div>
                      </div>
                    </HoverCardContent>
                  </HoverCard>

                  {/* Tasks Done */}
                  <HoverCard openDelay={200}>
                    <HoverCardTrigger asChild>
                      <div className="flex items-center gap-1 text-xs bg-white/30 backdrop-blur-sm rounded px-2 py-1 cursor-help hover:bg-white/40 transition-colors shadow-sm">
                        <CheckCircle2 className="h-3 w-3 text-green-600 flex-shrink-0" />
                        <span className="font-bold tabular-nums">{tasksDone}</span>
                      </div>
                    </HoverCardTrigger>
                    <HoverCardContent className="w-80 p-3" side="bottom" align="start">
                      <div className="space-y-2">
                        <h4 className="font-semibold text-xs flex items-center gap-1 text-green-700">
                          <CheckCircle2 className="h-3 w-3" />
                          Completed Tasks ({tasksDone})
                        </h4>
                        <div className="max-h-60 overflow-y-auto space-y-1">
                          {columnTasks
                            .filter(t => t.is_completed)
                            .map(t => {
                              const proj = columnProjects.find(p => p.id === t.project_id);
                              return (
                                <button
                                  key={t.id}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    navigate(createPageUrl("ProjectDetails") + "?id=" + t.project_id);
                                  }}
                                  className="text-xs py-1 border-b border-border/50 last:border-0 w-full text-left hover:bg-muted/50 transition-colors rounded px-1"
                                >
                                  <div className="font-medium truncate" title={t.title}>{t.title}</div>
                                  <div className="text-muted-foreground text-[10px] truncate" title={proj?.title}>{proj?.title}</div>
                                </button>
                              );
                            })}
                        </div>
                      </div>
                    </HoverCardContent>
                  </HoverCard>

                  {/* Tasks In Progress */}
                  <HoverCard openDelay={200}>
                    <HoverCardTrigger asChild>
                      <div className="flex items-center gap-1 text-xs bg-white/30 backdrop-blur-sm rounded px-2 py-1 cursor-help hover:bg-white/40 transition-colors shadow-sm">
                        <Clock className="h-3 w-3 text-blue-600 flex-shrink-0" />
                        <span className="font-bold tabular-nums">{tasksInProgress}</span>
                      </div>
                    </HoverCardTrigger>
                    <HoverCardContent className="w-80 p-3" side="bottom" align="start">
                      <div className="space-y-2">
                        <h4 className="font-semibold text-xs flex items-center gap-1 text-blue-700">
                          <Clock className="h-3 w-3" />
                          In Progress Tasks ({tasksInProgress})
                        </h4>
                        <div className="max-h-60 overflow-y-auto space-y-1">
                          {columnTasks
                            .filter(t => !t.is_completed && !t.is_blocked)
                            .map(t => {
                              const proj = columnProjects.find(p => p.id === t.project_id);
                              return (
                                <button
                                  key={t.id}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    navigate(createPageUrl("ProjectDetails") + "?id=" + t.project_id);
                                  }}
                                  className="text-xs py-1 border-b border-border/50 last:border-0 w-full text-left hover:bg-muted/50 transition-colors rounded px-1"
                                >
                                  <div className="font-medium truncate" title={t.title}>{t.title}</div>
                                  <div className="text-muted-foreground text-[10px] truncate" title={proj?.title}>{proj?.title}</div>
                                </button>
                              );
                            })}
                        </div>
                      </div>
                    </HoverCardContent>
                  </HoverCard>

                  {/* Tasks Overdue */}
                  <HoverCard openDelay={200}>
                    <HoverCardTrigger asChild>
                      <div className="flex items-center gap-1 text-xs bg-white/30 backdrop-blur-sm rounded px-2 py-1 cursor-help hover:bg-white/40 transition-colors shadow-sm">
                        <AlertCircle className="h-3 w-3 text-red-600 flex-shrink-0" />
                        <span className="font-bold tabular-nums">{tasksOverdue}</span>
                      </div>
                    </HoverCardTrigger>
                    <HoverCardContent className="w-80 p-3" side="bottom" align="start">
                      <div className="space-y-2">
                        <h4 className="font-semibold text-xs flex items-center gap-1 text-red-700">
                          <AlertCircle className="h-3 w-3" />
                          Overdue Tasks ({tasksOverdue})
                        </h4>
                        <div className="max-h-60 overflow-y-auto space-y-1">
                          {columnTasks
                            .filter(t => {
                              if (t.is_completed || !t.due_date) return false;
                              return new Date(t.due_date) < new Date();
                            })
                            .sort((a, b) => new Date(a.due_date) - new Date(b.due_date))
                            .map(t => {
                              const proj = columnProjects.find(p => p.id === t.project_id);
                              const dueDate = new Date(t.due_date);
                              return (
                                <button
                                  key={t.id}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    navigate(createPageUrl("ProjectDetails") + "?id=" + t.project_id);
                                  }}
                                  className="text-xs py-1 border-b border-border/50 last:border-0 w-full text-left hover:bg-muted/50 transition-colors rounded px-1"
                                >
                                  <div className="font-medium truncate" title={t.title}>{t.title}</div>
                                  <div className="flex items-center justify-between text-[10px] text-muted-foreground mt-0.5">
                                    <span className="truncate" title={proj?.title}>{proj?.title}</span>
                                    <span className="text-red-600 font-medium ml-2">{dueDate.toLocaleDateString()}</span>
                                  </div>
                                </button>
                              );
                            })}
                        </div>
                      </div>
                    </HoverCardContent>
                  </HoverCard>
                </div>
              </div>

              {/* Cards Container */}
              <Droppable droppableId={column.id}>
                {(provided, snapshot) => (
                  <div
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    className={`min-h-[400px] p-2 space-y-2 transition-all duration-200 ${
                      snapshot.isDraggingOver ? "bg-primary/10 ring-2 ring-primary/20 scale-[1.02]" : "bg-muted/15"
                    } rounded-b-md relative`}
                  >
                    {columnProjects.length === 0 && !snapshot.isDraggingOver && (
                      <div className="absolute inset-0 flex items-center justify-center text-muted-foreground/40 text-xs font-medium pointer-events-none">
                        Drag projects here
                      </div>
                    )}
                    {(() => {
                      const renderCard = (project, index) => {
                      const projectTasks = allTasks.filter(
                        t => t.project_id === project.id && !t.parent_task_id
                      );
                      const projectTimeLogs = allTimeLogs.filter(l => l.project_id === project.id);

                      return (
                        <Draggable key={project.id} draggableId={project.id} index={index}>
                          {(provided, snapshot) => (
                            <Card
                              ref={provided.innerRef}
                              {...provided.draggableProps}
                              {...provided.dragHandleProps}
                              className={`cursor-pointer hover:shadow-lg transition-all duration-200 border-0 group/card active:scale-[0.98] ${
                                snapshot.isDragging ? "shadow-2xl ring-4 ring-primary/50 scale-105 rotate-2 opacity-90" : ""
                              }`}
                              onClick={() => navigate(createPageUrl("ProjectDetails") + "?id=" + project.id)}
                            >
                              {/* Card Header */}
                              <div className="px-3 py-2 border-b border-border/50">
                                <h4 className="font-semibold truncate text-xs leading-tight group-hover/card:text-primary transition-colors" title={project.title}>{project.title}</h4>
                                <p className="text-xs text-muted-foreground truncate mt-0.5" title={project.property_address}>{project.property_address}</p>
                              </div>

                              {/* Card Content */}
                              <div className="px-3 pb-2">
                                <div className="scale-90 origin-top-left">
                                  <ProjectCardFields
                                    project={project}
                                    enabledFields={enabledFields}
                                    products={products}
                                    packages={packages}
                                    tasks={projectTasks}
                                    timeLogs={projectTimeLogs}
                                  />
                                </div>

                                {/* Shoot date with color coding */}
                                {project.shoot_date && (
                                  <div className={`flex items-center gap-1 text-[10px] mt-1 flex-wrap ${
                                    (() => {
                                      const d = new Date(project.shoot_date);
                                      const today = new Date();
                                      today.setHours(0, 0, 0, 0);
                                      if (d < today) return 'text-red-500 font-semibold';
                                      if (d.getTime() === today.getTime()) return 'text-amber-600 font-semibold';
                                      if (d.getTime() === new Date(today.getTime() + 86400000).getTime()) return 'text-blue-600';
                                      return 'text-muted-foreground';
                                    })()
                                  }`}>
                                    <Calendar className="h-3 w-3" />
                                    {(() => {
                                      const d = new Date(project.shoot_date);
                                      const today = new Date();
                                      today.setHours(0, 0, 0, 0);
                                      const diff = Math.floor((d - today) / 86400000);
                                      if (diff === 0) return 'Today';
                                      if (diff === 1) return 'Tomorrow';
                                      if (diff === -1) return 'Yesterday';
                                      if (diff < 0) return `${Math.abs(diff)}d ago`;
                                      if (diff < 7) return d.toLocaleDateString('en-AU', { weekday: 'short' });
                                      return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
                                    })()}
                                    {project.tonomo_is_twilight && (
                                      <span className="text-purple-500" title="Twilight">🌅</span>
                                    )}
                                  </div>
                                )}

                                {/* Pricing tier & overdue chips */}
                                <div className="flex items-center gap-1 flex-wrap mt-1">
                                  {project.pricing_tier === 'premium' && (
                                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-100
                                                     text-amber-700 border border-amber-200 font-medium">
                                      Premium
                                    </span>
                                  )}
                                  {project.shoot_date && new Date(project.shoot_date) < new Date() &&
                                   !['delivered', 'in_revision', 'cancelled'].includes(project.status) && (
                                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-red-100
                                                     text-red-700 border border-red-200 font-medium animate-pulse">
                                      Overdue
                                    </span>
                                  )}
                                </div>

                                {/* Email indicator — pre-filtered emails passed from batch query */}
                                <div className="flex items-center justify-end mt-1.5">
                                  <ProjectEmailIndicator
                                    emails={allProjectEmails.filter(e => e.project_id === project.id)}
                                  />
                                </div>
                              </div>
                            </Card>
                          )}
                        </Draggable>
                      );
                      };

                      // Twilight lane in scheduled column
                      if (column.id === 'scheduled' && columnProjects.some(p => p.tonomo_is_twilight)) {
                      return (
                        <>
                          {columnProjects.filter(p => !p.tonomo_is_twilight).map((p, i) => renderCard(p, i))}
                          {columnProjects.some(p => p.tonomo_is_twilight) && (
                            <div className="flex items-center gap-2 my-2">
                              <div className="flex-1 h-px bg-purple-200" />
                              <span className="text-[9px] text-purple-500 font-medium flex-shrink-0">
                                🌅 Twilight
                              </span>
                              <div className="flex-1 h-px bg-purple-200" />
                            </div>
                          )}
                          {columnProjects.filter(p => p.tonomo_is_twilight).map((p, i) => renderCard(p, i + columnProjects.filter(tp => !tp.tonomo_is_twilight).length))}
                        </>
                      );
                      }

                      return columnProjects.map((p, i) => renderCard(p, i));
                      })()}
                    {provided.placeholder}
                  </div>
                )}
              </Droppable>
            </div>
          );
        })}
      </div>

      {/* Backward drag confirmation */}
      {pendingDrag && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setPendingDrag(null)}>
          <div className="bg-white rounded-lg p-6 max-w-sm shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold text-base mb-2">Move Project Backward?</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Moving <strong>{pendingDrag.project?.title || 'this project'}</strong> from{' '}
              <strong>{PROJECT_STAGES.find(s => s.value === pendingDrag.project?.status)?.label}</strong> back to{' '}
              <strong>{PROJECT_STAGES.find(s => s.value === pendingDrag.newStatus)?.label}</strong>.
              Stage timer history is preserved.
            </p>
            <div className="flex gap-2 justify-end">
              <button className="px-3 py-1.5 text-sm border rounded hover:bg-muted" onClick={() => setPendingDrag(null)}>Cancel</button>
              <button className="px-3 py-1.5 text-sm bg-orange-600 text-white rounded hover:bg-orange-700" onClick={confirmBackwardDrag}>Move Backward</button>
            </div>
          </div>
        </div>
      )}
    </DragDropContext>
  );
}