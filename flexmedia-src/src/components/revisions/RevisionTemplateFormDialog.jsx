import React, { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, GripVertical, ChevronDown, ChevronUp } from "lucide-react";
import { ROLE_LABELS } from "@/components/projects/TaskManagement";

const REVISION_TYPES = {
  images: { label: "Images", color: "bg-blue-100 text-blue-700" },
  drones: { label: "Drones", color: "bg-sky-100 text-sky-700" },
  floorplan: { label: "Floorplan", color: "bg-amber-100 text-amber-700" },
  video: { label: "Video", color: "bg-purple-100 text-purple-700" },
};

const REQUEST_KINDS = [
  { value: "revision", label: "Revision" },
  { value: "change_request", label: "Change Request" },
];

const DEADLINE_PRESETS = [
  { value: "tonight", label: "Tonight" },
  { value: "tomorrow_night", label: "Tomorrow Night" },
  { value: "tomorrow_am", label: "Tomorrow AM" },
  { value: "tomorrow_business_am", label: "Tomorrow Business AM" },
  { value: "in_2_nights", label: "In 2 Nights" },
  { value: "in_3_nights", label: "In 3 Nights" },
  { value: "in_4_nights", label: "In 4 Nights" },
  { value: "next_business_night", label: "Next Business Night" },
  { value: "2_business_nights", label: "2 Business Nights" },
  { value: "3_business_nights", label: "3 Business Nights" },
];

const emptyTask = () => ({
  title: "",
  description: "",
  task_type: "back_office",
  auto_assign_role: "none",
  estimated_minutes: 0,
  depends_on_indices: [],
  timer_trigger: "none",
  deadline_type: "custom",
  deadline_preset: "",
  deadline_hours_after_trigger: 0,
});

export default function RevisionTemplateFormDialog({ open, onClose, template, onSave, isSaving }) {
  const [form, setForm] = useState({ name: "", request_kind: "revision", revision_type: "images", description: "", is_active: true, task_templates: [] });
  const [expandedTask, setExpandedTask] = useState(null);

  useEffect(() => {
    if (template) {
      setForm({ ...template, task_templates: template.task_templates || [], request_kind: template.request_kind || "revision" });
    } else {
      setForm({ name: "", request_kind: "revision", revision_type: "images", description: "", is_active: true, task_templates: [] });
    }
    setExpandedTask(null);
  }, [template, open]);

  const updateTask = (idx, field, value) => {
    setForm(prev => {
      const tasks = [...prev.task_templates];
      tasks[idx] = { ...tasks[idx], [field]: value };
      return { ...prev, task_templates: tasks };
    });
  };

  const addTask = () => {
    setForm(prev => ({ ...prev, task_templates: [...prev.task_templates, emptyTask()] }));
    setExpandedTask(form.task_templates.length);
  };

  const removeTask = (idx) => {
    setForm(prev => {
      const tasks = prev.task_templates.filter((_, i) => i !== idx);
      return { ...prev, task_templates: tasks };
    });
    if (expandedTask === idx) setExpandedTask(null);
  };

  const moveTask = (idx, dir) => {
    setForm(prev => {
      const tasks = [...prev.task_templates];
      const swapIdx = idx + dir;
      if (swapIdx < 0 || swapIdx >= tasks.length) return prev;
      [tasks[idx], tasks[swapIdx]] = [tasks[swapIdx], tasks[idx]];
      return { ...prev, task_templates: tasks };
    });
    setExpandedTask(idx + dir);
  };

  const handleSave = () => {
    if (!form.name?.trim() || !form.revision_type || !form.request_kind) return;
    onSave(form);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{template ? "Edit Request Template" : "New Request Template"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium block mb-1.5">Template Name *</label>
              <Input
                placeholder="e.g. Image Touch-ups"
                value={form.name}
                onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium block mb-1.5">Request Kind *</label>
                <Select value={form.request_kind || "revision"} onValueChange={v => setForm(p => ({ ...p, request_kind: v }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REQUEST_KINDS.map(k => (
                      <SelectItem key={k.value} value={k.value}>{k.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs font-medium block mb-1.5">Media Type *</label>
                <Select value={form.revision_type} onValueChange={v => setForm(p => ({ ...p, revision_type: v }))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(REVISION_TYPES).map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <div>
            <label className="text-xs font-medium block mb-1.5">Description</label>
            <Textarea
              placeholder="What does this revision type cover?"
              value={form.description || ""}
              onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
              rows={2}
            />
          </div>

          {/* Task Templates */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold">Task Templates ({form.task_templates.length})</label>
              <Button size="sm" variant="outline" onClick={addTask}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Add Task
              </Button>
            </div>

            <div className="space-y-2">
              {form.task_templates.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-6 border rounded-lg border-dashed">
                  No tasks yet. Add tasks to define the revision workflow.
                </p>
              )}
              {form.task_templates.map((task, idx) => (
                <div key={idx} className="border rounded-lg overflow-hidden">
                  <div
                    className="flex items-center gap-2 p-3 bg-muted/30 cursor-pointer hover:bg-muted/50"
                    onClick={() => setExpandedTask(expandedTask === idx ? null : idx)}
                  >
                    <GripVertical className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    <span className="flex-1 text-sm font-medium truncate">{task.title || <span className="text-muted-foreground italic">Untitled task</span>}</span>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {task.auto_assign_role !== "none" && (
                        <Badge variant="outline" className="text-xs">{ROLE_LABELS[task.auto_assign_role]}</Badge>
                      )}
                      {task.estimated_minutes > 0 && (
                        <Badge variant="secondary" className="text-xs">{task.estimated_minutes}m</Badge>
                      )}
                      <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={(e) => { e.stopPropagation(); moveTask(idx, -1); }} disabled={idx === 0}>
                        <ChevronUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={(e) => { e.stopPropagation(); moveTask(idx, 1); }} disabled={idx === form.task_templates.length - 1}>
                        <ChevronDown className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-destructive hover:text-destructive" onClick={(e) => { e.stopPropagation(); removeTask(idx); }}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  {expandedTask === idx && (
                    <div className="p-3 space-y-3 border-t bg-background">
                      <Input
                        placeholder="Task title *"
                        value={task.title}
                        onChange={e => updateTask(idx, "title", e.target.value)}
                      />
                      <Textarea
                        placeholder="Task description (optional)"
                        value={task.description || ""}
                        onChange={e => updateTask(idx, "description", e.target.value)}
                        rows={2}
                      />
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-xs font-medium block mb-1">Task Type</label>
                          <Select value={task.task_type} onValueChange={v => updateTask(idx, "task_type", v)}>
                            <SelectTrigger className="h-8 text-sm">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="back_office">Back Office</SelectItem>
                              <SelectItem value="onsite">Onsite</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <label className="text-xs font-medium block mb-1">Auto-assign Role</label>
                          <Select value={task.auto_assign_role || "none"} onValueChange={v => updateTask(idx, "auto_assign_role", v)}>
                            <SelectTrigger className="h-8 text-sm">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {Object.entries(ROLE_LABELS).map(([k, v]) => (
                                <SelectItem key={k} value={k}>{v}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <label className="text-xs font-medium block mb-1">Estimated Minutes</label>
                          <Input
                            type="number"
                            min="0"
                            className="h-8 text-sm"
                            value={task.estimated_minutes || 0}
                            onChange={e => updateTask(idx, "estimated_minutes", parseInt(e.target.value) || 0)}
                          />
                        </div>
                        <div>
                          <label className="text-xs font-medium block mb-1">Timer Trigger</label>
                          <Select value={task.timer_trigger || "none"} onValueChange={v => updateTask(idx, "timer_trigger", v)}>
                            <SelectTrigger className="h-8 text-sm">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">None</SelectItem>
                              <SelectItem value="project_onsite">Project Onsite</SelectItem>
                              <SelectItem value="project_uploaded">Project Uploaded</SelectItem>
                              <SelectItem value="project_submitted">Project Submitted</SelectItem>
                              <SelectItem value="dependencies_cleared">Dependencies Cleared</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <label className="text-xs font-medium block mb-1">Deadline Type</label>
                          <Select value={task.deadline_type || "custom"} onValueChange={v => updateTask(idx, "deadline_type", v)}>
                            <SelectTrigger className="h-8 text-sm">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="custom">Custom Hours</SelectItem>
                              <SelectItem value="preset">Preset</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        {task.deadline_type === "preset" ? (
                          <div>
                            <label className="text-xs font-medium block mb-1">Preset</label>
                            <Select value={task.deadline_preset || ""} onValueChange={v => updateTask(idx, "deadline_preset", v)}>
                              <SelectTrigger className="h-8 text-sm">
                                <SelectValue placeholder="Select..." />
                              </SelectTrigger>
                              <SelectContent>
                                {DEADLINE_PRESETS.map(p => (
                                  <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        ) : (
                          <div>
                            <label className="text-xs font-medium block mb-1">Hours After Trigger</label>
                            <Input
                              type="number"
                              min="0"
                              className="h-8 text-sm"
                              value={task.deadline_hours_after_trigger || 0}
                              onChange={e => updateTask(idx, "deadline_hours_after_trigger", parseFloat(e.target.value) || 0)}
                            />
                          </div>
                        )}
                        {idx > 0 && (
                          <div className="col-span-2">
                            <label className="text-xs font-medium block mb-1">Depends on Task #</label>
                            <Select
                              value={task.depends_on_indices?.[0] !== undefined ? String(task.depends_on_indices[0]) : "none"}
                              onValueChange={v => updateTask(idx, "depends_on_indices", v === "none" ? [] : [parseInt(v)])}
                            >
                              <SelectTrigger className="h-8 text-sm">
                                <SelectValue placeholder="No dependency" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">No dependency</SelectItem>
                                {form.task_templates.slice(0, idx).map((t, i) => (
                                  <SelectItem key={i} value={String(i)}>#{i + 1}: {t.title || "Untitled"}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!form.name?.trim() || !form.revision_type || !form.request_kind || isSaving} onClick={handleSave}>
            {isSaving ? "Saving..." : template ? "Save Changes" : "Create Template"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}