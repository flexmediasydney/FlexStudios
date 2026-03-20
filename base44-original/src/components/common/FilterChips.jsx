import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function FilterChips({ items = [], onRemove, className = "" }) {
  if (items.length === 0) return null;

  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      {items.map((item) => (
        <div key={item.id} className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-sm">
          <span className="text-primary">{item.label}</span>
          <button onClick={() => onRemove(item.id)} className="text-primary hover:text-primary/80 transition-colors">
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}