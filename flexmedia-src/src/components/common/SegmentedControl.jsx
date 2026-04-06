import { cn } from "@/lib/utils";

export default function SegmentedControl({ options = [], value, onChange, label }) {
  return (
    <div className="space-y-2">
      {label && <label className="text-sm font-medium block">{label}</label>}
      <div className="inline-flex gap-1 p-1 bg-gray-100 rounded-lg">
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={cn(
              "px-4 py-2 rounded text-sm font-medium transition-colors",
              value === opt.value ? "bg-white text-primary shadow-sm" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}