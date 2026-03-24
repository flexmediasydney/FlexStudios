import { useState, useRef, useEffect } from "react";
import { api } from "@/api/supabaseClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Tag, Check, Minus, X, Pencil, Trash2, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import LabelBadge, { ColorDotPicker, LABEL_COLORS } from "./LabelBadge";

export default function LabelSelectorRobust({
  emailAccountId,
  selectedLabels = [],
  indeterminateLabels = [], // Labels that SOME (but not all) selected items have (tri-state)
  onLabelsChange,
  isAdmin = false,
  compact = false,
}) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState(LABEL_COLORS[5]); // blue default
  const [editingLabel, setEditingLabel] = useState(null);
  const searchRef = useRef(null);
  const queryClient = useQueryClient();

  const { data: labels = [] } = useQuery({
    queryKey: ["email-labels", emailAccountId],
    queryFn: () =>
      api.entities.EmailLabel.filter({ email_account_id: emailAccountId }),
    enabled: !!emailAccountId,
  });

  // Auto-focus search on open
  useEffect(() => {
    if (open && searchRef.current) {
      setTimeout(() => searchRef.current?.focus(), 50);
    }
    if (!open) {
      setSearchQuery("");
      setShowCreate(false);
      setEditingLabel(null);
    }
  }, [open]);

  const createLabelMutation = useMutation({
    mutationFn: (data) => api.entities.EmailLabel.create(data),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["email-labels", emailAccountId] });
      // Auto-select newly created label
      if (vars.name && !selectedLabels.includes(vars.name)) {
        onLabelsChange([...selectedLabels, vars.name]);
      }
      setNewLabelName("");
      setNewLabelColor(LABEL_COLORS[5]);
      setShowCreate(false);
      toast.success("Label created");
    },
    onError: () => toast.error("Failed to create label"),
  });

  const deleteLabelMutation = useMutation({
    mutationFn: async (labelId) => {
      // Find the label name before deleting so we can remove it from selections
      const label = labels.find(l => l.id === labelId);
      await api.entities.EmailLabel.delete(labelId);
      return { deletedName: label?.name };
    },
    onSuccess: ({ deletedName }) => {
      queryClient.invalidateQueries({ queryKey: ["email-labels", emailAccountId] });
      // Remove the deleted label from the current selection
      if (deletedName && selectedLabels.includes(deletedName)) {
        onLabelsChange(selectedLabels.filter(l => l !== deletedName));
      }
      toast.success("Label deleted");
    },
    onError: () => toast.error("Failed to delete label"),
  });

  const updateLabelMutation = useMutation({
    mutationFn: async ({ id, name, color }) => {
      const oldLabel = labels.find(l => l.id === id);
      await api.entities.EmailLabel.update(id, { name, color });
      return { oldName: oldLabel?.name, newName: name };
    },
    onSuccess: ({ oldName, newName }) => {
      queryClient.invalidateQueries({ queryKey: ["email-labels", emailAccountId] });
      // Update selectedLabels if the renamed label was selected
      if (oldName && newName && oldName !== newName && selectedLabels.includes(oldName)) {
        onLabelsChange(selectedLabels.map(l => l === oldName ? newName : l));
      }
      setEditingLabel(null);
      toast.success("Label updated");
    },
    onError: () => toast.error("Failed to update label"),
  });

  const filteredLabels = labels.filter((l) =>
    l.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleLabelToggle = (labelName) => {
    const isSelected = selectedLabels.includes(labelName);
    const isIndeterminate = indeterminateLabels.includes(labelName);

    let newLabels;
    if (isSelected) {
      // Checked → unchecked (remove)
      newLabels = selectedLabels.filter((l) => l !== labelName);
    } else if (isIndeterminate) {
      // Indeterminate → checked (add to all)
      newLabels = [...selectedLabels, labelName];
    } else {
      // Unchecked → checked (add)
      newLabels = [...selectedLabels, labelName];
    }
    onLabelsChange(newLabels);
  };

  const handleAddLabel = () => {
    if (!newLabelName.trim()) return;
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
    if (!editingLabel?.name?.trim()) return;
    updateLabelMutation.mutate({
      id: editingLabel.id,
      name: editingLabel.name,
      color: editingLabel.color,
    });
  };

  // If search doesn't match any label and user presses Enter, trigger create
  const handleSearchKeyDown = (e) => {
    if (e.key === "Enter" && searchQuery.trim() && filteredLabels.length === 0 && isAdmin) {
      setNewLabelName(searchQuery.trim());
      setShowCreate(true);
    }
    if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {compact ? (
          <button
            className={cn(
              "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all",
              selectedLabels.length > 0
                ? "bg-blue-50 text-blue-700 hover:bg-blue-100"
                : "text-slate-500 hover:text-foreground hover:bg-muted"
            )}
            title="Manage labels"
          >
            <Tag className="h-3 w-3" />
            {selectedLabels.length > 0
              ? `${selectedLabels.length} label${selectedLabels.length !== 1 ? "s" : ""}`
              : "Label"}
          </button>
        ) : (
          <Button
            variant={selectedLabels.length > 0 ? "default" : "outline"}
            size="sm"
            className="gap-1.5"
          >
            <Tag className="h-3.5 w-3.5" />
            {selectedLabels.length > 0
              ? `${selectedLabels.length} label${selectedLabels.length !== 1 ? "s" : ""}`
              : "Labels"}
          </Button>
        )}
      </PopoverTrigger>

      <PopoverContent className="w-72 p-0" align="start" sideOffset={4}>
        {/* Search */}
        <div className="p-2 border-b">
          <Input
            ref={searchRef}
            placeholder="Search or type to create..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            className="h-8 text-sm border-0 bg-slate-50 focus-visible:ring-1"
          />
        </div>

        {/* Labels List */}
        <div className="max-h-56 overflow-y-auto">
          {filteredLabels.length === 0 && !searchQuery ? (
            <div className="px-3 py-6 text-center">
              <p className="text-xs text-muted-foreground">No labels yet</p>
              {isAdmin && (
                <button
                  onClick={() => setShowCreate(true)}
                  className="text-xs text-blue-600 hover:text-blue-700 font-medium mt-1"
                >
                  Create your first label
                </button>
              )}
            </div>
          ) : filteredLabels.length === 0 && searchQuery ? (
            <div className="px-3 py-4 text-center">
              <p className="text-xs text-muted-foreground mb-1">No matching labels</p>
              {isAdmin && (
                <button
                  onClick={() => { setNewLabelName(searchQuery.trim()); setShowCreate(true); }}
                  className="text-xs text-blue-600 hover:text-blue-700 font-medium inline-flex items-center gap-1"
                >
                  <Plus className="h-3 w-3" />
                  Create "{searchQuery.trim()}"
                </button>
              )}
            </div>
          ) : (
            filteredLabels.map((label) => {
              const isSelected = selectedLabels.includes(label.name);
              const isIndeterminate = indeterminateLabels.includes(label.name);
              const isEditing = editingLabel?.id === label.id;

              if (isEditing) {
                return (
                  <div key={label.id} className="px-3 py-2.5 border-b last:border-b-0 bg-slate-50 space-y-2">
                    <Input
                      value={editingLabel.name}
                      onChange={(e) => setEditingLabel({ ...editingLabel, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSaveEdit();
                        if (e.key === "Escape") setEditingLabel(null);
                      }}
                      className="h-7 text-sm"
                      autoFocus
                    />
                    <ColorDotPicker
                      value={editingLabel.color}
                      onChange={(c) => setEditingLabel({ ...editingLabel, color: c })}
                      size="sm"
                    />
                    <div className="flex justify-end gap-1 pt-1">
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setEditingLabel(null)}>
                        Cancel
                      </Button>
                      <Button size="sm" className="h-6 px-3 text-xs" onClick={handleSaveEdit} disabled={updateLabelMutation.isPending}>
                        Save
                      </Button>
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={label.id}
                  className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/50 border-b last:border-b-0 group cursor-pointer transition-colors"
                  onClick={() => handleLabelToggle(label.name)}
                >
                  {/* Checkbox — tri-state: checked / indeterminate / unchecked */}
                  <div className={cn(
                    "w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-all",
                    isSelected
                      ? "bg-blue-600 border-blue-600"
                      : isIndeterminate
                      ? "bg-blue-400 border-blue-400"
                      : "border-slate-300 group-hover:border-slate-400"
                  )}>
                    {isSelected && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
                    {isIndeterminate && !isSelected && <Minus className="h-3 w-3 text-white" strokeWidth={3} />}
                  </div>

                  {/* Color dot + name */}
                  <div
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: label.color || "#64748b" }}
                  />
                  <span className="text-sm text-slate-700 flex-1 truncate">{label.name}</span>

                  {/* Admin actions on hover */}
                  {isAdmin && (
                    <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="p-1 hover:bg-slate-200 rounded transition-colors"
                        onClick={() => setEditingLabel({ ...label })}
                        title="Edit label"
                      >
                        <Pencil className="h-3 w-3 text-slate-400" />
                      </button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <button
                            className="p-1 hover:bg-red-50 rounded transition-colors"
                            title="Delete label"
                          >
                            <Trash2 className="h-3 w-3 text-slate-400 hover:text-red-500" />
                          </button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogTitle>Delete "{label.name}"?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This label will be removed from all emails.
                          </AlertDialogDescription>
                          <div className="flex justify-end gap-3 mt-4">
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              className="bg-destructive hover:bg-destructive/90"
                              onClick={() => deleteLabelMutation.mutate(label.id)}
                            >
                              Delete
                            </AlertDialogAction>
                          </div>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Create Section */}
        {isAdmin && (
          <div className="border-t">
            {showCreate ? (
              <div className="p-3 space-y-2.5 bg-slate-50/50">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-600">New Label</span>
                  <button onClick={() => setShowCreate(false)} className="text-slate-400 hover:text-slate-600">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <Input
                  placeholder="Label name"
                  value={newLabelName}
                  onChange={(e) => setNewLabelName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddLabel()}
                  className="h-8 text-sm"
                  autoFocus
                />
                <ColorDotPicker
                  value={newLabelColor}
                  onChange={setNewLabelColor}
                  size="sm"
                />
                <div className="flex items-center justify-between pt-1">
                  <LabelBadge label={newLabelName || "Preview"} color={newLabelColor} />
                  <Button
                    size="sm"
                    onClick={handleAddLabel}
                    disabled={createLabelMutation.isPending || !newLabelName.trim()}
                    className="h-7 px-3 text-xs gap-1"
                  >
                    <Plus className="h-3 w-3" />
                    Create
                  </Button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowCreate(true)}
                className="w-full px-3 py-2 text-xs font-medium text-blue-600 hover:bg-blue-50/50 transition-colors flex items-center gap-1.5"
              >
                <Plus className="h-3 w-3" />
                Create new label
              </button>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
