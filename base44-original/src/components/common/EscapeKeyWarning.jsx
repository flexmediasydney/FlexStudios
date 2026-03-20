import React, { useEffect } from 'react';
import { AlertCircle } from 'lucide-react';

/**
 * Escape Key Warning Hook
 * Shows warning when user tries to close dialog with unsaved changes
 */
export function useEscapeKeyWarning(unsavedChanges = false) {
  useEffect(() => {
    if (!unsavedChanges) return;

    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        // If there's a modal dialog open with unsaved changes,
        // we intercept the escape key and show a warning instead
        e.preventDefault();
        const confirmed = confirm(
          'You have unsaved changes. Are you sure you want to close?\n\nClick OK to discard changes, or Cancel to keep editing.'
        );
        if (confirmed) {
          // User confirmed - they can now close
          // The dialog/page should handle the actual closing
          return true;
        }
        return false;
      }
    };

    window.addEventListener('keydown', handleEscape, true);
    return () => window.removeEventListener('keydown', handleEscape, true);
  }, [unsavedChanges]);
}

/**
 * Escape Key Warning Banner
 * Visual indicator that escape key is monitored
 */
export function EscapeKeyWarningBanner({ unsavedChanges = false, className = '' }) {
  if (!unsavedChanges) return null;

  return (
    <div className={`flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2 ${className}`}>
      <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
      <span>Press Escape to close (unsaved changes will be lost)</span>
    </div>
  );
}