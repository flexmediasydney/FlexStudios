import { useState, useEffect } from "react";
import { api } from "@/api/supabaseClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import LabelBadge, { ColorDotPicker, LABEL_COLORS } from "./LabelBadge";

export default function EmailLabelsTab() {
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(LABEL_COLORS[5]);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState(LABEL_COLORS[5]);
  const [selectedAccountId, setSelectedAccountId] = useState(null);

  const queryClient = useQueryClient();
  const { data: user } = useCurrentUser();

  const { data: emailAccounts = [] } = useQuery({
    queryKey: ["email-accounts-labels", user?.id],
    queryFn: () =>
      api.entities.EmailAccount.filter({
        is_active: true,
        assigned_to_user_id: user?.id,
      }),
    enabled: !!user?.id,
  });

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
      queryClient.invalidateQueries({ queryKey: ["email-labels", accountId] });
      setNewName("");
      setNewColor(LABEL_COLORS[5]);
      toast.success("Label created");
    },
    onError: () => toast.error("Failed to create label"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, updates }) => api.entities.EmailLabel.update(id, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-labels-manage", accountId] });
      queryClient.invalidateQueries({ queryKey: ["email-labels", accountId] });
      setEditingId(null);
      toast.success("Label updated");
    },
    onError: () => toast.error("Failed to update label"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => api.entities.EmailLabel.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-labels-manage", accountId] });
      queryClient.invalidateQueries({ queryKey: ["email-labels", accountId] });
      toast.success("Label deleted");
    },
    onError: () => toast.error("Failed to delete label"),
  });

  const handleAdd = () => {
    if (!newName.trim()) { toast.error("Name is required"); return; }
    if (!accountId) { toast.error("No email account found"); return; }
    if (labels.some((l) => l.name.toLowerCase() === newName.trim().toLowerCase())) {
      toast.error("Label already exists");
      return;
    }
    createMutation.mutate({ email_account_id: accountId, name: newName.trim(), color: newColor });
  };

  const startEdit = (label) => {
    setEditingId(label.id);
    setEditName(label.name);
    setEditColor(label.color || LABEL_COLORS[5]);
  };

  const saveEdit = () => {
    if (!editName.trim()) { toast.error("Name cannot be empty"); return; }
    // Check for duplicate name (excluding the label being edited)
    if (labels.some((l) => l.id !== editingId && l.name.toLowerCase() === editName.trim().toLowerCase())) {
      toast.error("A label with this name already exists");
      return;
    }
    updateMutation.mutate({ id: editingId, updates: { name: editName.trim(), color: editColor } });
  };

  const isAdmin = user?.role === "master_admin" || user?.role === "admin";
  if (!isAdmin) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <p>Only admins can manage labels.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-xl">
      <div>
        <h3 className="text-lg font-semibold mb-1">Email Labels</h3>
        <p className="text-sm text-muted-foreground mb-5">
          Categorise and filter emails. Labels are per account.
        </p>

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

        {/* Create New Label */}
        <div className="bg-slate-50 border rounded-xl p-4 mb-6 space-y-3">
          <h4 className="text-sm font-semibold text-foreground/80">Create Label</h4>
          <Input
            placeholder="e.g. Hot Lead, Follow Up, Urgent..."
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            className="h-9"
          />
          <div>
            <p className="text-xs text-muted-foreground mb-2">Color</p>
            <ColorDotPicker value={newColor} onChange={setNewColor} size="md" />
          </div>
          <div className="flex items-center justify-between pt-1">
            {newName.trim() ? (
              <LabelBadge label={newName.trim()} color={newColor} />
            ) : (
              <span />
            )}
            <Button
              onClick={handleAdd}
              disabled={createMutation.isPending || !newName.trim()}
              size="sm"
              className="gap-1.5"
            >
              <Plus className="h-3.5 w-3.5" /> Create
            </Button>
          </div>
        </div>

        {/* Labels List */}
        <div>
          <h4 className="text-sm font-semibold text-foreground/80 mb-3">
            Your Labels
            {labels.length > 0 && (
              <span className="text-muted-foreground font-normal ml-1.5">({labels.length})</span>
            )}
          </h4>

          {isLoading ? (
            <p className="text-sm text-muted-foreground py-4">Loading labels...</p>
          ) : labels.length === 0 ? (
            <div className="text-center py-10 border rounded-xl text-muted-foreground bg-slate-50/50">
              <p className="text-sm">No labels yet. Create one above to get started.</p>
            </div>
          ) : (
            <div className="border rounded-xl overflow-hidden divide-y">
              {labels.map((label) => {
                const isEditing = editingId === label.id;
                return (
                  <div
                    key={label.id}
                    className={`flex items-center gap-3 px-4 py-3 transition-colors ${
                      isEditing ? "bg-blue-50/50" : "hover:bg-muted/50/50"
                    }`}
                  >
                    {isEditing ? (
                      <div className="flex-1 space-y-2.5">
                        <div className="flex gap-2 items-center">
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
                          <Button size="sm" className="h-8 px-3 gap-1" onClick={saveEdit} disabled={updateMutation.isPending}>
                            <Check className="h-3.5 w-3.5" /> Save
                          </Button>
                          <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => setEditingId(null)}>
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                        <ColorDotPicker value={editColor} onChange={setEditColor} size="sm" />
                        <div className="flex items-center gap-2 pt-1">
                          <span className="text-xs text-muted-foreground">Preview:</span>
                          <LabelBadge label={editName || label.name} color={editColor} />
                        </div>
                      </div>
                    ) : (
                      <>
                        <div
                          className="w-3 h-3 rounded-full flex-shrink-0 ring-1 ring-black/10"
                          style={{ backgroundColor: label.color || "#64748b" }}
                        />
                        <span className="text-sm font-medium text-foreground/80 flex-1">{label.name}</span>
                        <LabelBadge label={label.name} color={label.color} className="text-[10px]" />
                        <div className="flex gap-1 ml-2">
                          <button
                            className="p-1.5 hover:bg-muted rounded-md transition-colors"
                            onClick={() => startEdit(label)}
                            title="Edit label"
                          >
                            <Pencil className="h-3.5 w-3.5 text-muted-foreground/70" />
                          </button>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <button
                                className="p-1.5 hover:bg-red-50 rounded-md transition-colors"
                                title="Delete label"
                              >
                                <Trash2 className="h-3.5 w-3.5 text-muted-foreground/70 hover:text-red-500" />
                              </button>
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
                        </div>
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
