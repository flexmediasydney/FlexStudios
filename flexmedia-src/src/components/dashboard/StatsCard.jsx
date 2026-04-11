import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export default function StatsCard({ title, value, subtitle, icon: Icon, trend, className }) {
  return (
    <Card className={cn("p-6 relative overflow-hidden group hover:shadow-lg hover:scale-105 transition-all duration-300 bg-gradient-to-br from-card to-card/80 cursor-default", className)}>
      <div className="flex justify-between items-start">
        <div className="space-y-1">
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <p className="text-3xl font-bold tracking-tight tabular-nums">{value}</p>
          {subtitle && (
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          )}
        </div>
        {Icon && (
          <div className="p-3 rounded-xl bg-primary/10 text-primary group-hover:scale-125 group-hover:rotate-6 group-hover:bg-primary/20 transition-all duration-300" aria-hidden="true">
            <Icon className="h-5 w-5" />
          </div>
        )}
      </div>
      {trend && (
        <div className="mt-4 flex items-center gap-1.5 text-sm font-medium">
          <span className={cn(
            "tabular-nums",
            trend > 0 ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400"
          )}>
            {trend > 0 ? "↑" : "↓"} {Math.abs(trend)}%
          </span>
          <span className="text-muted-foreground">vs last month</span>
        </div>
      )}
      <div className="absolute -right-8 -bottom-8 w-32 h-32 bg-primary/5 rounded-full group-hover:scale-150 transition-transform duration-500" />
    </Card>
  );
}