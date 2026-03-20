import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";

export default function DragHandle({ className }) {
  return (
    <div className={cn("cursor-grab active:cursor-grabbing flex-shrink-0", className)}>
      <GripVertical className="h-5 w-5 text-muted-foreground" />
    </div>
  );
}