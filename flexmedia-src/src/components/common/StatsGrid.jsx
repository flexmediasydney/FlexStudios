import { Card } from "@/components/ui/card";
import { TrendingUp, TrendingDown } from "lucide-react";

export default function StatsGrid({ stats = [] }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {stats.map((stat, idx) => {
        const Icon = stat.icon;
        const TrendIcon = stat.trend === "up" ? TrendingUp : TrendingDown;

        return (
          <Card key={idx} className="p-6">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm text-muted-foreground font-medium">{stat.label}</p>
                <p className="text-2xl font-bold mt-2">{stat.value}</p>
                {stat.trend && (
                  <div className="flex items-center gap-1 mt-2 text-xs font-semibold">
                    <TrendIcon className={`h-3 w-3 ${stat.trend === "up" ? "text-green-600" : "text-red-600"}`} />
                    <span className={stat.trend === "up" ? "text-green-600" : "text-red-600"}>
                      {stat.change}%
                    </span>
                  </div>
                )}
              </div>
              {Icon && <Icon className="h-8 w-8 text-muted-foreground" />}
            </div>
          </Card>
        );
      })}
    </div>
  );
}