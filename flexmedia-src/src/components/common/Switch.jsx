import { Switch as SwitchUI } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

export default function SwitchField({ label, checked, onCheckedChange, description, disabled }) {
  return (
    <div className="flex items-center justify-between py-3">
      <div>
        {label && <Label className="text-sm font-medium mb-0">{label}</Label>}
        {description && <p className="text-xs text-muted-foreground mt-1">{description}</p>}
      </div>
      <SwitchUI checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </div>
  );
}