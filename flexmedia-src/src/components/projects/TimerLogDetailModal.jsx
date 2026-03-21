import { useState } from "react";
import { api } from "@/api/supabaseClient";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { fmtTimestampCustom } from "@/components/utils/dateUtils";
import { Trash2 } from "lucide-react";
import { formatDuration, getStatusColor } from "./useEffortLogging";
import { toast } from "sonner";

export default function TimerLogDetailModal({ log, onClose, currentUser, isMasterAdmin }) {
  const [editMode, setEditMode] = useState(false);
  const [hours, setHours] = useState(Math.floor(log.total_seconds / 3600));
  const [minutes, setMinutes] = useState(Math.floor((log.total_seconds % 3600) / 60));

  const { data: task } = useQuery({
    queryKey: ["task", log.task_id],
    queryFn: () => api.entities.ProjectTask.filter({ id: log.task_id }, null, 1).then(r => r[0] || null),
    enabled: !!log.task_id
  });

  const isOwner = log.user_id === currentUser?.id;
  const canEdit = isMasterAdmin || isOwner;

  const updateMutation = useMutation({
    mutationFn: () => {
      const totalSeconds = hours * 3600 + minutes * 60;
      if (totalSeconds <= 0) throw new Error("Duration must be greater than 0");
      return api.entities.TaskTimeLog.update(log.id, { total_seconds: totalSeconds });
    },
    onSuccess: () => {
      toast.success("Time log updated");
      setEditMode(false);
      onClose();
    },
    onError: (err) => {
      toast.error(err.message || "Failed to update");
    }
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.entities.TaskTimeLog.delete(log.id),
    onSuccess: () => {
      toast.success("Time log deleted");
      onClose();
    },
    onError: () => {
      toast.error("Failed to delete");
    }
  });

  const colors = getStatusColor(log.status);

  return (
    <Dialog open={!!log} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Time Log Details</DialogTitle>
          <DialogDescription>
            {log.user_name} • {task?.title}
          </DialogDescription>
        </DialogHeader>

        <div className={`rounded-lg p-4 ${colors.bg} border ${colors.border} space-y-3`}>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-muted-foreground">Person</p>
              <p className="font-semibold text-sm">{log.user_name}</p>
              <p className="text-xs text-muted-foreground">{log.user_email}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Role</p>
              <Badge variant="secondary" className="capitalize mt-1">{log.role}</Badge>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-muted-foreground">Status</p>
              <Badge variant="outline" className={`text-xs ${colors.text} mt-1`}>{log.status}</Badge>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Logged</p>
              <p className="font-mono text-xs mt-1">{fmtTimestampCustom(log.created_date, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 pt-2 border-t">
            <div>
              <p className="text-xs text-muted-foreground">Start</p>
              <p className="font-mono text-sm">{fmtTimestampCustom(log.start_time, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">End</p>
              <p className="font-mono text-sm">{fmtTimestampCustom(log.end_time, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</p>
            </div>
          </div>

          {editMode ? (
            <div className="grid grid-cols-2 gap-3 pt-2 border-t">
              <div>
                <Label className="text-xs">Hours</Label>
                <Input
                  type="number"
                  min="0"
                  value={hours}
                  onChange={(e) => setHours(parseInt(e.target.value) || 0)}
                  className="mt-1 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs">Minutes</Label>
                <Input
                  type="number"
                  min="0"
                  max="59"
                  value={minutes}
                  onChange={(e) => setMinutes(parseInt(e.target.value) || 0)}
                  className="mt-1 text-sm"
                />
              </div>
            </div>
          ) : (
            <div className="pt-2 border-t">
              <p className="text-xs text-muted-foreground">Total Duration</p>
              <p className="text-2xl font-bold">{formatDuration(log.total_seconds)}</p>
            </div>
          )}

          {log.is_manual && (
            <div className="text-xs text-muted-foreground bg-muted/50 p-2 rounded">
              📝 Manual entry
            </div>
          )}
        </div>

        <DialogFooter className="flex items-center justify-between">
          <div>
            {canEdit && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" className="text-destructive hover:text-destructive">
                    <Trash2 className="h-4 w-4 mr-1" />
                    Delete
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete Time Log?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This cannot be undone.
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
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Close</Button>
            {canEdit && (
              <>
                {editMode ? (
                  <>
                    <Button variant="outline" onClick={() => setEditMode(false)}>Cancel</Button>
                    <Button onClick={() => updateMutation.mutate()} disabled={updateMutation.isPending}>
                      {updateMutation.isPending ? "Saving..." : "Save"}
                    </Button>
                  </>
                ) : (
                  <Button onClick={() => setEditMode(true)}>Edit</Button>
                )}
              </>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}