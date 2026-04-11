import { Plus, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function Counter({ value, onChange, min = 0, max = 100, label }) {
  const atMin = value <= min;
  const atMax = value >= max;

  return (
    <div>
      {label && <label className="text-sm font-medium mb-2 block">{label}</label>}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => onChange(Math.max(min, value - 1))} disabled={atMin} aria-label="Decrease" title={atMin ? `Minimum is ${min}` : "Decrease by 1"}>
          <Minus className="h-4 w-4" />
        </Button>
        <Input
          type="number"
          value={value}
          onChange={(e) => onChange(Math.max(min, Math.min(max, parseInt(e.target.value) || min)))}
          className="w-16 text-center tabular-nums"
          min={min}
          max={max}
          title={label || `Value (${min}–${max})`}
          aria-label={label || "Counter value"}
        />
        <Button variant="outline" size="sm" onClick={() => onChange(Math.min(max, value + 1))} disabled={atMax} aria-label="Increase" title={atMax ? `Maximum is ${max}` : "Increase by 1"}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}