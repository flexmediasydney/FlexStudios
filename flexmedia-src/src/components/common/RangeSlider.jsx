import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";

export default function RangeSlider({ min = 0, max = 100, value, onChange, step = 1, label }) {
  return (
    <div className="space-y-2">
      {label && <label className="text-sm font-medium">{label}</label>}
      <div className="flex items-center gap-4">
        <Slider
          min={min}
          max={max}
          step={step}
          value={[value]}
          onValueChange={(v) => onChange(v[0])}
          className="flex-1"
        />
        <Input
          type="number"
          value={value}
          onChange={(e) => onChange(Math.max(min, Math.min(max, parseInt(e.target.value) || min)))}
          className="w-20"
          min={min}
          max={max}
        />
      </div>
    </div>
  );
}