import React, { useState, useEffect } from "react";
import { api } from "@/api/supabaseClient";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { isTransientError } from "@/lib/networkResilience";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarIcon, Layers, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { wallClockToUTC, calculatePresetDeadline, APP_TIMEZONE } from "@/components/lib/deadlinePresets";
import { getSydneyHourMinute, utcToSydneyInput } from "@/components/utils/dateUtils";
import { calculateConstrainedTaskDeadline } from "@/components/lib/revisionTaskDeadlineValidator";
import RevisionPricingImpact from "./RevisionPricingImpact";
import RevisionAttachments from "./RevisionAttachments";
import { createNotificationsForUsers } from "@/components/notifications/createNotification";

const REVISION_TYPES = {
  images: { label: "📷 Images", color: "bg-blue-100 text-blue-700 border-blue-200" },
  drones: { label: "🚁 Drones", color: "bg-sky-100 text-sky-700 border-sky-200" },
  floorplan: { label: "📐 Floorplan", color: "bg-amber-100 text-amber-700 border-amber-200" },
  video: { label: "🎬 Video", color: "bg-purple-100 text-purple-700 border-purple-200" },
};

const REQUEST_KINDS = [
  { value: "revision", label: "Revision", description: "Re-do or touch up existing deliverables", color: "border-red-300 bg-red-50 text-red-700" },
  { value: "change_request", label: "Change Request", description: "New scope or changes to what was agreed", color: "border-purple-300 bg-purple-50 text-purple-700" },
];

const emptyManualTask = () => ({ title: "", description: "", task_type: "back_office" });

export default function CreateRevisionDialog({ open, onClose, project, existingRevisions = [], logActivity }) {
  const queryClient = useQueryClient();
  const [requestKind, setRequestKind] = useState("revision");
  const [revisionType, setRevisionType] = useState("images");
  const [selectedTemplateId, setSelectedTemplateId] = useState("none");
  const [form, setForm] = useState({ title: "", description: "", priority: "normal", due_date: null });
  const [manualTasks, setManualTasks] = useState([]);
  const [attachments, setAttachments] = useState([]);
  const [pricingImpact, setPricingImpact] = useState({ has_impact: false, products_added: [], products_removed: [], quantity_changes: [] });

  const { data: templates = [] } = useEntityList("RevisionTemplate", "name", 200, { is_active: true });
  const { data: users = [] } = useEntityList("User", null, 500);
  const { data: teams = [] } = useEntityList("InternalTeam", null, 200, { is_active: true });
  const { data: allProducts = [] } = useEntityList("Product", "name", 500);

  const filteredTemplates = templates.filter(t => t.revision_type === revisionType && (t.request_kind === requestKind || !t.request_kind));
  const selectedTemplate = filteredTemplates.find(t => t.id === selectedTemplateId);

  useEffect(() => {
    if (open) {
      setRequestKind("revision");
      setRevisionType("images");
      setSelectedTemplateId("none");
      setForm({ title: "", description: "", priority: "normal", due_date: null });
      setManualTasks([]);
      setAttachments([]);
      setPricingImpact({ has_impact: false, products_added: [], products_removed: [], quantity_changes: [] });
    }
  }, [open]);

  useEffect(() => {
    setSelectedTemplateId("none");
  }, [revisionType, requestKind]);

  const addManualTask = () => setManualTasks(p => [...p, emptyManualTask()]);
  const removeManualTask = (i) => setManualTasks(p => p.filter((_, idx) => idx !== i));
  const updateManualTask = (i, field, value) => setManualTasks(p => {
    const next = [...p];
    next[i] = { ...next[i], [field]: value };
    return next;
  });
  // Batch update multiple fields at once to avoid stale-state overwrites
  const updateManualTaskBatch = (i, fields) => setManualTasks(p => {
    const next = [...p];
    next[i] = { ...next[i], ...fields };
    return next;
  });

  const createMutation = useMutation({
    retry: (failureCount, error) => failureCount < 2 && isTransientError(error),
    retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 4000),
    mutationFn: async (data) => {
      const allRevisions = await api.entities.ProjectRevision.filter(
        { project_id: project.id },
        null,
        500
      ).catch(() => existingRevisions);
      // Count only non-cancelled revisions for sequential display numbering
      const activeRevCount = allRevisions.filter(
        (r) => r.status !== 'cancelled'
      ).length;
      const revNum = activeRevCount + 1;
      const user = await api.auth.me().catch(() => null);

      const revision = await api.entities.ProjectRevision.create({
        project_id: project.id,
        project_title: project.title,
        revision_number: revNum,
        request_kind: requestKind,
        revision_type: revisionType,
        template_id: selectedTemplate?.id || null,
        template_name: selectedTemplate?.name || null,
        title: data.title,
        description: data.description,
        priority: data.priority,
        due_date: data.due_date,
        attachments: data.attachments || [],
        status: "identified",
        requested_by_id: user?.id || null,
        requested_by_name: user?.full_name || user?.email || null,
        requested_date: new Date().toISOString(),
        pricing_impact: data.pricingImpact?.has_impact ? {
          ...data.pricingImpact,
          applied: false,
        } : null,
      });

      // Auto-create tasks from template with deadline constraint
      const createdTaskIds = [];
      let taskIndex = 0;
      const now = new Date();

      if (selectedTemplate?.task_templates?.length > 0) {
        for (let i = 0; i < selectedTemplate.task_templates.length; i++) {
          const tmpl = selectedTemplate.task_templates[i];
          const depIds = (tmpl.depends_on_indices || []).map(depIdx => createdTaskIds[depIdx]).filter(Boolean);

          const assignData = {};
          if (tmpl.auto_assign_role && tmpl.auto_assign_role !== "none") {
            const roleFieldMap = {
              project_owner: { id: "project_owner_id", name: "project_owner_name" },
              photographer: { id: "onsite_staff_1_id", name: "onsite_staff_1_name" },
              videographer: { id: "onsite_staff_2_id", name: "onsite_staff_2_name" },
              image_editor: { id: "image_editor_id", name: "image_editor_name" },
              video_editor: { id: "video_editor_id", name: "video_editor_name" },
              floorplan_editor: { id: "floorplan_editor_id", name: "floorplan_editor_name" },
              drone_editor: { id: "drone_editor_id", name: "drone_editor_name" },
            };
            const fields = roleFieldMap[tmpl.auto_assign_role];
            if (fields && project[fields.id]) {
              assignData.assigned_to = project[fields.id];
              assignData.assigned_to_name = project[fields.name] || "";
              assignData.assigned_to_type = "user";
            }
          }

          // Calculate task due date, respecting request constraint
          let taskDueDate = null;
          if (tmpl.deadline_type === 'preset' && tmpl.deadline_preset) {
            const constrainedResult = calculateConstrainedTaskDeadline(tmpl, now, data.due_date, APP_TIMEZONE);
            taskDueDate = constrainedResult.constrained;
          } else if (tmpl.deadline_type === 'custom' && tmpl.deadline_hours_after_trigger) {
            const calculated = new Date(now.getTime() + tmpl.deadline_hours_after_trigger * 3600000);
            // Clamp to request due_date if present
            if (data.due_date && calculated.getTime() > new Date(data.due_date).getTime()) {
              taskDueDate = data.due_date;
            } else {
              taskDueDate = calculated.toISOString();
            }
          }

          const task = await api.entities.ProjectTask.create({
            project_id: project.id,
            title: `[Revision #${revNum}] ${tmpl.title}`,
            description: tmpl.description || "",
            task_type: tmpl.task_type || "back_office",
            auto_assign_role: tmpl.auto_assign_role || "none",
            estimated_minutes: tmpl.estimated_minutes || 0,
            timer_trigger: tmpl.timer_trigger || "none",
            deadline_type: tmpl.deadline_type || "custom",
            deadline_preset: tmpl.deadline_preset || "",
            deadline_hours_after_trigger: tmpl.deadline_hours_after_trigger || 0,
            due_date: taskDueDate,
            depends_on_task_ids: depIds,
            is_completed: false,
            is_blocked: depIds.length > 0,
            auto_generated: true,
            order: 1000 + taskIndex++,
            ...assignData,
          });
          createdTaskIds.push(task.id);
        }
      }

      // Create manual tasks
      for (const mt of data.manualTasks) {
        if (!mt.title?.trim()) continue;
        const assignData = {};
          if (mt.assigned_to_team_id) {
            assignData.assigned_to_team_id = mt.assigned_to_team_id;
            assignData.assigned_to_team_name = mt.assigned_to_team_name || "";
            assignData.assigned_to_type = "team";
          } else if (mt.assigned_to) {
            assignData.assigned_to = mt.assigned_to;
            assignData.assigned_to_name = mt.assigned_to_name || "";
            assignData.assigned_to_type = "user";
          }
        const manualTaskDueDate = (() => {
          if (data.due_date) {
            return data.due_date;
          }
          return null;
        })();

        await api.entities.ProjectTask.create({
          project_id: project.id,
          title: `[Revision #${revNum}] ${mt.title}`,
          description: mt.description || "",
          task_type: mt.task_type || "back_office",
          is_completed: false,
          is_blocked: false,
          due_date: manualTaskDueDate,
          order: 1000 + taskIndex++,
          ...assignData,
        });
      }

      if (createdTaskIds.length > 0 || data.manualTasks.some(t => t.title?.trim())) {
        api.functions.invoke('calculateProjectTaskDeadlines', {
          project_id: project.id,
          trigger_event: 'task_update'
        }).catch(() => {});
      }

      // Log to TeamActivityFeed
      api.entities.TeamActivityFeed.create({
        event_type: 'revision_created',
        category: 'requests',
        severity: 'info',
        actor_id: user?.id || null,
        actor_name: user?.full_name || user?.email || 'System',
        title: `New ${requestKind === 'change_request' ? 'Change Request' : 'Revision'}: ${data.title}`,
        description: `Created ${requestKind === 'change_request' ? 'change request' : 'revision'} #${revNum} for ${project.title || project.property_address}`,
        project_id: project.id,
        project_name: project.title || project.property_address,
        project_address: project.property_address,
        project_stage: project.status,
        entity_type: 'revision',
        entity_id: revision.id,
        metadata: JSON.stringify({ 
          revision_number: revNum, 
          request_kind: requestKind,
          revision_type: revisionType 
        }),
      }).catch(err => console.warn('Failed to log to TeamActivityFeed:', err));

      return revision;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['project-revisions'] });
      queryClient.invalidateQueries({ queryKey: ['project-tasks'] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      refetchEntityList("ProjectRevision");
      refetchEntityList("ProjectTask");
      refetchEntityList("Project");
      const revNum = data.revision_number;
      logActivity?.('request_created',
        `${requestKind === 'change_request' ? 'Change request' : 'Revision'} #${revNum} created: "${data.title}"`
      );
      toast.success("Request created");
      refetchEntityList("ProjectRevision");
      refetchEntityList("ProjectTask");

      // Notify image/video editors and project owner about the new request
      try {
        const recipientIds = [
          project.image_editor_id,
          project.video_editor_id,
          project.project_owner_id,
        ].filter(Boolean);

        const isUrgent = data.priority === 'urgent' || data.is_urgent;
        const isChangeRequest = requestKind === 'change_request';

        createNotificationsForUsers(recipientIds, {
          type: isUrgent ? 'revision_urgent' : (isChangeRequest ? 'change_request_created' : 'revision_created'),
          title: isUrgent
            ? `🚨 Urgent request: "${data.title}"`
            : `New ${isChangeRequest ? 'change request' : 'revision'} #${revNum}: "${data.title}"`,
          message: `${project.title || project.property_address} — ${isChangeRequest ? 'Change request' : 'Revision'} #${revNum} requires attention`,
          projectId: project.id,
          projectName: project.title || project.property_address,
          entityType: 'revision',
          entityId: data.id,
          ctaUrl: 'ProjectDetails',
          ctaParams: { id: project.id },
          sourceUserId: null, // client-originated, no source user
          idempotencyKey: `revision_created:${data.id}`,
        }, null).catch(() => { /* non-critical */ });
      } catch { /* non-critical */ }

      onClose(true); // pass true to indicate a revision was created
    },
    onError: (e) => {
      const hint = isTransientError(e) ? ' — check your connection and try again' : '';
      toast.error((e.message || "Failed to create request") + hint);
    },
  });

  const handleSubmit = () => {
    if (!form.title?.trim()) {
      toast.error("Request title is required");
      return;
    }
    if (!revisionType) {
      toast.error("Media type is required");
      return;
    }
    if (selectedTemplateId !== 'none' && !selectedTemplate) {
      toast.error('Selected template no longer exists. Please choose another.');
      return;
    }
    // Enforce minimum tasks: at least 1 from template or manually added
    const hasTemplateTasks = (selectedTemplate?.task_templates?.length ?? 0) > 0;
    const hasManualTasks = manualTasks.some(t => t.title?.trim());
    if (!hasTemplateTasks && !hasManualTasks) {
      toast.error("Add at least 1 task to the request");
      return;
    }
    createMutation.mutate({ ...form, manualTasks, attachments, pricingImpact });
  };

  return (
    <Dialog open={open} onOpenChange={o => { if (!o && !createMutation.isPending) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Request</DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Create a revision or change request for this project. Tasks are automatically assigned to the relevant team members.
          </p>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Request Kind */}
          <div>
            <label className="text-xs font-medium block mb-2">Request Kind <span className="text-destructive">*</span></label>
            <div className="grid grid-cols-2 gap-2">
              {REQUEST_KINDS.map(k => (
                <button
                  key={k.value}
                  onClick={() => setRequestKind(k.value)}
                  className={`py-2.5 px-3 rounded-lg border text-xs font-medium transition-all text-left ${
                    requestKind === k.value ? k.color + " border-current" : "border-border text-muted-foreground hover:bg-muted/50"
                  }`}
                >
                  <p className="font-semibold">{k.label}</p>
                  <p className="text-xs opacity-75 mt-0.5">{k.description}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Revision Type */}
          <div>
            <label className="text-xs font-medium block mb-2">Media Type <span className="text-destructive">*</span></label>
            <div className="grid grid-cols-4 gap-2">
              {Object.entries(REVISION_TYPES).map(([key, meta]) => (
                <button
                  key={key}
                  onClick={() => setRevisionType(key)}
                  className={`py-2 px-2 rounded-lg border text-xs font-medium transition-all ${
                    revisionType === key
                      ? `${meta.color} border-current`
                      : "border-border text-muted-foreground hover:bg-muted/50"
                  }`}
                >
                  {meta.label}
                </button>
              ))}
            </div>
          </div>

          {/* Template Selection */}
          <div>
            <label className="text-xs font-medium block mb-1.5">
              <Layers className="h-3.5 w-3.5 inline mr-1" />
              Template (optional)
            </label>
            {filteredTemplates.length === 0 ? (
              <p className="text-xs text-muted-foreground border rounded-lg p-3 bg-muted/20">
                No templates available for this combination.
                <a href="/SettingsRevisionTemplates" className="underline ml-1 hover:text-primary">Set up templates</a>.
              </p>
            ) : (
              <Select value={selectedTemplateId || "none"} onValueChange={(val) => setSelectedTemplateId(val)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a template..." />
                </SelectTrigger>
                <SelectContent className="z-50">
                  <SelectItem value="none">No template (manual)</SelectItem>
                  {filteredTemplates.map(t => (
                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {selectedTemplateId !== "none" && selectedTemplate && (
              <div className="mt-2 p-2.5 bg-muted/40 rounded-lg border text-xs space-y-1">
                {selectedTemplate.description && <p className="text-muted-foreground">{selectedTemplate.description}</p>}
                <p className="font-medium">Will auto-create {selectedTemplate.task_templates?.length || 0} task{selectedTemplate.task_templates?.length !== 1 ? "s" : ""}:</p>
                <ul className="space-y-0.5 ml-2 max-h-32 overflow-y-auto">
                    {(selectedTemplate.task_templates || []).slice(0, 5).map((t, i) => (
                      <li key={i} className="text-muted-foreground text-xs truncate">• {t.title}</li>
                    ))}
                    {selectedTemplate.task_templates?.length > 5 && (
                      <li className="text-xs text-primary font-medium">+ {selectedTemplate.task_templates.length - 5} more tasks</li>
                    )}
                  </ul>
              </div>
            )}
          </div>

          {/* Title */}
          <div>
            <label className="text-xs font-medium block mb-1.5">Title <span className="text-destructive">*</span></label>
            <Input
              placeholder="e.g. Touch up kitchen photos"
              value={form.title}
              onChange={e => setForm(p => ({ ...p, title: e.target.value }))}
              className={form.title?.trim() === "" ? "border-red-200 bg-red-50/20" : ""}
              disabled={createMutation.isPending}
            />
            {form.title?.trim() === "" && <p className="text-xs text-destructive mt-0.5">Title is required</p>}
          </div>

          {/* Description */}
          <div>
            <label className="text-xs font-medium block mb-1.5">Details {!form.description?.trim() && <span className="text-xs text-amber-600">(recommended)</span>}</label>
            <Textarea
              placeholder="Describe what changes are needed..."
              value={form.description || ""}
              onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
              rows={3}
              className={!form.description?.trim() ? "border-amber-200 bg-amber-50/20" : ""}
              disabled={createMutation.isPending}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* Priority */}
            <div>
              <label className="text-xs font-medium block mb-1.5">Priority</label>
              <Select value={form.priority} onValueChange={v => setForm(p => ({ ...p, priority: v }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Due Date with Time */}
              <div>
                <label className="text-xs font-medium block mb-1.5">Due Date & Time</label>
                <div className="space-y-2">
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" className="w-full justify-start text-left h-9 text-sm">
                        <CalendarIcon className="h-4 w-4 mr-2 text-muted-foreground" />
                        {form.due_date
                          ? new Date(form.due_date).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })
                          : "Pick date"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={form.due_date ? new Date(form.due_date) : undefined}
                        onSelect={date => {
                          if (!date) { setForm(p => ({ ...p, due_date: null })); return; }
                          const utc = wallClockToUTC(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 0, "Australia/Sydney");
                          setForm(p => ({ ...p, due_date: utc.toISOString() }));
                        }}
                      />
                    </PopoverContent>
                  </Popover>
                  {form.due_date && (
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="text-xs text-muted-foreground block mb-1">Hour (0-23)</label>
                              <Input
                                type="number"
                                min="0"
                                max="23"
                                value={String(getSydneyHourMinute(form.due_date).hour).padStart(2, "0")}
                                onChange={e => {
                                  const sydParts = utcToSydneyInput(form.due_date).split(/[-T:]/);
                                  const h = Math.max(0, Math.min(23, parseInt(e.target.value, 10) || 0));
                                  const utc = wallClockToUTC(+sydParts[0], +sydParts[1] - 1, +sydParts[2], h, +sydParts[4], 0, "Australia/Sydney");
                                  setForm(p => ({ ...p, due_date: utc.toISOString() }));
                                }}
                                className="h-8 text-sm text-center"
                              />
                            </div>
                            <div>
                              <label className="text-xs text-muted-foreground block mb-1">Minute (0-59)</label>
                              <Input
                                type="number"
                                min="0"
                                max="59"
                                value={String(getSydneyHourMinute(form.due_date).minute).padStart(2, "0")}
                                onChange={e => {
                                  const sydParts = utcToSydneyInput(form.due_date).split(/[-T:]/);
                                  const m = Math.max(0, Math.min(59, parseInt(e.target.value, 10) || 0));
                                  const utc = wallClockToUTC(+sydParts[0], +sydParts[1] - 1, +sydParts[2], +sydParts[3], m, 0, "Australia/Sydney");
                                  setForm(p => ({ ...p, due_date: utc.toISOString() }));
                                }}
                                className="h-8 text-sm text-center"
                              />
                            </div>
                          </div>
                        )}
                </div>
              </div>
          </div>
          {/* Pricing Impact — moved before attachments for visibility */}
          <div className="p-3 rounded-lg border border-amber-200 bg-amber-50/50">
            <RevisionPricingImpact
              pricingImpact={pricingImpact}
              onChange={setPricingImpact}
              project={project}
              allProducts={allProducts}
            />
          </div>

          {/* Attachments */}
          <RevisionAttachments attachments={attachments} onChange={setAttachments} />

          {/* Manual Tasks */}
          <div className={pricingImpact.has_impact || selectedTemplate?.task_templates?.length ? "pt-2 border-t" : ""}>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold">Additional Tasks (optional)</label>
              <Button size="sm" variant="outline" onClick={addManualTask}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Add Task
              </Button>
            </div>
            {manualTasks.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No additional tasks. Use "Add Task" to include tasks beyond those in the template.</p>
            ) : (
              <div className="space-y-3">
                {manualTasks.map((task, i) => (
                  <div key={i} className="border rounded-lg p-3 space-y-2 bg-muted/20">
                    <div className="flex items-center gap-2">
                      <Input
                        placeholder="Task title *"
                        value={task.title}
                        onChange={e => updateManualTask(i, "title", e.target.value)}
                        className="h-8 text-sm flex-1"
                      />
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-destructive hover:text-destructive flex-shrink-0" onClick={() => removeManualTask(i)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <Input
                      placeholder="Description (optional)"
                      value={task.description || ""}
                      onChange={e => updateManualTask(i, "description", e.target.value)}
                      className="h-8 text-sm"
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs text-muted-foreground block mb-1">Task Type</label>
                        <p className="text-xs text-muted-foreground mb-1 italic">Office work or on location?</p>
                        <Select value={task.task_type} onValueChange={v => updateManualTask(i, "task_type", v)}>
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="back_office">🏢 Back Office — editing, admin work</SelectItem>
                            <SelectItem value="onsite">📍 Onsite — field work, location visit</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground block mb-1">Assign To</label>
                        <p className="text-xs text-muted-foreground mb-1.5 italic">Person or team responsible</p>
                        <Select
                          value={task.assigned_to_team_id ? `team:${task.assigned_to_team_id}` : task.assigned_to ? `user:${task.assigned_to}` : "none"}
                          onValueChange={v => {
                            if (v === "none") {
                              updateManualTaskBatch(i, {
                                assigned_to: "", assigned_to_name: "",
                                assigned_to_team_id: "", assigned_to_team_name: ""
                              });
                            } else {
                              const [type, id] = v.split(":");
                              if (type === "user") {
                                const u = users.find(u => u.id === id);
                                updateManualTaskBatch(i, {
                                  assigned_to: id, assigned_to_name: u?.full_name || "",
                                  assigned_to_team_id: "", assigned_to_team_name: ""
                                });
                              } else {
                                const t = teams.find(t => t.id === id);
                                updateManualTaskBatch(i, {
                                  assigned_to_team_id: id, assigned_to_team_name: t?.name || "",
                                  assigned_to: "", assigned_to_name: ""
                                });
                              }
                            }
                          }}
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue placeholder="Unassigned" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">Unassigned</SelectItem>
                            {users.length > 0 && <>
                              <div className="px-2 py-1 text-xs font-semibold text-muted-foreground bg-muted">👤 Individual</div>
                              {users.map(u => <SelectItem key={u.id} value={`user:${u.id}`}>{u.full_name}</SelectItem>)}
                            </>}
                            {teams.length > 0 && <>
                              <div className="px-2 py-1 text-xs font-semibold text-muted-foreground bg-muted">👥 Team</div>
                              {teams.map(t => <SelectItem key={t.id} value={`team:${t.id}`}>{t.name}</SelectItem>)}
                            </>}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={createMutation.isPending}>Cancel</Button>
            <Button 
              disabled={!form.title?.trim() || createMutation.isPending} 
              onClick={handleSubmit}
              title={!form.title?.trim() ? "A title is required to create a request" : ""}
            >
              {createMutation.isPending ? (
                <>
                  <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-current mr-2" />
                  Creating...
                </>
              ) : requestKind === "change_request" ? "Submit Change Request" : "Submit Revision Request"}
            </Button>
          </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}