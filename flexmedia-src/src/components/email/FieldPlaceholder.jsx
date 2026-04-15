import React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export default function FieldPlaceholder({ 
  field, 
  icon: Icon, 
  onRemove,
  className 
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-muted text-foreground/80 text-sm border border-border hover:bg-muted/80 transition-colors group",
        className
      )}
      contentEditable={false}
      suppressContentEditableWarning
    >
      {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />}
      <span className="font-medium">{field}</span>
      {onRemove && (
        <button
          onClick={(e) => {
            e.preventDefault();
            onRemove();
          }}
          className="opacity-0 group-hover:opacity-100 transition-opacity ml-1 p-0.5 hover:bg-muted rounded"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}