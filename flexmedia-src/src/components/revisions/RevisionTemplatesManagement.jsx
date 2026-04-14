import React, { useState, useEffect } from "react";

import { api } from "@/api/supabaseClient";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEntityList } from "@/components/hooks/useEntityData";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Edit, Trash2, Search, ChevronRight, ChevronDown, ArrowUp, ArrowDown, Save } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import RevisionTemplateFormDialog from "./RevisionTemplateFormDialog";

const REVISION_TYPES = {
  images: { label: "Images", color: "bg-blue-100 text-blue-700 border-blue-200" },
  drones: { label: "Drones", color: "bg-sky-100 text-sky-700 border-sky-200" },
  floorplan: { label: "Floorplan", color: "bg-amber-100 text-amber-700 border-amber-200" },
  video: { label: "Video", color: "bg-purple-100 text-purple-700 border-purple-200" },
};

const REQUEST_KINDS = {
  revision: { label: "Revision", color: "bg-violet-100 text-violet-700 border-violet-200" },
  change_request: { label: "Change Request", color: "bg-rose-100 text-rose-700 border-rose-200" },
};

const ROLE_LABELS = {
  none: "No auto-assign", project_owner: "Project Owner", photographer: "Photographer",
  videographer: "Videographer", image_editor: "Image Editor", video_editor: "Video Editor",
  floorplan_editor: "Floorplan Editor", drone_editor: "Drone Editor",
};

export default function RevisionTemplatesManagement() {
  const queryClient = useQueryClient();
  const [showDialog, setShowDialog] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [deletingTemplate, setDeletingTemplate] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedIds, setExpandedIds] = useState({});

  const { data: templates = [], loading } = useEntityList("RevisionTemplate", "revision_type");
  const { data: requestLevelTemplates = [] } = useEntityList("RequestLevelTaskTemplate");

  // Request-level inline editor state
  const [rlTasks, setRlTasks] = useState([]);
  const [rlDirty, setRlDirty] = useState(false);

  // Sync local editor state when data loads or changes (only if not dirty)
  useEffect(() => {
    if (requestLevelTemplates.length > 0 && !rlDirty) {
      setRlTasks(JSON.parse(JSON.stringify(requestLevelTemplates[0].task_templates || [])));
    }
  }, [requestLevelTemplates]);

  const rlSaveMutation = useMutation({
    mutationFn: async (tasks) => {
      const record = requestLevelTemplates[0];
      if (!record) throw new Error("No RequestLevelTaskTemplate record found");
      return api.entities.RequestLevelTaskTemplate.update(record.id, { task_templates: tasks });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['RequestLevelTaskTemplate'] });
      setRlDirty(false);
      toast.success("Request-level tasks saved");
    },
    onError: (e) => toast.error(e.message || "Failed to save request-level tasks"),
  });

  const rlAddTask = () => {
    setRlTasks(prev => [...prev, { title: "", auto_assign_role: "none", estimated_minutes: 0, description: "" }]);
    setRlDirty(true);
  };
  const rlRemoveTask = (index) => {
    setRlTasks(prev => prev.filter((_, i) => i !== index));
    setRlDirty(true);
  };
  const rlUpdateTask = (index, field, value) => {
    setRlTasks(prev => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
    setRlDirty(true);
  };
  const rlMoveTask = (index, direction) => {
    setRlTasks(prev => {
      const next = [...prev];
      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= next.length) return prev;
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      return next;
    });
    setRlDirty(true);
  };

  const saveMutation = useMutation({
    mutationFn: async (data) => {
      if (editingTemplate) {
        return api.entities.RevisionTemplate.update(editingTemplate.id, data);
      }
      return api.entities.RevisionTemplate.create(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['RevisionTemplate'] });
      toast.success(editingTemplate ? "Template updated" : "Template created");
      setShowDialog(false);
      setEditingTemplate(null);
    },
    onError: (e) => toast.error(e.message || "Failed to save template"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => api.entities.RevisionTemplate.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['RevisionTemplate'] });
      toast.success("Template deleted");
      setDeletingTemplate(null);
    },
    onError: (e) => toast.error(e.message || "Failed to delete"),
  });

  const handleOpen = (tpl = null) => {
    setEditingTemplate(tpl);
    setShowDialog(true);
  };

  const toggleExpand = (id) => setExpandedIds(prev => ({ ...prev, [id]: !prev[id] }));

  const [activeKind, setActiveKind] = useState("revision");

  const filtered = templates.filter(t =>
    (t.request_kind === activeKind || (!t.request_kind && activeKind === "revision")) &&
    (t.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    t.revision_type?.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  // Group by revision_type
  const grouped = filtered.reduce((acc, tpl) => {
    const key = tpl.revision_type || "other";
    if (!acc[key]) acc[key] = [];
    acc[key].push(tpl);
    return acc;
  }, {});

  return (
    <div className="space-y-5">
      {/* Kind Tabs */}
      <div className="flex gap-2">
        {Object.entries(REQUEST_KINDS).map(([k, v]) => (
          <button
            key={k}
            onClick={() => setActiveKind(k)}
            className={`px-4 py-2 rounded-lg text-sm font-medium border transition-all ${
              activeKind === k ? `${v.color} border-current` : "border-border text-muted-foreground hover:bg-muted/50"
            }`}
          >
            {v.label}
          </button>
        ))}
        <button
          onClick={() => setActiveKind("request_level")}
          className={`px-4 py-2 rounded-lg text-sm font-medium border transition-all ${
            activeKind === "request_level"
              ? "bg-teal-100 text-teal-700 border-teal-300"
              : "border-border text-muted-foreground hover:bg-muted/50"
          }`}
        >
          Request Level
        </button>
      </div>

      {/* Request Level inline editor */}
      {activeKind === "request_level" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold">Request-Level Default Tasks</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                These tasks are automatically added to every revision and change request, regardless of which template is selected.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={rlAddTask}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Add Task
              </Button>
              <Button
                size="sm"
                disabled={!rlDirty || rlSaveMutation.isPending}
                onClick={() => rlSaveMutation.mutate(rlTasks)}
              >
                <Save className="h-3.5 w-3.5 mr-1" />
                {rlSaveMutation.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>

          {requestLevelTemplates.length === 0 && (
            <div className="text-center py-12 text-muted-foreground border rounded-lg border-dashed">
              <p className="font-medium">No request-level template record found</p>
              <p className="text-sm mt-1">A RequestLevelTaskTemplate row must be seeded in the database.</p>
            </div>
          )}

          {requestLevelTemplates.length > 0 && rlTasks.length === 0 && (
            <div className="text-center py-12 text-muted-foreground border rounded-lg border-dashed">
              <p className="font-medium">No request-level tasks defined yet</p>
              <p className="text-sm mt-1">Add tasks that should apply to every revision and change request.</p>
              <Button className="mt-4" size="sm" onClick={rlAddTask}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Add First Task
              </Button>
            </div>
          )}

          {rlTasks.length > 0 && (
            <div className="space-y-3">
              {rlTasks.map((task, i) => (
                <div key={i} className="border rounded-lg p-3 bg-card space-y-2.5">
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-full bg-teal-100 text-teal-700 flex items-center justify-center font-bold flex-shrink-0 text-xs">{i + 1}</span>
                    <Input
                      placeholder="Task title *"
                      value={task.title || ""}
                      onChange={e => rlUpdateTask(i, "title", e.target.value)}
                      className="h-8 text-sm flex-1 font-medium"
                    />
                    <div className="flex items-center gap-0.5 flex-shrink-0">
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={i === 0} onClick={() => rlMoveTask(i, -1)} title="Move up">
                        <ArrowUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={i === rlTasks.length - 1} onClick={() => rlMoveTask(i, 1)} title="Move down">
                        <ArrowDown className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive hover:text-destructive" onClick={() => rlRemoveTask(i)} title="Remove task">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs text-muted-foreground block mb-1">Auto-Assign Role</label>
                      <Select value={task.auto_assign_role || "none"} onValueChange={v => rlUpdateTask(i, "auto_assign_role", v)}>
                        <SelectTrigger className="h-8 text-xs">
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
                      <label className="text-xs text-muted-foreground block mb-1">Estimated Minutes</label>
                      <Input
                        type="number"
                        min="0"
                        value={task.estimated_minutes || 0}
                        onChange={e => rlUpdateTask(i, "estimated_minutes", parseInt(e.target.value, 10) || 0)}
                        className="h-8 text-sm"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">Description</label>
                    <Textarea
                      placeholder="Optional task description..."
                      value={task.description || ""}
                      onChange={e => rlUpdateTask(i, "description", e.target.value)}
                      rows={2}
                      className="text-sm"
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          {rlDirty && (
            <p className="text-xs text-amber-600 font-medium">You have unsaved changes.</p>
          )}
        </div>
      )}

      {/* Existing template list (Revision / Change Request tabs) */}
      {activeKind !== "request_level" && (<>
      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search templates..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
        <Button onClick={() => handleOpen()}>
          <Plus className="h-4 w-4 mr-1.5" /> New Template
        </Button>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-primary" />
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="text-center py-16 text-muted-foreground border rounded-lg border-dashed">
          <p className="font-medium">No {REQUEST_KINDS[activeKind]?.label.toLowerCase()} templates yet</p>
          <p className="text-sm mt-1">Create templates to standardize your request workflows.</p>
          <Button className="mt-4" onClick={() => handleOpen()}>
            <Plus className="h-4 w-4 mr-1.5" /> Create First Template
          </Button>
        </div>
      )}

      {!loading && Object.entries(REVISION_TYPES).map(([type, meta]) => {
        const group = grouped[type] || [];
        if (group.length === 0 && searchQuery) return null;
        return (
          <div key={type}>
            <div className="flex items-center gap-2 mb-2">
              <Badge className={meta.color + " text-xs font-semibold"}>{meta.label}</Badge>
              <span className="text-xs text-muted-foreground">{group.length} template{group.length !== 1 ? "s" : ""}</span>
            </div>
            {group.length === 0 ? (
              <p className="text-xs text-muted-foreground pl-2 py-2 italic">No {meta.label.toLowerCase()} templates. <button className="underline hover:text-primary" onClick={() => handleOpen()}>Create one</button>.</p>
            ) : (
              <div className="space-y-2">
                {group.map(tpl => {
                  const isExpanded = expandedIds[tpl.id];
                  return (
                    <div key={tpl.id} className="border rounded-lg overflow-hidden">
                      <div
                        className="flex items-center gap-3 p-3 bg-card hover:bg-muted/30 cursor-pointer transition-colors"
                        onClick={() => toggleExpand(tpl.id)}
                      >
                        <span className="text-muted-foreground">
                          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm">{tpl.name}</p>
                          {tpl.description && (
                            <p className="text-xs text-muted-foreground truncate">{tpl.description}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <Badge variant="secondary" className="text-xs">{tpl.task_templates?.length || 0} tasks</Badge>
                          {!tpl.is_active && <Badge variant="outline" className="text-xs text-muted-foreground">Inactive</Badge>}
                          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={e => { e.stopPropagation(); handleOpen(tpl); }}>
                            <Edit className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive hover:text-destructive" onClick={e => { e.stopPropagation(); setDeletingTemplate(tpl); }}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="border-t bg-muted/20 p-3">
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-xs font-semibold text-muted-foreground">Task Templates ({tpl.task_templates?.length || 0})</p>
                            <Button variant="outline" size="sm" className="h-6 text-[11px] gap-1" onClick={e => { e.stopPropagation(); handleOpen(tpl); }}>
                              <Edit className="h-3 w-3" /> Edit Tasks
                            </Button>
                          </div>
                          {(tpl.task_templates?.length || 0) === 0 ? (
                            <p className="text-xs text-muted-foreground italic py-2">No task templates defined. <button className="underline hover:text-primary" onClick={e => { e.stopPropagation(); handleOpen(tpl); }}>Add tasks</button></p>
                          ) : (
                            <div className="space-y-1.5">
                              {tpl.task_templates.map((task, i) => (
                                <div key={i} className="flex items-center gap-2 text-xs bg-background/60 rounded-md px-2.5 py-1.5 border">
                                  <span className="w-5 h-5 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold flex-shrink-0 text-[10px]">{i + 1}</span>
                                  <span className="flex-1 min-w-0 truncate font-medium" title={task.title}>{task.title}</span>
                                  {task.auto_assign_role && task.auto_assign_role !== "none" && (
                                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 whitespace-nowrap">{task.auto_assign_role.replace(/_/g, " ")}</Badge>
                                  )}
                                  {task.estimated_minutes > 0 && (
                                    <span className="text-[10px] text-muted-foreground whitespace-nowrap tabular-nums">{task.estimated_minutes}m</span>
                                  )}
                                  {task.timer_trigger && task.timer_trigger !== "none" && (
                                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 bg-blue-50 text-blue-600 border-blue-200 whitespace-nowrap">{task.timer_trigger.replace(/_/g, " ")}</Badge>
                                  )}
                                  {task.depends_on_indices?.length > 0 && (
                                    <span className="text-[10px] text-muted-foreground whitespace-nowrap" title={`Depends on step ${task.depends_on_indices.map(d => d+1).join(', ')}`}>
                                      → #{task.depends_on_indices.map(d => d+1).join(',')}
                                    </span>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      </>)}

      <RevisionTemplateFormDialog
        open={showDialog}
        onClose={() => { setShowDialog(false); setEditingTemplate(null); }}
        template={editingTemplate}
        onSave={(data) => saveMutation.mutate(data)}
        isSaving={saveMutation.isPending}
      />

      <AlertDialog open={!!deletingTemplate} onOpenChange={() => setDeletingTemplate(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deletingTemplate?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>This will permanently delete this revision template. Existing revision requests that used this template will not be affected.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              disabled={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate(deletingTemplate.id)}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}