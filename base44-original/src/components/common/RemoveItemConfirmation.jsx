import React from 'react';
import { AlertCircle, Loader2, Trash2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

export default function RemoveItemConfirmation({
  open,
  itemName,
  itemType = 'item',
  isLoading = false,
  onConfirm,
  onCancel,
  affectedCount = 0,
}) {
  return (
    <AlertDialog open={open} onOpenChange={onCancel}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
              <AlertCircle className="h-5 w-5 text-amber-600" />
            </div>
            <AlertDialogTitle>Remove {itemType}?</AlertDialogTitle>
          </div>
        </AlertDialogHeader>

        <AlertDialogDescription className="space-y-3 py-2">
          <p>
            Are you sure you want to remove <strong>{itemName}</strong>?
          </p>
          {affectedCount > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-2 text-sm">
              <p className="text-amber-900 font-medium">
                ⚠️ This may affect {affectedCount} related item{affectedCount !== 1 ? 's' : ''}.
              </p>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            This action cannot be undone.
          </p>
        </AlertDialogDescription>

        <div className="flex justify-end gap-2 pt-4">
          <AlertDialogCancel disabled={isLoading}>
            Keep It
          </AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={isLoading}
            className="gap-2"
          >
            {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Remove {itemType}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}