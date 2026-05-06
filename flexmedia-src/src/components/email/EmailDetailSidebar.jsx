import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Users, Link2, Trash2, ExternalLink } from "lucide-react";
import { useState, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { api } from "@/api/supabaseClient";
import { toast } from "sonner";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { useEntitySubscription } from "@/components/hooks/useEntitySubscription";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export default function EmailDetailSidebar({ thread, onProjectLinkClick, onProjectUnlink }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: currentUser } = useCurrentUser();
  const [showAssignMenu, setShowAssignMenu] = useState(false);
  const [unlinkConfirmOpen, setUnlinkConfirmOpen] = useState(false);

  // Get the primary message ID
  const messageId = useMemo(() => thread.messages[0]?.id, [thread.messages]);
  
  // Subscribe to real-time updates for this specific email message
  const liveMessage = useEntitySubscription('EmailMessage', messageId, thread.messages[0]);

  const { data: allUsers = [] } = useQuery({
    queryKey: ["users"],
    queryFn: () => api.entities.User.list(),
  });

  const assignMutation = useMutation({
    mutationFn: async (userId) => {
      // Update all messages in the thread with the assigned user
      await Promise.all(
        thread.messages.map(m =>
          api.entities.EmailMessage.update(m.id, { assigned_to: userId })
        )
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-messages"] });
      if (messageId) {
        queryClient.invalidateQueries({ queryKey: ['email-activity', messageId] });
      }
      toast.success("Email assigned");
    },
    onError: () => toast.error("Failed to assign email"),
  });

  // Use liveMessage if available, fallback to original
  const msg = liveMessage || thread.messages[0];

  return (
    <div className="space-y-4">
      {/* Linked Project Widget */}
      <Card className={msg.project_id ? "border-2 border-emerald-300 bg-emerald-50" : "border-2 border-slate-200"}>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <Link2 className="h-4.5 w-4.5" />
            Linked Project
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {msg.project_id ? (
            <>
              <button
                type="button"
                onClick={() => navigate(createPageUrl(`ProjectDetails?id=${msg.project_id}`))}
                className="w-full text-left bg-card p-3 rounded-lg border border-emerald-200 hover:border-emerald-400 hover:bg-emerald-100/40 transition-colors group"
                title="Open project"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-bold text-sm text-foreground truncate">{msg.project_title}</p>
                    <p className="text-xs text-emerald-700 mt-1.5 font-semibold">✓ Connected — click to open</p>
                  </div>
                  <ExternalLink className="h-3.5 w-3.5 text-emerald-700 opacity-60 group-hover:opacity-100 mt-0.5 flex-shrink-0" />
                </div>
              </button>
              <Button
                variant="outline"
                size="sm"
                className="w-full text-destructive hover:bg-red-50 border-red-200"
                onClick={() => setUnlinkConfirmOpen(true)}
              >
                <Trash2 className="h-3.5 w-3.5 mr-2" />
                Unlink
              </Button>
              <AlertDialog open={unlinkConfirmOpen} onOpenChange={setUnlinkConfirmOpen}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Unlink project?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will unlink <span className="font-semibold">{msg.project_title}</span> from this email thread. The email will no longer appear in the project's timeline.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={() => onProjectUnlink()}
                    >
                      Unlink
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          ) : (
            <>
              <p className="text-xs text-muted-foreground mb-3">No project linked. Link one to auto-populate fields.</p>
              <Button
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold"
                size="sm"
                onClick={() => onProjectLinkClick()}
              >
                <Link2 className="h-3.5 w-3.5 mr-2" />
                Link Project
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* Assign To Widget */}
      <Card className="border-2 border-slate-200">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-bold flex items-center gap-2">
            <Users className="h-4.5 w-4.5" />
            Assigned To
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {msg.assigned_to ? (
            <div className="bg-blue-50 p-3 rounded-lg border border-blue-200">
              <p className="text-sm font-bold text-foreground">{msg.assigned_to_name}</p>
              <Button
                variant="outline"
                size="sm"
                className="w-full mt-3 border-blue-200"
                onClick={() => setShowAssignMenu(true)}
              >
                Change
              </Button>
            </div>
          ) : (
            <>
              <p className="text-xs text-muted-foreground mb-3">Not assigned to anyone yet</p>
              <DropdownMenu open={showAssignMenu} onOpenChange={setShowAssignMenu}>
                <DropdownMenuTrigger asChild>
                  <Button className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold" size="sm">
                    Assign to...
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-56">
                  {allUsers
                    .filter((u) => u.role !== "master_admin")
                    .map((user) => (
                      <DropdownMenuItem
                        key={user.id}
                        onClick={() => {
                          assignMutation.mutate(user.id);
                          setShowAssignMenu(false);
                        }}
                        className="font-medium"
                      >
                        <span>{user.full_name}</span>
                        {msg.assigned_to === user.id && (
                          <span className="ml-auto text-emerald-600 font-bold">✓</span>
                        )}
                      </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </CardContent>
      </Card>

      {/* Email Details */}
      <Card className="border-2 border-slate-200">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-bold">Email Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-xs">
          <div>
            <p className="text-muted-foreground font-bold uppercase tracking-wider mb-2">From</p>
            <p className="font-medium truncate text-sm text-foreground">{msg.from_name || msg.from}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}