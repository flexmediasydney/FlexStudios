import { api } from "@/api/supabaseClient";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fmtDate } from "@/components/utils/dateUtils";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

export default function TimerLogActions({ log, currentUser, isMasterAdmin }) {
  const queryClient = useQueryClient();
  const isOwner = log.user_id === currentUser?.id;
  const canEdit = isMasterAdmin || isOwner;

  const deleteMutation = useMutation({
    mutationFn: () => api.entities.TaskTimeLog.delete(log.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['time-logs'] });
      queryClient.invalidateQueries({ queryKey: ['project-tasks'] });
      toast.success("Time log deleted");
    },
    onError: () => {
      toast.error("Failed to delete log");
    }
  });

  if (!canEdit) return null;

  return (
    <div className="flex items-center gap-1">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button size="icon" variant="ghost" className="h-6 w-6">
            <Trash2 className="h-3 w-3 text-destructive" />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Time Log?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove {log.user_name}'s time log from {fmtDate(log.created_date)}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}