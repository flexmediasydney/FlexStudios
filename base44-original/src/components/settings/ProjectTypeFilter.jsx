import React from "react";
import { useEntityList } from "@/components/hooks/useEntityData";
import { Badge } from "@/components/ui/badge";

/**
 * A single-selection pill filter for project types.
 * Only one type can be active at a time (exclusive).
 * selectedTypeId = null means "All"
 */
export default function ProjectTypeFilter({ selectedTypeId, onChange }) {
  const { data: types = [] } = useEntityList("ProjectType", "order");
  const activeTypes = types.filter(t => t.is_active !== false);

  if (activeTypes.length <= 1) return null; // No filter needed if 0 or 1 types

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs text-muted-foreground font-medium">Type:</span>
      <button
        onClick={() => onChange(null)}
        className={`px-3 py-1 rounded-full text-xs font-medium border transition-all ${
          !selectedTypeId
            ? "bg-foreground text-background border-foreground"
            : "bg-background text-muted-foreground border-border hover:border-muted-foreground"
        }`}
      >
        All
      </button>
      {activeTypes.map(type => {
        const isSelected = selectedTypeId === type.id;
        return (
          <button
            key={type.id}
            onClick={() => onChange(isSelected ? null : type.id)}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border-2 transition-all ${
              isSelected ? "text-white border-transparent" : "bg-background text-muted-foreground border-border hover:border-muted-foreground/40"
            }`}
            style={isSelected ? { backgroundColor: type.color || "#3b82f6", borderColor: type.color || "#3b82f6" } : {}}
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: isSelected ? "rgba(255,255,255,0.7)" : (type.color || "#3b82f6") }} />
            {type.name}
          </button>
        );
      })}
    </div>
  );
}