import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function Chip({ label, onRemove, icon: Icon, variant = "default", className }) {
  const variants = {
    default: "bg-gray-100 text-gray-800 hover:bg-gray-200",
    primary: "bg-primary/10 text-primary hover:bg-primary/20",
    success: "bg-green-100 text-green-800",
  };

  return (
    <div className={cn("inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm", variants[variant], className)}>
      {Icon && <Icon className="h-3.5 w-3.5" />}
      <span>{label}</span>
      {onRemove && (
        <Button variant="ghost" size="sm" onClick={onRemove} className="h-5 w-5 p-0 ml-1 rounded-full hover:bg-black/10" title="Remove">
          <X className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
}