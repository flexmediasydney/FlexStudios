import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

export default function ProgressBar({ value, label, showLabel = true, showPercent = true, size = "default" }) {
  const sizeClasses = {
    small: "h-1",
    default: "h-2",
    large: "h-3",
  };

  return (
    <div className="space-y-1">
      {label && (
        <div className="flex justify-between items-center">
          <span className="text-sm font-medium">{label}</span>
          {showPercent && <span className="text-sm text-muted-foreground">{Math.round(value)}%</span>}
        </div>
      )}
      <Progress value={value} className={cn(sizeClasses[size])} aria-label={label ? `${label}: ${Math.round(value)}%` : `${Math.round(value)}% complete`} />
    </div>
  );
}