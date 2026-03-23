import React, { useState } from "react";
import { useEntityAccess } from '@/components/auth/useEntityAccess';
import AccessBadge from '@/components/auth/AccessBadge';
import { api } from "@/api/supabaseClient";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { useMutation } from "@tanstack/react-query";
import { Plus, Edit, Trash2, Star, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import DeleteConfirmationDialog from "../common/DeleteConfirmationDialog";
import { toast } from "sonner";

const COLORS = [
  "#3b82f6", "#8b5cf6", "#10b981", "#f59e0b", "#ef4444",
  "#06b6d4", "#ec4899", "#84cc16", "#f97316", "#6366f1"
];

const DEFAULT_FORM = { name: "", slug: "", description: "", color: "#3b82f6", is_active: true, is_default: false, order: 0 };

function slugify(str) {
  return str.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}

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

  const handleOpen = (type = null) => {
    setEditingType(type);
    setFormData(type ? { ...type } : DEFAULT_FORM);
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
                </div>
                {type.description && <p className="text-xs text-muted-foreground mt-0.5 truncate">{type.description}</p>}
                {type.slug && <p className="text-xs text-muted-foreground/60 font-mono">{type.slug}</p>}
              </div>
              <div className="flex items-center gap-1">
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
        <DialogContent className="max-w-md">
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