import React from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { AlertTriangle } from 'lucide-react';

/**
 * Bulk Action Confirmation Dialog
 * Warns user before bulk delete/update operations
 */
export default function BulkActionConfirmation({
  open = false,
  onOpenChange,
  actionType = 'delete', // 'delete' | 'update' | 'archive'
  itemCount = 0,
  itemLabel = 'items',
  onConfirm,
  onCancel,
  isLoading = false
}) {
  const actionLabels = {
    delete: { verb: 'delete', color: 'destructive', bgColor: 'bg-destructive' },
    update: { verb: 'update', color: 'primary', bgColor: 'bg-primary' },
    archive: { verb: 'archive', color: 'secondary', bgColor: 'bg-secondary' }
  };

  const action = actionLabels[actionType] || actionLabels.delete;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            <AlertDialogTitle>
              {action.verb.charAt(0).toUpperCase() + action.verb.slice(1)} {itemCount} {itemLabel}?
            </AlertDialogTitle>
          </div>
        </AlertDialogHeader>
        <AlertDialogDescription>
          <p>
            You're about to <strong>{action.verb}</strong> <strong>{itemCount} {itemLabel}</strong>.
          </p>
          {actionType === 'delete' && (
            <p className="text-destructive font-medium mt-2">This action cannot be undone.</p>
          )}
        </AlertDialogDescription>
        <div className="flex gap-3 pt-4">
          <AlertDialogCancel disabled={isLoading}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={isLoading}
            className={action.color === 'destructive' ? 'bg-destructive hover:bg-destructive/90' : ''}
          >
            {isLoading ? `${action.verb.charAt(0).toUpperCase() + action.verb.slice(1)}ing...` : `Yes, ${action.verb}`}
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}