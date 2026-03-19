import React from 'react';
import { Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function SubmitButtonGuard({
  isLoading,
  isDisabled,
  hasErrors,
  unsavedChanges,
  isEdit,
  onClick,
  children,
}) {
  const disabled = isLoading || isDisabled || hasErrors;
  const showWarning = hasErrors && unsavedChanges;

  return (
    <div className="flex flex-col gap-2">
      {showWarning && (
        <div className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-red-50 border border-red-200">
          <AlertCircle className="h-4 w-4 text-red-600 flex-shrink-0" />
          <p className="text-xs text-red-700 font-medium">Fix errors before saving</p>
        </div>
      )}
      <Button
        type="submit"
        disabled={disabled}
        onClick={onClick}
        title={disabled ? 'Please fix errors and fill required fields' : 'Ctrl+S'}
        className="shadow-sm hover:shadow-md transition-shadow focus:ring-2 focus:ring-primary gap-2"
        aria-label={`${isEdit ? 'Save' : 'Create'} - Ctrl+S`}
      >
        {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
        {isLoading ? (isEdit ? 'Saving...' : 'Creating...') : (
          <>
            <CheckCircle className="h-4 w-4" />
            {isEdit ? 'Save' : 'Create'}
          </>
        )}
      </Button>
    </div>
  );
}