import React, { useState } from 'react';
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
 * Overwrite Confirmation Dialog
 * Warns user when they're about to overwrite existing data
 */
export default function OverwriteConfirmation({
  open = false,
  onOpenChange,
  itemType = 'Item',
  itemName = '',
  existingValue = '',
  newValue = '',
  onConfirm,
  onCancel,
  isLoading = false
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-600" />
            <AlertDialogTitle>Overwrite Existing Data?</AlertDialogTitle>
          </div>
        </AlertDialogHeader>
        <AlertDialogDescription className="space-y-2">
          <p>
            You're about to overwrite the {itemType.toLowerCase()} <strong>{itemName}</strong>.
          </p>
          <div className="bg-muted p-3 rounded-lg space-y-2 text-xs">
            <div>
              <span className="text-muted-foreground">Current: </span>
              <code className="bg-background px-2 py-1 rounded">{existingValue}</code>
            </div>
            <div>
              <span className="text-muted-foreground">New: </span>
              <code className="bg-background px-2 py-1 rounded">{newValue}</code>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">This action cannot be undone immediately.</p>
        </AlertDialogDescription>
        <div className="flex gap-3 pt-4">
          <AlertDialogCancel disabled={isLoading}>Keep Current</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={isLoading}
            className="bg-amber-600 hover:bg-amber-700"
          >
            {isLoading ? 'Overwriting...' : 'Yes, Overwrite'}
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}