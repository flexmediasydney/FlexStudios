import { TrendingUp, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";

export default function Stat({ label, value, unit, trend, trendPercent, className }) {
  const isTrendUp = trend === "up";

  return (
    <div className={cn("p-4", className)}>
      <p className="text-sm text-muted-foreground mb-1">{label}</p>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold">{value}</span>
        {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
        {trend && (
          <div className={cn("flex items-center gap-1 text-xs font-medium ml-auto", isTrendUp ? "text-green-600" : "text-red-600")}>
            {isTrendUp ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            {trendPercent && <span>{trendPercent}%</span>}
          </div>
        )}
      </div>
    </div>
  );
}