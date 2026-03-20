import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fmtHoursMins } from '@/components/utilization/utilizationUtils';

const periodLabels = {
  day: 'Today',
  week: 'This Week',
  month: 'This Month',
};

const statusConfig = {
  underutilized: { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-600', bar: 'bg-blue-400', icon: TrendingDown },
  balanced: { bg: 'bg-green-50', border: 'border-green-200', text: 'text-green-600', bar: 'bg-green-500', icon: Minus },
  overutilized: { bg: 'bg-orange-50', border: 'border-orange-200', text: 'text-orange-600', bar: 'bg-orange-500', icon: TrendingUp },
};

export default function EmployeeUtilizationCard({ utilization }) {
  const {
    user_name,
    role,
    team_name,
    utilization_percent,
    status,
    estimated_seconds,
    actual_seconds,
    period,
    has_data,
  } = utilization;

  const periodLabel = periodLabels[period] || period;

  if (!has_data) {
    return (
      <Card className="p-4 border-l-4 border-gray-200 bg-gray-50">
        <div className="flex items-start justify-between mb-2">
          <div>
            <h3 className="font-semibold text-sm">{user_name || 'Unknown'}</h3>
            <p className="text-xs text-muted-foreground capitalize">{role?.replace(/_/g, ' ')}</p>
            {team_name && <p className="text-xs text-muted-foreground/60">{team_name}</p>}
          </div>
          <Badge variant="outline" className="text-xs text-gray-400 border-gray-300">
            idle
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">No time logged {periodLabel.toLowerCase()}</p>
      </Card>
    );
  }

  const displayStatus = status || 'balanced';
  const config = statusConfig[displayStatus] || statusConfig.balanced;
  const Icon = config.icon;

  return (
    <Card className={cn('p-4 border-l-4', config.bg, config.border)}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="font-semibold text-sm">{user_name || 'Unknown'}</h3>
          <p className="text-xs text-muted-foreground capitalize">{role?.replace(/_/g, ' ')}</p>
          {team_name && <p className="text-xs text-muted-foreground/60">{team_name}</p>}
          <p className="text-xs text-muted-foreground/60 mt-0.5">{periodLabel}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <Icon className={cn('h-4 w-4', config.text)} />
          <Badge variant="outline" className={cn('text-xs', config.text)}>
            {displayStatus}
          </Badge>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center text-xs mb-3">
        <div>
          <p className="text-muted-foreground">Estimated</p>
            <p className="font-semibold">{estimated_seconds > 0 ? fmtHoursMins(estimated_seconds) : '—'}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Actual</p>
          <p className="font-semibold">{fmtHoursMins(actual_seconds)}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Utilization</p>
          <p className={cn('font-semibold', config.text)}>
            {estimated_seconds > 0 ? `${utilization_percent}%` : '—'}
          </p>
        </div>
      </div>

      {estimated_seconds > 0 && (
        <div className="w-full bg-gray-200 rounded-full h-1.5">
          <div
            className={cn('h-1.5 rounded-full transition-all', config.bar)}
            style={{ width: `${Math.min(utilization_percent, 100)}%` }}
          />
        </div>
      )}
    </Card>
  );
}