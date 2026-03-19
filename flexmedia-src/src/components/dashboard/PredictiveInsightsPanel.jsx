import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, AlertTriangle, Lightbulb, Target, DollarSign, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function PredictiveInsightsPanel({ insights }) {
  const iconMap = {
    opportunity: { Icon: Lightbulb, color: 'text-amber-600', bg: 'bg-amber-50', border: 'border-amber-200' },
    risk: { Icon: AlertTriangle, color: 'text-red-600', bg: 'bg-red-50', border: 'border-red-200' },
    trend: { Icon: TrendingUp, color: 'text-green-600', bg: 'bg-green-50', border: 'border-green-200' },
    action: { Icon: Target, color: 'text-blue-600', bg: 'bg-blue-50', border: 'border-blue-200' }
  };

  return (
    <Card className="lg:col-span-2">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Lightbulb className="h-4 w-4 text-amber-500" />
            AI-Powered Insights
          </CardTitle>
          <Badge variant="secondary" className="text-xs">
            Live Analysis
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {insights.map((insight, idx) => {
            const config = iconMap[insight.type] || iconMap.action;
            const Icon = config.Icon;
            
            return (
              <div
                key={idx}
                className={`p-4 rounded-lg border ${config.bg} ${config.border}`}
              >
                <div className="flex items-start gap-3">
                  <div className={`w-8 h-8 rounded-lg bg-white border ${config.border} flex items-center justify-center flex-shrink-0`}>
                    <Icon className={`h-4 w-4 ${config.color}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-xs font-semibold mb-1 ${config.color}`}>
                      {insight.title}
                    </p>
                    <p className="text-xs text-muted-foreground mb-2">
                      {insight.description}
                    </p>
                    {insight.action && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 text-xs"
                        onClick={insight.action.onClick}
                      >
                        {insight.action.label}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}