import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Activity, AlertCircle, CheckCircle2, Clock } from "lucide-react";

export default function ProjectHealthScore({ healthMetrics }) {
  const {
    overallScore,
    onTimeDelivery,
    budgetAdherence,
    clientSatisfaction,
    resourceUtilization,
    riskScore
  } = healthMetrics;

  const getScoreColor = (score) => {
    if (score >= 80) return { bg: 'bg-green-500', text: 'text-green-700', light: 'bg-green-50' };
    if (score >= 60) return { bg: 'bg-amber-500', text: 'text-amber-700', light: 'bg-amber-50' };
    return { bg: 'bg-red-500', text: 'text-red-700', light: 'bg-red-50' };
  };

  const scoreColor = getScoreColor(overallScore);

  const metrics = [
    { label: 'On-Time Delivery', value: onTimeDelivery, icon: Clock },
    { label: 'Budget Adherence', value: budgetAdherence, icon: CheckCircle2 },
    { label: 'Client Satisfaction', value: clientSatisfaction, icon: Activity },
    { label: 'Resource Utilization', value: resourceUtilization, icon: Activity },
  ];

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="text-base">Portfolio Health Score</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Overall Score */}
        <div className="text-center">
          <div className={`inline-flex items-center justify-center w-32 h-32 rounded-full ${scoreColor.light} mb-3 relative`}>
            <svg className="absolute inset-0 w-full h-full -rotate-90">
              <circle
                cx="64"
                cy="64"
                r="56"
                fill="none"
                stroke="#e5e7eb"
                strokeWidth="8"
              />
              <circle
                cx="64"
                cy="64"
                r="56"
                fill="none"
                stroke="currentColor"
                strokeWidth="8"
                strokeDasharray={`${2 * Math.PI * 56}`}
                strokeDashoffset={`${2 * Math.PI * 56 * (1 - overallScore / 100)}`}
                className={scoreColor.text}
                strokeLinecap="round"
              />
            </svg>
            <div className="relative">
              <p className="text-4xl font-bold">{overallScore}</p>
              <p className="text-xs text-muted-foreground">/ 100</p>
            </div>
          </div>
          <p className="text-sm font-semibold mb-1">Overall Health</p>
          <Badge variant={overallScore >= 80 ? 'default' : overallScore >= 60 ? 'secondary' : 'destructive'}>
            {overallScore >= 80 ? 'Excellent' : overallScore >= 60 ? 'Good' : 'Needs Attention'}
          </Badge>
        </div>

        {/* Metric Breakdown */}
        <div className="space-y-3">
          {metrics.map((metric) => {
            const Icon = metric.icon;
            const color = getScoreColor(metric.value);
            return (
              <div key={metric.label} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <Icon className="h-3 w-3" />
                    {metric.label}
                  </span>
                  <span className={`font-semibold ${color.text}`}>{metric.value}%</span>
                </div>
                <Progress value={metric.value} className="h-1.5" />
              </div>
            );
          })}
        </div>

        {/* Risk Alert */}
        {riskScore > 30 && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200">
            <AlertCircle className="h-4 w-4 text-red-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-semibold text-red-700">High Risk Alert</p>
              <p className="text-xs text-red-600 mt-0.5">
                {riskScore}% of projects require immediate attention
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}