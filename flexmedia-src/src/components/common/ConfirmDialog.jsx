import { useState, useEffect } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Loader2 } from "lucide-react";

export default function ConfirmDialog({ open, title, description, confirmText = "Confirm", cancelText = "Cancel", onConfirm, onCancel, danger = false, confirmDisabled = false }) {
  const [isPending, setIsPending] = useState(false);

  // Reset pending state when dialog opens/closes
  useEffect(() => {
    if (!open) setIsPending(false);
  }, [open]);

  const handleConfirm = async () => {
    if (isPending) return;
    setIsPending(true);
    try {
      await onConfirm?.();
    } catch (err) {
      // Let caller handle errors, but always reset pending state
      console.error("[ConfirmDialog] confirm action failed:", err);
    } finally {
      setIsPending(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(isOpen) => !isOpen && !isPending && onCancel?.()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel} disabled={isPending}>{cancelText}</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={confirmDisabled || isPending}
            className={danger ? "bg-destructive hover:bg-destructive/90" : ""}
          >
            {isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            {confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}