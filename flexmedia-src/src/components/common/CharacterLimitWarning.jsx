import React from 'react';
import { AlertCircle } from 'lucide-react';

export default function CharacterLimitWarning({ current, max, showWarning = true }) {
  const percentage = (current / max) * 100;
  const isWarning = percentage >= 80;
  const isError = percentage >= 100;

  const barColor = isError ? 'bg-red-500' : isWarning ? 'bg-amber-500' : 'bg-primary/40';

  if (!showWarning || current < max * 0.7) {
    return (
      <div className="space-y-1">
        <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
          <div className={`h-full rounded-full bg-primary/30 transition-all`} style={{ width: `${Math.min(percentage, 100)}%` }} />
        </div>
        <p className="text-xs text-muted-foreground text-right tabular-nums font-medium">
          {current} / {max}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${barColor} transition-all`} style={{ width: `${Math.min(percentage, 100)}%` }} />
      </div>
      <div className="flex items-center justify-end gap-1.5">
        {isError ? (
          <AlertCircle className="h-3.5 w-3.5 text-red-500" />
        ) : isWarning ? (
          <AlertCircle className="h-3.5 w-3.5 text-amber-500" />
        ) : null}
        <p className={`text-xs font-medium tabular-nums ${
          isError ? 'text-red-600' : isWarning ? 'text-amber-600' : 'text-muted-foreground'
        }`}>
          {current} / {max}
        </p>
      </div>
    </div>
  );
}