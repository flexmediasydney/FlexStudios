import React from 'react';
import { Button } from '@/components/ui/button';
import { RotateCcw, Maximize2 } from 'lucide-react';
import { toast } from 'sonner';

export default function ColumnControls({
  onReset,
  onFitToScreen,
  containerWidth
}) {
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        onClick={onReset}
        className="h-7 gap-1 text-xs"
        title="Reset columns to default"
      >
        <RotateCcw className="h-3 w-3" />
        Reset
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          onFitToScreen(containerWidth);
          toast.success('Columns fitted to screen');
        }}
        className="h-7 gap-1 text-xs"
        title="Fit all columns to screen width"
      >
        <Maximize2 className="h-3 w-3" />
        Fit
      </Button>
    </div>
  );
}