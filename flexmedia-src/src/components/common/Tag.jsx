import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export default function Tag({ children, onRemove, variant = "default", className }) {
  const variants = {
    default: "bg-slate-100 text-slate-800",
    primary: "bg-primary/10 text-primary",
    success: "bg-green-100 text-green-800",
    error: "bg-red-100 text-red-800",
  };

  return (
    <span className={cn("inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium", variants[variant], className)}>
      {children}
      {onRemove && <button onClick={onRemove} className="hover:opacity-70"><X className="h-3 w-3" /></button>}
    </span>
  );
}