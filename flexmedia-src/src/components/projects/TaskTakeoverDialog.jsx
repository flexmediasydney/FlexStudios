import React from "react";
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

/**
 * Confirmation dialog for task takeover on completion.
 *
 * Props:
 *   - pending: { task, currentUser, kind: "team" | "individual" } | null
 *   - onApprove: () => void — user confirms takeover
 *   - onCancel:  () => void — user aborts completion
 */
export default function TaskTakeoverDialog({ pending, onApprove, onCancel }) {
  const open = !!pending;
  const task = pending?.task;
  const kind = pending?.kind;

  const title = kind === "team" ? "Take Over Team Task?" : "Take Over This Task?";
  const previousOwner =
    kind === "team"
      ? (task?.assigned_to_team_name || "a team")
      : (task?.assigned_to_name || "another user");

  const description =
    kind === "team"
      ? `This task is assigned to ${previousOwner}. Completing it will reassign it to you.`
      : `This task is assigned to ${previousOwner}. Completing it will reassign it to you.`;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Radix fires onOpenChange(false) when user dismisses (Esc, click outside).
        // Treat dismissal as cancel so the completion body does NOT run.
        if (!next) onCancel?.();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>
            {description}
            {task?.title ? (
              <>
                <br />
                <span className="mt-2 inline-block text-foreground font-medium">
                  &ldquo;{task.title}&rdquo;
                </span>
              </>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onApprove}>
            Take Over &amp; Complete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
