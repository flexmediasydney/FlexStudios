import React from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Real-time Validation Feedback
 * Shows validation state while user types
 * Green checkmark for valid, red error for invalid
 */
export default function RealtimeValidationFeedback({ 
  isValid = null, 
  errorMessage = '', 
  showOnValid = true,
  className = ''
}) {
  if (isValid === null) return null;
  
  const isError = isValid === false;
  
  return (
    <div 
      className={cn(
        'flex items-center gap-1.5 mt-1.5 text-xs transition-all',
        isError ? 'text-destructive' : 'text-green-600',
        className
      )}
      role="status"
      aria-live="polite"
    >
      {isError ? (
        <>
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
          <span>{errorMessage || 'Invalid input'}</span>
        </>
      ) : showOnValid && (
        <>
          <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />
          <span>Looks good</span>
        </>
      )}
    </div>
  );
}