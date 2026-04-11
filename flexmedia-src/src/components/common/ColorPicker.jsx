import { Input } from "@/components/ui/input";
import { useState } from "react";

const colors = [
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4",
  "#3b82f6", "#8b5cf6", "#ec4899", "#6b7280", "#000000", "#ffffff",
];

export default function ColorPicker({ value = "#3b82f6", onChange, label, showPresets = true }) {
  const [openInput, setOpenInput] = useState(false);

  return (
    <div className="space-y-2">
      {label && <label className="text-sm font-medium">{label}</label>}
      <div className="flex gap-2 items-center">
        <button
          onClick={() => setOpenInput(!openInput)}
          className="h-10 w-10 rounded border-2 transition-transform hover:scale-105"
          style={{ borderColor: value, backgroundColor: value }}
          title={value}
          aria-label={`Current color: ${value}. Click to ${openInput ? 'hide' : 'show'} color input.`}
        />
        {openInput && (
          <Input
            type="color"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="h-10 w-20 cursor-pointer"
          />
        )}
      </div>
      {showPresets && (
        <div className="flex gap-2 flex-wrap">
          {colors.map((color) => (
            <button
              key={color}
              onClick={() => onChange(color)}
              className={`h-8 w-8 rounded transition-transform hover:scale-110 ${value === color ? "ring-2 ring-offset-2 ring-primary" : ""} ${color === "#ffffff" ? "border border-border" : ""}`}
              style={{ backgroundColor: color }}
              title={color}
              aria-label={`Select color ${color}${value === color ? ' (selected)' : ''}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}