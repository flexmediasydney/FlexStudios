import { Plus, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function Counter({ value, onChange, min = 0, max = 100, label }) {
  return (
    <div>
      {label && <label className="text-sm font-medium mb-2 block">{label}</label>}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => onChange(Math.max(min, value - 1))}>
          <Minus className="h-4 w-4" />
        </Button>
        <Input
          type="number"
          value={value}
          onChange={(e) => onChange(Math.max(min, Math.min(max, parseInt(e.target.value) || min)))}
          className="w-16 text-center"
          min={min}
          max={max}
        />
        <Button variant="outline" size="sm" onClick={() => onChange(Math.min(max, value + 1))}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}