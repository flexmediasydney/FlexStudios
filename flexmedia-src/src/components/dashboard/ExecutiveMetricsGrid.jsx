import { Card } from "@/components/ui/card";
import { TrendingUp, TrendingDown, Minus, DollarSign, Camera, CheckCircle2, Clock, Users, AlertTriangle, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { createPageUrl } from "@/utils";

export default function ExecutiveMetricsGrid({ metrics, navigate }) {
  const {
    totalRevenue,
    revenueGrowth,
    activeProjects,
    projectsGrowth,
    completionRate,
    completionTrend,
    averageValue,
    valueGrowth,
    deliverySpeed,
    speedTrend,
    clientSatisfaction,
    satisfactionTrend,
    teamUtilization,
    utilizationTrend,
    overdueItems,
    overdueTrend
  } = metrics;

  const cards = [
    {
      label: "Total Revenue",
      value: `$${(totalRevenue / 1000).toFixed(1)}k`,
      subvalue: `${Math.abs(revenueGrowth)}% ${revenueGrowth >= 0 ? 'up' : 'down'} vs last period`,
      trend: revenueGrowth,
      icon: DollarSign,
      color: "emerald",
      highlight: true,
      onClick: navigate ? () => navigate(createPageUrl("Projects")) : null,
    },
    {
      label: "Active Pipeline",
      value: activeProjects,
      subvalue: `${Math.abs(projectsGrowth)} ${projectsGrowth >= 0 ? 'more' : 'fewer'} than last period`,
      trend: projectsGrowth,
      icon: Camera,
      color: "blue",
      onClick: navigate ? () => navigate(createPageUrl("Projects")) : null,
    },
    {
      label: "Completion Rate",
      value: `${completionRate}%`,
      subvalue: `${Math.abs(completionTrend)}% ${completionTrend >= 0 ? 'improvement' : 'decline'}`,
      trend: completionTrend,
      icon: CheckCircle2,
      color: "green",
      onClick: navigate ? () => navigate(createPageUrl("Projects") + "?status=delivered") : null,
    },
    {
      label: "Avg Project Value",
      value: `$${(averageValue / 1000).toFixed(1)}k`,
      subvalue: `${Math.abs(valueGrowth)}% ${valueGrowth >= 0 ? 'increase' : 'decrease'}`,
      trend: valueGrowth,
      icon: TrendingUp,
      color: "violet",
      onClick: navigate ? () => navigate(createPageUrl("Projects")) : null,
    },
    {
      label: "Avg Delivery Time",
      value: `${deliverySpeed}d`,
      subvalue: `${Math.abs(speedTrend)}d ${speedTrend <= 0 ? 'faster' : 'slower'}`,
      trend: -speedTrend,
      icon: Clock,
      color: "amber",
      onClick: navigate ? () => navigate(createPageUrl("Projects") + "?status=delivered") : null,
    },
    {
      label: "Team Utilization",
      value: `${teamUtilization}%`,
      subvalue: `${Math.abs(utilizationTrend)}% ${utilizationTrend >= 0 ? 'increase' : 'decrease'}`,
      trend: utilizationTrend,
      icon: Users,
      color: "cyan",
      onClick: navigate ? () => navigate(createPageUrl("Analytics") + "?tab=utilisation") : null,
    },
    {
      label: "At Risk Items",
      value: overdueItems,
      subvalue: `${Math.abs(overdueTrend)} ${overdueTrend >= 0 ? 'more' : 'fewer'} than last period`,
      trend: -overdueTrend,
      icon: AlertTriangle,
      color: overdueItems > 0 ? "red" : "slate",
      alert: overdueItems > 5,
      onClick: navigate ? () => navigate(createPageUrl("Projects")) : null,
    }
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((card, idx) => {
        const TrendIcon = card.trend > 0 ? TrendingUp : card.trend < 0 ? TrendingDown : Minus;
        const Icon = card.icon;
        
        const colorClasses = {
          emerald: "from-emerald-500 to-emerald-600",
          blue: "from-blue-500 to-blue-600",
          green: "from-green-500 to-green-600",
          violet: "from-violet-500 to-violet-600",
          amber: "from-amber-500 to-amber-600",
          cyan: "from-cyan-500 to-cyan-600",
          red: "from-red-500 to-red-600",
          slate: "from-slate-400 to-slate-500"
        };

        return (
          <Card
            key={idx}
            onClick={card.onClick || undefined}
            className={cn(
              "relative overflow-hidden transition-all hover:shadow-lg",
              card.highlight && "lg:col-span-2",
              card.alert && "ring-2 ring-red-500/20 animate-pulse",
              card.onClick && "cursor-pointer hover:ring-2 hover:ring-primary/20"
            )}
          >
            {/* Background gradient accent */}
            <div className={cn("absolute top-0 right-0 w-32 h-32 bg-gradient-to-br opacity-10 blur-2xl", colorClasses[card.color])} />
            
            <div className="relative p-5">
              <div className="flex items-start justify-between mb-3">
                <div className={cn("w-12 h-12 rounded-xl bg-gradient-to-br flex items-center justify-center shadow-lg", colorClasses[card.color])}>
                  <Icon className="h-6 w-6 text-white" />
                </div>
                {card.trend !== 0 && (
                  <div className={cn(
                    "flex items-center gap-1 px-2 py-1 rounded-full text-xs font-semibold",
                    card.trend > 0 ? "bg-green-100 text-green-700" : card.trend < 0 ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-600"
                  )}>
                    <TrendIcon className="h-3 w-3" />
                    {Math.abs(card.trend)}%
                  </div>
                )}
              </div>
              
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">
                  {card.label}
                </p>
                <p className="text-3xl font-bold tracking-tight mb-1">
                  {card.value}
                </p>
                <p className="text-xs text-muted-foreground">
                  {card.subvalue}
                </p>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}