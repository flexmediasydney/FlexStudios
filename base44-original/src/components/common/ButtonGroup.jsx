import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function ButtonGroup({ buttons = [], value, onChange, className }) {
  return (
    <div className={cn("flex gap-0 border rounded-lg", className)}>
      {buttons.map((btn, idx) => (
        <Button
          key={idx}
          variant={value === btn.value ? "default" : "ghost"}
          onClick={() => onChange(btn.value)}
          className={cn(
            "flex-1 rounded-none border-r last:border-r-0",
            value === btn.value ? "border-0" : "border-r"
          )}
        >
          {btn.icon && <btn.icon className="h-4 w-4 mr-2" />}
          {btn.label}
        </Button>
      ))}
    </div>
  );
}