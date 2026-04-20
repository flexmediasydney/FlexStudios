import React from 'react';
import { AlertCircle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

export default function ProjectValidationBanner({ project, canEdit, onEditClick }) {
  // Skip backend call — validate directly from project data
  if (!project?.id || project?.project_owner_id) return null;

  return (
    <Alert className="border-orange-200 bg-orange-50 text-orange-900 dark:bg-orange-950/30 dark:border-orange-800 dark:text-orange-200 mb-4">
      <AlertCircle className="h-4 w-4 text-orange-600 dark:text-orange-400" />
      <AlertTitle>Project Configuration Issue</AlertTitle>
      <AlertDescription className="space-y-2">
        <p className="text-sm text-orange-800 dark:text-orange-300">Project owner is not assigned.</p>
        {canEdit && (
          <Button
            size="sm"
            variant="outline"
            onClick={onEditClick}
            className="border-orange-300 hover:bg-orange-100 dark:border-orange-800 dark:hover:bg-orange-900/40 w-full"
          >
            Fix Now
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}