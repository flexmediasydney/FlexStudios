import { useState } from "react";
import { api } from "@/api/supabaseClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Tag, X, Edit2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import LabelBadge from "./LabelBadge";

export default function LabelSelectorRobust({
  emailAccountId,
  selectedLabels = [],
  onLabelsChange,
  isAdmin = false,
  compact = false,
}) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState("#3b82f6");
  const [editingLabel, setEditingLabel] = useState(null);
  const queryClient = useQueryClient();

  const { data: labels = [] } = useQuery({
    queryKey: ["email-labels", emailAccountId],
    queryFn: () =>
      api.entities.EmailLabel.filter({ email_account_id: emailAccountId }),
    enabled: !!emailAccountId,
  });

  const createLabelMutation = useMutation({
    mutationFn: (data) => api.entities.EmailLabel.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-labels", emailAccountId] });
      setNewLabelName("");
      setNewLabelColor("#3b82f6");
      toast.success("Label created");
    },
    onError: () => toast.error("Failed to create label"),
  });

  const deleteLabelMutation = useMutation({
    mutationFn: (labelId) => api.entities.EmailLabel.delete(labelId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-labels", emailAccountId] });
      toast.success("Label deleted");
    },
    onError: () => toast.error("Failed to delete label"),
  });

  const updateLabelMutation = useMutation({
    mutationFn: ({ id, name, color }) =>
      api.entities.EmailLabel.update(id, { name, color }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-labels", emailAccountId] });
      setEditingLabel(null);
      toast.success("Label updated");
    },
    onError: () => toast.error("Failed to update label"),
  });

  const filteredLabels = labels.filter((l) =>
    l.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const selectedLabelObjects = labels.filter((l) =>
    selectedLabels.includes(l.name)
  );

  const handleLabelToggle = (labelName) => {
    const newLabels = selectedLabels.includes(labelName)
      ? selectedLabels.filter((l) => l !== labelName)
      : [...selectedLabels, labelName];
    // Immediate visual feedback
    onLabelsChange(newLabels);
    // Keep popover open for multiple selections
  };

  const handleAddLabel = () => {
    if (!newLabelName.trim()) {
      toast.error("Label name required");
      return;
    }
    if (labels.some((l) => l.name.toLowerCase() === newLabelName.toLowerCase())) {
      toast.error("Label already exists");
      return;
    }
    createLabelMutation.mutate({
      email_account_id: emailAccountId,
      name: newLabelName.trim(),
      color: newLabelColor,
    });
  };

  const handleSaveEdit = () => {
    if (!editingLabel.name.trim()) {
      toast.error("Label name required");
      return;
    }
    updateLabelMutation.mutate({
      id: editingLabel.id,
      name: editingLabel.name,
      color: editingLabel.color,
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={selectedLabels.length > 0 ? "default" : "outline"}
          size={compact ? "sm" : "default"}
          className="gap-2"
        >
          <Tag className="h-4 w-4" />
          {selectedLabels.length > 0 ? (
            <span>{selectedLabels.length} label{selectedLabels.length !== 1 ? "s" : ""}</span>
          ) : (
            <span>Labels</span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-96 p-0" align="start">
        {/* Header with Search */}
        <div className="p-3 border-b space-y-3">
          <Input
            placeholder="Search or add label..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-9"
            autoFocus
          />
          {selectedLabelObjects.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {selectedLabelObjects.map((label) => (
                <LabelBadge
                  key={label.id}
                  label={label.name}
                  color={label.color}
                  onRemove={() => handleLabelToggle(label.name)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Labels List */}
        <div className="max-h-64 overflow-y-auto">
          {filteredLabels.length === 0 && !searchQuery ? (
            <div className="p-4 text-sm text-muted-foreground text-center">
              No labels yet. Create one to get started.
            </div>
          ) : filteredLabels.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground text-center">
              No matching labels
            </div>
          ) : (
            filteredLabels.map((label) => (
              <div
                key={label.id}
                className="px-3 py-2.5 hover:bg-muted border-b last:border-b-0 group transition-colors flex items-center justify-between"
              >
                <label className="flex items-center gap-3 cursor-pointer flex-1">
                  <input
                    type="checkbox"
                    checked={selectedLabels.includes(label.name)}
                    onChange={() => handleLabelToggle(label.name)}
                    className="h-4 w-4 cursor-pointer"
                  />
                  <LabelBadge label={label.name} color={label.color} />
                </label>
                {isAdmin && (
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setEditingLabel(label)}
                    >
                      <Edit2 className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      onClick={() => deleteLabelMutation.mutate(label.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Add/Edit Label Section */}
        {isAdmin && (
          <div className="p-3 border-t bg-muted/30 space-y-3">
            {editingLabel ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold">Edit Label</p>
                <Input
                  placeholder="Label name"
                  value={editingLabel.name}
                  onChange={(e) =>
                    setEditingLabel({ ...editingLabel, name: e.target.value })
                  }
                  className="h-8 text-sm"
                />
                <div className="flex gap-2 items-center">
                  <input
                    type="color"
                    value={editingLabel.color}
                    onChange={(e) =>
                      setEditingLabel({ ...editingLabel, color: e.target.value })
                    }
                    className="h-8 w-12 rounded cursor-pointer"
                  />
                  <Button
                    size="sm"
                    onClick={handleSaveEdit}
                    className="flex-1 h-8"
                  >
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEditingLabel(null)}
                    className="h-8 w-8 p-0"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs font-semibold">Create New Label</p>
                <Input
                  placeholder="Label name"
                  value={newLabelName}
                  onChange={(e) => setNewLabelName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddLabel()}
                  className="h-8 text-sm"
                />
                <div className="flex gap-2 items-center">
                  <input
                    type="color"
                    value={newLabelColor}
                    onChange={(e) => setNewLabelColor(e.target.value)}
                    className="h-8 w-12 rounded cursor-pointer"
                  />
                  <Button
                    size="sm"
                    onClick={handleAddLabel}
                    disabled={createLabelMutation.isPending}
                    className="flex-1 h-8"
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    Create
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}