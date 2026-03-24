import { useState, useEffect } from "react";
import { api } from "@/api/supabaseClient";
import { refetchEntityList } from "@/components/hooks/useEntityData";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { fmtTimestampCustom, fixTimestamp } from "@/components/utils/dateUtils";
import { Trash2 } from "lucide-react";
import { formatDuration, getStatusColor } from "./useEffortLogging";
import { toast } from "sonner";

/** Compute live seconds for a log, accounting for running timers whose total_seconds is stale */
function computeLiveSeconds(log) {
  if (!log) return 0;
  if (log.status === 'running' && log.is_active && log.start_time) {
    return Math.max(0, Math.floor((Date.now() - new Date(fixTimestamp(log.start_time)).getTime()) / 1000) - (log.paused_duration || 0));
  }
  return log.total_seconds || 0;
}

export default function TimerLogDetailModal({ log, onClose, currentUser, isMasterAdmin }) {
  const queryClient = useQueryClient();
  const [editMode, setEditMode] = useState(false);
  const [hours, setHours] = useState(Math.floor((log.total_seconds || 0) / 3600));
  const [minutes, setMinutes] = useState(Math.floor(((log.total_seconds || 0) % 3600) / 60));

  // Tick every second when viewing a running timer to keep duration live
  const [, setTick] = useState(0);
  const isRunning = log.is_active && log.status === 'running';
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  // Reset edit state when a different log is viewed
  useEffect(() => {
    setHours(Math.floor((log.total_seconds || 0) / 3600));
    setMinutes(Math.floor(((log.total_seconds || 0) % 3600) / 60));
    setEditMode(false);
  }, [log.id, log.total_seconds]);

  const { data: task } = useQuery({
    queryKey: ["task", log.task_id],
    queryFn: () => api.entities.ProjectTask.filter({ id: log.task_id }, null, 1).then(r => r[0] || null),
    enabled: !!log.task_id
  });

  const isOwner = log.user_id === currentUser?.id;
  const isActive = log.is_active && (log.status === 'running' || log.status === 'paused');
  const canEdit = (isMasterAdmin || isOwner) && !isActive;

  // Block non-integer characters in number inputs
  const blockNonInteger = (e) => {
    if (['e', 'E', '+', '-', '.'].includes(e.key)) e.preventDefault();
  };

  const updateMutation = useMutation({
    mutationFn: () => {
      const h = Math.max(0, Math.min(24, Math.floor(Number(hours) || 0)));
      const m = Math.max(0, Math.min(59, Math.floor(Number(minutes) || 0)));
      const totalSeconds = h * 3600 + m * 60;
      if (totalSeconds <= 0) throw new Error("Duration must be greater than 0");
      if (totalSeconds > 86400) throw new Error("Cannot log more than 24 hours per entry");
      return api.entities.TaskTimeLog.update(log.id, { total_seconds: totalSeconds });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['time-logs'] });
      queryClient.invalidateQueries({ queryKey: ['project-tasks'] });
      refetchEntityList("TaskTimeLog");
      refetchEntityList("ProjectTask");
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
      queryClient.invalidateQueries({ queryKey: ['time-logs'] });
      queryClient.invalidateQueries({ queryKey: ['project-tasks'] });
      refetchEntityList("TaskTimeLog");
      refetchEntityList("ProjectTask");
      toast.success("Time log deleted");
      onClose();
    },
    onError: () => {
      toast.error("Failed to delete");
    }
  });

  const colors = getStatusColor(log.status);

  return (
    <Dialog open={!!log} onOpenChange={(open) => { if (!open) onClose(); }}>
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
                <Label className="text-xs" htmlFor="edit-hours">Hours (0-24)</Label>
                <Input
                  id="edit-hours"
                  type="number"
                  min="0"
                  max="24"
                  step="1"
                  value={hours}
                  onChange={(e) => setHours(Math.min(24, Math.max(0, parseInt(e.target.value) || 0)))}
                  onKeyDown={blockNonInteger}
                  className="mt-1 text-sm"
                  aria-label="Hours"
                  disabled={updateMutation.isPending}
                />
              </div>
              <div>
                <Label className="text-xs" htmlFor="edit-minutes">Minutes (0-59)</Label>
                <Input
                  id="edit-minutes"
                  type="number"
                  min="0"
                  max="59"
                  step="1"
                  value={minutes}
                  onChange={(e) => setMinutes(Math.min(59, Math.max(0, parseInt(e.target.value) || 0)))}
                  onKeyDown={blockNonInteger}
                  className="mt-1 text-sm"
                  aria-label="Minutes"
                  disabled={updateMutation.isPending}
                />
              </div>
            </div>
          ) : (
            <div className="pt-2 border-t">
              <p className="text-xs text-muted-foreground">Total Duration</p>
              <p className="text-2xl font-bold">{formatDuration(computeLiveSeconds(log))}</p>
            </div>
          )}

          {isActive && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 p-2 rounded">
              Timer is {log.status} — pause and finish before editing.
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
                      disabled={deleteMutation.isPending}
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