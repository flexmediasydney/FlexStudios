import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Curated color palette for email labels — 12 preset colors.
 * Shared across LabelSelectorRobust and EmailLabelsTab.
 */
export const LABEL_COLORS = [
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#14b8a6", // teal
  "#3b82f6", // blue
  "#6366f1", // indigo
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#64748b", // slate
  "#78716c", // stone
  "#0ea5e9", // sky
];

/**
 * Compact color dot picker — renders the 12 preset colors as clickable dots.
 */
export function ColorDotPicker({ value, onChange, size = "sm" }) {
  const dotSize = size === "sm" ? "w-5 h-5" : "w-6 h-6";
  return (
    <div className="flex flex-wrap gap-1.5">
      {LABEL_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={cn(
            dotSize,
            "rounded-full transition-all flex-shrink-0 border-2",
            value === c
              ? "border-slate-900 scale-110 ring-2 ring-offset-1 ring-slate-400"
              : "border-transparent hover:scale-110 hover:border-slate-300"
          )}
          style={{ backgroundColor: c }}
          title={c}
          aria-label={`Color ${c}`}
        />
      ))}
    </div>
  );
}

export default function LabelBadge({ label, color, onRemove, clickable = false, className = "" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold text-white leading-tight whitespace-nowrap",
        clickable && "cursor-pointer hover:brightness-110",
        className
      )}
      style={{ backgroundColor: color || "#64748b" }}
    >
      {label}
      {onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="ml-0.5 hover:opacity-75 transition-opacity"
          title="Remove label"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </span>
  );
}
