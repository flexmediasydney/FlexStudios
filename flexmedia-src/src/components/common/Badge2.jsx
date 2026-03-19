import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export default function Badge({ children, onRemove, variant = "default", className }) {
  const variants = {
    default: "bg-primary/10 text-primary border border-primary/20",
    secondary: "bg-secondary/10 text-secondary-foreground border border-secondary",
    success: "bg-green-100 text-green-800",
    error: "bg-red-100 text-red-800",
    warning: "bg-amber-100 text-amber-800",
  };

  return (
    <span className={cn("inline-flex items-center gap-2 px-3 py-1 rounded-full text-sm font-medium", variants[variant], className)}>
      {children}
      {onRemove && (
        <button onClick={onRemove} className="hover:opacity-70">
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}