import { useState } from "react";
import { api } from "@/api/supabaseClient";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertCircle } from "lucide-react";
import { toast } from "sonner";

export default function ManualTimeEntryDialog({ open, onClose, task, project, user, role }) {
  // All hooks must be called unconditionally (before any returns)
  const queryClient = useQueryClient();
  const [hours, setHours] = useState("");
  const [minutes, setMinutes] = useState("");
  const [error, setError] = useState("");

  // Validate role param (before mutation)
  const validRole = role && ["photographer", "videographer", "image_editor", "video_editor", "admin"].includes(role)
    ? role
    : "admin";

  const mutation = useMutation({
    mutationFn: async () => {
      // Fix 8: Prevent if task became locked during dialog open
      if (task?.is_locked) {
        throw new Error("Task is locked - cannot log time");
      }

      // Fix 9-10: Validate and parse numbers safely
      let h = 0, m = 0;
      try {
        h = hours ? Math.max(0, parseInt(hours, 10)) : 0;
        m = minutes ? Math.max(0, parseInt(minutes, 10)) : 0;
      } catch (e) {
        throw new Error("Invalid hours or minutes");
      }

      // Fix 11: Clamp to reasonable values (max 24 hours)
      if (h > 24 || m > 59) {
        throw new Error("Hours must be 0-24, minutes 0-59");
      }

      const totalSeconds = h * 3600 + m * 60;

      // Fix 12: Validate total is positive and reasonable
      if (totalSeconds <= 0) {
        throw new Error("Please enter a valid duration (at least 1 minute)");
      }

      if (totalSeconds > 86400) { // max 24 hours
        throw new Error("Cannot log more than 24 hours at once");
      }

      // Fix 13: Validate all required fields exist
      if (!project?.id || !task?.id || !user?.id || !user?.full_name || !user?.email) {
        throw new Error("Missing required user or project information");
      }

      // end_time = now, start_time = now minus the logged duration
      // This gives the Effort Logging tab a meaningful time range to display
      const endTime = new Date().toISOString();
      const startTime = new Date(Date.now() - totalSeconds * 1000).toISOString();

      return api.entities.TaskTimeLog.create({
        project_id: project.id,
        task_id: task.id,
        user_id: user.id,
        user_name: user.full_name,
        user_email: user.email,
        role: validRole,
        status: "completed",
        is_active: false,
        is_manual: true,
        start_time: startTime,
        end_time: endTime,
        total_seconds: totalSeconds,
        paused_duration: 0,
        team_id: user.team_id || null,
        team_name: user.team_name || null
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['time-logs'] });
      queryClient.invalidateQueries({ queryKey: ['project-tasks'] });
      if (project?.id) {
        api.entities.ProjectActivity.create({
          project_id: project.id,
          project_title: project.title || project.property_address || '',
          action: 'manual_time_entry',
          description: `Manual time entry: ${hours || 0}h ${minutes || 0}m on "${task?.title || 'Task'}" by ${user?.full_name || 'Unknown'}`,
          user_name: user?.full_name || 'Unknown',
          user_email: user?.email || '',
        }).catch(() => {});
      }
      setHours("");
      setMinutes("");
      setError("");
      if (onClose) onClose();
    },
    onError: (err) => toast.error(err?.message || "Failed to log time entry"),
  });

  // Now we can safely guard against invalid props
  if (!task || !project || !user) {
    return null;
  }

  if (task?.is_locked === true) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg">Log Manual Time</DialogTitle>
          <DialogDescription className="text-sm">
            {task?.title} • {validRole}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="hours" className="text-xs font-medium">Hours (0-24)</Label>
              <Input
                id="hours"
                type="number"
                min="0"
                max="24"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                placeholder="0"
                className="mt-1.5 h-9"
                disabled={mutation.isPending}
                aria-label="Hours"
              />
            </div>
            <div>
              <Label htmlFor="minutes" className="text-xs font-medium">Minutes (0-59)</Label>
              <Input
                id="minutes"
                type="number"
                min="0"
                max="59"
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                placeholder="0"
                className="mt-1.5 h-9"
                disabled={mutation.isPending}
                aria-label="Minutes"
              />
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 text-xs text-red-600 bg-red-50 p-3 rounded border border-red-200">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="text-xs text-muted-foreground bg-gray-50 p-2 rounded">
            Total: <span className="font-semibold">{hours || 0}h {minutes || 0}m</span>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button 
            onClick={() => mutation.mutate()} 
            disabled={mutation.isPending || (!hours && !minutes)}
            className="bg-primary hover:bg-primary/90"
          >
            {mutation.isPending ? "Saving..." : "Log Time"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}