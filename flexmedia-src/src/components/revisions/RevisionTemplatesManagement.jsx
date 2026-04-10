import React, { useState } from "react";

import { api } from "@/api/supabaseClient";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEntityList } from "@/components/hooks/useEntityData";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Plus, Edit, Trash2, Search, ChevronRight, ChevronDown } from "lucide-react";
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

export default function RevisionTemplatesManagement() {
  const queryClient = useQueryClient();
  const [showDialog, setShowDialog] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [deletingTemplate, setDeletingTemplate] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedIds, setExpandedIds] = useState({});

  const { data: templates = [], loading } = useEntityList("RevisionTemplate", "revision_type");

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
      </div>

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
        <div className="text-center py-16 text-muted-foreground border rounded-xl border-dashed">
          <p className="font-medium">No {REQUEST_KINDS[activeKind]?.label} templates yet</p>
          <p className="text-sm mt-1">Create templates to standardize your request workflows.</p>
          <Button className="mt-4" onClick={() => handleOpen()}>
            <Plus className="h-4 w-4 mr-1.5" /> Create First Template
          </Button>
        </div>
      )}

      {!isLoading && Object.entries(REVISION_TYPES).map(([type, meta]) => {
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
                        className="flex items-center gap-3 p-3 bg-card hover:bg-muted/30 cursor-pointer"
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

                      {isExpanded && (tpl.task_templates?.length || 0) > 0 && (
                        <div className="border-t bg-muted/20 p-3">
                          <p className="text-xs font-semibold text-muted-foreground mb-2">Tasks in this template:</p>
                          <div className="space-y-1.5">
                            {tpl.task_templates.map((task, i) => (
                              <div key={i} className="flex items-center gap-2 text-xs">
                                <span className="w-5 h-5 rounded-full bg-primary/10 text-primary flex items-center justify-center font-medium flex-shrink-0">{i + 1}</span>
                                <span className="flex-1 truncate font-medium">{task.title}</span>
                                {task.auto_assign_role !== "none" && (
                                  <Badge variant="outline" className="text-xs">{task.auto_assign_role?.replace(/_/g, " ")}</Badge>
                                )}
                                {task.estimated_minutes > 0 && (
                                  <span className="text-muted-foreground">{task.estimated_minutes}m</span>
                                )}
                              </div>
                            ))}
                          </div>
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