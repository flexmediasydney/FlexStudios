import React, { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { refetchEntityList } from "@/components/hooks/useEntityData";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

export default function InviteUserDialog({ open, onClose, onSuccess }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState("employee");
  const [loading, setLoading] = useState(false);

  // Reset form state when dialog opens to prevent stale data from previous session
  useEffect(() => {
    if (open) {
      setEmail("");
      setFullName("");
      setRole("employee");
      setLoading(false);
    }
  }, [open]);

  const handleSubmit = async (e) => {
    e.preventDefault();

    const trimmedEmail = email.trim().toLowerCase();
    const trimmedName = fullName.trim();

    // Validate email format (HTML type="email" is easily bypassed)
    if (!trimmedEmail) {
      toast.error("Email address is required");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      toast.error("Please enter a valid email address");
      return;
    }

    // Validate name is not whitespace-only if provided
    if (fullName && !trimmedName) {
      toast.error("Name cannot be only whitespace");
      return;
    }
    if (trimmedName.length > 120) {
      toast.error("Name must be 120 characters or fewer");
      return;
    }

    setLoading(true);

    try {
      await api.users.inviteUser(trimmedEmail, role, trimmedName || undefined);
      await queryClient.invalidateQueries({ queryKey: ["users"] });
      await queryClient.invalidateQueries({ queryKey: ["internal-teams"] });
      refetchEntityList("User");
      refetchEntityList("InternalTeam");
      toast.success("Invitation sent successfully!");
      setEmail("");
      setFullName("");
      setRole("employee");
      onSuccess?.();
      onClose();
    } catch (error) {
      toast.error(error.message || "Failed to send invitation");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite New User</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="email">Email Address *</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
              required
              disabled={loading}
              maxLength={100}
            />
          </div>

          <div>
            <Label htmlFor="fullName">Full Name</Label>
            <Input
              id="fullName"
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Jane Smith"
              disabled={loading}
              maxLength={120}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Optional. The user can change this after accepting the invite.
            </p>
          </div>

          <div>
            <Label htmlFor="role">Role *</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="master_admin">Owner</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="manager">Manager</SelectItem>
                <SelectItem value="employee">Staff</SelectItem>
                <SelectItem value="contractor">Contractor</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              {role === "master_admin" && "Full access to all settings, users, and data management"}
              {role === "admin" && "Settings access, can manage integrations and products"}
              {role === "manager" && "Can manage projects, contacts, view pricing and reports"}
              {role === "employee" && "Standard access to projects, tasks, and day-to-day operations"}
              {role === "contractor" && "Limited access — assigned tasks and field mode only"}
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading || !email.trim()}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Send Invitation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}