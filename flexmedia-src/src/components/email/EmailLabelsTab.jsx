import { useState, useEffect } from "react";
import { api } from "@/api/supabaseClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Plus, Trash2, Pencil, Check, X } from "lucide-react";
import { toast } from "sonner";
import { useCurrentUser } from "@/components/auth/PermissionGuard";

export default function EmailLabelsTab() {
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#3b82f6");
  // FIX 13: edit state includes both name and color
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("#3b82f6");
  // FIX 14: account selector
  const [selectedAccountId, setSelectedAccountId] = useState(null);

  const queryClient = useQueryClient();
  const { data: user } = useCurrentUser();

  // FIX 14: filter by user
  const { data: emailAccounts = [] } = useQuery({
    queryKey: ["email-accounts-labels", user?.id],
    queryFn: () =>
      api.entities.EmailAccount.filter({
        is_active: true,
        assigned_to_user_id: user?.id,
      }),
    enabled: !!user?.id,
  });

  // Set first account once loaded
  useEffect(() => {
    if (emailAccounts.length > 0 && !selectedAccountId) {
      setSelectedAccountId(emailAccounts[0].id);
    }
  }, [emailAccounts, selectedAccountId]);

  const accountId = selectedAccountId || emailAccounts[0]?.id;

  const { data: labels = [], isLoading } = useQuery({
    queryKey: ["email-labels-manage", accountId],
    queryFn: () => api.entities.EmailLabel.filter({ email_account_id: accountId }),
    enabled: !!accountId,
  });

  const createMutation = useMutation({
    mutationFn: (data) => api.entities.EmailLabel.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-labels-manage", accountId] });
      setNewName("");
      setNewColor("#3b82f6");
      toast.success("Label created.");
    },
    onError: () => toast.error("Failed to create label."),
  });

  // FIX 12: updateMutation now actually called from Save button
  const updateMutation = useMutation({
    mutationFn: ({ id, updates }) => api.entities.EmailLabel.update(id, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-labels-manage", accountId] });
      setEditingId(null);
      toast.success("Label updated.");
    },
    onError: () => toast.error("Failed to update label."),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => api.entities.EmailLabel.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-labels-manage", accountId] });
      toast.success("Label deleted.");
    },
    onError: () => toast.error("Failed to delete label."),
  });

  const handleAdd = () => {
    if (!newName.trim()) { toast.error("Name is required."); return; }
    if (!accountId) { toast.error("No email account found."); return; }
    if (labels.some((l) => l.name.toLowerCase() === newName.trim().toLowerCase())) {
      toast.error("A label with this name already exists.");
      return;
    }
    createMutation.mutate({ email_account_id: accountId, name: newName.trim(), color: newColor });
  };

  const startEdit = (label) => {
    setEditingId(label.id);
    setEditName(label.name);
    setEditColor(label.color);
  };

  // FIX 12: this now calls updateMutation
  const saveEdit = () => {
    if (!editName.trim()) { toast.error("Name cannot be empty."); return; }
    updateMutation.mutate({ id: editingId, updates: { name: editName.trim(), color: editColor } });
  };

  const isAdmin = user?.role === "master_admin" || user?.role === "employee";
  if (!isAdmin) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <p>Only admins can manage labels.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h3 className="text-lg font-semibold mb-1">Email Labels</h3>
        <p className="text-sm text-muted-foreground mb-5">
          Categorise and filter emails. Labels are per account.
        </p>

        {/* FIX 14: account selector for multi-account users */}
        {emailAccounts.length > 1 && (
          <div className="mb-5">
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Account</label>
            <Select value={accountId || ""} onValueChange={setSelectedAccountId}>
              <SelectTrigger className="w-72">
                <SelectValue placeholder="Select account" />
              </SelectTrigger>
              <SelectContent>
                {emailAccounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>{a.email_address}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Create */}
        <div className="bg-muted/40 border rounded-lg p-4 mb-6">
          <h4 className="text-sm font-medium mb-3">Create Label</h4>
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <label className="text-xs text-muted-foreground mb-1 block">Name</label>
              <Input
                placeholder="e.g. Hot Lead"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                className="h-8"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Color</label>
              <input
                type="color"
                value={newColor}
                onChange={(e) => setNewColor(e.target.value)}
                className="h-8 w-14 rounded border border-input cursor-pointer"
              />
            </div>
            <Button
              onClick={handleAdd}
              disabled={createMutation.isPending || !newName.trim()}
              className="h-8 gap-1.5"
            >
              <Plus className="h-3.5 w-3.5" /> Add
            </Button>
          </div>
          {newName.trim() && (
            <div className="mt-3 flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Preview:</span>
              <Badge style={{ backgroundColor: newColor }} className="text-white text-xs">
                {newName.trim()}
              </Badge>
            </div>
          )}
        </div>

        {/* List */}
        <div>
          <h4 className="text-sm font-medium mb-3">
            Labels
            {labels.length > 0 && (
              <span className="text-muted-foreground font-normal ml-1">({labels.length})</span>
            )}
          </h4>

          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : labels.length === 0 ? (
            <div className="text-center py-8 border rounded-lg text-muted-foreground">
              <p className="text-sm">No labels yet. Create one above.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {labels.map((label) => {
                const isEditing = editingId === label.id;
                return (
                  <div
                    key={label.id}
                    className={`flex items-center gap-3 p-3 border rounded-lg transition-colors ${
                      isEditing ? "border-primary bg-primary/5" : "hover:bg-muted/30"
                    }`}
                  >
                    {isEditing ? (
                      // FIX 12 + 13: inline edit with both name input and color picker
                      <>
                        <input
                          type="color"
                          value={editColor}
                          onChange={(e) => setEditColor(e.target.value)}
                          className="h-8 w-10 rounded border border-input cursor-pointer flex-shrink-0"
                        />
                        <Input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveEdit();
                            if (e.key === "Escape") setEditingId(null);
                          }}
                          className="h-8 flex-1"
                          autoFocus
                        />
                        <Badge
                          style={{ backgroundColor: editColor }}
                          className="text-white text-xs flex-shrink-0 min-w-[48px] justify-center"
                        >
                          {editName || label.name}
                        </Badge>
                        <Button
                          size="icon"
                          className="h-8 w-8 flex-shrink-0"
                          onClick={saveEdit}
                          disabled={updateMutation.isPending}
                        >
                          <Check className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 flex-shrink-0"
                          onClick={() => setEditingId(null)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </>
                    ) : (
                      <>
                        <div
                          className="w-3.5 h-3.5 rounded-full flex-shrink-0 ring-1 ring-black/10"
                          style={{ backgroundColor: label.color }}
                        />
                        <Badge
                          style={{ backgroundColor: label.color }}
                          className="text-white text-xs"
                        >
                          {label.name}
                        </Badge>
                        {/* FIX 15: remove fake message_count */}
                        <span className="text-xs text-muted-foreground font-mono ml-auto">
                          {label.color}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 flex-shrink-0"
                          onClick={() => startEdit(label)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 flex-shrink-0 text-destructive hover:text-destructive"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogTitle>Delete "{label.name}"?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This removes the label from all emails that have it.
                            </AlertDialogDescription>
                            <div className="flex justify-end gap-3 mt-4">
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                className="bg-destructive hover:bg-destructive/90"
                                onClick={() => deleteMutation.mutate(label.id)}
                              >
                                Delete
                              </AlertDialogAction>
                            </div>
                          </AlertDialogContent>
                        </AlertDialog>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}