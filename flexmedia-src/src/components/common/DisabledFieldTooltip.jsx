import React from 'react';
import { Lock } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export default function DisabledFieldTooltip({ reason, children }) {
  if (!reason) return children;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="relative" tabIndex={0} role="group" aria-label={reason}>
            {children}
            <div className="absolute top-2 right-2 p-1 bg-muted rounded">
              <Lock className="h-3 w-3 text-muted-foreground" />
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-xs">
          <p className="text-xs">{reason}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}