import { useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { fmtHoursMins } from '@/components/utilization/utilizationUtils';
import { cn } from '@/lib/utils';

export default function TeamComparisonView({ groupedByTeam }) {
  const teamStats = useMemo(() =>
    Object.entries(groupedByTeam)
      .filter(([, { utilizations }]) => utilizations.length > 0)
      .map(([, { team, utilizations }]) => {
        const totalActual = utilizations.reduce((s, u) => s + u.actual_seconds, 0);
        const totalEstimated = utilizations.reduce((s, u) => s + u.estimated_seconds, 0);
        const withData = utilizations.filter(u => u.has_data);
        const avgUtilization = withData.length > 0
          ? Math.round(withData.reduce((s, u) => s + u.utilization_percent, 0) / withData.length)
          : 0;

        return {
          name: team.name,
          actual: parseFloat((totalActual / 3600).toFixed(1)),
          estimated: parseFloat((totalEstimated / 3600).toFixed(1)),
          utilization: avgUtilization,
          headcount: utilizations.length,
          activeCount: withData.length,
          actualSeconds: totalActual,
          estimatedSeconds: totalEstimated,
        };
      })
      .sort((a, b) => b.utilization - a.utilization),
  [groupedByTeam]);

  return (
    <div className="space-y-6">
      {/* Chart */}
      <Card className="p-6">
        <h3 className="text-sm font-semibold mb-4">Team Utilization Comparison</h3>
        {teamStats.length > 0 ? (
          <ResponsiveContainer width="100%" height={380}>
            <BarChart data={teamStats} margin={{ left: 10, right: 60, top: 10, bottom: 80 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" angle={-35} textAnchor="end" height={90} interval={0} tick={{ fontSize: 12 }} />
              <YAxis yAxisId="left" label={{ value: 'Hours', angle: -90, position: 'insideLeft', offset: -5 }} tickFormatter={v => `${v}h`} />
              <YAxis yAxisId="right" orientation="right" label={{ value: 'Util %', angle: 90, position: 'insideRight', offset: -5 }} tickFormatter={v => `${v}%`} />
              <Tooltip
                formatter={(val, name) =>
                  name === 'Util %' ? [`${val}%`, name] : [`${val}h`, name]
                }
              />
              <Legend />
              <Bar yAxisId="left" dataKey="actual" fill="#10b981" name="Actual (h)" radius={[2, 2, 0, 0]} />
              <Bar yAxisId="left" dataKey="estimated" fill="#94a3b8" name="Estimated (h)" radius={[2, 2, 0, 0]} />
              <Bar yAxisId="right" dataKey="utilization" fill="#f59e0b" name="Util %" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-sm text-muted-foreground">No team data available</p>
        )}
      </Card>

      {/* Team Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {teamStats.map(team => {
          const utilColor = team.utilization > 120
            ? 'text-orange-600' : team.utilization >= 80
            ? 'text-green-600' : 'text-blue-600';
          const barColor = team.utilization > 120
            ? 'bg-orange-500' : team.utilization >= 80
            ? 'bg-green-500' : 'bg-blue-400';

          return (
            <Card key={team.name} className="p-4 hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <p className="text-sm font-semibold">{team.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {team.headcount} {team.headcount === 1 ? 'person' : 'people'}
                    {team.activeCount < team.headcount && (
                      <span className="ml-1 text-muted-foreground/60">
                        ({team.activeCount} active)
                      </span>
                    )}
                  </p>
                </div>
                <div className="text-right">
                  <p className={cn('text-2xl font-bold', utilColor)}>
                    {team.activeCount > 0 ? `${team.utilization}%` : '—'}
                  </p>
                  <p className="text-xs text-muted-foreground">utilization</p>
                </div>
              </div>

              <div className="space-y-1 text-xs mb-2">
                <div className="flex justify-between text-muted-foreground">
                  <span>Estimated</span>
                  <span className="font-medium text-foreground">{fmtHoursMins(team.estimatedSeconds)}</span>
                </div>
                <div className="flex justify-between text-muted-foreground">
                  <span>Actual</span>
                  <span className="font-medium text-foreground">{fmtHoursMins(team.actualSeconds)}</span>
                </div>
              </div>

              <div className="w-full bg-gray-200 rounded h-1.5">
                <div
                  className={cn('h-1.5 rounded transition-all', barColor)}
                  style={{ width: `${Math.min(team.utilization, 100)}%` }}
                />
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}