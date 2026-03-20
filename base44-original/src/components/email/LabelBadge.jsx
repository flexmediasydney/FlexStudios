import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export default function LabelBadge({ label, color, onRemove, clickable = false, className = "" }) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium text-white transition-all",
        clickable && "cursor-pointer hover:shadow-md hover:scale-105",
        className
      )}
      style={{ backgroundColor: color }}
    >
      <span>{label}</span>
      {onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="ml-0.5 hover:opacity-75 transition-opacity"
          title="Remove label"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}