import { Card } from '@/components/ui/card';
import { TrendingUp, TrendingDown, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export default function UtilizationMetricsCard({ label, value, valueUnit = 'h', subtext, status, trend }) {
  const statusConfig = {
    balanced: { bg: 'bg-green-50', border: 'border-green-200', text: 'text-green-700', icon: TrendingUp },
    overutilized: { bg: 'bg-orange-50', border: 'border-orange-200', text: 'text-orange-700', icon: AlertCircle },
    underutilized: { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-700', icon: TrendingDown },
  };

  const config = status ? statusConfig[status] : null;
  const Icon = config?.icon;

  const safeValue = isNaN(value) || value === null || value === undefined ? 0 : value;
  const displayValue = valueUnit === '%'
    ? `${safeValue}%`
    : valueUnit === 'h'
    ? `${safeValue}h`
    : `${safeValue}`;

  return (
    <Card className={cn('p-4', config && `${config.bg} border-l-4 ${config.border}`)}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-muted-foreground font-medium mb-1">{label}</p>
          <p className={cn('text-2xl font-bold', config ? config.text : 'text-foreground')}>
            {displayValue}
          </p>
          {subtext && <p className="text-xs text-muted-foreground mt-1">{subtext}</p>}
        </div>
        {Icon && <Icon className={cn('h-5 w-5 mt-0.5', config?.text)} />}
      </div>
      {trend !== undefined && trend !== 0 && (
        <p className="text-xs text-muted-foreground mt-3 pt-2 border-t">
          {trend > 0 ? '↑' : '↓'} {Math.abs(trend)}% vs last period
        </p>
      )}
    </Card>
  );
}