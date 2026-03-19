import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { fmtHoursMins } from '@/components/utilization/utilizationUtils';

// FIX: Heatmap colour bands now align with the status thresholds used in cards/page
function getColor(percent, hasData) {
  if (!hasData) return 'bg-gray-100 text-gray-500 border border-dashed border-gray-300';
  if (percent > 120) return 'bg-orange-100 text-orange-900 border border-orange-200';
  if (percent >= 80) return 'bg-green-100 text-green-900 border border-green-200';
  if (percent >= 50) return 'bg-blue-100 text-blue-900 border border-blue-200';
  return 'bg-slate-100 text-slate-700 border border-slate-200';
}

const LEGEND = [
  { label: 'No data', color: 'bg-gray-100 border border-dashed border-gray-300' },
  { label: '<50%', color: 'bg-slate-100 border border-slate-200' },
  { label: '50–80%', color: 'bg-blue-100 border border-blue-200' },
  { label: '80–120%', color: 'bg-green-100 border border-green-200' },
  { label: '>120%', color: 'bg-orange-100 border border-orange-200' },
];

export default function UtilizationHeatmap({ utilizations, onEmployeeClick }) {
  const sorted = [...utilizations].sort((a, b) => {
    // Sort: active employees by percent desc, then idle employees
    if (a.has_data && !b.has_data) return -1;
    if (!a.has_data && b.has_data) return 1;
    return b.utilization_percent - a.utilization_percent;
  });

  return (
    <div className="space-y-4">
      {/* Legend */}
      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Legend:</span>
          {LEGEND.map(l => (
            <div key={l.label} className="flex items-center gap-1.5">
              <span className={cn('inline-block w-4 h-4 rounded', l.color)} />
              <span>{l.label}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-6">
        <h3 className="text-sm font-semibold mb-4">
          Employee Utilization Heatmap
          <span className="ml-2 text-xs font-normal text-muted-foreground">({sorted.length} employees)</span>
        </h3>
        {sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground">No employees to display</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
            {sorted.map(util => (
              <button
                key={util.user_id}
                onClick={() => onEmployeeClick?.(util)}
                className={cn(
                  'p-3 rounded-lg text-center transition-all hover:shadow-md cursor-pointer',
                  getColor(util.utilization_percent, util.has_data),
                )}
                title={`${util.user_name} — ${util.has_data ? `${util.utilization_percent}% utilization` : 'no data this period'}`}
              >
                <p className="text-xs font-semibold truncate">{util.user_name}</p>
                <p className="text-lg font-bold leading-tight">
                  {util.has_data ? `${util.utilization_percent}%` : '—'}
                </p>
                <p className="text-xs opacity-75">
                  {util.has_data ? fmtHoursMins(util.actual_seconds) : 'idle'}
                </p>
              </button>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}