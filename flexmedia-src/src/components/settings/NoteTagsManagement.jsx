import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, Pencil, Check, X } from "lucide-react";
import { toast } from "sonner";

export default function NoteTagsManagement() {
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#6366f1");
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");
  const [deletingId, setDeletingId] = useState(null);

  const { data: tags = [], isLoading } = useQuery({
    queryKey: ["note-tags"],
    queryFn: () => api.entities.NoteTag.list("order", 100),
  });

  const createMutation = useMutation({
    mutationFn: (data) => api.entities.NoteTag.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["note-tags"] });
      toast.success("Tag created");
    },
    onError: (err) => toast.error(err?.message || "Failed to create tag"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => api.entities.NoteTag.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["note-tags"] });
      setEditingId(null);
      toast.success("Tag updated");
    },
    onError: (err) => toast.error(err?.message || "Failed to update tag"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => {
      setDeletingId(id);
      return api.entities.NoteTag.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["note-tags"] });
      setDeletingId(null);
      toast.success("Tag deleted");
    },
    onError: (err) => {
      setDeletingId(null);
      toast.error(err?.message || "Failed to delete tag");
    },
  });

  const handleAdd = () => {
    const name = newName.trim();
    if (!name) return;
    // Prevent duplicate tag names (case-insensitive)
    if (tags.some(t => t.name.toLowerCase() === name.toLowerCase())) {
      toast.error(`Tag "${name}" already exists`);
      return;
    }
    createMutation.mutate({ name, color: newColor, order: tags.length });
    setNewName("");
  };

  const startEdit = (tag) => {
    setEditingId(tag.id);
    setEditName(tag.name);
    setEditColor(tag.color || "#6366f1");
  };

  const saveEdit = () => {
    const name = editName.trim();
    if (!name) return;
    // Prevent duplicate names when editing (exclude current tag)
    if (tags.some(t => t.id !== editingId && t.name.toLowerCase() === name.toLowerCase())) {
      toast.error(`Tag "${name}" already exists`);
      return;
    }
    updateMutation.mutate({ id: editingId, data: { name, color: editColor } });
  };

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h2 className="text-lg font-semibold">Note Tags</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Tags available when writing notes on organisations.
        </p>
      </div>

      {/* Add new tag */}
      <div className="flex gap-2 items-center">
        <input
          type="color"
          value={newColor}
          onChange={(e) => setNewColor(e.target.value)}
          className="h-9 w-10 rounded border border-input cursor-pointer p-0.5"
          title="Tag colour"
        />
        <Input
          placeholder="Tag name (e.g. pricing, schedule)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          className="flex-1"
        />
        <Button onClick={handleAdd} disabled={!newName.trim() || createMutation.isPending}>
          <Plus className="h-4 w-4 mr-1" />
          Add
        </Button>
      </div>

      {/* Tag list */}
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : tags.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">No tags yet. Add one above.</p>
      ) : (
        <div className="space-y-2">
          {tags.map((tag) => (
            <div
              key={tag.id}
              className="flex items-center justify-between px-3 py-2 rounded-lg border bg-card"
            >
              {editingId === tag.id ? (
                <div className="flex items-center gap-2 flex-1">
                  <input
                    type="color"
                    value={editColor}
                    onChange={(e) => setEditColor(e.target.value)}
                    className="h-7 w-8 rounded border border-input cursor-pointer p-0.5"
                  />
                  <Input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && saveEdit()}
                    className="flex-1 h-8 text-sm"
                    autoFocus
                  />
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={saveEdit} disabled={updateMutation.isPending}>
                    <Check className="h-4 w-4 text-green-600" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditingId(null)}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-3">
                    <span
                      className="inline-block w-3 h-3 rounded-full border"
                      style={{ background: tag.color || "#6366f1" }}
                    />
                    <Badge
                      style={
                        tag.color
                          ? { background: tag.color + "22", color: tag.color, borderColor: tag.color + "55" }
                          : {}
                      }
                      variant="outline"
                      className="text-sm"
                    >
                      {tag.name}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={() => startEdit(tag)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-destructive hover:text-destructive h-8 w-8"
                      onClick={() => deleteMutation.mutate(tag.id)}
                      disabled={deletingId === tag.id}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}