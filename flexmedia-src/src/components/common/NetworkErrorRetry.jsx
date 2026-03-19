import React from 'react';
import { AlertCircle, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Network Error Retry Component
 * Shows error with prominent "Try Again" button
 */
export default function NetworkErrorRetry({
  error = null,
  onRetry,
  isRetrying = false,
  className = '',
  variant = 'default'
}) {
  if (!error) return null;

  const isNetworkError = error?.message?.toLowerCase().includes('network') || 
                        error?.message?.toLowerCase().includes('failed to fetch');

  return (
    <div className={cn(
      'flex items-center justify-between gap-4 p-4 rounded-lg border',
      'bg-destructive/5 border-destructive/20',
      className
    )}>
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0" />
        <div className="min-w-0">
          <p className="font-medium text-sm text-destructive">
            {isNetworkError ? 'Connection Error' : 'Error'}
          </p>
          <p className="text-xs text-destructive/80 truncate">
            {error?.message || 'Something went wrong'}
          </p>
        </div>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onRetry}
        disabled={isRetrying}
        className="gap-2 flex-shrink-0 border-destructive/30 hover:bg-destructive/10"
      >
        <RotateCw className={cn(
          'h-4 w-4',
          isRetrying && 'animate-spin'
        )} />
        {isRetrying ? 'Retrying...' : 'Try Again'}
      </Button>
    </div>
  );
}