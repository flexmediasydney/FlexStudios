import React, { useState } from "react";
import { useEntityAccess } from '@/components/auth/useEntityAccess';
import AccessBadge from '@/components/auth/AccessBadge';
import { api } from "@/api/supabaseClient";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { useMutation } from "@tanstack/react-query";
import { Plus, Edit, Trash2, Star, Check, ChevronDown, ChevronRight, GripVertical, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import DeleteConfirmationDialog from "../common/DeleteConfirmationDialog";
import { toast } from "sonner";

const COLORS = [
  "#3b82f6", "#8b5cf6", "#10b981", "#f59e0b", "#ef4444",
  "#06b6d4", "#ec4899", "#84cc16", "#f97316", "#6366f1"
];

const ROLE_OPTIONS = [
  { value: "none", label: "None" },
  { value: "project_owner", label: "Project Owner" },
  { value: "photographer", label: "Photographer" },
  { value: "videographer", label: "Videographer" },
  { value: "image_editor", label: "Image Editor" },
  { value: "video_editor", label: "Video Editor" },
  { value: "floorplan_editor", label: "Floorplan Editor" },
  { value: "drone_editor", label: "Drone Editor" },
];

const TRIGGER_OPTIONS = [
  { value: "none", label: "None (manual)" },
  { value: "project_onsite", label: "Project reaches Onsite" },
  { value: "project_uploaded", label: "Project reaches Uploaded" },
  { value: "project_submitted", label: "Project reaches Submitted" },
  { value: "dependencies_cleared", label: "Dependencies completed" },
];

const TASK_TYPE_OPTIONS = [
  { value: "back_office", label: "Back Office" },
  { value: "onsite", label: "Onsite" },
];

const DEFAULT_TEMPLATE = {
  title: "",
  description: "",
  task_type: "back_office",
  auto_assign_role: "none",
  estimated_minutes: 0,
  depends_on_indices: [],
  timer_trigger: "none",
  deadline_type: "custom",
  deadline_preset: null,
  deadline_hours_after_trigger: 0,
};

const DEFAULT_FORM = {
  name: "",
  slug: "",
  description: "",
  color: "#3b82f6",
  is_active: true,
  is_default: false,
  order: 0,
  task_templates: [],
  // Wave 7 P1-6 (W7.7): when false, the shortlisting subtab runs in manual
  // mode (no AI passes; operator drags Dropbox files into approved). When
  // true (default), full Pass 0/1/2/3 engine runs.
  shortlisting_supported: true,
};

function slugify(str) {
  return str.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}

// ─── Task Template Card ────────────────────────────────────────────────────────
function TaskTemplateCard({ template, index, allTemplates, onChange, onRemove }) {
  const [expanded, setExpanded] = useState(false);

  const handleField = (field, value) => {
    onChange(index, { ...template, [field]: value });
  };

  const toggleDependency = (depIdx) => {
    const current = template.depends_on_indices || [];
    const next = current.includes(depIdx)
      ? current.filter(i => i !== depIdx)
      : [...current, depIdx];
    handleField("depends_on_indices", next);
  };

  return (
    <div className="border rounded-md bg-card text-sm">
      {/* Compact header row */}
      <div className="flex items-center gap-2 px-3 py-2">
        <GripVertical className="h-3.5 w-3.5 text-muted-foreground/40 flex-shrink-0 cursor-grab" />
        <Input
          value={template.title}
          onChange={(e) => handleField("title", e.target.value)}
          placeholder="Task title…"
          className="h-7 text-xs flex-1 min-w-0"
        />
        {/* Role */}
        <Select value={template.auto_assign_role} onValueChange={(v) => handleField("auto_assign_role", v)}>
          <SelectTrigger className="h-7 text-xs w-[130px] flex-shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLE_OPTIONS.map(o => (
              <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* Trigger */}
        <Select value={template.timer_trigger} onValueChange={(v) => handleField("timer_trigger", v)}>
          <SelectTrigger className="h-7 text-xs w-[160px] flex-shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TRIGGER_OPTIONS.map(o => (
              <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* Est minutes */}
        <Input
          type="number"
          min={0}
          value={template.estimated_minutes || ""}
          onChange={(e) => handleField("estimated_minutes", parseInt(e.target.value) || 0)}
          placeholder="min"
          className="h-7 text-xs w-16 flex-shrink-0"
          title="Estimated minutes"
        />
        {/* Expand / delete */}
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="text-muted-foreground hover:text-foreground flex-shrink-0"
          title="More options"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={() => onRemove(index)}
          className="text-destructive/60 hover:text-destructive flex-shrink-0"
          title="Remove template"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Expanded detail row */}
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {/* Task type */}
            <div>
              <Label className="text-xs text-muted-foreground">Task Type</Label>
              <Select value={template.task_type} onValueChange={(v) => handleField("task_type", v)}>
                <SelectTrigger className="h-7 text-xs mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TASK_TYPE_OPTIONS.map(o => (
                    <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {/* Deadline hours after trigger */}
            <div>
              <Label className="text-xs text-muted-foreground">Deadline (hrs after trigger)</Label>
              <Input
                type="number"
                min={0}
                value={template.deadline_hours_after_trigger || ""}
                onChange={(e) => handleField("deadline_hours_after_trigger", parseInt(e.target.value) || 0)}
                placeholder="0"
                className="h-7 text-xs mt-1"
              />
            </div>
          </div>
          {/* Description */}
          <div>
            <Label className="text-xs text-muted-foreground">Description</Label>
            <Textarea
              value={template.description || ""}
              onChange={(e) => handleField("description", e.target.value)}
              placeholder="Optional details…"
              rows={2}
              className="mt-1 resize-none text-xs"
            />
          </div>
          {/* Dependencies */}
          {allTemplates.length > 1 && (
            <div>
              <Label className="text-xs text-muted-foreground">Depends on (must complete first)</Label>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                {allTemplates.map((t, i) => {
                  if (i === index) return null;
                  const checked = (template.depends_on_indices || []).includes(i);
                  return (
                    <label key={i} className="flex items-center gap-1.5 text-xs cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleDependency(i)}
                        className="h-3 w-3 rounded"
                      />
                      <span className={checked ? "font-medium" : "text-muted-foreground"}>
                        {t.title || `Task ${i + 1}`}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Task Templates Section ────────────────────────────────────────────────────
function TaskTemplatesSection({ templates, onChange }) {
  const [open, setOpen] = useState(true);

  const handleAdd = () => {
    onChange([...templates, { ...DEFAULT_TEMPLATE }]);
  };

  const handleChange = (index, updated) => {
    const next = templates.map((t, i) => (i === index ? updated : t));
    onChange(next);
  };

  const handleRemove = (index) => {
    // Also remove this index from other templates' depends_on_indices
    const next = templates
      .filter((_, i) => i !== index)
      .map(t => ({
        ...t,
        depends_on_indices: (t.depends_on_indices || [])
          .filter(dep => dep !== index)
          .map(dep => (dep > index ? dep - 1 : dep)),
      }));
    onChange(next);
  };

  return (
    <div className="border rounded-lg overflow-hidden">
      {/* Section header */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-3 py-2.5 bg-muted/30 hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          {open ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
          <span className="text-sm font-medium">Task Templates</span>
          {templates.length > 0 && (
            <Badge variant="secondary" className="text-xs px-1.5 py-0 h-5">
              {templates.length}
            </Badge>
          )}
        </div>
        {/* Add button — stop propagation so it doesn't toggle collapse */}
        <div onClick={(e) => e.stopPropagation()}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleAdd}
            className="h-6 px-2 text-xs gap-1"
          >
            <Plus className="h-3 w-3" />
            Add Task
          </Button>
        </div>
      </button>

      {/* Template list */}
      {open && (
        <div className="p-3 space-y-2">
          {templates.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-3">
              No task templates yet. Tasks will be created manually for each project.
            </p>
          ) : (
            templates.map((t, i) => (
              <TaskTemplateCard
                key={i}
                template={t}
                index={i}
                allTemplates={templates}
                onChange={handleChange}
                onRemove={handleRemove}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────────
export default function ProjectTypesManagement() {
  const { canEdit, canView } = useEntityAccess('project_types');
  const [showDialog, setShowDialog] = useState(false);
  const [editingType, setEditingType] = useState(null);
  const [deletingType, setDeletingType] = useState(null);
  const [formData, setFormData] = useState(DEFAULT_FORM);
  const [autoSlug, setAutoSlug] = useState(true);

  const { data: types = [], loading } = useEntityList("ProjectType", "order");

  const saveMutation = useMutation({
    mutationFn: async (data) => {
      // If setting as default, clear other defaults first
      if (data.is_default) {
        const others = types.filter(t => t.is_default && t.id !== editingType?.id);
        await Promise.all(others.map(t => api.entities.ProjectType.update(t.id, { is_default: false })));
      }
      if (editingType) {
        return api.entities.ProjectType.update(editingType.id, data);
      }
      return api.entities.ProjectType.create(data);
    },
    onSuccess: () => {
      refetchEntityList("ProjectType");
      toast.success(editingType ? "Project type updated" : "Project type created");
      handleClose();
    },
    onError: (e) => toast.error(e.message || "Failed to save")
  });

  const deleteMutation = useMutation({
    mutationFn: (type) => api.entities.ProjectType.delete(type.id),
    onSuccess: () => {
      refetchEntityList("ProjectType");
      toast.success(`"${deletingType?.name}" deleted`);
      setDeletingType(null);
    },
    onError: (e) => toast.error(e.message || "Failed to delete")
  });

  const setDefaultMutation = useMutation({
    mutationFn: async (type) => {
      const others = types.filter(t => t.is_default && t.id !== type.id);
      await Promise.all(others.map(t => api.entities.ProjectType.update(t.id, { is_default: false })));
      return api.entities.ProjectType.update(type.id, { is_default: true });
    },
    onSuccess: () => { refetchEntityList("ProjectType"); toast.success("Default updated"); },
    onError: (err) => toast.error(err?.message || 'Failed to set default project type'),
  });

  // Wave 7 P1-19 (W7.13): inline toggle for shortlisting_supported. Allows
  // master_admin to flip the flag without opening the full edit dialog —
  // matches the per-row "Set default" action pattern.
  const toggleShortlistingMutation = useMutation({
    mutationFn: ({ type, value }) =>
      api.entities.ProjectType.update(type.id, { shortlisting_supported: value }),
    onSuccess: (_, vars) => {
      refetchEntityList("ProjectType");
      toast.success(
        vars.value
          ? `"${vars.type.name}" — AI shortlisting enabled`
          : `"${vars.type.name}" — manual shortlisting mode`,
      );
    },
    onError: (err) => toast.error(err?.message || 'Failed to update shortlisting mode'),
  });

  const handleOpen = (type = null) => {
    setEditingType(type);
    setFormData(type
      ? { ...DEFAULT_FORM, ...type, task_templates: type.task_templates || [] }
      : { ...DEFAULT_FORM }
    );
    setAutoSlug(!type);
    setShowDialog(true);
  };

  const handleClose = () => {
    setShowDialog(false);
    setEditingType(null);
    setFormData(DEFAULT_FORM);
  };

  const handleNameChange = (val) => {
    setFormData(prev => ({
      ...prev,
      name: val,
      ...(autoSlug ? { slug: slugify(val) } : {})
    }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!formData.name?.trim()) { toast.error("Name is required"); return; }
    if (formData.name.trim().length > 120) { toast.error("Name must be 120 characters or less"); return; }
    // Check duplicate name
    const duplicate = types.find(t => t.id !== editingType?.id && t.name?.toLowerCase().trim() === formData.name.toLowerCase().trim());
    if (duplicate) { toast.error(`A project type named "${duplicate.name}" already exists`); return; }
    // Validate templates have titles
    const untitled = formData.task_templates.findIndex(t => !t.title?.trim());
    if (untitled !== -1) { toast.error(`Task ${untitled + 1} is missing a title`); return; }
    saveMutation.mutate({ ...formData, name: formData.name.trim() });
  };

  if (!canView) return <div className="p-8 text-center text-muted-foreground">You don't have access to this section.</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-base">Project Types <AccessBadge entityType="project_types" /></h3>
          <p className="text-sm text-muted-foreground">Define the types of projects your business handles. Each type has its own set of products and packages.</p>
        </div>
        <Button onClick={() => handleOpen()} size="sm" className="gap-1.5" disabled={!canEdit}>
          <Plus className="h-4 w-4" />
          Add Type
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center p-8">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
        </div>
      ) : types.length === 0 ? (
        <div className="border-2 border-dashed rounded-lg p-8 text-center">
          <p className="text-muted-foreground text-sm">No project types defined yet.</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => handleOpen()}>
            <Plus className="h-4 w-4 mr-1" /> Add first type
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {types.map(type => (
            <div key={type.id} className="flex items-center gap-3 p-4 border rounded-lg bg-card hover:bg-muted/30 transition-colors">
              <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: type.color || "#3b82f6" }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{type.name}</span>
                  {type.is_default && (
                    <Badge className="text-xs bg-primary/10 text-primary border-primary/20 gap-1">
                      <Star className="h-3 w-3" /> Default
                    </Badge>
                  )}
                  {!type.is_active && (
                    <Badge variant="secondary" className="text-xs">Inactive</Badge>
                  )}
                  {type.shortlisting_supported === false && (
                    <Badge
                      variant="outline"
                      className="text-xs bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-950 dark:text-amber-300"
                    >
                      Manual shortlist
                    </Badge>
                  )}
                  {type.task_templates?.length > 0 && (
                    <Badge variant="outline" className="text-xs gap-1">
                      {type.task_templates.length} task{type.task_templates.length !== 1 ? "s" : ""}
                    </Badge>
                  )}
                </div>
                {type.description && <p className="text-xs text-muted-foreground mt-0.5 truncate">{type.description}</p>}
                {type.slug && <p className="text-xs text-muted-foreground/60 font-mono">{type.slug}</p>}
              </div>
              <div className="flex items-center gap-1">
                {/* Wave 7 P1-19 (W7.13): inline AI-shortlisting toggle. */}
                <div
                  className="flex items-center gap-1.5 mr-2 pr-2 border-r"
                  title={
                    type.shortlisting_supported === false
                      ? "Manual mode — operator drags Dropbox files into Approved (no AI). Click to enable AI shortlisting."
                      : "AI shortlisting enabled (Pass 0/1/2/3 engine). Click to switch to manual mode."
                  }
                >
                  <Switch
                    checked={type.shortlisting_supported !== false}
                    onCheckedChange={(v) =>
                      toggleShortlistingMutation.mutate({ type, value: v })
                    }
                    disabled={!canEdit || toggleShortlistingMutation.isPending}
                    aria-label="AI shortlisting supported"
                  />
                  <span className="text-[10px] text-muted-foreground hidden sm:inline">
                    AI
                  </span>
                </div>
                {!type.is_default && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs h-7 px-2 text-muted-foreground"
                    onClick={() => setDefaultMutation.mutate(type)}
                    disabled={!canEdit || setDefaultMutation.isPending}
                    title="Set as default"
                  >
                    <Star className="h-3 w-3" />
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => handleOpen(type)} className="h-7 w-7 p-0" disabled={!canEdit}>
                  <Edit className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeletingType(type)}
                  className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                  disabled={!canEdit}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={showDialog} onOpenChange={handleClose}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingType ? "Edit Project Type" : "New Project Type"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label>Name *</Label>
              <Input
                value={formData.name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="e.g. Real Estate, Commercial, Events"
                className="mt-1"
              />
            </div>
            <div>
              <Label>Slug (auto-generated)</Label>
              <Input
                value={formData.slug}
                onChange={(e) => { setAutoSlug(false); setFormData(prev => ({ ...prev, slug: e.target.value })); }}
                placeholder="real_estate"
                className="mt-1 font-mono text-sm"
              />
            </div>
            <div>
              <Label>Description</Label>
              <Textarea
                value={formData.description}
                onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                placeholder="Brief description..."
                rows={2}
                className="mt-1 resize-none text-sm"
              />
            </div>
            <div>
              <Label>Color</Label>
              <div className="flex gap-2 mt-2 flex-wrap">
                {COLORS.map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setFormData(prev => ({ ...prev, color: c }))}
                    className="w-7 h-7 rounded-full border-2 flex items-center justify-center transition-transform hover:scale-110"
                    style={{ backgroundColor: c, borderColor: formData.color === c ? "#000" : "transparent" }}
                  >
                    {formData.color === c && <Check className="h-3 w-3 text-white" />}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Switch
                  checked={formData.is_active}
                  onCheckedChange={(v) => setFormData(prev => ({ ...prev, is_active: v }))}
                />
                <Label>Active</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={formData.is_default}
                  onCheckedChange={(v) => setFormData(prev => ({ ...prev, is_default: v }))}
                />
                <Label>Default type</Label>
              </div>
            </div>

            {/* Wave 7 P1-6 (W7.7): manual-mode plumbing for the shortlisting subtab */}
            <div className="flex items-start gap-2 p-3 rounded-md bg-muted/30 border">
              <Switch
                checked={formData.shortlisting_supported !== false}
                onCheckedChange={(v) =>
                  setFormData(prev => ({ ...prev, shortlisting_supported: v }))
                }
                className="mt-0.5"
              />
              <div className="flex-1">
                <Label className="text-sm font-medium">AI shortlisting supported</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  When ON (default), the project's shortlisting subtab runs the full
                  AI engine (Pass 0/1/2/3). When OFF, it falls back to manual mode —
                  operator drags Dropbox files into the approved set; lock-triggers-move.
                  Disable for project types where AI scoring doesn't make sense.
                </p>
              </div>
            </div>

            {/* ── Task Templates ── */}
            <TaskTemplatesSection
              templates={formData.task_templates || []}
              onChange={(updated) => setFormData(prev => ({ ...prev, task_templates: updated }))}
            />

            <DialogFooter>
              <Button type="button" variant="outline" onClick={handleClose}>Cancel</Button>
              <Button type="submit" disabled={saveMutation.isPending}>
                {saveMutation.isPending ? "Saving..." : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <DeleteConfirmationDialog
        open={!!deletingType}
        itemName={deletingType?.name}
        itemType="project type"
        isLoading={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate(deletingType)}
        onCancel={() => setDeletingType(null)}
      />
    </div>
  );
}
